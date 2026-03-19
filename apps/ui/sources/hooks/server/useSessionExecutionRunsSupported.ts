import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { useSessionMessages } from '@/sync/domains/state/storage';
import { sessionExecutionRunList } from '@/sync/ops/sessionExecutionRuns';
import { deriveExecutionRunPollingRefreshKey } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';

const EMPTY_EXECUTION_RUN_REFRESH_KEY = 'subagent:|started:|stopped:';

export function useSessionExecutionRunsSupported(sessionId: string): boolean {
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const backends = useExecutionRunsBackendsForSession(sessionId);
    const { messages } = useSessionMessages(sessionId);
    const [historicalRunsSupported, setHistoricalRunsSupported] = React.useState(false);

    const transcriptHasExecutionRunSignals = React.useMemo(() => {
        return deriveExecutionRunPollingRefreshKey(messages) !== EMPTY_EXECUTION_RUN_REFRESH_KEY;
    }, [messages]);

    const hasLiveExecutionRunSupport = React.useMemo(() => {
        return Boolean(backends && typeof backends === 'object' && Object.keys(backends).length > 0);
    }, [backends]);

    React.useEffect(() => {
        // Clear state immediately when sessionId changes to prevent stale state from previous session
        setHistoricalRunsSupported(false);

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
            const result = await sessionExecutionRunList(normalizedSessionId, {});
            if (cancelled) return;
            const runs = Array.isArray((result as any)?.runs) ? (result as any).runs : [];
            setHistoricalRunsSupported(runs.length > 0);
        })();

        return () => {
            cancelled = true;
        };
    }, [executionRunsEnabled, hasLiveExecutionRunSupport, sessionId, transcriptHasExecutionRunSignals]);

    return React.useMemo(() => {
        if (executionRunsEnabled !== true) {
            return false;
        }
        return hasLiveExecutionRunSupport || transcriptHasExecutionRunSignals || historicalRunsSupported;
    }, [executionRunsEnabled, hasLiveExecutionRunSupport, historicalRunsSupported, transcriptHasExecutionRunSignals]);
}
