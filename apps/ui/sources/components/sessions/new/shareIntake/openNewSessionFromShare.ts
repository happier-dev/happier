import { randomUUID } from '@/platform/randomUUID';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { resolveNewSessionDraftAttachmentFlowId } from '@/components/sessions/new/attachments/newSessionDraftAttachmentFlowId';
import { writeNewSessionAttachmentDrafts } from '@/components/sessions/new/attachments/newSessionAttachmentDraftStore';

import type { NewSessionShare } from './mapShareIntentToNewSession';

// Seeds a fresh new-session draft with the shared content and returns its route. The composer already
// reads attachment drafts for `draft:<draftId>` on mount, so no extra route param is needed.
export function prepareNewSessionFromShare(share: NewSessionShare): Readonly<{
    pathname: '/new';
    params: Readonly<{ draftId: string; draftOrigin: 'ordinary'; prompt?: string }>;
}> {
    const draftId = randomUUID();
    if (share.sources.length > 0) {
        const drafts: AttachmentDraft[] = share.sources.map((source) => ({
            id: randomUUID(),
            source,
            status: 'pending',
        }));
        writeNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(draftId), drafts);
    }
    return {
        pathname: '/new',
        params: share.prompt === undefined
            ? { draftId, draftOrigin: 'ordinary' }
            : { draftId, draftOrigin: 'ordinary', prompt: share.prompt },
    };
}
