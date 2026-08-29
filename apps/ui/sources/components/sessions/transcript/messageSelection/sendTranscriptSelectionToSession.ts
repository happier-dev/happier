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

export type SendTranscriptSelectionOpenNewSessionInput = Readonly<{
    promptText: string;
    sourceServerId: string;
    placement?: Readonly<{
        kind: 'exactTarget';
        serverId: string;
        machineId: string;
    }>;
}>;

export async function sendTranscriptSelectionToSession(params: Readonly<{
    sourceSessionId: string;
    sourceServerId: string;
    sourceMachineId: string | null;
    sourceSessionName: string | null;
    selectedMessages: ReadonlyArray<TranscriptSelectionToolbarMessage>;
    bulkCopyFormat: TranscriptBulkCopyFormat;
    template: string;
    roleLabels: Readonly<{ user: string; assistant: string }>;
    nowMs: () => number;
    chooseDestinationSessionId: (input: SendTranscriptSelectionChooseDestinationInput) => Promise<SendTranscriptSelectionDestination | null>;
    writeInitialPrompt: (input: SendTranscriptSelectionWriteInitialPromptInput) => Promise<void>;
    /** Opens New Session through its canonical seed/hydration owner. */
    openNewSession: (input: SendTranscriptSelectionOpenNewSessionInput) => Promise<boolean>;
    navigateToSession: (input: Readonly<{ sessionId: string; serverId: string }>) => void;
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
        return params.openNewSession({
            promptText,
            sourceServerId: params.sourceServerId,
            ...(params.sourceMachineId === null
                ? {}
                : {
                    placement: {
                        kind: 'exactTarget' as const,
                        serverId: params.sourceServerId,
                        machineId: params.sourceMachineId,
                    },
                }),
        });
    }

    await params.writeInitialPrompt({
        destinationSessionId: destination.sessionId,
        serverId: destination.serverId,
        prompt,
    });
    params.navigateToSession({ sessionId: destination.sessionId, serverId: destination.serverId });
    return true;
}
