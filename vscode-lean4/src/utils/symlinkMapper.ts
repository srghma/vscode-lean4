import * as fs from 'fs'
import * as path from 'path'
import { Location, LocationLink, Uri, workspace } from 'vscode'
import { ExtUri, FileUri } from './exturi'

interface LakePackage {
    pkgDir: string
    realTarget: string
}

// Short-lived cache (5s) to avoid repetitive synchronous I/O during multi-result queries (e.g., "Find All References")
const PACKAGE_CACHE = new Map<string, { timestamp: number; packages: LakePackage[] }>()
const CACHE_TTL_MS = 5000

/**
 * Returns all packages inside `.lake/packages` for a workspace folder.
 */
function getLakePackages(folderPath: string): LakePackage[] {
    const now = Date.now()
    const cached = PACKAGE_CACHE.get(folderPath)
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        return cached.packages
    }

    const packagesDir = path.join(folderPath, '.lake', 'packages')
    const packages: LakePackage[] = []

    try {
        const entries = fs.readdirSync(packagesDir, { withFileTypes: true })
        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

            const pkgDir = path.join(packagesDir, entry.name)
            try {
                const realTarget = fs.realpathSync(pkgDir)
                packages.push({ pkgDir, realTarget })
            } catch {
                // Ignore broken symlinks
            }
        }
    } catch {
        // Ignore missing or unreadable directories
    }

    PACKAGE_CACHE.set(folderPath, { timestamp: now, packages })
    return packages
}

/**
 * Collects unique candidate workspace folder paths, prioritizing `preferredFolder`.
 */
function getCandidateFolderPaths(preferredFolder?: Uri): string[] {
    const candidatePaths: string[] = []
    const seen = new Set<string>()

    if (preferredFolder?.scheme === 'file') {
        candidatePaths.push(preferredFolder.fsPath)
        seen.add(preferredFolder.fsPath)
    }

    for (const folder of workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === 'file' && !seen.has(folder.uri.fsPath)) {
            candidatePaths.push(folder.uri.fsPath)
            seen.add(folder.uri.fsPath)
        }
    }

    return candidatePaths
}

/**
 * Checks if `target` is equal to or located inside `base`.
 */
function isSameOrDescendant(base: string, target: string): boolean {
    const rel = path.relative(base, target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Maps a URI pointing into /nix/store/... back to its workspace symlink in .lake/packages/<pkg>/...
 */
export function mapStoreUriToPackageUri(uri: Uri, preferredFolder?: Uri): Uri {
    if (uri.scheme !== 'file' || !uri.fsPath.includes('/nix/store/')) {
        return uri
    }

    const targetPath = uri.fsPath
    const candidateFolders = getCandidateFolderPaths(preferredFolder)

    for (const folderPath of candidateFolders) {
        for (const { pkgDir, realTarget } of getLakePackages(folderPath)) {
            if (isSameOrDescendant(realTarget, targetPath)) {
                const rel = path.relative(realTarget, targetPath)
                return Uri.file(path.join(pkgDir, rel))
            }
        }
    }

    return uri
}

export function mapStoreExtUriToPackageExtUri(uri: ExtUri, preferredFolder?: ExtUri): ExtUri {
    if (uri.scheme !== 'file') {
        return uri
    }

    const folderUri = preferredFolder?.scheme === 'file' ? preferredFolder.asUri() : undefined
    const mapped = mapStoreUriToPackageUri(uri.asUri(), folderUri)

    // Preserve original reference if unchanged
    return mapped.fsPath === uri.fsPath ? uri : new FileUri(mapped.fsPath)
}

type LocationItem = Location | LocationLink

/**
 * Maps Definition or Location results from Nix store URIs back to workspace package URIs.
 */
export function mapLocationResult<T extends LocationItem | LocationItem[] | null | undefined>(
    res: T,
    preferredFolder?: Uri,
): T {
    if (!res) return res

    const mapItem = (loc: LocationItem): LocationItem => {
        if ('uri' in loc) {
            const mappedUri = mapStoreUriToPackageUri(loc.uri, preferredFolder)
            return mappedUri === loc.uri ? loc : new Location(mappedUri, loc.range)
        }

        if ('targetUri' in loc) {
            const mappedUri = mapStoreUriToPackageUri(loc.targetUri, preferredFolder)
            return mappedUri === loc.targetUri ? loc : { ...loc, targetUri: mappedUri }
        }

        return loc
    }

    if (Array.isArray(res)) {
        return res.map(mapItem) as T
    }

    return mapItem(res) as T
}
