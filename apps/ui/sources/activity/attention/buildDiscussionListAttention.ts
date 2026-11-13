import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import type { InboxItemAttentionTypeV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { OpenApprovalDiscussionAttention } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type DiscussionListAttention = Readonly<{
    attentionReason: 'draft_waiting' | 'approval_pending' | 'mentioned' | null;
    attentionType: InboxItemAttentionTypeV1 | null;
    approvalArtifactIds: readonly string[];
    /** A member Session's own status word, already classified by the Session attention owner. */
    word?: string;
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

/** Transient list projection over the Inbox approval owner, member Session attention and private mention cursor. */
export function buildDiscussionListAttention<T extends Pick<DiscussionOpenedSummaryV1, 'id' | 'unreadMentionCount' | 'participantSessionIds'>>(input: Readonly<{
    scope: ServerAccountScope;
    artifactScope: ServerAccountScope | null;
    artifactsLoaded: boolean;
    approvalEntries: readonly DiscussionApprovalAttentionFact[];
    items: readonly T[];
    /** Home-qualified rows from the canonical keyed Session-list subscription. */
    sessionRows?: ReadonlyMap<string, SessionListRenderableSession>;
    nowMs?: number;
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
    const memberAttention = new Map<string, WorkStatusPresentation>();
    const nowMs = input.nowMs ?? Date.now();
    for (const [key, session] of input.sessionRows ?? []) {
        const status = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(session, nowMs) });
        if (status.bucket === 'needs_you') memberAttention.set(key, status);
    }
    const before = new Map(previous.map(row => [row.id, row]));
    const rows = input.items.map(item => {
        const ids = approvals.get(item.id) ?? [];
        const waitingMember = (item.participantSessionIds ?? []).find(sessionId =>
            memberAttention.has(buildSessionListServerScopedRowKey(input.scope.serverId, sessionId)!));
        const sessionStatus = waitingMember
            ? memberAttention.get(buildSessionListServerScopedRowKey(input.scope.serverId, waitingMember)!) : undefined;
        const word = ids.length > 0 ? undefined : sessionStatus?.word;
        const attentionReason: DiscussionListAttention['attentionReason'] = drafts.has(item.id) ? 'draft_waiting' : ids.length ? 'approval_pending'
            : sessionStatus ? null : item.unreadMentionCount > 0 ? 'mentioned' : null;
        const attentionType: DiscussionListAttention['attentionType'] = ids.length > 0 ? 'approval'
            : sessionStatus?.attentionType ?? (item.unreadMentionCount > 0 ? 'mention' : null);
        const waitingSessionId = ids.length > 0 ? waitingSessions.get(item.id)?.sessionId ?? null : waitingMember ?? null;
        const old = before.get(item.id);
        if (old && old.attentionReason === attentionReason && old.attentionType === attentionType && old.word === word && old.approvalAttentionAvailable === available && old.waitingSessionId === waitingSessionId
            && old.approvalArtifactIds.length === ids.length && old.approvalArtifactIds.every((id, index) => id === ids[index])
            && Object.entries(item).every(([key, value]) => Reflect.get(old, key) === value)) return old;
        return { ...item, attentionReason, attentionType, word, approvalArtifactIds: ids, waitingSessionId, approvalAttentionAvailable: available };
    });
    return previous.length === rows.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
