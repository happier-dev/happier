import { describe, expect, it, vi } from 'vitest';

import { sendTranscriptSelectionToSession } from './sendTranscriptSelectionToSession';
import type { SendTranscriptSelectionDestination } from './sendTranscriptSelectionToSession';
import type { TranscriptSelectionToolbarMessage } from './TranscriptSelectionToolbar';

const selectedMessages: ReadonlyArray<TranscriptSelectionToolbarMessage> = [
    { id: 'm1', role: 'user', text: 'Question' },
    { id: 'm2', role: 'assistant', text: 'Answer' },
];

describe('sendTranscriptSelectionToSession', () => {
    it('formats messages, appends to the destination draft, and then navigates', async () => {
        const chooseDestinationSessionId = vi.fn(async (): Promise<SendTranscriptSelectionDestination> => ({ kind: 'existingSession', sessionId: 'dest', serverId: 'server-b' }));
        const appendToDraft = vi.fn(async () => undefined);
        const openNewSession = vi.fn(async () => true);
        const navigateToSession = vi.fn();

        const result = await sendTranscriptSelectionToSession({
            sourceSessionId: 'source',
            sourceServerId: 'server-a',
            sourceMachineId: 'machine-a',
            sourceSessionName: 'Source session',
            selectedMessages,
            bulkCopyFormat: 'markdown_labeled',
            template: 'Review these from {{SOURCE_SESSION_NAME}}:\n\n{{MESSAGES}}',
            roleLabels: { user: 'You', assistant: 'Assistant' },
            chooseDestinationSessionId,
            appendToDraft,
            openNewSession,
            navigateToSession,
        });

        expect(result).toBe(true);
        const expectedPromptText = 'Review these from Source session:\n\n**You:**\n\nQuestion\n\n**Assistant:**\n\nAnswer';
        expect(chooseDestinationSessionId).toHaveBeenCalledWith({
            sourceSessionId: 'source',
            sourceServerId: 'server-a',
            previewText: expectedPromptText,
        });
        expect(appendToDraft).toHaveBeenCalledWith({
            sessionId: 'dest',
            serverId: 'server-b',
            text: expectedPromptText,
            sourceSessionId: 'source',
        });
        expect(openNewSession).not.toHaveBeenCalled();
        expect(navigateToSession).toHaveBeenCalledWith({ sessionId: 'dest', serverId: 'server-b' });
    });

    it('does nothing when the picker is cancelled', async () => {
        const appendToDraft = vi.fn(async () => undefined);
        const navigateToSession = vi.fn();

        const result = await sendTranscriptSelectionToSession({
            sourceSessionId: 'source',
            sourceServerId: 'server-a',
            sourceMachineId: 'machine-a',
            sourceSessionName: null,
            selectedMessages,
            bulkCopyFormat: 'plain',
            template: '{{MESSAGES}}',
            roleLabels: { user: 'You', assistant: 'Assistant' },
            chooseDestinationSessionId: vi.fn(async () => null),
            appendToDraft,
            openNewSession: vi.fn(async () => true),
            navigateToSession,
        });

        expect(result).toBe(false);
        expect(appendToDraft).not.toHaveBeenCalled();
        expect(navigateToSession).not.toHaveBeenCalled();
    });

    it('opens New Session through the canonical seed owner when the picker chooses a new session', async () => {
        const chooseDestinationSessionId = vi.fn(async (): Promise<SendTranscriptSelectionDestination> => ({ kind: 'newSession' }));
        const appendToDraft = vi.fn(async () => undefined);
        const openNewSession = vi.fn(async () => true);
        const navigateToSession = vi.fn();

        const result = await sendTranscriptSelectionToSession({
            sourceSessionId: 'source',
            sourceServerId: 'server-a',
            sourceMachineId: 'machine-a',
            sourceSessionName: null,
            selectedMessages,
            bulkCopyFormat: 'plain',
            template: '{{MESSAGES}}',
            roleLabels: { user: 'You', assistant: 'Assistant' },
            chooseDestinationSessionId,
            appendToDraft,
            openNewSession,
            navigateToSession,
        });

        expect(result).toBe(true);
        expect(openNewSession).toHaveBeenCalledWith({
            promptText: 'Question\n\nAnswer',
            sourceServerId: 'server-a',
            placement: {
                kind: 'exactTarget',
                serverId: 'server-a',
                machineId: 'machine-a',
            },
        });
        expect(appendToDraft).not.toHaveBeenCalled();
        expect(navigateToSession).not.toHaveBeenCalled();
    });

    it('does not fabricate a partial placement when the source machine is unavailable', async () => {
        const openNewSession = vi.fn(async () => true);

        await sendTranscriptSelectionToSession({
            sourceSessionId: 'source',
            sourceServerId: 'server-b',
            sourceMachineId: null,
            sourceSessionName: null,
            selectedMessages,
            bulkCopyFormat: 'plain',
            template: '{{MESSAGES}}',
            roleLabels: { user: 'You', assistant: 'Assistant' },
            chooseDestinationSessionId: vi.fn(async () => ({ kind: 'newSession' as const })),
            appendToDraft: vi.fn(async () => undefined),
            openNewSession,
            navigateToSession: vi.fn(),
        });

        expect(openNewSession).toHaveBeenCalledWith({
            promptText: 'Question\n\nAnswer',
            sourceServerId: 'server-b',
        });
    });
});
