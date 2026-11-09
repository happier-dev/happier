import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { useSessionServerId, useSessionHasExecutionRunSignals } from '@/sync/domains/state/storage';
import { sessionExecutionRunList } from '@/sync/ops/sessionExecutionRuns';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

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
    const supportScopeKey = resolvedSessionServerId
        ? sessionAddressKey({ serverId: resolvedSessionServerId, sessionId })
        : JSON.stringify(['legacy_unscoped_session', sessionId]);
    const [historicalSupport, setHistoricalSupport] = React.useState<Readonly<{
        scopeKey: string;
        supported: boolean;
    }> | null>(null);
    const historicalRunsSupported = historicalSupport?.scopeKey === supportScopeKey
        ? historicalSupport.supported
        : false;

    const hasLiveExecutionRunSupport = React.useMemo(() => {
        return Boolean(backends && typeof backends === 'object' && Object.keys(backends).length > 0);
    }, [backends]);

    React.useEffect(() => {
        if (executionRunsEnabled !== true) {
            return;
        }
        if (hasLiveExecutionRunSupport || transcriptHasExecutionRunSignals) {
            return;
        }
        const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!normalizedSessionId) {
            return;
        }

        let cancelled = false;
        void (async () => {
            const result = await sessionExecutionRunList(
                normalizedSessionId,
                {},
                resolvedSessionServerId ? { serverId: resolvedSessionServerId } : undefined,
            );
            if (cancelled) return;
            const runs = Array.isArray((result as any)?.runs) ? (result as any).runs : [];
            setHistoricalSupport({ scopeKey: supportScopeKey, supported: runs.length > 0 });
        })();

        return () => {
            cancelled = true;
        };
    }, [executionRunsEnabled, hasLiveExecutionRunSupport, resolvedSessionServerId, sessionId, supportScopeKey, transcriptHasExecutionRunSignals]);

    return React.useMemo(() => {
        if (executionRunsEnabled !== true) {
            return false;
        }
        return hasLiveExecutionRunSupport || transcriptHasExecutionRunSignals || historicalRunsSupported;
    }, [executionRunsEnabled, hasLiveExecutionRunSupport, historicalRunsSupported, transcriptHasExecutionRunSignals]);
}
