import * as React from 'react';
import { DiscussionAttachmentRemovedV1Schema } from '@happier-dev/protocol/discussions/attachments';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { confirmRemoveDiscussionFile } from '@/components/storage/storageConfirmations';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readRegisteredDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { t } from '@/text';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';

/** One committed Discussion file, as a storage item names it (its message triple) and the view shows it. */
export type DiscussionFileRemoval = Readonly<{
    discussionId: string;
    messageId: string;
    blobId: string;
    name: string;
    bytes: number;
    /** The Discussion's name when the caller has it; the confirmation says "the message" otherwise. */
    discussionTitle: string | null;
    /** The viewer wrote the message. */
    own: boolean;
}>;

/**
 * Remove a committed Discussion file through `discussion.attachment.remove` on the mounted Action execution, after the
 * shared confirmation (as the shipped Artifact delete is). Callers offer it only where the storage item's
 * `viewerMayRemove` admits it; the server decides again at the Action. Both storage views (the Account's and a
 * Discussion's) remove through this one path.
 */
export function useRemoveDiscussionFile(scope: ServerAccountScope | null, onChanged?: () => void) {
    const mounted = useMountedActionExecution(scope, { retainInvocation: true });
    const [busy, setBusy] = React.useState(false);
    const run = React.useCallback(async (file: DiscussionFileRemoval) => {
        if (!scope || busy) return;
        const confirmed = await confirmRemoveDiscussionFile({ name: file.name, discussionTitle: file.discussionTitle, own: file.own,
            freesBytes: file.bytes });
        if (!confirmed) return;
        setBusy(true);
        try {
            const result = await mounted.execute('discussion.attachment.remove',
                { discussionId: file.discussionId, messageId: file.messageId, blobId: file.blobId }, { confirmed: true });
            if (!result.ok) { alertActionFailure({ reason: t('artifacts.deleteError'), code: result.errorCode ?? null }); return; }
            const removal = DiscussionAttachmentRemovedV1Schema.safeParse(result.result);
            if (removal.success) {
                readRegisteredDiscussionRepository(scope, { serverId: scope.serverId })
                    ?.recordAttachmentRemoval(file.discussionId, file.messageId, removal.data);
            }
            onChanged?.();
        } finally { setBusy(false); }
    }, [busy, mounted, onChanged, scope]);
    return { busy, run };
}
