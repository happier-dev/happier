import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/sessions/composer/newSessionDraftRepositoryAdapter', () => ({
    writeNewSessionDraftToRepository: vi.fn(),
}));

import { appendTranscriptSelectionToNewSessionDraft } from './appendTranscriptSelectionToNewSessionDraft';

describe('appendTranscriptSelectionToNewSessionDraft', () => {
    it('creates a fresh exact repository draft targeting the source server', () => {
        const writeDraft = vi.fn();
        const scope = { serverId: 'server-a', accountId: 'account-a' };

        const draftId = appendTranscriptSelectionToNewSessionDraft({
            promptText: 'Forwarded transcript',
            sourceServerId: 'server-a',
            scope,
            nowMs: () => 456,
            createDraftId: () => 'draft-a',
            writeDraft,
        });

        expect(draftId).toBe('draft-a');
        expect(writeDraft).toHaveBeenCalledWith({
            scope,
            draftId: 'draft-a',
            draft: expect.objectContaining({
                input: 'Forwarded transcript',
                targetServerId: 'server-a',
                entryIntent: 'session',
            }),
        });
    });

    it('does not create a draft without account scope or meaningful text', () => {
        const writeDraft = vi.fn();
        expect(appendTranscriptSelectionToNewSessionDraft({
            promptText: ' ',
            sourceServerId: 'server-a',
            scope: { serverId: 'server-a', accountId: 'account-a' },
            writeDraft,
        })).toBeNull();
        expect(appendTranscriptSelectionToNewSessionDraft({
            promptText: 'Forwarded transcript',
            sourceServerId: 'server-a',
            scope: null,
            writeDraft,
        })).toBeNull();
        expect(writeDraft).not.toHaveBeenCalled();
    });
});
