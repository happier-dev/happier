import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';

import {
    clearAllNewSessionAttachmentDrafts,
    readNewSessionAttachmentDrafts,
    writeNewSessionAttachmentDrafts,
} from './newSessionAttachmentDraftStore';

function createDraft(id: string): AttachmentDraft {
    return {
        id,
        source: {
            kind: 'native',
            uri: `file:///tmp/${id}.txt`,
            name: `${id}.txt`,
            sizeBytes: 12,
            mimeType: 'text/plain',
        },
        status: 'pending',
    };
}

describe('newSessionAttachmentDraftStore', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
        clearAllNewSessionAttachmentDrafts();
    });

    afterEach(() => {
        clearAllNewSessionAttachmentDrafts();
        vi.useRealTimers();
    });

    it('keeps drafts for the browser app lifetime instead of expiring by time', () => {
        writeNewSessionAttachmentDrafts('flow-a', [createDraft('draft-a')]);

        vi.setSystemTime(new Date('2026-02-06T00:00:00.000Z'));

        expect(readNewSessionAttachmentDrafts('flow-a')).toEqual([expect.objectContaining({
            id: 'draft-a',
        })]);
    });

    it('evicts the oldest flows when the draft store reaches its count cap', () => {
        for (let index = 0; index < 51; index += 1) {
            vi.setSystemTime(new Date(Date.UTC(2026, 1, 5, 0, 0, index)));
            writeNewSessionAttachmentDrafts(`flow-${index}`, [createDraft(`draft-${index}`)]);
        }

        expect(readNewSessionAttachmentDrafts('flow-0')).toEqual([]);
        expect(readNewSessionAttachmentDrafts('flow-1')).toEqual([expect.objectContaining({
            id: 'draft-1',
        })]);
        expect(readNewSessionAttachmentDrafts('flow-50')).toEqual([expect.objectContaining({
            id: 'draft-50',
        })]);
    });
});
