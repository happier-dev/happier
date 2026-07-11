import { createScmCapabilitiesFromBackendCapabilities } from '@happier-dev/plugin-sdk/scm';
import type {
    PluginApiV1,
    ScmBackendRuntimeRegistration,
} from '@happier-dev/plugin-sdk';

import { saplingChangeDiscard } from './operations/changeOperations.js';
import { saplingCommitBackout, saplingCommitCreate } from './operations/commitOperations.js';
import { saplingDiffCommit, saplingDiffFile, saplingLogList } from './operations/readOperations.js';
import { saplingRemoteFetch, saplingRemotePull, saplingRemotePush } from './operations/remoteOperations.js';
import { mapSaplingErrorCode } from './parsing/errorCodes.js';
import { SAPLING_SCM_BACKEND_CAPABILITIES } from './capabilities.js';
import { detectSaplingRepo, getSaplingSnapshot } from './repository.js';

export const SAPLING_SCM_BACKEND_ID = 'sapling';

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function classifySaplingPortableWorkspacePath(input: Readonly<{
    relativePath: string;
}>): 'non_portable' | 'unknown' {
    const normalized = normalizeRelativePath(input.relativePath);
    return normalized === '.sl' || normalized.startsWith('.sl/')
        ? 'non_portable'
        : 'unknown';
}

function isSaplingAdministrativeWorkspacePath(input: Readonly<{
    relativePath: string;
}>): boolean {
    return classifySaplingPortableWorkspacePath(input) === 'non_portable';
}

export function createSaplingScmBackendRegistration(): ScmBackendRuntimeRegistration {
    return {
        id: SAPLING_SCM_BACKEND_ID,
        handlers: {
            detection: {
                detectRepo: detectSaplingRepo,
                describeBackend({ context }) {
                    return {
                        success: true,
                        backendId: SAPLING_SCM_BACKEND_ID,
                        repoMode: context.detection.mode ?? undefined,
                        isRepo: context.detection.isRepo,
                        capabilities: createScmCapabilitiesFromBackendCapabilities(SAPLING_SCM_BACKEND_CAPABILITIES),
                    };
                },
            },
            read: {
                async statusSnapshot({ context }) {
                    try {
                        const snapshot = await getSaplingSnapshot({
                            cwd: context.cwd,
                            projectKey: context.projectKey,
                            detection: context.detection,
                        });
                        return {
                            success: true,
                            snapshot,
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error ?? 'Status snapshot failed');
                        return {
                            success: false,
                            error: message,
                            errorCode: mapSaplingErrorCode(message),
                        };
                    }
                },
                diffFile: saplingDiffFile,
                diffCommit: saplingDiffCommit,
                logList: saplingLogList,
            },
            changeSet: {
                discard: saplingChangeDiscard,
            },
            commit: {
                create: saplingCommitCreate,
                backout: saplingCommitBackout,
            },
            remote: {
                fetch: saplingRemoteFetch,
                pull: saplingRemotePull,
                push: saplingRemotePush,
            },
            workspaceIntegration: {
                isAdministrativeWorkspacePath: isSaplingAdministrativeWorkspacePath,
                classifyPortableWorkspacePath: classifySaplingPortableWorkspacePath,
                classifyPortableWorkspaceTransferEntry: classifySaplingPortableWorkspacePath,
            },
        },
    };
}

export function registerSaplingScmBackend(api: Pick<PluginApiV1, 'registerScmBackend'>): void {
    api.registerScmBackend(createSaplingScmBackendRegistration());
}
