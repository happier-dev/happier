import { isAbsolute, relative, resolve, sep } from 'path';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
    resolvedPath?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    if (!workingDirectory || typeof workingDirectory !== 'string') {
        return { valid: false, error: 'Access denied: Invalid working directory' };
    }

    // Resolve both paths to absolute paths to handle path traversal attempts.
    const resolvedWorkingDir = resolve(workingDirectory);
    const resolvedTarget = resolve(resolvedWorkingDir, targetPath);

    // Use a separator-agnostic check so this works across platforms.
    const rel = relative(resolvedWorkingDir, resolvedTarget);

    // If the relative path is outside (../..) or absolute, it's not within the allowed root.
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return {
            valid: false,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    return { valid: true, resolvedPath: resolvedTarget };
}
