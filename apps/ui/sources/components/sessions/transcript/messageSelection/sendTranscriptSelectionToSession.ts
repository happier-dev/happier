import type { SessionDraftTextAppend } from '@/components/sessions/composer/sessionDraftAppendAction';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { applySendToSessionTemplate } from './applySendToSessionTemplate';
import { formatSelectedMessagesForClipboard } from './formatSelectedMessagesForClipboard';
import type { TranscriptBulkCopyFormat } from './_types';
import type { TranscriptSelectionToolbarMessage } from './TranscriptSelectionToolbar';

export type SendTranscriptSelectionChooseDestinationInput = Readonly<{
    sourceSessionId: string;
    sourceServerId: string;
    previewText: string;
    /** How many messages travel, for the picker's "these N messages" sentence. */
    selectedCount: number;
}>;

export type SendTranscriptSelectionDestination =
    | Readonly<{
        kind: 'existingSession';
        sessionId: string;
        serverId: string;
    }>
    | Readonly<{
        kind: 'newSession';
    }>
    /** Several Sessions chosen with Select: one bulk composer owns sending to them. */
    | Readonly<{
        kind: 'bulk';
        targets: readonly SessionAddress[];
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
    chooseDestinationSessionId: (input: SendTranscriptSelectionChooseDestinationInput) => Promise<SendTranscriptSelectionDestination | null>;
    appendToDraft: (input: SessionDraftTextAppend) => Promise<void>;
    /** Opens New Session through its canonical seed/hydration owner. */
    openNewSession: (input: SendTranscriptSelectionOpenNewSessionInput) => Promise<boolean>;
    /** Opens the bulk composer aimed at the chosen Sessions with the formatted text as its message. */
    openBulkComposer: (input: Readonly<{ targets: readonly SessionAddress[]; text: string }>) => void;
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
        selectedCount: params.selectedMessages.length,
    });
    if (!destination) return false;

    if (destination.kind === 'bulk') {
        if (destination.targets.length === 0) return false;
        params.openBulkComposer({ targets: destination.targets, text: promptText });
        return true;
    }

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

    await params.appendToDraft({
        sessionId: destination.sessionId,
        serverId: destination.serverId,
        text: promptText,
        sourceSessionId: params.sourceSessionId,
    });
    params.navigateToSession({ sessionId: destination.sessionId, serverId: destination.serverId });
    return true;
}
