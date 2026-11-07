import * as React from 'react';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import type { TriagePullRequestOperationsV1 } from '@happier-dev/triage-protocol/v1';
import { useTriagePullRequestPrimaryWriteV1, type TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';

import { executeTriageSessionPullRequestOperationV1 } from '../sessionPullRequestControls.js';
import { useTriageSessionPullRequestStatusV1, type TriageSessionPullRequestProjectionSnapshotV1 } from '../sessionPullRequestStatus.js';

const selectSnapshot = (snapshot: TriageSessionPullRequestProjectionSnapshotV1) => snapshot;

function admittedBinding(snapshot: TriageSessionPullRequestProjectionSnapshotV1, sessionId: string | null, bindingId: string | null) {
    if (snapshot.value?.kind !== 'ready' || snapshot.value.sessionId !== sessionId) return null;
    const matches = snapshot.value.pullRequests.filter(binding => binding.bindingId === bindingId);
    return matches.length === 1 ? matches[0]! : null;
}

function currentBinding(snapshot: TriageSessionPullRequestProjectionSnapshotV1, sessionId: string | null, bindingId: string | null) {
    return snapshot.freshness !== 'fresh' || snapshot.error || snapshot.subscription === 'ended'
        ? null : admittedBinding(snapshot, sessionId, bindingId);
}

/** The existing Resource owns reads; this hook binds original source choices to its mounted lifetime. */
export function usePullRequestOperationsV1(sessionId: string | null, bindingId: string | null, signal: AbortSignal): Readonly<{
    operations: TriagePullRequestOperationsV1 | undefined;
    primaryWrite: TriageDetailPrimaryWriteV1 | null;
    execute(operationId: string, variantId?: string): Promise<unknown>;
}> {
    const host = usePluginHostApi();
    const text = usePluginTranslation();
    const resource = useTriageSessionPullRequestStatusV1(selectSnapshot, sessionId !== null && bindingId !== null);
    const binding = currentBinding(resource.value, sessionId, bindingId);
    const scope = admittedBinding(resource.value, sessionId, bindingId);
    const native = binding?.nativeStatus;
    const operations = native?.kind === 'current' && binding?.entry ? native.value.operations : undefined;
    const scopedNative = scope?.nativeStatus;
    // Finite native mutations belong to the captured presentation/caller lifetime.
    const request = React.useMemo(() => new AbortController(), [sessionId, bindingId, signal]);
    React.useEffect(() => {
        const abort = () => request.abort();
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        return () => { signal.removeEventListener('abort', abort); abort(); };
    }, [request, signal]);
    const execute = React.useCallback(async (operationId: string, variantId?: string) => {
        if (!binding || request.signal.aborted) return { kind: 'unavailable', reason: 'operationUnavailable' } as const;
        return executeTriageSessionPullRequestOperationV1(host, {
            binding, operationId,
            ...(variantId === undefined ? {} : { variantId }),
        }, { signal: request.signal });
    }, [binding, request, host]);
    const refresh = React.useCallback(async () => {
        await resource.refresh();
        const current = currentBinding(resource.getSnapshot(), sessionId, bindingId);
        return current?.nativeStatus.kind === 'current';
    }, [resource.refresh, resource.getSnapshot, sessionId, bindingId]);
    // Retained admitted facts keep uncertain feedback and explicit re-read reachable after a read failure.
    // They never authorize execution: both the adapter and execute check the current Resource envelope.
    const displayedOperations = scopedNative && scopedNative.kind !== 'unavailable' && scope?.entry
        ? scopedNative.value.operations : undefined;
    const { primaryWrite } = useTriagePullRequestPrimaryWriteV1({ operations: displayedOperations, nativeStatus: scopedNative,
        ...(binding === null ? { unavailableReason: text('plugins.triage.prGlance.readFailed',
            'Couldn’t read this session’s pull request') } : {}),
        execute, signal: request.signal, refresh });
    return React.useMemo(() => ({ operations, primaryWrite, execute }), [operations, primaryWrite, execute]);
}
