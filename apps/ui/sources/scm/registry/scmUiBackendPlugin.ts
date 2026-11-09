import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';

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
    id: string;
    displayName: string;
    mapCapabilitiesToUiPolicy: (snapshot: ScmWorkingSnapshot | null) => ScmUiPolicy;
    diffModeConfig: (snapshot: ScmWorkingSnapshot | null) => {
        defaultMode: ScmDiffArea;
        availableModes: ScmDiffArea[];
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

    // Conservative fallback for legacy daemons.
    // Older CLI/daemon versions often support "included" and "pending" (or just "pending") but do NOT
    // implement a server-side "both" diff. Only surface "both" when explicitly advertised.
    return resolveChangeSetModel(capabilities) === 'index'
        ? ['included', 'pending']
        : ['pending'];
}

export function resolveScmUiPolicy(capabilities: ScmCapabilities | null | undefined): ScmUiPolicy {
    const supportsIncludeExclude = capabilities?.writeInclude === true
        && capabilities?.writeExclude === true;
    return {
        supportsIncludeExclude,
        supportsLineSelection: capabilities?.writeCommitLineSelection === true || supportsIncludeExclude,
        changeSetModel: resolveChangeSetModel(capabilities),
        supportedDiffAreas: resolveSupportedDiffAreas(capabilities),
    };
}

export function resolveScmCommitSelectionPolicy(capabilities: ScmCapabilities | null | undefined): Readonly<{
    supportsPathScopedCommit: boolean;
    supportsLineSelection: boolean;
}> {
    return {
        supportsPathScopedCommit: capabilities?.writeCommitPathSelection === true,
        supportsLineSelection: capabilities?.writeCommitLineSelection === true,
    };
}
