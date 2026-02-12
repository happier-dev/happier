import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmCapabilities, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type ScmUiPolicy = {
    supportsIncludeExclude: boolean;
    supportsLineSelection: boolean;
    changeSetModel: 'index' | 'working-copy';
    supportedDiffAreas: ScmDiffArea[];
};

export type ScmStatusSummary = {
    changedFiles: number;
    includedFiles: number;
    pendingFiles: number;
    untrackedFiles: number;
};

export type ScmRemoteTarget = {
    remote: string;
    branch: string | null;
};

export type ScmUiBackendPlugin = {
    id: 'git' | 'sapling';
    displayName: string;
    mapCapabilitiesToUiPolicy: (snapshot: ScmWorkingSnapshot | null) => ScmUiPolicy;
    diffModeConfig: (snapshot: ScmWorkingSnapshot | null) => {
        defaultMode: ScmDiffArea;
        availableModes: ScmDiffArea[];
        labels: Record<ScmDiffArea, string>;
    };
    commitActionConfig: (snapshot: ScmWorkingSnapshot | null) => {
        label: string;
        supportsPathScopedCommit: boolean;
        supportsLineSelection: boolean;
    };
    remoteActionConfig: (snapshot: ScmWorkingSnapshot | null) => {
        fetch: boolean;
        pull: boolean;
        push: boolean;
        confirmationCopy: string;
    };
    inferRemoteTarget: (snapshot: ScmWorkingSnapshot | null) => ScmRemoteTarget;
    errorNormalizer: (input: unknown) => string;
    statusSummaryMapper: (snapshot: ScmWorkingSnapshot | null) => ScmStatusSummary | null;
};

export function resolveChangeSetModel(capabilities: ScmCapabilities | null | undefined): 'index' | 'working-copy' {
    if (capabilities?.changeSetModel === 'index') return 'index';
    if (capabilities?.changeSetModel === 'working-copy') return 'working-copy';
    const includeExcludeSupported = capabilities?.writeInclude === true && capabilities?.writeExclude === true;
    return includeExcludeSupported ? 'index' : 'working-copy';
}

export function resolveSupportedDiffAreas(capabilities: ScmCapabilities | null | undefined): ScmDiffArea[] {
    if (capabilities?.supportedDiffAreas?.length) {
        return capabilities.supportedDiffAreas;
    }
    return resolveChangeSetModel(capabilities) === 'index'
        ? ['included', 'pending', 'both']
        : ['pending', 'both'];
}
