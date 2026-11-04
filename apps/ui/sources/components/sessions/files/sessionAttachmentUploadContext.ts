import { sync } from '@/sync/sync';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Sync remains the owner of the admitted attachment carrier. */
export function readSessionAttachmentUploadContext(sessionId: string, scope: ServerAccountScope | null): ReturnType<typeof sync.getSessionAttachmentTransferContext> {
    return sync.getSessionAttachmentTransferContext(sessionId,
        scope ? { purpose: 'attachmentUpload', target: { ...scope, sessionId } } : undefined);
}
