import * as React from 'react';

import { useSessionServerId } from '@/sync/store/hooks';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';

/**
 * Registers the mounting surface as an explicit live-transcript consumer for `sessionId`.
 *
 * Use this in transcript-content surfaces that render a session's messages without going through the
 * main `SessionView` surface-visibility tracking (e.g. standalone message/tool detail and
 * execution-run detail routes on mobile / deep links). Without this, realtime projection routing
 * defers hidden durable messages and the open pane would show stale transcript content while the
 * session streams.
 */
export function useSessionRealtimeTranscriptConsumer(sessionId: string | null | undefined): void {
  const normalizedSessionId = String(sessionId ?? '').trim();
  const serverId = useSessionServerId(normalizedSessionId);

  React.useEffect(() => {
    if (!normalizedSessionId) return;
    const unregister = registerSessionRealtimeTranscriptConsumer(normalizedSessionId, serverId);
    return unregister;
  }, [normalizedSessionId, serverId]);
}
