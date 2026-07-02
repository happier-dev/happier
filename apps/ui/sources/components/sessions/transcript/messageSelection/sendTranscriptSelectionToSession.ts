import type { SessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';

import { applySendToSessionTemplate } from './applySendToSessionTemplate';
import { formatSelectedMessagesForClipboard } from './formatSelectedMessagesForClipboard';
import type { TranscriptBulkCopyFormat } from './_types';
import type { TranscriptSelectionToolbarMessage } from './TranscriptSelectionToolbar';

export type SendTranscriptSelectionChooseDestinationInput = Readonly<{
    sourceSessionId: string;
    sourceServerId: string;
    previewText: string;
}>;

export type SendTranscriptSelectionDestination =
    | Readonly<{
        kind: 'existingSession';
        sessionId: string;
        serverId: string;
    }>
    | Readonly<{
        kind: 'newSession';
    }>;

export type SendTranscriptSelectionWriteInitialPromptInput = Readonly<{
    destinationSessionId: string;
    serverId: string;
    prompt: SessionInitialPromptV1;
}>;

export type SendTranscriptSelectionAppendNewSessionDraftInput = Readonly<{
    promptText: string;
    createdAtMs: number;
    sourceMessageIds: ReadonlyArray<string>;
    sourceSessionId: string;
    sourceServerId: string;
}>;

export async function sendTranscriptSelectionToSession(params: Readonly<{
    sourceSessionId: string;
    sourceServerId: string;
    sourceSessionName: string | null;
    selectedMessages: ReadonlyArray<TranscriptSelectionToolbarMessage>;
    bulkCopyFormat: TranscriptBulkCopyFormat;
    template: string;
    roleLabels: Readonly<{ user: string; assistant: string }>;
    nowMs: () => number;
    chooseDestinationSessionId: (input: SendTranscriptSelectionChooseDestinationInput) => Promise<SendTranscriptSelectionDestination | null>;
    writeInitialPrompt: (input: SendTranscriptSelectionWriteInitialPromptInput) => Promise<void>;
    appendNewSessionDraft: (input: SendTranscriptSelectionAppendNewSessionDraftInput) => void;
    navigateToSession: (input: Readonly<{ sessionId: string; serverId: string }>) => void;
    navigateToNewSession: () => void;
}>): Promise<boolean> {
    if (params.selectedMessages.length === 0) return false;
    const formattedMessages = formatSelectedMessagesForClipboard(params.selectedMessages, {
        format: params.bulkCopyFormat,
        roleLabels: params.roleLabels,
    });
    const promptText = applySendToSessionTemplate({
        template: params.template,
        formattedMessages,
        selectedCount: params.selectedMessages.length,
        sourceSessionName: params.sourceSessionName,
    });
    if (!promptText.trim()) return false;

    const destination = await params.chooseDestinationSessionId({
        sourceSessionId: params.sourceSessionId,
        sourceServerId: params.sourceServerId,
        previewText: promptText,
    });
    if (!destination) return false;

    const prompt: SessionInitialPromptV1 = {
        v: 1,
        text: promptText,
        mode: 'append',
        createdAtMs: params.nowMs(),
        sourceMessageIds: params.selectedMessages.map((message) => message.id),
        sourceSessionId: params.sourceSessionId,
    };

    if (destination.kind === 'newSession') {
        params.appendNewSessionDraft({
            promptText,
            createdAtMs: prompt.createdAtMs,
            sourceMessageIds: prompt.sourceMessageIds ?? [],
            sourceSessionId: params.sourceSessionId,
            sourceServerId: params.sourceServerId,
        });
        params.navigateToNewSession();
        return true;
    }

    await params.writeInitialPrompt({
        destinationSessionId: destination.sessionId,
        serverId: destination.serverId,
        prompt,
    });
    params.navigateToSession({ sessionId: destination.sessionId, serverId: destination.serverId });
    return true;
}
