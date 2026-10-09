import { isAbsolute, resolve } from 'path';

import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
    resolvedPath?: string;
}

export function validateWorkspaceInspectionPath(targetPath: string): PathValidationResult {
    const trimmedPath = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (!trimmedPath) {
        return {
            valid: false,
            error: 'candidatePath is required',
        };
    }
    if (trimmedPath.includes('\0')) {
        return {
            valid: false,
            error: 'Attached workspace candidate path contains invalid characters',
        };
    }
    if (!isAbsolute(trimmedPath)) {
        return {
            valid: false,
            error: 'Attached workspace candidate path must be absolute',
        };
    }

    return {
        valid: true,
        resolvedPath: resolve(trimmedPath),
    };
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
    accessPolicy?: FilesystemAccessPolicy,
): PathValidationResult {
    if (accessPolicy) {
        return authorizeFilesystemPath({
            targetPath,
            defaultDirectory: workingDirectory,
            accessPolicy,
            additionalAllowedDirs,
        });
    }

    if (!workingDirectory || typeof workingDirectory !== 'string') {
        return { valid: false, error: 'Access denied: Invalid working directory' };
    }

    return authorizeFilesystemPath({
        targetPath,
        defaultDirectory: workingDirectory,
        accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
        additionalAllowedDirs,
    });
}
