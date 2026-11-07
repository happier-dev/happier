import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import type { InboxItemAttentionTypeV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { OpenApprovalDiscussionAttention } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type DiscussionListAttention = Readonly<{
    attentionReason: 'draft_waiting' | 'approval_pending' | 'mentioned' | null;
    attentionType: InboxItemAttentionTypeV1 | null;
    approvalArtifactIds: readonly string[];
    /** The Session behind the waiting draft or request, so its line can name who is waiting. */
    waitingSessionId: string | null;
    /** Other Homes' private Artifact inventory is never interpreted as an empty approval set. */
    approvalAttentionAvailable: boolean;
}>;
export type DiscussionListRow = DiscussionOpenedSummaryV1 & DiscussionListAttention;
/** What the list reads of an open approval's Discussion attention (`useDiscussionApprovalAttentionEntries`). */
export type DiscussionApprovalAttentionFact = Readonly<{
    artifact: Readonly<{ id: string }>;
    discussionAttention: OpenApprovalDiscussionAttention | null;
}>;

/** Transient list projection over the Inbox approval owner and the established private mention cursor. */
export function buildDiscussionListAttention<T extends Pick<DiscussionOpenedSummaryV1, 'id' | 'unreadMentionCount'>>(input: Readonly<{
    scope: ServerAccountScope;
    artifactScope: ServerAccountScope | null;
    artifactsLoaded: boolean;
    approvalEntries: readonly DiscussionApprovalAttentionFact[];
    items: readonly T[];
}>, previous: readonly (T & DiscussionListAttention)[] = []): readonly (T & DiscussionListAttention)[] {
    const sameScope = areServerAccountScopesEqual(input.scope, input.artifactScope);
    const available = input.artifactsLoaded && sameScope;
    const approvals = new Map<string, string[]>();
    const drafts = new Set<string>();
    // The Session whose request the line speaks of: the first draft when a draft is waiting, else the first request.
    const waitingSessions = new Map<string, Readonly<{ draft: boolean; sessionId: string | null }>>();
    // An admitted same-Home draft is actionable even while the census is incomplete.
    // Only interpreting absence requires complete membership.
    if (sameScope) for (const entry of input.approvalEntries) {
        const address = entry.discussionAttention;
        if (!address || !areServerProfileIdentifiersEquivalent(address.serverId, input.scope.serverId)) continue;
        const ids = approvals.get(address.discussionId) ?? [];
        ids.push(entry.artifact.id);
        approvals.set(address.discussionId, ids);
        if (address.reason === 'draft_waiting') drafts.add(address.discussionId);
        const draft = address.reason === 'draft_waiting';
        const named = waitingSessions.get(address.discussionId);
        if (!named || draft && !named.draft) waitingSessions.set(address.discussionId, { draft, sessionId: address.sessionId });
    }
    const before = new Map(previous.map(row => [row.id, row]));
    const rows = input.items.map(item => {
        const ids = approvals.get(item.id) ?? [];
        const attentionReason: DiscussionListAttention['attentionReason'] = drafts.has(item.id) ? 'draft_waiting' : ids.length ? 'approval_pending'
            : item.unreadMentionCount > 0 ? 'mentioned' : null;
        const attentionType: DiscussionListAttention['attentionType'] = ids.length > 0 ? 'approval' : item.unreadMentionCount > 0 ? 'mention' : null;
        const waitingSessionId = ids.length > 0 ? waitingSessions.get(item.id)?.sessionId ?? null : null;
        const old = before.get(item.id);
        if (old && old.attentionReason === attentionReason && old.attentionType === attentionType && old.approvalAttentionAvailable === available && old.waitingSessionId === waitingSessionId
            && old.approvalArtifactIds.length === ids.length && old.approvalArtifactIds.every((id, index) => id === ids[index])
            && Object.entries(item).every(([key, value]) => Reflect.get(old, key) === value)) return old;
        return { ...item, attentionReason, attentionType, approvalArtifactIds: ids, waitingSessionId, approvalAttentionAvailable: available };
    });
    return previous.length === rows.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
