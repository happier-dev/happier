/**
 * Resolves a path relative to the root path from metadata.
 * ALL paths are treated as relative to the metadata root, regardless of their format.
 * If metadata is not provided, returns the original path.
 * 
 * @param path - The path to resolve (always treated as relative to the metadata root)
 * @param metadata - Optional metadata containing the root path
 * @returns The resolved absolute path
 */
export { resolveToolPath as resolvePath } from "@happier-dev/session-core/tools";

/**
 * Resolves paths starting with ~ to absolute paths using the provided home directory.
 * Non-tilde paths are returned unchanged.
 * 
 * @param path - The path to resolve (may start with ~)
 * @param homeDir - The user's home directory (e.g., '/Users/steve' or 'C:\Users\steve')
 * @returns The resolved absolute path
 */
export function resolveAbsolutePath(path: string, homeDir?: string): string {
    // Return original path if it doesn't start with ~
    if (!path.startsWith('~')) {
        return path;
    }
    
    // Return original path if no home directory provided
    if (!homeDir) {
        return path;
    }
    
    // Handle exact ~ (home directory)
    if (path === '~') {
        // Remove trailing separator for consistency
        return homeDir.endsWith('/') || homeDir.endsWith('\\') 
            ? homeDir.slice(0, -1) 
            : homeDir;
    }
    
    // Handle ~/ and ~\ paths (home directory with subdirectory)
    if (path.startsWith('~/') || path.startsWith('~\\')) {
        const relativePart = path.slice(2); // Remove '~/' or '~\'
        // Detect path separator based on homeDir - prefer the last separator found
        const hasBackslash = homeDir.lastIndexOf('\\') > homeDir.lastIndexOf('/');
        const separator = hasBackslash ? '\\' : '/';
        const normalizedHome = homeDir.endsWith('/') || homeDir.endsWith('\\') 
            ? homeDir.slice(0, -1) 
            : homeDir;
        const normalizedRelativePart = relativePart
            .split(/[\\/]+/)
            .filter(Boolean)
            .join(separator);
        return normalizedRelativePart
            ? normalizedHome + separator + normalizedRelativePart
            : normalizedHome + separator;
    }
    
    // Handle ~username paths (not supported, return original)
    return path;
}

/** The last folder of an absolute path ("/home/dev/dp2-fixture" is "dp2-fixture"), or null for an empty path. */
export function leafFolderName(path: string | null | undefined): string | null {
    if (!path) return null;
    const segments = path.split(/[\\/]+/).filter(Boolean);
    return segments[segments.length - 1] ?? null;
}
