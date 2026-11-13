import * as React from 'react';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { sessionExecutionRunList, type SessionExecutionRunListResult } from '@/sync/ops/sessionExecutionRuns';
import { storage } from '@/sync/domains/state/storage';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { isExecutionRunTargetUnavailable } from '@/sync/runtime/executionRuns/executionRunHeaderReads';
import {
    readRunningExecutionRunRoster,
    refreshRunningExecutionRunRoster,
    subscribeRunningExecutionRunRoster,
} from '@/sync/runtime/executionRuns/executionRunActivityBus';

export function resolveRunningExecutionRunsFromListResult(
    result: SessionExecutionRunListResult,
): readonly ExecutionRunPublicState[] {
    if (!('runs' in result)) return [];
    return result.runs.filter((run) => run.status === 'running');
}

/** Every demanded roster uses the same admitted list reader, including Inbox Follow sources. */
export async function readSessionRunningExecutionRuns(address: SessionAddress): Promise<readonly ExecutionRunPublicState[] | null> {
    const result = await sessionExecutionRunList(address.sessionId, {}, { serverId: address.serverId });
    // The list response is a loose object, so `ok === false` does not narrow `errorCode`.
    return result.ok === false
        ? isExecutionRunTargetUnavailable(typeof result.errorCode === 'string' ? result.errorCode : null) ? [] : null
        : resolveRunningExecutionRunsFromListResult(result);
}

/**
 * The Home sends live `execution-run-updated` hints to the Session's owner; a
 * collaborator (finite publication recipient) gets none until the Run's output
 * is published. Only a locally known owner row proves the push path.
 */
export function receivesSessionLiveRunActivity(address: SessionAddress): boolean {
    const state = storage.getState();
    const direct = state.sessions[address.sessionId];
    const session = findSessionListLookupSession(state, address)?.session
        ?? (direct && areServerProfileIdentifiersEquivalent(direct.serverId ?? getActiveServerSnapshot().serverId, address.serverId)
            ? direct : undefined);
    return session !== undefined && isSessionAccessOwner(session.access, session.accessLevel);
}

/** Every demanded roster subscribes through this one source: the list reader and its live-delivery fact. */
export function subscribeSessionRunningExecutionRunRoster(address: SessionAddress, listener: () => void): () => void {
    return subscribeRunningExecutionRunRoster(address, listener, () => readSessionRunningExecutionRuns(address),
        () => receivesSessionLiveRunActivity(address));
}

export function useSessionRunningExecutionRuns(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    enabled: boolean;
    refreshKey?: unknown;
}>): readonly ExecutionRunPublicState[] {
    // Legacy unqualified callers follow the existing active-Home owner. Never
    // share a roster by raw Session id, including while the Home is unavailable.
    const explicitServerId = params.serverId?.trim() || null;
    const subscribeServer = React.useCallback((listener: () => void) => (
        explicitServerId ? () => {} : subscribeActiveServer(listener)
    ), [explicitServerId]);
    const readServer = React.useCallback(() => explicitServerId ?? getActiveServerSnapshot().serverId, [explicitServerId]);
    const serverId = React.useSyncExternalStore(subscribeServer, readServer, readServer);
    const sessionId = normalizeSessionId(params.sessionId);
    const address = React.useMemo(
        () => params.enabled ? normalizeSessionAddress(serverId, sessionId) : null,
        [params.enabled, serverId, sessionId],
    );
    const subscribe = React.useCallback((listener: () => void) => {
        if (!address) return () => {};
        return subscribeSessionRunningExecutionRunRoster(address, listener);
    }, [address]);
    const read = React.useCallback(() => readRunningExecutionRunRoster(address), [address]);
    const runningRuns = React.useSyncExternalStore(subscribe, read, read);

    const previousRefresh = React.useRef({ address, key: params.refreshKey });
    React.useEffect(() => {
        const previous = previousRefresh.current;
        previousRefresh.current = { address, key: params.refreshKey };
        // A new address has already acquired its baseline in subscribe.
        if (!address || previous.address !== address || Object.is(previous.key, params.refreshKey)) return;
        refreshRunningExecutionRunRoster(address);
    }, [address, params.refreshKey]);

    return runningRuns;
}
