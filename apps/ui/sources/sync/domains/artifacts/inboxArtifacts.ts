import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestStatusSchema, ApprovalRequestV2StatusSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1,
    AccountNoticeArtifactHeaderV1Schema, UsageNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { normalizeAccountNoticeArtifactV1, projectOpenUsageNoticeHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { OwnedNoticeArtifactAdmissionV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

import { readOpenApprovalInboxAdmission, readOpenApprovalInboxEntry, listOpenApprovalInboxArtifactHydrationRequests,
    readListedOpenApproval, type ListedOpenApproval, type OpenApprovalInboxEntry } from './approvalArtifactAdmission';
import { readAccountNoticeArtifactAdmission, isOpenAccountNotice, isUnreadAccountNotice,
    type AccountNoticeArtifact, type OpenUsageNoticeArtifact } from './usageNoticeArtifacts';
import type { DecryptedArtifact } from './artifactTypes';
import { deleteInboxTree, getInboxTree, inboxTreeArray, inboxTreeSize, setInboxTree, type InboxTree } from './inboxArtifactTree';

const approvalKinds: readonly string[] = Object.values(APPROVAL_ARTIFACT_KINDS_V1);
const noticeKinds: readonly string[] = [ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1];
export const INBOX_ARTIFACT_KINDS: readonly string[] = Object.freeze([...approvalKinds, ...noticeKinds].sort());

/** Admission facts travel with the changed row; consumers never reclassify retained rows. */
export type InboxArtifactEntry = Readonly<{
    artifact: DecryptedArtifact;
    openApproval: OpenApprovalInboxEntry | null;
    noticeFamily: boolean;
    notice: AccountNoticeArtifact | null;
    usageNotice: OpenUsageNoticeArtifact | null;
    /**
     * An open approval known only from its header index; its body is not read yet. It counts (the
     * header is the index), but it is not a presentable row until a presenting consumer demands its body.
     */
    indexedOpenApproval: boolean;
    /** The open request as list surfaces present it, from header facts, whether or not its body is read. */
    listedApproval: ListedOpenApproval | null;
    complete: boolean;
}>;

/** The header index says open; the body (once read) must still agree before the row is presented. */
function isIndexedOpenApproval(artifact: DecryptedArtifact): boolean {
    return artifact.isDecrypted && artifact.body === undefined && artifact.header?.approvalStatus === 'open'
        && approvalKinds.includes(artifact.header.kind ?? '');
}

export function readInboxArtifactEntry(artifact: DecryptedArtifact): InboxArtifactEntry | null {
    if (artifact.draft) return null;
    const kind = artifact.header?.kind ?? artifact.kindHint;
    if ((typeof kind === 'string' && !INBOX_ARTIFACT_KINDS.includes(kind))
        || (artifact.isDecrypted && typeof kind !== 'string')) return null;
    const openApproval = readOpenApprovalInboxEntry(artifact);
    // The authenticated owner is a grouping key, not the active Account. The
    // source selects its own Account below, so switching scope cannot reuse a
    // notice admitted for a different owner.
    const noticeAdmission = readAccountNoticeArtifactAdmission(artifact, artifact.ownerAccountId);
    const header = noticeAdmission.kind === 'presented' ? normalizeAccountNoticeArtifactV1(noticeAdmission.notice) : null;
    const notice = header ? { artifact, header } : null;
    const usageHeader = header ? projectOpenUsageNoticeHeaderV1(header) : null;
    const complete = isInboxArtifactAdmissionComplete(artifact, artifact.ownerAccountId, noticeAdmission);
    if (complete && !openApproval && !notice) return null; // Settled receipts have no Inbox consumer.
    const indexedOpenApproval = !openApproval && isIndexedOpenApproval(artifact);
    return { artifact, openApproval, noticeFamily: typeof kind === 'string' && noticeKinds.includes(kind),
        notice, usageNotice: usageHeader ? { artifact, header: usageHeader } : null,
        indexedOpenApproval, listedApproval: openApproval || indexedOpenApproval ? readListedOpenApproval(artifact, openApproval) : null,
        complete };
}

export type InboxArtifactOrderChange = Readonly<{ previous?: InboxArtifactEntry; next?: InboxArtifactEntry }>;

type EntryKey = Readonly<{ entry: InboxArtifactEntry; ordinal: number }>;
type EntryTree<Value> = InboxTree<EntryKey, Value>;
type NoticeItems = Readonly<{
    all: EntryTree<AccountNoticeArtifact>;
    open: EntryTree<AccountNoticeArtifact>;
    usage: EntryTree<OpenUsageNoticeArtifact>;
    unread: number;
    incomplete: number;
}>;
type OrderState = Readonly<{
    entries: EntryTree<InboxArtifactEntry>;
    approvals: EntryTree<DecryptedArtifact>;
    notices: InboxTree<string, NoticeItems>;
    incomplete: number;
    indexedApprovals: number;
}>;

const EMPTY_NOTICES: NoticeItems = { all: null, open: null, usage: null, unread: 0, incomplete: 0 };
const EMPTY_ORDER: OrderState = { entries: null, approvals: null, notices: null, incomplete: 0, indexedApprovals: 0 };
const ORDER_STATE = Symbol('Inbox admitted order');
// A weak admission key preserves equal-time position across body revisions without scanning ties.
// Keys belong to admitted entries; the immutable trees retain their own key for each old snapshot.
const entryKeys = new WeakMap<InboxArtifactEntry, EntryKey>();
let nextOrdinal = 0;
const compareKeys = (left: EntryKey, right: EntryKey) =>
    right.entry.artifact.updatedAt - left.entry.artifact.updatedAt || left.ordinal - right.ordinal;
const compareOwners = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const artifactOf = (entry: InboxArtifactEntry) => entry.artifact;

function stateOf(order: readonly InboxArtifactEntry[]): OrderState {
    if (order.length === 0) return EMPTY_ORDER;
    // All nonempty orders are created here. The store resets with [] and has no other writer.
    return Reflect.get(order, ORDER_STATE) as OrderState;
}

function keyOf(entry: InboxArtifactEntry): EntryKey {
    const key = entryKeys.get(entry);
    if (!key) throw new Error('Inbox Artifact order lost an admitted entry');
    return key;
}

function patchEntry(state: OrderState, entry: InboxArtifactEntry, key: EntryKey, adding: boolean): OrderState {
    const patch = <Value>(tree: EntryTree<Value>, value: Value) => adding
        ? setInboxTree(tree, key, value, compareKeys) : deleteInboxTree(tree, key, compareKeys);
    const entries = patch(state.entries, entry);
    // Listed approvals: body-admitted, or open by the header index with the body not read yet.
    const approvals = entry.listedApproval ? patch(state.approvals, entry.artifact) : state.approvals;
    const owner = entry.artifact.ownerAccountId;
    const ownerIncomplete = entry.noticeFamily && owner !== undefined && !entry.complete;
    // An indexed open approval is counted from its header; only a presenting consumer awaits its body.
    const incomplete = state.incomplete + (!entry.complete && !ownerIncomplete && !entry.indexedOpenApproval ? (adding ? 1 : -1) : 0);
    const indexedApprovals = state.indexedApprovals + (entry.indexedOpenApproval ? (adding ? 1 : -1) : 0);
    let notices = state.notices;
    if (owner !== undefined && (entry.notice || ownerIncomplete)) {
        const previous = getInboxTree(notices, owner, compareOwners) ?? EMPTY_NOTICES;
        const next: NoticeItems = {
            all: entry.notice ? patch(previous.all, entry.notice) : previous.all,
            open: entry.notice && isOpenAccountNotice(entry.notice.header) ? patch(previous.open, entry.notice) : previous.open,
            usage: entry.usageNotice ? patch(previous.usage, entry.usageNotice) : previous.usage,
            unread: previous.unread + (entry.notice && isUnreadAccountNotice(entry.notice.header) ? (adding ? 1 : -1) : 0),
            incomplete: previous.incomplete + (ownerIncomplete ? (adding ? 1 : -1) : 0),
        };
        notices = !next.all && next.incomplete === 0 ? deleteInboxTree(notices, owner, compareOwners)
            : setInboxTree(notices, owner, next, compareOwners);
    }
    return { entries, approvals, notices, incomplete, indexedApprovals };
}

/**
 * The store's sole order/projection writer. Each changed admission patches balanced search paths;
 * retained rows and their projections are structurally shared. No whole-list copy or projection
 * is deferred to the shell's first reader. Equal-time revisions keep their original admission key.
 */
export function patchInboxArtifactOrder(order: readonly InboxArtifactEntry[],
    changes: readonly InboxArtifactOrderChange[]): readonly InboxArtifactEntry[] {
    if (changes.length === 0) return order;
    let state = stateOf(order);
    for (const { previous, next } of changes) {
        if (previous === next) continue;
        if (previous) state = patchEntry(state, previous, keyOf(previous), false);
        if (next) {
            const key: EntryKey = { entry: next, ordinal: previous && previous.artifact.updatedAt === next.artifact.updatedAt
                ? keyOf(previous).ordinal : ++nextOrdinal };
            entryKeys.set(next, key);
            state = patchEntry(state, next, key, true);
        }
    }
    return state === stateOf(order) ? order : inboxTreeArray(state.entries, undefined, { key: ORDER_STATE, value: state });
}

/**
 * How many of these rows the Inbox count includes, by the same rule as `projectInboxArtifactItems().count`:
 * every listed open request, plus the Account's own unread notices.
 */
export function countInboxArtifactRows(artifacts: readonly DecryptedArtifact[], accountId: string | null | undefined): number {
    let count = 0;
    for (const artifact of artifacts) {
        const entry = readInboxArtifactEntry(artifact);
        if (!entry) continue;
        if (entry.listedApproval) count += 1;
        else if (entry.notice && accountId && entry.artifact.ownerAccountId === accountId && isUnreadAccountNotice(entry.notice.header)) count += 1;
    }
    return count;
}

export type InboxArtifactItems = Readonly<{
    artifacts: readonly DecryptedArtifact[];
    /** Listed open requests (header index), newest first; a read body that disagrees removes its row. */
    openApprovals: readonly DecryptedArtifact[];
    accountNotices: readonly AccountNoticeArtifact[];
    openAccountNotices: readonly AccountNoticeArtifact[];
    openUsageNotices: readonly OpenUsageNoticeArtifact[];
    count: number;
    /** The count is certified (header index for approvals, strict body admission for notices). */
    complete: boolean;
    /** Open approval headers whose body is not read yet: counted, not yet presentable. */
    unreadApprovalBodies: number;
}>;

/**
 * Reads ingress-maintained projections. Counts and completeness need no retained-row visit;
 * indexed list views build only the rows a consumer reads and preserve unchanged list identity.
 */
export function projectInboxArtifactItems(order: readonly InboxArtifactEntry[], accountId: string | null | undefined,
    previous?: InboxArtifactItems | null): InboxArtifactItems {
    const state = stateOf(order);
    const owner = accountId === undefined || accountId === null ? EMPTY_NOTICES
        : getInboxTree(state.notices, accountId, compareOwners) ?? EMPTY_NOTICES;
    const notices = accountId ? owner : EMPTY_NOTICES;
    const next: InboxArtifactItems = { artifacts: inboxTreeArray(state.entries, artifactOf),
        openApprovals: inboxTreeArray(state.approvals), accountNotices: inboxTreeArray(notices.all),
        openAccountNotices: inboxTreeArray(notices.open), openUsageNotices: inboxTreeArray(notices.usage),
        count: inboxTreeSize(state.approvals) + notices.unread,
        complete: state.incomplete === 0 && owner.incomplete === 0, unreadApprovalBodies: state.indexedApprovals };
    return previous && (Object.keys(next) as (keyof InboxArtifactItems)[]).every(key => previous[key] === next[key]) ? previous : next;
}

type InboxArtifactHydrationRequest = Readonly<{
    artifactId: string; serverId: string; headerVersion: number; bodyVersion?: number;
}>;

/**
 * The existing exact-body owner admits the same families the Inbox's strict readers classify.
 * Approval bodies are requested only for a presenting consumer (`approvalBodies`); notice bodies
 * certify the unread count and are always requested.
 */
export function listInboxArtifactBodyHydrationRequests(artifacts: readonly DecryptedArtifact[],
    serverId: string | null | undefined, accountId: string | null | undefined,
    options: Readonly<{ approvalBodies: boolean }> = { approvalBodies: true }): readonly InboxArtifactHydrationRequest[] {
    const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
    const requests = new Map(options.approvalBodies ? listOpenApprovalInboxArtifactHydrationRequests(artifacts, serverId)
        .map(request => [request.artifactId, request]) : []);
    if (serverId && accountId) for (const artifact of artifacts) {
        if (artifact.draft || !artifact.isDecrypted || artifact.body !== undefined
            || !noticeKinds.includes(artifact.header?.kind ?? '') || artifact.header?.status !== 'open'
            || artifact.ownerAccountId !== accountId || artifact.access !== 'owner' || artifact.publicAudience !== 'none') continue;
        requests.set(artifact.id, { artifactId: artifact.id, serverId });
    }
    return [...requests.values()].map(request => ({ ...request,
        headerVersion: byId.get(request.artifactId)!.headerVersion, bodyVersion: byId.get(request.artifactId)!.bodyVersion,
    })).sort((left, right) => left.serverId.localeCompare(right.serverId) || left.artifactId.localeCompare(right.artifactId));
}

/** Membership alone cannot certify a count while a countable header lacks strict body admission. */
export function isInboxArtifactBodyAdmissionComplete(artifacts: readonly DecryptedArtifact[], accountId: string | null | undefined): boolean {
    return artifacts.every(artifact => isInboxArtifactAdmissionComplete(artifact, accountId));
}

function isInboxArtifactAdmissionComplete(artifact: DecryptedArtifact, accountId: string | null | undefined,
    noticeAdmission?: OwnedNoticeArtifactAdmissionV1): boolean {
        if (artifact.draft) return true;
        const kind = artifact.header?.kind ?? artifact.kindHint;
        // A newly admitted opaque legacy row may be an Inbox family even after
        // an earlier exact selection completed. Known other kinds stay excluded.
        if (!artifact.isDecrypted && typeof kind !== 'string') return false;
        if (typeof kind !== 'string' || !INBOX_ARTIFACT_KINDS.includes(kind)) return true;
        if (!artifact.isDecrypted || !artifact.header || artifact.header.kind !== kind) return false;
        if (approvalKinds.includes(kind)) {
            const status = kind === APPROVAL_ARTIFACT_KINDS_V1.targetAction ? TargetActionApprovalRequestV1Schema.shape.status
                : kind === APPROVAL_ARTIFACT_KINDS_V1.executionRunHostAction ? ApprovalRequestStatusSchema : ApprovalRequestV2StatusSchema;
            if (!status.safeParse(artifact.header.approvalStatus).success
                || (artifact.header.approvalStatus === 'open' && readOpenApprovalInboxAdmission(artifact).kind === 'unreadable')) return false;
        } else {
            // A known foreign/shared/public notice is not this Account's Inbox. Missing authority is unknown.
            if ((artifact.ownerAccountId !== undefined && artifact.ownerAccountId !== accountId)
                || (artifact.access !== undefined && artifact.access !== 'owner')
                || (artifact.publicAudience !== undefined && artifact.publicAudience !== 'none')) return true;
            const status = kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1 ? AccountNoticeArtifactHeaderV1Schema.shape.status
                : UsageNoticeArtifactHeaderV1Schema.shape.status;
            if (!status.safeParse(artifact.header.status).success
                || (artifact.header.status === 'open'
                    && (noticeAdmission ?? readAccountNoticeArtifactAdmission(artifact, accountId)).kind === 'unreadable')) return false;
        }
    return true;
}
