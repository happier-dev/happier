import { describe, expect, it, vi } from 'vitest';

import { appendTranscriptSelectionToNewSessionDraft } from './appendTranscriptSelectionToNewSessionDraft';

describe('appendTranscriptSelectionToNewSessionDraft', () => {
    it('seeds a fresh exact-address draft instead of mutating another open draft', () => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        const writeNewSessionDraft = vi.fn();
        const flushSessionDraft = vi.fn(async () => ({ status: 'clean' as const }));

        const draftId = appendTranscriptSelectionToNewSessionDraft({
            promptText: 'Forwarded transcript',
            sourceServerId: 'server-a',
            scope,
            createDraftId: () => '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            writeNewSessionDraft,
            flushSessionDraft,
        });

        expect(draftId).toBe('8e0a5dd1-b1df-43dd-b51e-b7787b30362e');
        expect(writeNewSessionDraft).toHaveBeenCalledWith({
            scope,
            draftId,
            patch: {
                text: 'Forwarded transcript',
                authoring: {
                    targetType: 'new_session',
                    serverId: 'server-a',
                },
            },
            materializationIntent: 'seeded',
        });
        expect(flushSessionDraft).toHaveBeenCalledWith({
            scope,
            address: { kind: 'newSession', draftId },
        });
    });

    it('does not create an address for empty content or without an account scope', () => {
        const writeNewSessionDraft = vi.fn();
        expect(appendTranscriptSelectionToNewSessionDraft({
            promptText: '   ',
            sourceServerId: 'server-a',
            scope: { serverId: 'server-a', accountId: 'account-a' },
            writeNewSessionDraft,
        })).toBeNull();
        expect(appendTranscriptSelectionToNewSessionDraft({
            promptText: 'Forwarded transcript',
            sourceServerId: 'server-a',
            scope: null,
            writeNewSessionDraft,
        })).toBeNull();
        expect(writeNewSessionDraft).not.toHaveBeenCalled();
    });
});
