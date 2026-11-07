import type { Message } from '@happier-dev/session-core/messages';
import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

import { readInboxReadySessionMessage } from '@/activity/presentation/buildInboxReadySessionResult';
import { runSessionMessagesPagePipeline } from './sessionMessagesPagePipeline';

type PageParams = Parameters<typeof runSessionMessagesPagePipeline>[0];

/** A result preview consumes one anchored reply, without moving the transcript's window or cursors. */
export async function fetchAndApplySessionResultPreview(params: Omit<PageParams,
    'purpose' | 'page' | 'lifecyclePolicy' | 'onMessagesPage' | 'onTaskLifecycleEvent'
> & Readonly<{ turn: SessionTurnV1 | null; messages?: readonly Message[] }>): Promise<void> {
    if (readInboxReadySessionMessage(params.turn, params.messages)) return;
    const seq = params.turn?.transcriptAnchors?.finalAssistantMessageSeq;
    if (typeof seq !== 'number') return;
    // The existing preview selects one final assistant message. Its anchor supplies the read size,
    // rather than borrowing a full transcript page or imposing a separate preview text budget.
    const limit = 1;
    const beforeSeq = seq + 1;
    await runSessionMessagesPagePipeline({
        ...params,
        purpose: 'target-window',
        page: { direction: 'older', scope: 'main', limit, beforeSeq,
            requestPath: buildSessionMessagesPath({ sessionId: params.sessionId, scope: 'main', limit, beforeSeq }) },
        lifecyclePolicy: 'suppress',
    });
}
