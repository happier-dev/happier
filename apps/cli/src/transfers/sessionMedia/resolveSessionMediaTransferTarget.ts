import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

import {
    isDurableSessionMediaCategory,
    sessionMediaCategoryToDirectory,
    type SessionMediaCategory,
} from './sessionMediaCategories';
import {
    normalizeSessionMediaWorkspaceRelativeDir,
    type SessionMediaTransferConfig,
} from './sessionMediaConfig';

export type SessionMediaTransferTarget = Readonly<{
    uploadBasePath: string;
    additionalAllowedReadDirs: readonly string[];
    additionalAllowedWriteDirs: readonly string[];
}>;

export type ConfiguredSessionMediaTransferTargetResult =
    | Readonly<{
        success: true;
        target: SessionMediaTransferTarget;
        uploadBasePath: string;
    }>
    | Readonly<{
        success: false;
        target: SessionMediaTransferTarget;
        error: string;
    }>;

export function resolveSessionMediaTempUploadBasePath(temporaryDirectory = tmpdir()): string {
    return join(temporaryDirectory, 'happier', 'uploads');
}

export function resolveSessionMediaTransferTarget(input: Readonly<{
    config: SessionMediaTransferConfig;
    tempUploadRoot: string;
    category: SessionMediaCategory;
}>): SessionMediaTransferTarget {
    const directory = sessionMediaCategoryToDirectory(input.category);
    const workspaceRelativeDir =
        normalizeSessionMediaWorkspaceRelativeDir(input.config.workspaceRelativeDir)
        ?? input.config.workspaceRelativeDir.trim();

    if (input.config.uploadLocation === 'workspace') {
        return {
            uploadBasePath: join(workspaceRelativeDir, directory).replace(/[\\]+/g, '/'),
            additionalAllowedReadDirs: [],
            additionalAllowedWriteDirs: [],
        };
    }

    return {
        uploadBasePath: join(input.tempUploadRoot, directory),
        additionalAllowedReadDirs: [input.tempUploadRoot],
        additionalAllowedWriteDirs: [input.tempUploadRoot],
    };
}

export function resolveConfiguredSessionMediaTransferTarget(input: Readonly<{
    config: SessionMediaTransferConfig;
    tempUploadRoot: string;
    workingDirectory: string;
    category: SessionMediaCategory;
    accessPolicy?: FilesystemAccessPolicy;
}>): ConfiguredSessionMediaTransferTargetResult {
    const workspaceRelativeDir = normalizeSessionMediaWorkspaceRelativeDir(input.config.workspaceRelativeDir);
    const effectiveConfig = workspaceRelativeDir
        ? { ...input.config, workspaceRelativeDir }
        : input.config;
    const target = resolveSessionMediaTransferTarget({
        config: effectiveConfig,
        tempUploadRoot: input.tempUploadRoot,
        category: input.category,
    });
    if (!workspaceRelativeDir) {
        return {
            success: false,
            target,
            error: 'Invalid workspaceRelativeDir',
        };
    }

    if (isDurableSessionMediaCategory(input.category) && effectiveConfig.uploadLocation !== 'workspace') {
        return {
            success: false,
            target,
            error: `Session media category ${input.category} must use workspace storage`,
        };
    }

    const authorization = authorizeFilesystemPath({
        targetPath: target.uploadBasePath,
        defaultDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy ?? { kind: 'osUser' },
        additionalAllowedDirs: target.additionalAllowedWriteDirs,
    });
    if (!authorization.valid) {
        return {
            success: false,
            target,
            error: authorization.error,
        };
    }

    return {
        success: true,
        target,
        uploadBasePath: target.uploadBasePath,
    };
}
