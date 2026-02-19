import { realpathSync } from 'fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
    resolvedPath?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @param additionalAllowedDirs - Extra absolute directories that are also permitted
 * @returns Validation result
 */
export function validatePath(
    targetPath: string,
    workingDirectory: string,
    additionalAllowedDirs?: ReadonlyArray<string>,
): PathValidationResult {
    if (!workingDirectory || typeof workingDirectory !== 'string') {
        return { valid: false, error: 'Access denied: Invalid working directory' };
    }

    // Resolve and realpath the working directory to ensure comparisons stay consistent on platforms
    // where e.g. /var is a symlink to /private/var (macOS).
    const resolvedWorkingDir = resolve(workingDirectory);
    const realWorkingDir = (() => {
        try {
            return realpathSync(resolvedWorkingDir);
        } catch {
            return resolvedWorkingDir;
        }
    })();

    // Resolve the target against the real working dir to keep it on the same canonical root.
    const resolvedTarget = resolve(realWorkingDir, targetPath);

    const resolvedExtraDirs = (additionalAllowedDirs ?? [])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => resolve(value));

    // Resolve symlinks for the target when possible to prevent traversal via symlinks.
    // If the file doesn't exist yet, validate based on the realpath of its parent directory.
    const resolveRealTarget = (): string => {
        try {
            return realpathSync(resolvedTarget);
        } catch {
            try {
                const parent = realpathSync(dirname(resolvedTarget));
                return resolve(parent, basename(resolvedTarget));
            } catch {
                return resolvedTarget;
            }
        }
    };

    const realTarget = resolveRealTarget();

    const allowedDirs = [realWorkingDir, ...resolvedExtraDirs].map((dir) => {
        try {
            return realpathSync(dir);
        } catch {
            // Directory may not exist yet (e.g., upload dir before first upload).
            return dir;
        }
    });

    for (const dir of allowedDirs) {
        const rel = relative(dir, realTarget);
        if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
            return { valid: true, resolvedPath: resolvedTarget };
        }
    }

    return {
        valid: false,
        error: `Access denied: Path '${targetPath}' is outside the allowed directories`,
    };
}
