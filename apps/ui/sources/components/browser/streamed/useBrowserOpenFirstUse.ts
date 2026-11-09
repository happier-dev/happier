import * as React from 'react';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationAddressKey } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import {
    findLatestBrowserOpenOperation,
    needsBrowserOpenResult,
    projectBrowserOpenOperation,
    readBrowserOpenFirstUse,
    readBrowserOpenTargetUrl,
    type BrowserOpenFirstUse,
    type BrowserOpenFirstUseScope,
    type BrowserOpenOperationState,
} from '@/sync/domains/browser/firstUse/browserFirstUse';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { useArtifacts } from '@/sync/domains/state/storage';

const noopSubscribe = () => () => {};

/** Home, Account and Machine an open operation is read in; its Session and id narrow it further. */
type BrowserOpenAddress = Readonly<{ serverId: string; accountId: string; machineId: string }>;

/**
 * The exact settled open, fetched when the store only holds its list entry. Lists omit a settled
 * operation's result by design, so after a reload the typed outcome (sandbox unavailable) comes
 * from `get` on the bound operation, never from a guess.
 */
function useRecoveredBrowserOpen(snapshot: ActionOperationSnapshotV1 | null, address: BrowserOpenAddress | null): ActionOperationSnapshotV1 | null {
    const operationId = address && needsBrowserOpenResult(snapshot) ? snapshot?.operationId ?? null : null;
    const serverId = address?.serverId;
    const accountId = address?.accountId;
    const machineId = address?.machineId;
    const [recovered, setRecovered] = React.useState<ActionOperationSnapshotV1 | null>(null);
    React.useEffect(() => {
        if (!operationId || !serverId || !accountId || !machineId) return;
        let current = true;
        void getActionOperation({ machineId, serverId, accountId, operationId }).then((response) => {
            if (!current || response.kind !== 'found') return;
            const operation = response.operation;
            if (operation.operationId === operationId && operation.actionId === 'browser.view.open'
                && operation.scope.accountId === accountId && operation.scope.machineId === machineId) setRecovered(operation);
        }).catch(() => undefined);
        return () => { current = false; };
    }, [operationId, serverId, accountId, machineId]);
    return recovered && recovered.operationId === operationId ? recovered : null;
}

/** The Session's first-use state of the agent's browser, from the incumbent Action operation owner. */
export function useBrowserOpenFirstUse(scope: BrowserOpenFirstUseScope | null): BrowserOpenFirstUse | null {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const machineId = scope?.machineId;
    const sessionId = scope?.sessionId;
    const bound = serverId && accountId && machineId && sessionId ? { serverId, accountId, machineId, sessionId } : null;
    const readLatest = React.useCallback(
        () => (bound ? findLatestBrowserOpenOperation(actionOperationStore.getSnapshot(), bound) : null),
        [serverId, accountId, machineId, sessionId],
    );
    const latest = React.useSyncExternalStore(bound ? actionOperationStore.subscribe : noopSubscribe, readLatest, readLatest);
    const recovered = useRecoveredBrowserOpen(latest, bound);
    // The page the agent asked for is named by the open's approval receipt, which links to this operation.
    const artifacts = useArtifacts();
    const operationId = latest?.operationId ?? null;
    const targetUrl = React.useMemo(
        () => (operationId ? readBrowserOpenTargetUrl(artifacts, operationId) : null),
        [artifacts, operationId],
    );
    const firstUse = React.useMemo(
        () => (bound ? readBrowserOpenFirstUse(actionOperationStore.getSnapshot(), bound, recovered) : null),
        [latest, recovered, serverId, accountId, machineId, sessionId],
    );
    return React.useMemo(() => (firstUse && targetUrl ? { ...firstUse, targetUrl } : firstUse), [firstUse, targetUrl]);
}

/**
 * The live state of one open operation bound to its original Home, Account and Machine, for an
 * approval that carries the open's provisioning acceptance.
 */
export function useBoundBrowserOpenOperation(binding: (BrowserOpenAddress & Readonly<{ operationId: string }>) | null): BrowserOpenOperationState | null {
    const serverId = binding?.serverId;
    const accountId = binding?.accountId;
    const machineId = binding?.machineId;
    const operationId = binding?.operationId;
    const read = React.useCallback((): ActionOperationSnapshotV1 | null => {
        if (!serverId || !accountId || !machineId || !operationId) return null;
        const snapshot = actionOperationStore.getSnapshot().operationsByKey
            .get(actionOperationAddressKey({ serverId, operationId }))?.snapshot;
        return snapshot && snapshot.actionId === 'browser.view.open' && snapshot.scope.accountId === accountId
            && snapshot.scope.machineId === machineId ? snapshot : null;
    }, [serverId, accountId, machineId, operationId]);
    const snapshot = React.useSyncExternalStore(binding ? actionOperationStore.subscribe : noopSubscribe, read, read);
    const recovered = useRecoveredBrowserOpen(snapshot, binding);
    return React.useMemo(() => {
        const exact = recovered && snapshot && recovered.revision >= snapshot.revision ? recovered : snapshot;
        return exact ? projectBrowserOpenOperation(exact) : null;
    }, [recovered, snapshot]);
}
