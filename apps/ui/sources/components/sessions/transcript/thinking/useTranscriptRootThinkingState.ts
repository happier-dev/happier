import * as React from 'react';
import { useSessionLatestThinkingMessageActivityAtMs, useSessionLatestThinkingMessageId, useSetting } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';

export function useTranscriptRootThinkingState(params: Readonly<{
    latestCommittedActivityKey: string | null;
    sessionId: string;
    sessionThinking: boolean;
}>) {
    const { latestCommittedActivityKey, sessionId, sessionThinking } = params;
    const latestThinkingMessageId = useSessionLatestThinkingMessageId(sessionId);
    const latestThinkingMessageActivityAtMs = useSessionLatestThinkingMessageActivityAtMs(sessionId);
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (sessionThinking !== true) return;
        if (typeof latestThinkingMessageActivityAtMs !== 'number') return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        const staleAt = latestThinkingMessageActivityAtMs + staleMs;
        const delayMs = staleAt - Date.now();
        if (delayMs <= 0) return;

        const t = setTimeout(() => setThinkingPulseNow(Date.now()), delayMs);
        return () => clearTimeout(t);
    }, [latestThinkingMessageActivityAtMs, sessionThinking, staleMs]);

    return React.useMemo(() => {
        return resolveActiveThinkingMessageId({
            sessionThinking,
            latestThinkingMessageId,
            latestCommittedMessageId: latestCommittedActivityKey,
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestCommittedActivityKey, latestThinkingMessageActivityAtMs, latestThinkingMessageId, sessionThinking, staleMs, thinkingPulseNow]);
}
