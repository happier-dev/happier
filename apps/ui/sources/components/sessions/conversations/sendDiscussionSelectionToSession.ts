import {
    SessionDiscussionSelectionSourceV1Schema,
    type SessionDiscussionSelectionSourceV1,
} from '@happier-dev/protocol/sessions/discussions/content';

import { applySendToSessionTemplate } from '@/components/sessions/transcript/messageSelection/applySendToSessionTemplate';
import type { SessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';

type SendSelectionSource = Omit<SessionDiscussionSelectionSourceV1, 'draftCorrelationId'>;

/**
 * Fixed-parent specialization of the canonical selection-to-Session initial-prompt handoff.
 * The initial-prompt consumer owns append/currentness; this function never enqueues input.
 */
export async function sendDiscussionSelectionToSession(params: Readonly<{
    sessionId: string;
    serverId: string;
    selectedText: string;
    source: SendSelectionSource;
    template: string;
    sourceSessionName: string | null;
    nowMs: () => number;
    writeInitialPrompt: (input: Readonly<{
        destinationSessionId: string;
        serverId: string;
        prompt: SessionInitialPromptV1;
    }>) => Promise<void>;
    revealPrimaryComposer: () => void | Promise<void>;
    focusPrimaryComposer: () => boolean | void | Promise<boolean | void>;
}>): Promise<boolean> {
    const sourceResult = SessionDiscussionSelectionSourceV1Schema
        .omit({ draftCorrelationId: true })
        .safeParse(params.source);
    if (!sourceResult.success || sourceResult.data.sessionId !== params.sessionId) return false;
    const promptText = applySendToSessionTemplate({
        template: params.template,
        formattedMessages: params.selectedText,
        selectedCount: sourceResult.data.messageIds.length,
        sourceSessionName: params.sourceSessionName,
    });
    if (!promptText.trim()) return false;

    await params.writeInitialPrompt({
        destinationSessionId: params.sessionId,
        serverId: params.serverId,
        prompt: {
            v: 1,
            text: promptText,
            mode: 'append',
            createdAtMs: params.nowMs(),
            source: sourceResult.data,
        },
    });
    await params.revealPrimaryComposer();
    await params.focusPrimaryComposer();
    return true;
}
