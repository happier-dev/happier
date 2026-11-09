import { snapshotReferenceSelectionKey } from '@/sync/domains/scope/snapshotReferenceSelectionKey';

/** Query identity shared by projection publication and its mounted consumer. */
export function modelProjectionScopeKey(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    agentTargetKey: string | null;
    mode?: 'picker' | 'management';
    selectionKey: string;
    sourceConnectionId?: string;
    favoriteKeys: readonly string[];
    teamCredentialResources?: readonly object[];
    /** Gathered arrays follow the admitted source bodies, independent of progress/presentation recomposition. */
    teamCredentialCatalogSources?: readonly (object | null | undefined)[];
    accountScopeKey: string | null;
    credentialKey: string | null;
}>): string {
    return JSON.stringify([input.enabled, input.machineId, input.agentTargetKey, input.mode ?? 'picker', input.selectionKey,
        input.sourceConnectionId ?? null, input.favoriteKeys,
        snapshotReferenceSelectionKey(input.teamCredentialCatalogSources ?? [input.teamCredentialResources]),
        input.accountScopeKey, input.credentialKey]);
}

