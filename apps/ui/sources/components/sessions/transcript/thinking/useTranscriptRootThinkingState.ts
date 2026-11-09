import * as React from 'react';
import {
    readSessionLatestThinkingMessageActivityAtMs,
    useSessionLatestThinkingMessageActivity,
    useSessionLatestThinkingMessageId,
    useSetting,
} from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import {
    isThinkingActivityFresh,
    resolveActiveThinkingMessageIdFromFreshness,
} from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';

export function useTranscriptRootThinkingState(params: Readonly<{
    latestCommittedActivityKey: string | null;
    sessionId: string;
    sessionThinking: boolean;
}>) {
    const { latestCommittedActivityKey, sessionId, sessionThinking } = params;
    const latestThinkingMessageId = useSessionLatestThinkingMessageId(sessionId);
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());
    // Each thinking delta restamps the activity time; the root subscribes only to whether it is fresh.
    const thinkingActivityFresh = useSessionLatestThinkingMessageActivity(sessionId,
        (activityAtMs) => isThinkingActivityFresh(activityAtMs, thinkingPulseNow, staleMs));

    React.useEffect(() => {
        if (sessionThinking !== true || !thinkingActivityFresh) return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        let timer: ReturnType<typeof setTimeout> | null = null;
        // The deadline follows the latest stamp, read when the previous deadline arrives.
        const arm = () => {
            const activityAtMs = readSessionLatestThinkingMessageActivityAtMs(sessionId);
            if (typeof activityAtMs !== 'number') return;
            const now = Date.now();
            if (!isThinkingActivityFresh(activityAtMs, now, staleMs)) {
                setThinkingPulseNow(now);
                return;
            }
            timer = setTimeout(arm, activityAtMs + staleMs - now + 1);
        };
        arm();
        return () => { if (timer !== null) clearTimeout(timer); };
    }, [sessionId, sessionThinking, staleMs, thinkingActivityFresh]);

    return React.useMemo(() => resolveActiveThinkingMessageIdFromFreshness({
        sessionThinking,
        latestThinkingMessageId,
        latestCommittedMessageId: latestCommittedActivityKey,
        thinkingActivityFresh,
    }), [latestCommittedActivityKey, latestThinkingMessageId, sessionThinking, thinkingActivityFresh]);
}
