import {
    buildQualifiedPluginContributionKey,
    PluginContributionIdentityV1Schema,
    type ScmDiffArea,
} from '@happier-dev/protocol';

import {
    getFirstPartyScmBackendLegacyLocalId,
    getFirstPartyScmBackendQualifiedId,
} from '@/scm/registry/firstPartyScmBackendIdentity';

export const SCM_GIT_REPO_BACKEND_OPTIONS = ['git', 'sapling'] as const;
export type ScmGitRepoPreferredBackend = (typeof SCM_GIT_REPO_BACKEND_OPTIONS)[number];

export const SCM_BACKEND_QUALIFIED_ID_MAX_LENGTH = 256;

export type ScmGitRepoBackendPreferenceSettingsDelta = Readonly<
    | {
        scmGitRepoPreferredBackend: ScmGitRepoPreferredBackend;
        scmGitRepoPreferredBackendQualifiedId: null;
    }
    | {
        scmGitRepoPreferredBackendQualifiedId: string;
    }
>;

export function normalizeScmGitRepoPreferredBackend(value: unknown): ScmGitRepoPreferredBackend {
    return value === 'sapling' ? 'sapling' : 'git';
}

export function normalizeScmBackendQualifiedId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > SCM_BACKEND_QUALIFIED_ID_MAX_LENGTH) return null;

    const separatorIndex = trimmed.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null;
    const identity = PluginContributionIdentityV1Schema.safeParse({
        pluginId: trimmed.slice(0, separatorIndex),
        localId: trimmed.slice(separatorIndex + 1),
    });
    if (!identity.success) return null;

    return buildQualifiedPluginContributionKey(identity.data);
}

export function resolveScmGitRepoPreferredBackendId(input: Readonly<{
    legacyPreference: unknown;
    qualifiedPreference: unknown;
}>): string {
    const qualifiedPreference = normalizeScmBackendQualifiedId(input.qualifiedPreference);
    if (qualifiedPreference) return qualifiedPreference;

    const legacyPreference = normalizeScmGitRepoPreferredBackend(input.legacyPreference);
    const qualifiedLegacyPreference = getFirstPartyScmBackendQualifiedId(legacyPreference);
    if (!qualifiedLegacyPreference) {
        throw new Error(`Missing first-party SCM backend identity for "${legacyPreference}"`);
    }
    return qualifiedLegacyPreference;
}

export function buildScmGitRepoBackendPreferenceSettingsDelta(
    backendId: unknown,
): ScmGitRepoBackendPreferenceSettingsDelta | null {
    if (typeof backendId !== 'string') return null;
    const trimmed = backendId.trim();
    const firstPartyLocalId = getFirstPartyScmBackendLegacyLocalId(trimmed)
        ?? SCM_GIT_REPO_BACKEND_OPTIONS.find((option) => option === trimmed)
        ?? null;

    if (firstPartyLocalId === 'git' || firstPartyLocalId === 'sapling') {
        return {
            scmGitRepoPreferredBackend: firstPartyLocalId,
            scmGitRepoPreferredBackendQualifiedId: null,
        };
    }

    const qualifiedId = normalizeScmBackendQualifiedId(trimmed);
    return qualifiedId
        ? { scmGitRepoPreferredBackendQualifiedId: qualifiedId }
        : null;
}

export const SCM_REMOTE_CONFIRM_POLICIES = ['always', 'pull_only', 'push_only', 'never'] as const;
export type ScmRemoteConfirmPolicy = (typeof SCM_REMOTE_CONFIRM_POLICIES)[number];

export const SCM_PUSH_REJECT_POLICIES = ['prompt_fetch', 'auto_fetch', 'manual'] as const;
export type ScmPushRejectPolicy = (typeof SCM_PUSH_REJECT_POLICIES)[number];

export const SCM_DIFF_MODE_OPTIONS = ['included', 'pending', 'both'] as const satisfies readonly ScmDiffArea[];
export type ScmDefaultDiffMode = (typeof SCM_DIFF_MODE_OPTIONS)[number];
