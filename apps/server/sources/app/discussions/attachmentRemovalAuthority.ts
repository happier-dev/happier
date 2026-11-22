/** Attachment withdrawal belongs to the message author and the Account charged for the bytes. */
export function viewerMayRemoveDiscussionAttachment(
    viewerAccountId: string, authorAccountId: string | null, discussionOwnerAccountId: string | null,
): boolean {
    return viewerAccountId === authorAccountId || viewerAccountId === discussionOwnerAccountId;
}
