import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { deploymentNoticeIndexedKindV1 } from '@happier-dev/protocol/activity/accountNoticeArtifactKindsV1';
import { useArtifactInventoryRead } from '@/components/artifacts/useArtifactInventoryRead';
import { isArtifactInventoryLoaded, isArtifactInventoryReady } from '@/sync/domains/artifacts/artifactInventory';
import { readAccountNoticeListHeader, type AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { selectArtifactInventoryRows } from '@/sync/store/domains/artifactInventoryIndex';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

const NO_KINDS: readonly string[] = [];
const NO_NOTICES: readonly AccountNoticeArtifact[] = [];

/** Acquire the existing notice/page association from the Artifact owner, without opening bodies. */
export function useDeploymentNoticeHeaders(scope: ServerAccountScope | null, environmentId: string | null,
    active: boolean, deploymentId?: string) {
    const account = useAccountSettingsScope();
    const admitted = active && scope !== null && areServerAccountScopesEqual(account, scope) && environmentId !== null;
    const selection = React.useMemo(() => admitted && environmentId !== null
        ? [deploymentNoticeIndexedKindV1(environmentId, deploymentId)] : NO_KINDS, [admitted, environmentId, deploymentId]);
    const { failed, retry } = useArtifactInventoryRead(admitted, selection);
    const rows = storage(useShallow(state => admitted && areServerAccountScopesEqual(state.profileScope, scope)
        ? Object.values(selectArtifactInventoryRows(state, selection)) : []));
    const membership = storage(state => !admitted || !areServerAccountScopesEqual(state.profileScope, scope) ? 'idle'
        : isArtifactInventoryLoaded(state, selection) ? 'ready' : isArtifactInventoryReady(state, selection) ? 'partial' : 'loading');
    const items = React.useMemo(() => {
        if (!scope || rows.length === 0) return NO_NOTICES;
        return rows.flatMap(artifact => {
            if (artifact.sourceServerId !== scope.serverId) return [];
            const header = readAccountNoticeListHeader(artifact, scope.accountId);
            if (!header || header.source.kind !== 'host' || header.source.topic !== 'service_health'
                || !header.page || !('kind' in header.page)) return [];
            const environment = header.page.environment;
            return environment?.environmentId === environmentId && areServerProfileIdentifiersEquivalent(environment.serverId, scope.serverId)
                ? [{ artifact, header }] : [];
        }).sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt || a.artifact.id.localeCompare(b.artifact.id));
    }, [rows, scope?.serverId, scope?.accountId, environmentId]);
    return { items, membership, failed, retry };
}
