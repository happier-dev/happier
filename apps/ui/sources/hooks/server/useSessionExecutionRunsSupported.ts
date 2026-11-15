import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { useSessionServerId, useSessionHasExecutionRunSignals } from '@/sync/domains/state/storage';
import { subscribeSessionRunningExecutionRunRoster } from '@/hooks/session/useSessionRunningExecutionRuns';
import { readRunningExecutionRunRosterSnapshot } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

export function useSessionExecutionRunsSupported(sessionId: string, sessionServerId?: string | null): boolean {
    const storedSessionServerId = useSessionServerId(sessionId);
    const explicitServerId = typeof sessionServerId === 'string' && sessionServerId.trim().length > 0
        ? sessionServerId.trim()
        : null;
    const preferredSessionServerId = usePreferredServerIdForSession({
        serverId: explicitServerId ?? storedSessionServerId,
        sessionId,
    });
    const resolvedSessionServerId = preferredSessionServerId;
    const executionRunsEnabled = useFeatureEnabled(
        'execution.runs',
        resolvedSessionServerId ? { scopeKind: 'spawn', serverId: resolvedSessionServerId } : undefined,
    );
    const backends = useExecutionRunsBackendsForSession(sessionId, resolvedSessionServerId);
    const transcriptScopeMatches = !resolvedSessionServerId || !storedSessionServerId
        || areServerProfileIdentifiersEquivalent(storedSessionServerId, resolvedSessionServerId);
    const transcriptHasExecutionRunSignals = useSessionHasExecutionRunSignals(sessionId, transcriptScopeMatches);
    const hasLiveExecutionRunSupport = React.useMemo(() => {
        return Boolean(backends && typeof backends === 'object' && Object.keys(backends).length > 0);
    }, [backends]);

    // Historical support is a fact of the Session's Run list. Read it from the canonical
    // demanded roster, so every mounted reader of one Session shares one list read.
    // An unqualified Session follows the active Home, as the roster's other readers do.
    const subscribeServer = React.useCallback((listener: () => void) => (
        resolvedSessionServerId ? () => {} : subscribeActiveServer(listener)
    ), [resolvedSessionServerId]);
    const readServer = React.useCallback(
        () => resolvedSessionServerId ?? getActiveServerSnapshot().serverId,
        [resolvedSessionServerId],
    );
    const historyServerId = React.useSyncExternalStore(subscribeServer, readServer, readServer);
    const historyAddress = React.useMemo(() => (
        executionRunsEnabled === true && !hasLiveExecutionRunSupport && !transcriptHasExecutionRunSignals
            ? normalizeSessionAddress(historyServerId, sessionId)
            : null
    ), [executionRunsEnabled, hasLiveExecutionRunSupport, historyServerId, sessionId, transcriptHasExecutionRunSignals]);
    const subscribeHistory = React.useCallback((listener: () => void) => (
        historyAddress ? subscribeSessionRunningExecutionRunRoster(historyAddress, listener) : () => {}
    ), [historyAddress]);
    const readHistory = React.useCallback(
        () => historyAddress !== null && readRunningExecutionRunRosterSnapshot(historyAddress).hasRuns,
        [historyAddress],
    );
    const historicalRunsSupported = React.useSyncExternalStore(subscribeHistory, readHistory, readHistory);

    return React.useMemo(() => {
        if (executionRunsEnabled !== true) {
            return false;
        }
        return hasLiveExecutionRunSupport || transcriptHasExecutionRunSignals || historicalRunsSupported;
    }, [executionRunsEnabled, hasLiveExecutionRunSupport, historicalRunsSupported, transcriptHasExecutionRunSignals]);
}
