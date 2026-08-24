import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    clearAllNewSessionAttachmentDrafts,
    subscribeNewSessionAttachmentDrafts,
    readNewSessionAttachmentDrafts,
    writeNewSessionAttachmentDrafts,
} from './newSessionAttachmentDraftStore';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';

describe('newSessionAttachmentDraftStore', () => {
    beforeEach(() => {
        clearAllNewSessionAttachmentDrafts();
    });

    it('keeps drafts after a navigation-length idle gap', () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const drafts: readonly AttachmentDraft[] = [{
            id: 'draft-1',
            source: {
                kind: 'native',
                uri: 'file:///tmp/note.txt',
                name: 'note.txt',
                sizeBytes: 12,
                mimeType: 'text/plain',
            },
            status: 'pending',
        }];

        try {
            writeNewSessionAttachmentDrafts('flow-1', drafts);
            nowSpy.mockReturnValue(1_000 + 30 * 60 * 1000);

            expect(readNewSessionAttachmentDrafts('flow-1')).toEqual([
                expect.objectContaining({
                    id: 'draft-1',
                    source: expect.objectContaining({ name: 'note.txt' }),
                }),
            ]);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('notifies derived consumers when a draft attachment problem changes', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeNewSessionAttachmentDrafts(listener);
        try {
            writeNewSessionAttachmentDrafts('flow-1', [{
                id: 'draft-1',
                source: { kind: 'native', uri: 'file:///tmp/note.txt', name: 'note.txt' },
                status: 'error',
                error: 'upload failed',
            }]);
            expect(listener).toHaveBeenCalledOnce();
        } finally {
            unsubscribe();
        }
    });

});
