import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connected-account-purposes';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { snapshotReferenceSelectionKey } from '@/sync/domains/scope/snapshotReferenceSelectionKey';

/** Query identity shared by projection publication and its mounted consumer. */
export function modelProjectionScopeKey(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    agentTargetKey: string | null;
    mode?: 'picker' | 'management';
    selectionKey: string;
    sourceConnectionId?: string;
    connectedServices?: ConnectedServiceBindingsV2;
    connectedAccountSourcePurpose?: QualifiedConnectedAccountPurposeV1;
    favoriteKeys: readonly string[];
    teamCredentialResources?: readonly object[];
    /** Gathered arrays follow the admitted source bodies, independent of progress/presentation recomposition. */
    teamCredentialCatalogSources?: readonly (object | null | undefined)[];
    accountScopeKey: string | null;
    credentialKey: string | null;
}>): string {
    return JSON.stringify([input.enabled, input.machineId, input.agentTargetKey, input.mode ?? 'picker', input.selectionKey,
        input.sourceConnectionId ?? null, input.connectedServices ? stableJsonStringify(input.connectedServices) : null,
        input.connectedAccountSourcePurpose ? qualifiedPurposeKey(input.connectedAccountSourcePurpose) : null, input.favoriteKeys,
        snapshotReferenceSelectionKey(input.teamCredentialCatalogSources ?? [input.teamCredentialResources]),
        input.accountScopeKey, input.credentialKey]);
}

