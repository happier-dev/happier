import { describe, expect, it } from 'vitest';

import { readNewSessionAttachmentDrafts } from '@/components/sessions/new/attachments/newSessionAttachmentDraftStore';
import { resolveNewSessionDraftAttachmentFlowId } from '@/components/sessions/new/attachments/newSessionDraftAttachmentFlowId';

import { prepareNewSessionFromShare } from './openNewSessionFromShare';

describe('prepareNewSessionFromShare', () => {
    it('seeds the draft attachment flow and routes to the new session with the prompt', () => {
        const route = prepareNewSessionFromShare({
            prompt: 'https://example.com',
            sources: [{ kind: 'native', uri: 'content://x/1', name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
        });
        expect(route.pathname).toBe('/new');
        expect(route.params.prompt).toBe('https://example.com');
        const drafts = readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(route.params.draftId));
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ status: 'pending', source: { uri: 'content://x/1' } });
    });

    it('omits the prompt param for a files-only share', () => {
        const route = prepareNewSessionFromShare({ prompt: undefined, sources: [] });
        expect('prompt' in route.params).toBe(false);
    });
});
