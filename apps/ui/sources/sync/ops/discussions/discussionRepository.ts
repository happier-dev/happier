import type {
    SessionDraftAddressV2} from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type {
    DiscussionCreateResultV1,
    DiscussionDetailsResultV1,
    DiscussionListInputV1,
    DiscussionListResultV1,
    DiscussionOpenedMessageV1,
    DiscussionOpenedSummaryV1,
    DiscussionPostResultV1,
    DiscussionReadStateResultV1,
} from '@happier-dev/protocol/discussions/actions';
import type {
    DiscussionMessageContentV1} from '@happier-dev/protocol/discussions/content';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionDraftCurrentness } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { createDiscussionClient, DiscussionClientOutcome, DiscussionPostOutcome } from '@/sync/api/discussions/discussionActions';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { watchMountedDiscussions, type DiscussionMessageChanges, type MountedDiscussionChangeWatch } from '@/sync/domains/discussions/discussionChangeWatch';
import type { DiscussionAnchorV1, DiscussionReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';
import type { DiscussionCreateInputV1 } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionInitialParticipantV1 } from '@happier-dev/protocol/discussions/participants';
import type { DiscussionAttachmentRemovedV1 } from '@happier-dev/protocol/discussions/attachments';
import { DISCUSSION_NOT_TRACKED_CODE_V1 } from '@happier-dev/protocol/discussions/api';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import type { DiscussionAttentionResultV1 } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionAttentionQueryV1 } from '@happier-dev/protocol/discussions/api';
import { classifyAccountActorLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { DISCUSSION_ITEM_COMMENT_ANCHOR_KINDS_V1, matchesDiscussionListAnchorKindV1 } from '@happier-dev/protocol/discussions/listing/discussionListFilterV1';
import type { PreparedAttachmentSource } from '@/sync/domains/attachments/prepareAttachmentPayloads';

export type DiscussionRepositoryClient = Readonly<Pick<ReturnType<typeof createDiscussionClient>,
    'participants' | 'setParticipantPolicy' | 'invite' | 'inviteExecutableParticipant' | 'removeParticipant' | 'leave' | 'transferOwner' | 'listGrants' | 'setGrant' | 'removeGrant' | 'getSettings' | 'setSettings'> & {
    attention(input?: DiscussionAttentionQueryV1, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionAttentionResultV1>>;
    list(input?: DiscussionListInputV1, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionListResultV1>>;
    get(discussionId: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionDetailsResultV1>>;
    read: ReturnType<typeof createDiscussionClient>['read'];
    create(input: Readonly<{ creationLocalId: string; messageLocalId: string; title: string; content: DiscussionMessageContentV1; mentionedAccountIds?: readonly string[]; mentionedSessionIds?: readonly string[]; anchor?: DiscussionAnchorV1; participants?: readonly NonNullable<DiscussionCreateInputV1['participants']>[number][]; onResolvedParticipants?: (participants: readonly DiscussionInitialParticipantV1[]) => void; replyTarget?: DiscussionReplyTargetV1; attachmentSources?: readonly PreparedAttachmentSource[] }>, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionCreateResultV1>>;
    post(input: Readonly<{ discussionId: string; localId: string; content: DiscussionMessageContentV1; mentionedAccountIds?: readonly string[]; mentionedSessionIds?: readonly string[]; replyTarget?: DiscussionReplyTargetV1; attachmentSources?: readonly PreparedAttachmentSource[] }>, signal?: AbortSignal): Promise<DiscussionPostOutcome>;
    rename(discussionId: string, title: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionDetailsResultV1>>;
    archive(discussionId: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionDetailsResultV1>>;
    restore(discussionId: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionDetailsResultV1>>;
    readState(discussionId: string, lastReadSeq: number, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionReadStateResultV1>>;
}>;

export type DiscussionRepositoryStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'locked' | 'error' | 'revoked';
export type DiscussionMutationStatus = 'sending' | 'checking' | 'outcome_unknown' | 'approval_pending' | 'failed' | 'observed_success';
/**
 * How a settled failure can be left behind: a transient failure keeps its
 * identity for an explicit retry, a definitive refusal is dismissed and the
 * retained draft is sent again as a fresh attempt.
 */
export type DiscussionMutationRecovery = 'retry' | 'dismiss';

export type DiscussionDraftSubmission = Readonly<{
    scope: ServerAccountScope;
    address: Extract<SessionDraftAddressV2, { kind: 'discussion' | 'newDiscussion' }>;
    currentness: SessionDraftCurrentness;
}>;

type CreateIntent = Readonly<{
    kind: 'create';
    creationLocalId: string;
    messageLocalId: string;
    title: string;
    content: DiscussionMessageContentV1;
    mentionedAccountIds?: readonly string[];
    mentionedSessionIds?: readonly string[];
    anchor?: DiscussionAnchorV1;
    participants?: readonly NonNullable<DiscussionCreateInputV1['participants']>[number][];
    replyTarget?: DiscussionReplyTargetV1;
    draftSubmission: DiscussionDraftSubmission;
    /** Process-local capture only; mutation snapshots persist immutable content descriptors. */
    attachmentSources?: readonly PreparedAttachmentSource[];
}>;

type PostIntent = Readonly<{
    kind: 'post';
    discussionId: string;
    localId: string;
    content: DiscussionMessageContentV1;
    mentionedAccountIds?: readonly string[];
    mentionedSessionIds?: readonly string[];
    replyTarget?: DiscussionReplyTargetV1;
    draftSubmission: DiscussionDraftSubmission;
    attachmentSources?: readonly PreparedAttachmentSource[];
}>;

type MutationIntent = CreateIntent | PostIntent;

export type DiscussionRepositoryMutation = Readonly<{
    kind: MutationIntent['kind'];
    localId: string;
    messageLocalId?: string;
    discussionId?: string;
    status: DiscussionMutationStatus;
    artifactId?: string;
    errorCode?: string;
    failureCause?: ActionFailureCauseV1;
    recovery?: DiscussionMutationRecovery;
    content: DiscussionMessageContentV1;
    mentionedAccountIds?: readonly string[];
    mentionedSessionIds?: readonly string[];
    draftSubmission: DiscussionDraftSubmission;
}>;

/** A dismissable refusal keeps its reason visible but no longer holds the composer. */
export function discussionMutationBlocksComposer(mutation: DiscussionRepositoryMutation | null): boolean {
    return mutation !== null && !(mutation.status === 'failed' && mutation.recovery === 'dismiss');
}

type ListPage = Readonly<{
    requestCursor: string | null;
    rows: readonly DiscussionOpenedSummaryV1[];
    nextCursor: string | null;
    incomplete: boolean;
}>;

// Session, Doc and item comment lists share retained pages and invalidation.
export const ITEM_COMMENTS_DISCUSSION_LIST_SCOPE = Object.freeze({ commentsOnItems: true } as const);
type DocListAnchor = Readonly<{ anchorDocArtifactId: string }>;
export type DiscussionListScope = string | DocListAnchor | typeof ITEM_COMMENTS_DISCUSSION_LIST_SCOPE;
type ListAnchor = DiscussionListScope;
const isDocListAnchor = (anchor?: ListAnchor): anchor is DocListAnchor => typeof anchor === 'object' && 'anchorDocArtifactId' in anchor;
const listAnchorKey = (anchor: ListAnchor) => JSON.stringify(typeof anchor === 'string' ? ['session', anchor]
    : isDocListAnchor(anchor) ? ['doc', anchor.anchorDocArtifactId] : ['itemComments']);
function listAnchorInput(anchor?: ListAnchor): Pick<DiscussionListInputV1, 'anchorSessionId' | 'anchorDocArtifactId' | 'anchorKinds'> {
    if (anchor === undefined) return {};
    if (typeof anchor === 'string') return { anchorSessionId: anchor };
    if (isDocListAnchor(anchor)) return anchor;
    return { anchorKinds: [...DISCUSSION_ITEM_COMMENT_ANCHOR_KINDS_V1] };
}
function matchesListAnchor(row: DiscussionOpenedSummaryV1, anchor?: ListAnchor): boolean {
    if (typeof anchor === 'string') return row.anchor?.kind === 'session' && row.anchor.sessionId === anchor;
    if (isDocListAnchor(anchor)) return row.anchor?.kind === 'doc' && row.anchor.doc.ref.artifactId === anchor.anchorDocArtifactId && row.archivedAt === null;
    return matchesDiscussionListAnchorKindV1(row.anchor?.kind, anchor ? DISCUSSION_ITEM_COMMENT_ANCHOR_KINDS_V1 : undefined);
}

export type DiscussionRepositoryListSnapshot = Readonly<{
    items: readonly DiscussionOpenedSummaryV1[];
    nextCursor: string | null;
    status: DiscussionRepositoryStatus;
    errorCode: string | null;
    incomplete: boolean;
}>;

/** Search only opened display facts. Message bodies, ciphertext and opaque ids are never inputs. */
export function selectDiscussionListSearch(
    list: DiscussionRepositoryListSnapshot,
    query: string,
    sourceLabels: ReadonlyMap<string, readonly string[]>,
    previous?: DiscussionRepositoryListSnapshot,
): DiscussionRepositoryListSnapshot {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return list;
    const matches = list.items.filter(row => [row.title,
        ...(row.participantAccounts ?? []).flatMap(actor => {
            const classification = classifyAccountActorLabelV1(actor, false);
            return classification.kind === 'profile' ? [classification.label, actor.profile?.username] : [];
        }),
        ...(sourceLabels.get(row.id) ?? []),
    ].some(label => label?.toLocaleLowerCase().includes(needle)));
    const sameItems = (items: readonly DiscussionOpenedSummaryV1[]) => items.length === matches.length
        && items.every((row, index) => row === matches[index]);
    const items = previous && sameItems(previous.items) ? previous.items : sameItems(list.items) ? list.items : matches;
    const incomplete = list.incomplete || list.nextCursor !== null || list.status !== 'ready';
    if (previous && previous.items === items && previous.incomplete === incomplete && previous.status === list.status
        && previous.nextCursor === list.nextCursor && previous.errorCode === list.errorCode) return previous;
    return items === list.items && incomplete === list.incomplete ? list : { ...list, items, incomplete };
}

export type DiscussionRepositoryThreadSnapshot = Readonly<{
    summary: DiscussionOpenedSummaryV1 | null;
    /** AccountChange revision admitted by the shared exact-summary reader. */
    changeRevision?: number;
    messages: readonly DiscussionOpenedMessageV1[];
    hasMoreOlder: boolean;
    /** The oldest ordinary history-page row; independently opened rows do not advance paging. */
    oldestHistorySeq?: number;
    newestHistorySeq?: number;
    messageSeq: number;
    status: DiscussionRepositoryStatus;
    errorCode: string | null;
    incomplete: boolean;
}>;

/**
 * Whether a query has any archived Discussion at all. `unknown` is the
 * honest answer before a read settles and after one is refused; a reader must
 * never present it as emptiness.
 */
export type DiscussionArchivedExistence = 'unknown' | 'empty' | 'present';

export type DiscussionRepositoryCollectionSnapshot = Readonly<{
    lists: Readonly<Record<'active' | 'archived', DiscussionRepositoryListSnapshot>>;
    archivedExistence: DiscussionArchivedExistence;
}>;

export type DiscussionRepositorySnapshot = DiscussionRepositoryCollectionSnapshot & Readonly<{
    address: Readonly<{ serverId: string }>;
    anchors: Readonly<Record<string, DiscussionRepositoryCollectionSnapshot>>;
    threads: Readonly<Record<string, DiscussionRepositoryThreadSnapshot>>;
    mutations: Readonly<Record<string, DiscussionRepositoryMutation>>;
    attention: DiscussionRepositoryAttentionSnapshot;
}>;

export type DiscussionRepositoryAttentionSnapshot = Readonly<{
    discussions: DiscussionAttentionResultV1['discussions'];
    nextCursor: string | null;
    status: DiscussionRepositoryStatus;
    errorCode: string | null;
    incomplete: boolean;
}>;

export type DiscussionRepositoryMutationOutcome<T> =
    | Readonly<{ kind: 'succeeded'; value: T }>
    | Readonly<{ kind: 'checking' }>
    | Readonly<{ kind: 'approval_request_created'; artifactId: string }>
    | Readonly<{ kind: 'failed'; errorCode: string }>;

export type DiscussionReadStateWriteOutcome =
    | Readonly<{ kind: 'succeeded'; lastReadSeq: number }>
    | Readonly<{ kind: 'retryable'; errorCode: string }>
    | Readonly<{ kind: 'stopped'; errorCode: string }>;

const EMPTY_LIST: DiscussionRepositoryListSnapshot = Object.freeze({ items: [], nextCursor: null, status: 'idle', errorCode: null, incomplete: false });
const EMPTY_ATTENTION: DiscussionRepositoryAttentionSnapshot = Object.freeze({ discussions: [], nextCursor: null,
    status: 'idle', errorCode: null, incomplete: false });
const EMPTY_COLLECTION: DiscussionRepositoryCollectionSnapshot = Object.freeze({
    lists: Object.freeze({ active: EMPTY_LIST, archived: EMPTY_LIST }), archivedExistence: 'unknown',
});

function emptyThread(): DiscussionRepositoryThreadSnapshot {
    return { summary: null, messages: [], hasMoreOlder: false, messageSeq: 0, status: 'idle', errorCode: null, incomplete: false };
}

function hasSameThreadFacts(
    previous: DiscussionRepositoryThreadSnapshot,
    next: DiscussionRepositoryThreadSnapshot,
): boolean {
    const previousKeys = Object.keys(previous) as (keyof DiscussionRepositoryThreadSnapshot)[];
    const nextKeys = Object.keys(next) as (keyof DiscussionRepositoryThreadSnapshot)[];
    return previousKeys.length === nextKeys.length
        && previousKeys.every(key => Object.hasOwn(next, key) && previous[key] === next[key]);
}

function flattenListPages(pages: readonly ListPage[], previous: readonly DiscussionOpenedSummaryV1[]): readonly DiscussionOpenedSummaryV1[] {
    const seen = new Set<string>();
    const rows: DiscussionOpenedSummaryV1[] = [];
    for (const page of pages) {
        for (const row of page.rows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            rows.push(row);
        }
    }
    return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}

/** Reconcile newly opened boundary facts before publishing them to any consumer. */
function reconcileAttentionFacts<T>(previous: T | undefined, incoming: T): T {
    if (previous === incoming) return incoming;
    if (!previous || !incoming || typeof previous !== 'object' || typeof incoming !== 'object'
        || Array.isArray(previous) !== Array.isArray(incoming)) return incoming;
    const before = previous as Readonly<Record<string, unknown>>;
    const after = incoming as Readonly<Record<string, unknown>>;
    const keys = Object.keys(after);
    let unchanged = keys.length === Object.keys(before).length;
    const values: [string, unknown][] = [];
    for (const key of keys) {
        const value = reconcileAttentionFacts(before[key], after[key]);
        values.push([key, value]);
        if (!Object.hasOwn(before, key) || value !== before[key]) unchanged = false;
    }
    return unchanged ? previous : (Array.isArray(incoming) ? values.map(([, value]) => value) : Object.fromEntries(values)) as T;
}

type AttentionEntry = DiscussionAttentionResultV1['discussions'][number];

function reconcileAttentionEntry(previous: AttentionEntry | undefined, incoming: AttentionEntry): AttentionEntry {
    if (!previous || previous === incoming) return incoming;
    const discussion = reconcileAttentionFacts(previous.discussion, incoming.discussion);
    // Occurrences are identified by both role and original message, independent of page/order.
    const byIdentity = new Map(previous.occurrences.map(occurrence => [`${occurrence.type}:${occurrence.message.id}`, occurrence]));
    const reconciled = incoming.occurrences.map(occurrence => {
        const current = byIdentity.get(`${occurrence.type}:${occurrence.message.id}`);
        const message = reconcileAttentionFacts(current?.message, occurrence.message);
        return current && message === current.message ? current : { ...occurrence, message };
    });
    const occurrences = reconciled.length === previous.occurrences.length
        && reconciled.every((occurrence, index) => occurrence === previous.occurrences[index]) ? previous.occurrences : reconciled;
    return discussion === previous.discussion && occurrences === previous.occurrences ? previous : { discussion, occurrences };
}

function hasUnreadableSummaryContent(rows: readonly DiscussionOpenedSummaryV1[]): boolean {
    return rows.some(row => row.title === null || row.latestMessage.content === null);
}

export function mergeDiscussionMessages(
    previous: readonly DiscussionOpenedMessageV1[],
    incoming: readonly DiscussionOpenedMessageV1[],
): readonly DiscussionOpenedMessageV1[] {
    if (incoming.length === 0) return previous;
    const byId = new Map(previous.map((row) => [row.id, row]));
    let changed = false;
    for (const row of incoming) {
        const current = byId.get(row.id);
        const decision = current?.docEditProposalDispositionV1;
        // Decisions close once. A response captured before that commit cannot
        // reopen the proposal or restore content hidden by the settled projection.
        // Incoming null content still hides; a current terminal read can reopen it.
        let reconciled = decision && decision.state !== 'open' && row.docEditProposalDispositionV1?.state === 'open'
            ? { ...row, content: current?.content === null ? null : row.content, docEditProposalDispositionV1: decision } : row;
        const retainedRemovals = current?.removedAttachments;
        if (retainedRemovals?.length) {
            // A read captured before a removal may arrive after its receipt. Removed bytes cannot be restored.
            const newRemovals = row.removedAttachments?.filter(removal =>
                !retainedRemovals.some(retained => retained.blobId === removal.blobId));
            reconciled = { ...reconciled, removedAttachments: newRemovals?.length ? [...retainedRemovals, ...newRemovals] : retainedRemovals };
        }
        // Overlapping history pages can repeat immutable messages, and their
        // mutable admission/disposition projection can change without a new seq.
        const retained = current && (current === reconciled || JSON.stringify(current) === JSON.stringify(reconciled)) ? current : reconciled;
        if (retained !== current) { byId.set(row.id, retained); changed = true; }
    }
    return changed ? [...byId.values()].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id)) : previous;
}

function statusForFailure(errorCode: string): DiscussionRepositoryStatus {
    if (errorCode === 'offline' || errorCode === 'unavailable' || errorCode === 'canceled') return 'offline';
    if (errorCode === 'locked' || errorCode === 'discussion_encryption_mode_mismatch' || errorCode === 'discussion_content_unavailable') return 'locked';
    if (errorCode === 'forbidden' || errorCode === 'discussion_read_denied') return 'revoked';
    return 'error';
}

/** Source refusal hides retained quote material, while a transport outage preserves it. */
export function isDiscussionSourceContentRefusal(errorCode: string | null | undefined): boolean {
    return errorCode === 'discussion_content_unavailable' || errorCode === 'discussion_access_forbidden';
}

/** The detail surface's read-access projection, shared with its draft/presence eligibility. */
export function selectDiscussionThreadAccessState(snapshot: DiscussionRepositorySnapshot, discussionId: string): Readonly<{
    accessRevoked: boolean; sourceRefused: boolean;
}> {
    const thread = snapshot.threads[discussionId];
    // A current resource read can admit this thread without admitting the Home
    // list. Whole-Home access loss clears summaries; only then use its refusal.
    const useCollectionRefusal = thread?.summary == null;
    return {
        accessRevoked: thread?.status === 'revoked' || useCollectionRefusal
            && (snapshot.lists.active.status === 'revoked' || snapshot.lists.archived.status === 'revoked'),
        sourceRefused: isDiscussionSourceContentRefusal(thread?.errorCode)
            || useCollectionRefusal && (isDiscussionSourceContentRefusal(snapshot.lists.active.errorCode)
                || isDiscussionSourceContentRefusal(snapshot.lists.archived.errorCode)),
    };
}

function isExplicitAccessLoss(errorCode: string): boolean {
    return errorCode === 'forbidden'
        || errorCode === 'discussion_read_denied'
        || isDiscussionSourceContentRefusal(errorCode)
        // Protected Discussion reads intentionally collapse a missing resource and
        // lost access into the same nondisclosing result. Once private content was
        // loaded, retaining it is unsafe whichever underlying condition caused it.
        || errorCode === 'discussion_not_found';
}

/**
 * A definitive refusal will be earned again by resending the identical intent:
 * the typed domain vocabulary says the request itself, the target, or the
 * viewer's standing was refused. Everything else (offline, transport, a
 * pending E2EE key, an unknown code) keeps the identity for an explicit retry.
 */
function isDefinitiveMutationRefusal(errorCode: string): boolean {
    return errorCode === 'discussion_post_denied'
        || errorCode === 'discussion_access_forbidden'
        || errorCode === 'discussion_manage_denied'
        || errorCode === 'discussion_invalid_content'
        || errorCode === 'discussion_invalid_mention'
        || errorCode === 'discussion_invalid_reply_target'
        || errorCode === 'doc_passage_mismatch'
        || errorCode === 'discussion_archived'
        || errorCode === 'discussion_encryption_mode_mismatch'
        || errorCode === 'discussion_idempotency_conflict'
        || errorCode === 'discussions_unavailable';
}

function recoveryForFailure(errorCode: string): DiscussionMutationRecovery {
    return isDefinitiveMutationRefusal(errorCode) ? 'dismiss' : 'retry';
}

function isPermanentReadStateRefusal(errorCode: string): boolean {
    return isExplicitAccessLoss(errorCode)
        || errorCode === DISCUSSION_NOT_TRACKED_CODE_V1
        || errorCode === 'discussion_read_cursor_invalid'
        || errorCode === 'discussions_unavailable';
}

export function createDiscussionRepository(options: Readonly<{
    scope: ServerAccountScope;
    address: Readonly<{ serverId: string }>;
    client: DiscussionRepositoryClient;
}>) {
    const findOwnMessage = (messages: readonly DiscussionOpenedMessageV1[], localId: string) => messages.find(row =>
        row.localId === localId && row.authorAccountId === options.scope.accountId);
    const canRetryDelivery = (message: DiscussionOpenedMessageV1 | undefined): message is DiscussionOpenedMessageV1
        & Readonly<{ localId: string; content: DiscussionMessageContentV1 }> => Boolean(message?.localId && message.content
            && message.producerV1 === null && message.authorAccountId === options.scope.accountId);
    const listeners = new Set<() => void>();
    const listPages: Record<'active' | 'archived', ListPage[]> = { active: [], archived: [] };
    const anchorPages = new Map<string, { anchor: ListAnchor; pages: Record<'active' | 'archived', ListPage[]> }>();
    const retainedAnchors = () => [...anchorPages.values()].map(entry => entry.anchor);
    const listInFlight = new Map<string, Promise<void>>();
    const summaryInFlight = new Map<string, Promise<boolean>>();
    const mountedAnchors = new Map<string, { anchor: ListAnchor; count: number }>();
    const mountedThreads = new Map<string, number>();
    const mountedSummaries = new Map<string, number>();
    const summaryObservers = new Map<string, Set<() => void>>();
    const settingsObservers = new Map<string, Set<() => void>>();
    const notifySummaryObservers = (discussionId: string) => {
        for (const listener of [...summaryObservers.get(discussionId) ?? []]) listener();
    };
    const intents = new Map<string, MutationIntent>();
    let client = options.client;
    let mountedWatch: MountedDiscussionChangeWatch | null = null;
    let mountReferences = 0;
    let homeMountReferences = 0;
    let attentionMountReferences = 0;
    let attentionInFlight: Promise<void> | null = null;
    let attentionPages: DiscussionAttentionResultV1[] = [];
    let accessLossEpoch = 0;
    const resourceEpochs = new Map<string, number>();
    const captureOperation = (discussionId?: string) => ({ home: accessLossEpoch, discussionId,
        resource: discussionId === undefined ? 0 : resourceEpochs.get(discussionId) ?? 0 });
    const isCurrentOperation = (operation: ReturnType<typeof captureOperation>) => operation.home === accessLossEpoch
        && (operation.discussionId === undefined || operation.resource === (resourceEpochs.get(operation.discussionId) ?? 0));
    let homeCollection = EMPTY_COLLECTION;
    let snapshot: DiscussionRepositorySnapshot = {
        address: options.address,
        ...homeCollection,
        anchors: {},
        threads: {},
        mutations: {},
        attention: EMPTY_ATTENTION,
    };

    let publicationBatchDepth = 0;
    let hasPendingPublication = false;
    const notifyListeners = () => {
        for (const listener of listeners) listener();
    };
    const publish = (next: DiscussionRepositorySnapshot) => {
        if (next === snapshot) return;
        if (next.lists !== homeCollection.lists || next.archivedExistence !== homeCollection.archivedExistence) {
            homeCollection = { lists: next.lists, archivedExistence: next.archivedExistence };
        }
        snapshot = next;
        if (publicationBatchDepth > 0) hasPendingPublication = true;
        else notifyListeners();
    };
    const batchPublications = <T>(operation: () => T): T => {
        publicationBatchDepth += 1;
        try {
            return operation();
        } finally {
            publicationBatchDepth -= 1;
            if (publicationBatchDepth === 0 && hasPendingPublication) {
                hasPendingPublication = false;
                notifyListeners();
            }
        }
    };
    const purgeAccessLost = (errorCode: string) => {
        accessLossEpoch += 1;
        listInFlight.clear();
        summaryInFlight.clear();
        attentionPages = [];
        listPages.active = [];
        listPages.archived = [];
        anchorPages.clear();
        intents.clear();
        const revoked: DiscussionRepositoryListSnapshot = Object.freeze({
            items: [], nextCursor: null, status: 'revoked', errorCode, incomplete: false,
        });
        publish({
            address: options.address,
            lists: { active: revoked, archived: revoked },
            archivedExistence: 'unknown',
            anchors: {},
            threads: {},
            mutations: {},
            attention: { ...EMPTY_ATTENTION, status: 'revoked', errorCode },
        });
        for (const id of summaryObservers.keys()) notifySummaryObservers(id);
    };
    const getListSnapshot = (anchorSessionId?: ListAnchor): DiscussionRepositoryCollectionSnapshot => anchorSessionId === undefined
        ? homeCollection : snapshot.anchors[listAnchorKey(anchorSessionId)]
            ?? (snapshot.lists.active.status === 'revoked' && snapshot.lists.archived.status === 'revoked' ? homeCollection : EMPTY_COLLECTION);
    const pagesFor = (anchorSessionId?: ListAnchor) => {
        if (anchorSessionId === undefined) return listPages;
        const key = listAnchorKey(anchorSessionId);
        let entry = anchorPages.get(key);
        if (!entry) { entry = { anchor: anchorSessionId, pages: { active: [], archived: [] } }; anchorPages.set(key, entry); }
        return entry.pages;
    };
    const updateCollection = (value: DiscussionRepositoryCollectionSnapshot, anchorSessionId?: ListAnchor) => publish(anchorSessionId === undefined
        ? { ...snapshot, ...value } : { ...snapshot, anchors: { ...snapshot.anchors, [listAnchorKey(anchorSessionId)]: value } });
    const updateList = (state: 'active' | 'archived', value: DiscussionRepositoryListSnapshot, anchorSessionId?: ListAnchor) => {
        const current = getListSnapshot(anchorSessionId);
        const previous = current.lists[state];
        if (previous.items === value.items && previous.nextCursor === value.nextCursor && previous.status === value.status
            && previous.errorCode === value.errorCode && previous.incomplete === value.incomplete) return;
        updateCollection({ ...current, lists: { ...current.lists, [state]: value } }, anchorSessionId);
    };
    const updateThread = (discussionId: string, value: DiscussionRepositoryThreadSnapshot) => {
        const previous = snapshot.threads[discussionId];
        const firstMessage = value.summary?.firstMessage;
        const canonicalRoot = firstMessage && value.messages.find(row => row.id === firstMessage.id);
        const summary = canonicalRoot && canonicalRoot !== firstMessage ? { ...value.summary!, firstMessage: canonicalRoot } : value.summary;
        const next = summary === value.summary ? value : { ...value, summary };
        if (!previous || !hasSameThreadFacts(previous, next)) {
            publish({ ...snapshot, threads: { ...snapshot.threads, [discussionId]: next } });
        }
        if (summary !== value.summary && canonicalRoot) {
            // Scoped discovery and ordinary lists retain the same summary facts;
            // an updated root must not leave a second readable body/disposition there.
            for (const anchor of [undefined, ...retainedAnchors()]) {
                const pages = pagesFor(anchor);
                for (const state of ['active', 'archived'] as const) {
                    pages[state] = pages[state].map(page => ({ ...page, rows: page.rows.map(row =>
                        row.id === discussionId && row.firstMessage ? { ...row, firstMessage: canonicalRoot } : row) }));
                    const list = getListSnapshot(anchor).lists[state];
                    applyListPages(state, list.status, list.errorCode, anchor);
                }
            }
        }
    };
    const updateMutation = (localId: string, value: DiscussionRepositoryMutation | null) => {
        const mutations = { ...snapshot.mutations };
        if (value) mutations[localId] = value;
        else delete mutations[localId];
        publish({ ...snapshot, mutations });
    };
    const markMutationObservedSuccess = (localId: string) => {
        const current = snapshot.mutations[localId];
        if (!current) return;
        const { artifactId: _artifactId, errorCode: _errorCode, failureCause: _failureCause, recovery: _recovery, ...retained } = current;
        updateMutation(localId, { ...retained, status: 'observed_success' });
    };
    const updateArchivedExistence = (value: DiscussionArchivedExistence, anchorSessionId?: ListAnchor) => {
        const current = getListSnapshot(anchorSessionId);
        if (current.archivedExistence === value) return;
        updateCollection({ ...current, archivedExistence: value }, anchorSessionId);
    };
    const applyListPages = (state: 'active' | 'archived', status: DiscussionRepositoryStatus, errorCode: string | null, anchorSessionId?: ListAnchor) => {
        const pages = pagesFor(anchorSessionId)[state];
        const current = getListSnapshot(anchorSessionId).lists[state];
        const items = flattenListPages(pages, current.items);
        updateList(state, {
            items,
            nextCursor: pages.at(-1)?.nextCursor ?? null,
            status,
            errorCode,
            incomplete: pages.some((page) => page.incomplete),
        }, anchorSessionId);
        // Loaded archived rows are a stronger answer than the bounded probe, so
        // the list settling replaces it. A failed or still-loading read leaves
        // the last proven answer alone rather than inventing emptiness.
        if (state === 'archived' && (items.length > 0 || status === 'ready' || status === 'locked')) {
            updateArchivedExistence(items.length > 0 ? 'present' : pages.at(-1)?.nextCursor ? 'unknown' : 'empty', anchorSessionId);
        }
    };
    const purgeDiscussion = (discussionId: string, errorCode: string, input: Readonly<{ docAdmissionKnown?: boolean }> = {}) => {
        resourceEpochs.set(discussionId, (resourceEpochs.get(discussionId) ?? 0) + 1);
        for (const anchor of [undefined, ...retainedAnchors()]) {
            const pages = pagesFor(anchor);
            for (const state of ['active', 'archived'] as const) {
                const lostDocAdmission = isDocListAnchor(anchor) && !input.docAdmissionKnown
                    && pages[state].some(page => page.rows.some(row => row.id === discussionId));
                pages[state] = pages[state].map(page => ({ ...page,
                    rows: page.rows.filter(row => row.id !== discussionId),
                    incomplete: page.incomplete || lostDocAdmission,
                }));
                const current = getListSnapshot(anchor).lists[state];
                // An exact refusal withdraws content, but does not prove a new
                // complete Doc count. Only scoped discovery can establish zero.
                applyListPages(state, lostDocAdmission ? 'locked' : current.status,
                    lostDocAdmission ? errorCode : current.errorCode, anchor);
            }
            if (pages.archived.length === 0) updateArchivedExistence('unknown', anchor);
        }
        const mutations = { ...snapshot.mutations };
        for (const [localId, mutation] of Object.entries(mutations)) {
            if (mutation.discussionId !== discussionId) continue;
            delete mutations[localId];
            intents.delete(localId);
        }
        attentionPages = attentionPages.map(page => ({ ...page, discussions: page.discussions.filter(entry => entry.discussion.id !== discussionId) }));
        publish({ ...snapshot, mutations, attention: { ...snapshot.attention,
            discussions: snapshot.attention.discussions.filter(entry => entry.discussion.id !== discussionId) }, threads: { ...snapshot.threads,
            [discussionId]: { ...emptyThread(), status: errorCode === 'discussion_content_unavailable' ? 'locked' : 'revoked', errorCode } } });
        notifySummaryObservers(discussionId);
    };
    const applySummary = (incoming: DiscussionOpenedSummaryV1, summaryRead?: Readonly<{ changeRevision?: number }>) => batchPublications(() => {
        const current = snapshot.threads[incoming.id];
        const firstMessage = incoming.firstMessage === undefined ? current?.summary?.firstMessage : incoming.firstMessage;
        const loadedLatestMessage = current?.messages.find(message => message.id === incoming.latestMessage.id);
        // A list preview can carry a relationship-only actor change for a
        // message already opened in the thread. Reconcile that projection, but
        // never hydrate an unopened or partial history from summary data.
        const projectedLatestMessage = loadedLatestMessage ? {
            ...loadedLatestMessage,
            accountActor: incoming.latestMessage.accountActor,
            ...(incoming.latestMessage.requesterAccountActor === undefined ? {} : {
                requesterAccountActor: incoming.latestMessage.requesterAccountActor,
            }),
        } : undefined;
        const summaryMessages = [firstMessage, projectedLatestMessage]
            .filter((message): message is DiscussionOpenedMessageV1 => message !== null && message !== undefined);
        const messages = summaryMessages.length > 0
            ? mergeDiscussionMessages(current?.messages ?? [], summaryMessages) : current?.messages;
        const root = firstMessage && messages?.find(message => message.id === firstMessage.id);
        const candidate = root && root !== incoming.firstMessage ? { ...incoming, firstMessage: root } : incoming;
        // One admitted summary can itself be unchanged (e.g. a deliberate warm
        // detail refresh). Preserve that fact here, never by comparing a whole
        // inventory again each time a changed row is patched.
        let row = candidate;
        if (current?.summary) {
            // Scoped summaries contain this optional field in schema order;
            // an exact get omits it and the retained root is appended above.
            // Compare the canonical root separately, not its property position.
            const { firstMessage: previousRoot, ...previousFacts } = current.summary;
            const { firstMessage: nextRoot, ...nextFacts } = candidate;
            if (previousRoot === nextRoot && JSON.stringify(previousFacts) === JSON.stringify(nextFacts)) row = current.summary;
        }
        for (const anchorSessionId of [undefined, ...retainedAnchors()]) {
            const pages = pagesFor(anchorSessionId);
            const docScoped = isDocListAnchor(anchorSessionId);
            const existing = [...pages.active, ...pages.archived].flatMap(page => page.rows).find(item => item.id === row.id);
            // Only scoped discovery can add a Doc root. An exact resource read
            // can update an admitted row, retaining that root until its own read.
            const admitted = matchesListAnchor(row, anchorSessionId) && (!docScoped || existing !== undefined);
            if (!admitted && !existing) continue;
            const state = row.archivedAt === null ? 'active' : 'archived';
            const other = state === 'active' ? 'archived' : 'active';
            pages[other] = pages[other].map(page => {
                if (!page.rows.some(item => item.id === row.id)) return page;
                const rows = page.rows.filter(item => item.id !== row.id);
                return { ...page, rows, incomplete: docScoped ? page.incomplete : hasUnreadableSummaryContent(rows) };
            });
            const target = getListSnapshot(anchorSessionId).lists[state];
            const edge = target.items.at(-1);
            const withinLoadedWindow = !target.nextCursor || !edge
                || row.latestMessage.createdAt > edge.latestMessage.createdAt
                || row.latestMessage.createdAt === edge.latestMessage.createdAt && row.id >= edge.id;
            const items = [...target.items];
            const index = items.findIndex(item => item.id === row.id);
            const previous = index < 0 ? undefined : items[index];
            if (index >= 0) items.splice(index, 1);
            if (admitted && withinLoadedWindow) {
                const projected = docScoped && existing?.firstMessage && row.firstMessage !== existing.firstMessage
                    ? { ...row, firstMessage: existing.firstMessage } : row;
                const reordered = !previous || previous.latestMessage.createdAt !== row.latestMessage.createdAt;
                const position = reordered ? items.findIndex(item => row.latestMessage.createdAt > item.latestMessage.createdAt
                    || row.latestMessage.createdAt === item.latestMessage.createdAt && row.id > item.id) : index;
                items.splice(position < 0 ? items.length : position, 0, projected);
            }
            if (pages[state].length === 0 && items.length > 0) pages[state] = [{
                requestCursor: null, rows: items, nextCursor: null,
                incomplete: docScoped ? row.title === null : hasUnreadableSummaryContent(items) }];
            else {
                let offset = 0;
                pages[state] = pages[state].map((page, pageIndex) => {
                    const end = pageIndex === pages[state].length - 1 ? items.length : offset + page.rows.length;
                    const rows = items.slice(offset, end);
                    offset = end;
                    return { ...page, rows, incomplete: docScoped
                        ? page.incomplete || admitted && withinLoadedWindow && row.title === null
                        : hasUnreadableSummaryContent(rows) };
                });
            }
            // Exact reads repair the readability of admitted rows without proving
            // query membership, paging completeness, or recovery from a failed read.
            // Doc discovery retains its separate root-admission incompleteness.
            for (const listState of [other, state] as const) {
                const current = getListSnapshot(anchorSessionId).lists[listState];
                const status = !docScoped && current.errorCode === null
                    && (current.status === 'ready' || current.status === 'locked')
                    ? pages[listState].some(page => page.incomplete) ? 'locked' : 'ready'
                    : current.status;
                applyListPages(listState, status, current.errorCode, anchorSessionId);
            }
        }
        const thread = snapshot.threads[row.id];
        // A first summary opens its label, not its history. Only the message read settles that empty thread.
        if (thread || row.firstMessage || summaryRead) updateThread(row.id, { ...(thread ?? emptyThread()), summary: row,
            ...(messages ? { messages } : {}), messageSeq: Math.max(thread?.messageSeq ?? 0, row.messageSeq),
            ...(summaryRead ? { errorCode: null, status: !thread || thread.status === 'idle' ? 'idle' : thread.status === 'loading' ? 'loading'
                : thread?.incomplete || row.title === null ? 'locked' : 'ready',
                ...(summaryRead.changeRevision === undefined ? {} : { changeRevision: summaryRead.changeRevision }) } : {}) });
    });

    /** Admit scoped discovery and its opened roots under the same custody as thread reads. */
    const readList = async (input: DiscussionListInputV1, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionListResultV1>> => {
        const operation = captureOperation();
        const epochs = new Map(resourceEpochs);
        const outcome = await client.list(input, signal);
        if (signal?.aborted) return { kind: 'failed', errorCode: 'canceled' };
        if (!isCurrentOperation(operation)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
        if (outcome.kind !== 'succeeded') {
            if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeAccessLost(outcome.errorCode);
            return outcome;
        }
        if (outcome.value.discussions.some(row => (epochs.get(row.id) ?? 0) !== (resourceEpochs.get(row.id) ?? 0))) {
            // This response lost custody; it is not a new Home-wide refusal.
            return { kind: 'failed', errorCode: 'discussion_read_stale' };
        }
        if (outcome.value.serverId !== options.scope.serverId || outcome.value.discussions.some(row => {
            const root = row.firstMessage;
            return (input.anchorDocArtifactId !== undefined && (row.anchor?.kind !== 'doc'
                || row.anchor.doc.ref.artifactId !== input.anchorDocArtifactId || root === undefined))
                || (root && (root.seq !== 1 || root.discussionId !== row.id || root.messageRef.messageId !== root.id
                    || root.messageRef.discussion.discussionId !== row.id || root.messageRef.discussion.serverId !== options.scope.serverId));
        })) return { kind: 'failed', errorCode: 'discussion_invalid_content' };
        for (const row of outcome.value.discussions) {
            if (row.firstMessage === null) purgeDiscussion(row.id, 'discussion_content_unavailable', { docAdmissionKnown: true });
            else applySummary(row);
        }
        return { kind: 'succeeded', value: { ...outcome.value,
            discussions: outcome.value.discussions.map(row => snapshot.threads[row.id]?.summary ?? row) } };
    };

    const loadListPage = async (state: 'active' | 'archived', cursor: string | null, signal?: AbortSignal, anchorSessionId?: ListAnchor) => {
        const operationEpoch = accessLossEpoch;
        const epochs = new Map(resourceEpochs);
        const previous = new Map(getListSnapshot(anchorSessionId).lists[state].items.map(row => [row.id, row]));
        const input = { state, ...(cursor ? { cursor } : {}), ...listAnchorInput(anchorSessionId) };
        const docScoped = isDocListAnchor(anchorSessionId);
        const outcome = await (docScoped ? readList(input, signal) : client.list(input, signal));
        if (signal?.aborted) return { kind: 'failed' as const, errorCode: 'canceled' };
        if (operationEpoch !== accessLossEpoch) return { kind: 'failed' as const, errorCode: 'discussion_read_denied' };
        if (outcome.kind !== 'succeeded') return outcome;
        // A genuine full-query refresh can return unchanged facts. Reconcile
        // those rows once at admission, not during every targeted list patch.
        const rows = outcome.value.discussions.filter(row => (epochs.get(row.id) ?? 0) === (resourceEpochs.get(row.id) ?? 0)).map(row => {
            const retained = previous.get(row.id);
            return retained && JSON.stringify(retained) === JSON.stringify(row) ? retained : row;
        });
        for (const row of rows) {
            // Query pages own membership/cursors, while a resource observed in
            // another loaded projection must not retain a divergent summary.
            if (snapshot.threads[row.id]?.summary || [listPages, ...[...anchorPages.values()].map(entry => entry.pages)].some(pages =>
                [...pages.active, ...pages.archived].some(page => page.rows.some(item => item.id === row.id)))) applySummary(row);
        }
        return { kind: 'succeeded' as const, value: {
            requestCursor: cursor,
            rows,
            nextCursor: outcome.value.nextCursor,
            // Scoped roots, not an unreadable title/latest preview, establish
            // Doc discovery. Explicit null is a known inaccessible root to
            // exclude; an unopened non-null root leaves admission unknown.
            incomplete: docScoped
                ? outcome.value.discussions.some(row => row.firstMessage === undefined
                    || (row.firstMessage !== null && row.firstMessage.content === null))
                : outcome.value.incomplete,
        } satisfies ListPage };
    };

    /**
     * One bounded archived read taken beside the active refresh, so a reader can
     * tell whether an archived Discussion exists before deciding to offer the
     * archived disclosure. It loads no page: the archived list stays lazy and
     * keeps its own pagination for when the reader actually opens it.
     */
    const probeArchivedExistence = async (signal?: AbortSignal, anchorSessionId?: ListAnchor): Promise<void> => {
        if (isDocListAnchor(anchorSessionId)) return;
        if (pagesFor(anchorSessionId).archived.length > 0) return;
        const operationEpoch = accessLossEpoch;
        const epochs = new Map(resourceEpochs);
        const outcome = await client.list({ state: 'archived', limit: 1, ...listAnchorInput(anchorSessionId) }, signal);
        if (operationEpoch !== accessLossEpoch || signal?.aborted) return;
        if (outcome.kind !== 'succeeded') {
            if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeAccessLost(outcome.errorCode);
            return;
        }
        const visible = outcome.value.discussions.some(row => (epochs.get(row.id) ?? 0) === (resourceEpochs.get(row.id) ?? 0));
        updateArchivedExistence(visible ? 'present' : outcome.value.discussions.length > 0 ? 'unknown' : 'empty', anchorSessionId);
    };

    const listReadKey = (state: 'active' | 'archived', anchorSessionId?: ListAnchor) => JSON.stringify([anchorSessionId ?? null, state]);
    const readListPages = (state: 'active' | 'archived', append: boolean, signal?: AbortSignal, anchorSessionId?: ListAnchor,
        input: Readonly<{ complete?: boolean }> = {}): Promise<void> => {
        const key = listReadKey(state, anchorSessionId);
        const existing = listInFlight.get(key);
        if (existing) return existing;
        if (signal?.aborted) return Promise.resolve();
        const operationEpoch = accessLossEpoch;
        const epochs = new Map(resourceEpochs);
        const queryPages = pagesFor(anchorSessionId);
        const retained = getListSnapshot(anchorSessionId).lists[state];
        let cursor = append ? queryPages[state].at(-1)?.nextCursor ?? null : null;
        if (append && !cursor) return Promise.resolve();
        const pageCount = append ? 1 : Math.max(1, queryPages[state].length);
        const firstPage = loadListPage(state, cursor, undefined, anchorSessionId);
        const pending = Promise.resolve().then(async () => {
            if (operationEpoch !== accessLossEpoch) return;
            let replacement: ListPage[] = append ? [...queryPages[state]] : [];
            const visited = new Set<string | null>();
            for (let index = 0; index < pageCount || (input.complete && !signal?.aborted); index += 1) {
                if (visited.has(cursor)) {
                    updateList(state, { ...getListSnapshot(anchorSessionId).lists[state], status: 'error', errorCode: 'discussion_invalid_content' }, anchorSessionId);
                    return;
                }
                visited.add(cursor);
                // The accepted page belongs to every joined reader. Canceling
                // search demand stops further traversal, not shared page custody.
                const outcome = await (index === 0 ? firstPage : loadListPage(state, cursor, undefined, anchorSessionId));
                if (operationEpoch !== accessLossEpoch) return;
                if (outcome.kind === 'failed' && outcome.errorCode === 'canceled') {
                    const current = getListSnapshot(anchorSessionId).lists[state];
                    updateList(state, { ...current, status: input.complete && queryPages[state].length > 0
                        ? current.incomplete ? 'locked' : 'ready' : retained.status, errorCode: retained.errorCode }, anchorSessionId);
                    return;
                }
                if (outcome.kind !== 'succeeded') {
                    const code = outcome.kind === 'failed' ? outcome.errorCode : 'outcome_unknown';
                    if (isExplicitAccessLoss(code)) purgeAccessLost(code);
                    else updateList(state, { ...getListSnapshot(anchorSessionId).lists[state], status: statusForFailure(code), errorCode: outcome.kind === 'failed' ? outcome.errorCode : outcome.kind }, anchorSessionId);
                    return;
                }
                if (append) {
                    replacement = [...queryPages[state]];
                    const pageIndex = replacement.findIndex(page => page.requestCursor === cursor);
                    if (pageIndex >= 0) replacement[pageIndex] = outcome.value;
                    else replacement.push(outcome.value);
                } else replacement.push(outcome.value);
                cursor = outcome.value.nextCursor;
                if (input.complete && !isDocListAnchor(anchorSessionId)) {
                    queryPages[state] = replacement.map(page => ({ ...page,
                        rows: page.rows.filter(row => (epochs.get(row.id) ?? 0) === (resourceEpochs.get(row.id) ?? 0)),
                    }));
                    applyListPages(state, 'loading', null, anchorSessionId);
                }
                if (!cursor) break;
            }
            queryPages[state] = replacement.map(page => ({ ...page,
                rows: page.rows.filter(row => (epochs.get(row.id) ?? 0) === (resourceEpochs.get(row.id) ?? 0)),
            }));
            applyListPages(state, replacement.some((page) => page.incomplete) ? 'locked' : 'ready', null, anchorSessionId);
            if (isDocListAnchor(anchorSessionId) && input.complete && !cursor) {
                const admittedIds = new Set(queryPages[state].flatMap(page => page.rows.map(row => row.id)));
                for (const row of retained.items) {
                    if (admittedIds.has(row.id) || !row.firstMessage) continue;
                    // Absence from the scoped query is not proof of resource
                    // revocation (it may have been archived). Recheck the exact
                    // retained root through the ordinary access-loss owner so a
                    // source refusal withdraws its thread as well as its row.
                    if (await refreshSummary(row.id, signal) && snapshot.threads[row.id]?.summary?.archivedAt === null) {
                        await readExactMessage(row.id, row.firstMessage.id, signal);
                    }
                }
            }
            if (state === 'active' && !append && !signal?.aborted) await probeArchivedExistence(signal, anchorSessionId);
        }).finally(() => { if (listInFlight.get(key) === pending) listInFlight.delete(key); });
        listInFlight.set(key, pending);
        updateList(state, { ...retained, status: retained.status === 'ready' || retained.status === 'locked' ? retained.status : 'loading', errorCode: null }, anchorSessionId);
        return pending;
    };

    const refreshList = (state: 'active' | 'archived', signal?: AbortSignal, anchorSessionId?: ListAnchor,
        input?: Readonly<{ complete?: boolean }>) => readListPages(state, false, signal, anchorSessionId, input);
    const loadMoreList = (state: 'active' | 'archived', signal?: AbortSignal, anchorSessionId?: ListAnchor,
        input?: Readonly<{ complete?: boolean }>) => readListPages(state, true, signal, anchorSessionId, input);

    /** Search demand extends the same query's retained page frontier, never a second list. */
    const loadCompleteList = async (state: 'active' | 'archived', signal?: AbortSignal, anchorSessionId?: ListAnchor): Promise<void> => {
        const operationEpoch = accessLossEpoch;
        const key = listReadKey(state, anchorSessionId);
        while (listInFlight.has(key)) await listInFlight.get(key);
        if (operationEpoch !== accessLossEpoch || signal?.aborted) return;
        const current = getListSnapshot(anchorSessionId).lists[state];
        if (current.status === 'revoked') return;
        if (current.status === 'idle' || (!pagesFor(anchorSessionId)[state].length && current.status !== 'ready')
            || ((current.status === 'error' || current.status === 'offline') && !current.nextCursor)) {
            await refreshList(state, signal, anchorSessionId, { complete: true });
        } else if (current.nextCursor) await loadMoreList(state, signal, anchorSessionId, { complete: true });
    };

    const refreshMessages = async (discussionId: string, signal?: AbortSignal, refreshedRootId?: string,
        changedMessageSeqs?: ReadonlySet<number>): Promise<void> => {
        const operationEpoch = captureOperation(discussionId);
        const retained = snapshot.threads[discussionId] ?? emptyThread();
        if (retained.oldestHistorySeq === undefined && retained.newestHistorySeq === undefined) {
            updateThread(discussionId, { ...retained, status: 'loading', errorCode: null });
        }
        const messages = retained.messages;
        let messageSeq = retained.messageSeq;
        let observedHasMoreOlder: boolean | null = null;
        let oldestHistorySeq = retained.oldestHistorySeq;
        let newestHistorySeq = retained.newestHistorySeq;
        const received: DiscussionOpenedMessageV1[] = [];
        // Locked content and open proposal dispositions can change without a new
        // message sequence. Revisit their earliest retained row, even when it is
        // older than the server's default tail page.
        const firstMutableIndex = messages.findIndex((row) => row.content === null || row.docEditProposalDispositionV1?.state === 'open');
        // A scoped root or exact focused row is not a history page. First load
        // the ordinary tail, regardless of which isolated rows were opened.
        let afterSeq = oldestHistorySeq === undefined ? undefined : firstMutableIndex >= 0
            ? messages[firstMutableIndex]!.seq - 1
            : newestHistorySeq;
        for (;;) {
            const outcome = await client.read(discussionId, afterSeq === undefined ? {} : { afterSeq }, signal);
            if (!isCurrentOperation(operationEpoch)) return;
            if (outcome.kind !== 'succeeded') {
                const code = outcome.kind === 'failed' ? outcome.errorCode : outcome.kind;
                if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
                else if (statusForFailure(code) === 'revoked') {
                    updateThread(discussionId, { ...emptyThread(), status: 'revoked', errorCode: code });
                } else {
                    // Reporting this read's failure must not republish the thread as it
                    // looked before the await: another surface may have loaded newer
                    // messages, and the pages this read did receive are still valid.
                    const failed = mergeDiscussionMessages(
                        (snapshot.threads[discussionId] ?? retained).messages,
                        received,
                    );
                    updateThread(discussionId, {
                        ...(snapshot.threads[discussionId] ?? retained),
                        messages: failed,
                        incomplete: failed.some((row) => row.content === null),
                        status: statusForFailure(code), errorCode: code,
                    });
                }
                return;
            }
            received.push(...outcome.value.messages);
            if (afterSeq === undefined) {
                observedHasMoreOlder = outcome.value.hasMoreOlder;
                oldestHistorySeq = outcome.value.messages[0]?.seq;
            }
            messageSeq = Math.max(messageSeq, outcome.value.messageSeq);
            const highest = outcome.value.messages.reduce((highest, row) => Math.max(highest, row.seq), afterSeq ?? 0);
            if (outcome.value.messages.length > 0) newestHistorySeq = Math.max(newestHistorySeq ?? 0, highest);
            if (highest >= messageSeq
                || outcome.value.messages.length === 0
                || (afterSeq !== undefined && highest <= afterSeq)) {
                break;
            }
            afterSeq = highest;
        }
        // Another mounted surface can publish newer rows while this read is in
        // flight, so the response reconciles against the current thread instead of
        // the snapshot it captured before awaiting.
        const current = snapshot.threads[discussionId] ?? retained;
        const merged = mergeDiscussionMessages(current.messages, received);
        const incomplete = merged.some((row) => row.content === null);
        updateThread(discussionId, {
            ...current,
            messages: merged,
            hasMoreOlder: observedHasMoreOlder ?? current.hasMoreOlder,
            oldestHistorySeq: current.oldestHistorySeq === undefined ? oldestHistorySeq
                : Math.min(current.oldestHistorySeq, oldestHistorySeq ?? current.oldestHistorySeq),
            newestHistorySeq: newestHistorySeq === undefined ? current.newestHistorySeq
                : Math.max(current.newestHistorySeq ?? 0, newestHistorySeq),
            messageSeq: Math.max(current.messageSeq, messageSeq),
            status: incomplete ? 'locked' : 'ready',
            errorCode: null,
            incomplete,
        });
        // Delivery and changed attachments are projected onto their originals
        // without appending a message. Reopen only originals the tail did not read;
        // a scoped root may have been admitted by the invalidation owner above.
        const receivedIds = new Set(received.map(row => row.id));
        for (const row of messages) {
            if ((!row.addressingV1?.participantSessionIds.length && !changedMessageSeqs?.has(row.seq))
                || receivedIds.has(row.id) || row.id === refreshedRootId) continue;
            await readExactMessage(discussionId, row.id, signal);
            if (!isCurrentOperation(operationEpoch) || signal?.aborted) return;
        }
        for (const intent of intents.values()) {
            if (intent.kind === 'post'
                && intent.discussionId === discussionId
                && findOwnMessage(merged, intent.localId)) {
                markMutationObservedSuccess(intent.localId);
            }
        }
    };

    const refreshSummary = (discussionId: string, signal?: AbortSignal, changeRevision?: number): Promise<boolean> => {
        const operationEpoch = captureOperation(discussionId);
        const preceding = summaryInFlight.get(discussionId);
        // Each invalidation needs a fresh authoritative read, but an older HTTP
        // snapshot must not settle after the next one and overwrite its preview.
        const pending = (async () => {
            if (preceding) await preceding;
            if (!isCurrentOperation(operationEpoch) || signal?.aborted) return false;
            const retained = snapshot.threads[discussionId] ?? emptyThread();
            const outcome = await client.get(discussionId, signal);
            if (!isCurrentOperation(operationEpoch)) return false;
            if (outcome.kind !== 'succeeded') {
                const code = outcome.kind === 'failed' ? outcome.errorCode : outcome.kind;
                if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
                else updateThread(discussionId, {
                    ...(snapshot.threads[discussionId] ?? retained),
                    status: statusForFailure(code), errorCode: code,
                });
                if (changeRevision !== undefined && !isExplicitAccessLoss(code)) notifySummaryObservers(discussionId);
                return false;
            }
            applySummary(outcome.value.discussion, { changeRevision });
            if (changeRevision !== undefined || retained.errorCode) notifySummaryObservers(discussionId);
            return true;
        })().finally(() => { if (summaryInFlight.get(discussionId) === pending) summaryInFlight.delete(discussionId); });
        summaryInFlight.set(discussionId, pending);
        return pending;
    };

    const refreshDiscussion = async (discussionId: string, signal?: AbortSignal, demand?: Readonly<{ includeFirstMessage?: boolean }>): Promise<void> => {
        if (!await refreshSummary(discussionId, signal)) return;
        await refreshMessages(discussionId, signal);
        const thread = snapshot.threads[discussionId];
        if (demand?.includeFirstMessage && (thread?.status === 'ready' || thread?.status === 'locked')
            && !thread.messages.some(message => message.seq === 1)) {
            await readMessagePage(discussionId, { afterSeq: 0 }, signal);
        }
    };

    /** Isolated message demand shares the history owner without moving its paging cursors. */
    const readMessagePage = async (discussionId: string, query: Parameters<DiscussionRepositoryClient['read']>[1], signal?: AbortSignal): Promise<readonly DiscussionOpenedMessageV1[] | null> => {
        const operationEpoch = captureOperation(discussionId);
        const outcome = await client.read(discussionId, query, signal);
        if (!isCurrentOperation(operationEpoch)) return null;
        const current = snapshot.threads[discussionId] ?? emptyThread();
        if (outcome.kind !== 'succeeded') {
            const code = outcome.kind === 'failed' ? outcome.errorCode : outcome.kind;
            if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
            else updateThread(discussionId, { ...current, status: statusForFailure(code), errorCode: code });
            return null;
        }
        const messages = mergeDiscussionMessages(current.messages, outcome.value.messages);
        const incomplete = messages.some(row => row.content === null);
        const root = outcome.value.messages.find(message => message.seq === 1);
        const summary = root && current.summary ? { ...current.summary, firstMessage: root } : current.summary;
        updateThread(discussionId, { ...current, summary, messages, messageSeq: Math.max(current.messageSeq, outcome.value.messageSeq),
            status: incomplete ? 'locked' : 'ready', errorCode: null, incomplete });
        return outcome.value.messages;
    };

    const readExactMessage = async (discussionId: string, messageId: string, signal?: AbortSignal): Promise<DiscussionOpenedMessageV1 | null> => {
        const messages = await readMessagePage(discussionId, { messageId }, signal);
        return messages?.some(row => row.id === messageId)
            ? snapshot.threads[discussionId]?.messages.find(row => row.id === messageId && row.content !== null) ?? null : null;
    };

    const loadOlderMessages = async (discussionId: string, signal?: AbortSignal): Promise<void> => {
        const retained = snapshot.threads[discussionId] ?? emptyThread();
        const operationEpoch = captureOperation(discussionId);
        const beforeSeq = retained.oldestHistorySeq;
        if (beforeSeq === undefined || !retained.hasMoreOlder) return;
        updateThread(discussionId, { ...retained, status: 'loading', errorCode: null });
        const outcome = await client.read(discussionId, { beforeSeq }, signal);
        if (!isCurrentOperation(operationEpoch)) return;
        if (outcome.kind !== 'succeeded') {
            const code = outcome.kind === 'failed' ? outcome.errorCode : outcome.kind;
            if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
            else updateThread(discussionId, {
                ...(snapshot.threads[discussionId] ?? retained),
                status: statusForFailure(code),
                errorCode: code,
            });
            return;
        }
        const current = snapshot.threads[discussionId] ?? retained;
        const merged = mergeDiscussionMessages(current.messages, outcome.value.messages);
        const incomplete = merged.some((row) => row.content === null);
        updateThread(discussionId, {
            ...current,
            messages: merged,
            hasMoreOlder: outcome.value.hasMoreOlder,
            oldestHistorySeq: Math.min(current.oldestHistorySeq ?? beforeSeq, outcome.value.messages[0]?.seq ?? beforeSeq),
            messageSeq: Math.max(current.messageSeq, outcome.value.messageSeq),
            status: incomplete ? 'locked' : 'ready',
            errorCode: null,
            incomplete,
        });
    };

    const recordMutation = (intent: MutationIntent, status: DiscussionMutationStatus, detail?: Pick<DiscussionRepositoryMutation, 'artifactId' | 'errorCode' | 'failureCause' | 'recovery'>) => {
        const localId = intent.kind === 'create' ? intent.creationLocalId : intent.localId;
        intents.set(localId, intent);
        updateMutation(localId, {
            kind: intent.kind, localId,
            ...(intent.kind === 'create' ? { messageLocalId: intent.messageLocalId } : { discussionId: intent.discussionId }),
            status,
            content: intent.content,
            ...(intent.mentionedAccountIds ? { mentionedAccountIds: intent.mentionedAccountIds } : {}),
            ...(intent.mentionedSessionIds ? { mentionedSessionIds: intent.mentionedSessionIds } : {}),
            draftSubmission: intent.draftSubmission,
            ...detail,
        });
    };

    const completeCreate = (intent: CreateIntent, value: DiscussionCreateResultV1) => {
        applySummary(value.discussion);
        const retained = snapshot.threads[value.discussion.id] ?? emptyThread();
        updateThread(value.discussion.id, {
            ...retained,
            summary: value.discussion,
            messages: mergeDiscussionMessages(retained.messages, [value.firstMessage]),
            messageSeq: value.discussion.messageSeq,
            hasMoreOlder: retained.messages.length > 0 ? retained.hasMoreOlder : false,
            status: value.firstMessage.content === null ? 'locked' : 'ready',
            errorCode: null,
            incomplete: retained.incomplete || value.firstMessage.content === null,
        });
        const mutation = snapshot.mutations[intent.creationLocalId];
        if (mutation) updateMutation(intent.creationLocalId, { ...mutation, discussionId: value.discussion.id });
        markMutationObservedSuccess(intent.creationLocalId);
    };

    const completePost = (intent: PostIntent, value: DiscussionPostResultV1) => {
        const retained = snapshot.threads[intent.discussionId] ?? emptyThread();
        updateThread(intent.discussionId, {
            ...retained,
            messages: mergeDiscussionMessages(retained.messages, [value.message]),
            messageSeq: value.messageSeq,
            status: value.message.content === null ? 'locked' : 'ready',
            errorCode: null,
            incomplete: retained.incomplete || value.message.content === null,
        });
        markMutationObservedSuccess(intent.localId);
    };

    const findCreatedDiscussionInList = async (
        intent: CreateIntent,
        state: 'active' | 'archived',
        operationEpoch: number,
        signal?: AbortSignal,
    ): Promise<
        | { kind: 'found'; row: DiscussionOpenedSummaryV1 }
        | { kind: 'absent' }
        | { kind: 'unavailable' }
    > => {
        let cursor: string | null = null;
        const visitedCursors = new Set<string>();
        for (;;) {
            const outcome = await client.list({ state, creationLocalId: intent.creationLocalId, ...(cursor ? { cursor } : {}) }, signal);
            if (operationEpoch !== accessLossEpoch) return { kind: 'unavailable' };
            if (outcome.kind !== 'succeeded') {
                return { kind: 'unavailable' };
            }
            const found = outcome.value.discussions.find((row) => row.creationLocalId === intent.creationLocalId);
            if (found) return { kind: 'found', row: found };
            const nextCursor = outcome.value.nextCursor;
            if (!nextCursor || visitedCursors.has(nextCursor)) return { kind: 'absent' };
            visitedCursors.add(nextCursor);
            cursor = nextCursor;
        }
    };

    const reconcileCreate = async (intent: CreateIntent, signal?: AbortSignal): Promise<boolean> => {
        const operationEpoch = accessLossEpoch;
        // A create can commit and then be archived — by this Account elsewhere
        // or by another collaborator — before the one-shot reconciler runs.
        // Observing only the active projection reports a committed discussion
        // as never created and leaves the attempt open for a duplicate resend,
        // so both existing list projections are observed before concluding
        // absence. Neither adds a route: this is the same paged list owner.
        let found: DiscussionOpenedSummaryV1 | null = null;
        for (const state of ['active', 'archived'] as const) {
            const outcome = await findCreatedDiscussionInList(intent, state, operationEpoch, signal);
            if (outcome.kind === 'unavailable') return false;
            if (outcome.kind === 'found') {
                found = outcome.row;
                break;
            }
        }
        if (!found) return false;
        // Resource/message existence cannot prove the post-create key-delivery
        // step completed. An explicit retry reuses this intent and the original
        // authorized envelope through the same create Action and shared runner.
        if (found.encryptionMode === 'e2ee' && intent.participants?.some(participant => participant.kind === 'account')) return false;
        const resourceOperation = captureOperation(found.id);
        const messages = await client.read(found.id, { localId: intent.messageLocalId }, signal);
        if (operationEpoch !== accessLossEpoch || !isCurrentOperation(resourceOperation)) return false;
        if (messages.kind !== 'succeeded') {
            if (messages.kind === 'failed' && isExplicitAccessLoss(messages.errorCode)) {
                purgeDiscussion(found.id, messages.errorCode);
                intents.delete(intent.creationLocalId);
                updateMutation(intent.creationLocalId, null);
            }
            return false;
        }
        const firstMessage = findOwnMessage(messages.value.messages, intent.messageLocalId);
        if (!firstMessage || firstMessage.seq !== 1) return false;
        completeCreate(intent, {
            v: 1,
            serverId: options.address.serverId,
            discussion: found,
            firstMessage,
        });
        return true;
    };

    const reconcilePost = async (intent: PostIntent, signal?: AbortSignal): Promise<boolean> => {
        const operationEpoch = captureOperation(intent.discussionId);
        const retained = snapshot.threads[intent.discussionId] ?? emptyThread();
        const alreadyPublished = findOwnMessage(retained.messages, intent.localId);
        if (alreadyPublished) {
            completePost(intent, {
                v: 1,
                serverId: options.address.serverId,
                message: alreadyPublished,
                messageSeq: retained.messageSeq,
            });
            return true;
        }
        const outcome = await client.read(intent.discussionId, { localId: intent.localId }, signal);
        if (!isCurrentOperation(operationEpoch)) return false;
        if (outcome.kind !== 'succeeded') {
            if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(intent.discussionId, outcome.errorCode);
            return false;
        }
        const found = findOwnMessage(outcome.value.messages, intent.localId);
        if (!found) return false;
        completePost(intent, { v: 1, serverId: options.address.serverId, message: found, messageSeq: outcome.value.messageSeq });
        return true;
    };

    const reconcileIntent = async (intent: MutationIntent, signal?: AbortSignal): Promise<boolean> => (
        intent.kind === 'create'
            ? await reconcileCreate(intent, signal)
            : await reconcilePost(intent, signal)
    );

    const reconcileRecordedIntent = async (intent: MutationIntent, signal?: AbortSignal): Promise<boolean> => {
        const localId = intent.kind === 'create' ? intent.creationLocalId : intent.localId;
        let observed = false;
        try {
            observed = await reconcileIntent(intent, signal);
        } catch {
            observed = false;
        }
        if (observed) return true;

        const retained = snapshot.mutations[localId];
        if (retained?.status === 'checking' || retained?.status === 'outcome_unknown') {
            recordMutation(intent, 'outcome_unknown', { errorCode: 'outcome_unknown', failureCause: retained.failureCause });
        }
        return false;
    };

    const executeCreate = async (initialIntent: CreateIntent, signal?: AbortSignal): Promise<DiscussionRepositoryMutationOutcome<DiscussionCreateResultV1>> => {
        let intent = initialIntent;
        const operationEpoch = accessLossEpoch;
        recordMutation(intent, 'sending');
        const outcome = await client.create({ ...intent, onResolvedParticipants: participants => {
            // The front door owns resolution. Retain its concrete choice in the
            // existing mutation intent before approval or an uncertain write.
            if (operationEpoch !== accessLossEpoch) return;
            intent = { ...intent, participants: [...participants] };
            intents.set(intent.creationLocalId, intent);
        } }, signal);
        if (operationEpoch !== accessLossEpoch) return { kind: 'failed', errorCode: 'discussion_read_denied' };
        if (outcome.kind === 'succeeded') {
            completeCreate(intent, outcome.value);
            return outcome;
        }
        if (outcome.kind === 'approval_request_created') {
            recordMutation(intent, 'approval_pending', { artifactId: outcome.artifactId });
            return { kind: 'approval_request_created', artifactId: outcome.artifactId };
        }
        if (outcome.errorCode === 'outcome_unknown') {
            recordMutation(intent, 'checking', { failureCause: outcome.failureCause });
            void reconcileRecordedIntent(intent, signal);
            return { kind: 'checking' };
        }
        // This proposed resource/participant set can be refused without losing
        // Account-wide access. Home retirement belongs to the lifetime owner.
        recordMutation(intent, 'failed', { errorCode: outcome.errorCode, failureCause: outcome.failureCause, recovery: recoveryForFailure(outcome.errorCode) });
        return outcome;
    };

    const executePost = async (intent: PostIntent, signal?: AbortSignal): Promise<DiscussionRepositoryMutationOutcome<DiscussionPostResultV1>> => {
        const operationEpoch = captureOperation(intent.discussionId);
        recordMutation(intent, 'sending');
        const outcome = await client.post(intent, signal);
        if (!isCurrentOperation(operationEpoch)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
        if (outcome.kind === 'succeeded') {
            completePost(intent, outcome.value);
            return outcome;
        }
        if (outcome.kind === 'approval_request_created') {
            recordMutation(intent, 'approval_pending', { artifactId: outcome.artifactId });
            return { kind: 'approval_request_created', artifactId: outcome.artifactId };
        }
        if (outcome.errorCode === 'outcome_unknown') {
            recordMutation(intent, 'checking', { failureCause: outcome.failureCause });
            void reconcileRecordedIntent(intent, signal);
            return { kind: 'checking' };
        }
        // An invitation refusal denies the proposed participant, not the loaded
        // thread. Retain the submitted draft and its definite failed attempt.
        if (outcome.stage !== 'participant_invitation' && isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(intent.discussionId, outcome.errorCode);
        else recordMutation(intent, 'failed', { errorCode: outcome.errorCode, failureCause: outcome.failureCause, recovery: recoveryForFailure(outcome.errorCode) });
        return outcome;
    };

    const retry = async (localId: string, signal?: AbortSignal): Promise<DiscussionRepositoryMutationOutcome<DiscussionCreateResultV1 | DiscussionPostResultV1>> => {
        const intent = intents.get(localId);
        if (!intent) return { kind: 'failed', errorCode: 'discussion_retry_not_found' };
        return intent.kind === 'create' ? executeCreate(intent, signal) : executePost(intent, signal);
    };

    const adoptPendingIntent = (intent: MutationIntent, signal?: AbortSignal): void => {
        const localId = intent.kind === 'create' ? intent.creationLocalId : intent.localId;
        if (intents.has(localId)) return;
        recordMutation(intent, 'checking');
        void reconcileRecordedIntent(intent, signal);
    };

    const applyLifecycleOutcome = (discussionId: string, outcome: DiscussionClientOutcome<DiscussionDetailsResultV1>, operationEpoch: ReturnType<typeof captureOperation>) => {
        if (!isCurrentOperation(operationEpoch)) return { kind: 'failed' as const, errorCode: 'discussion_read_denied' };
        if (outcome.kind === 'succeeded') applySummary(outcome.value.discussion);
        else if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(discussionId, outcome.errorCode);
        return outcome;
    };

    const applyAccessOutcome = async <TOutcome extends DiscussionClientOutcome<unknown>
        | Readonly<{ kind: 'checking'; value?: unknown }>>(discussionId: string,
        operation: () => Promise<TOutcome>, signal?: AbortSignal, refresh = true): Promise<TOutcome | Readonly<{ kind: 'failed'; errorCode: string }>> => {
        const epoch = captureOperation(discussionId);
        const outcome = await operation();
        if (!isCurrentOperation(epoch)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
        if ((outcome.kind === 'succeeded' || outcome.kind === 'checking') && outcome.value !== undefined) {
            if (outcome.value !== null && typeof outcome.value === 'object' && 'access' in outcome.value
                && outcome.value.access === null) purgeDiscussion(discussionId, 'discussion_read_denied');
            else if (refresh) {
                await refreshDiscussion(discussionId, signal);
                if (!isCurrentOperation(epoch)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
            }
        } else if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(discussionId, outcome.errorCode);
        return outcome;
    };

    const refreshLoaded = async (discussionIds: readonly string[], revisions: ReadonlyMap<string, number>, refresh?: Readonly<{
        readStateOnlyIds?: ReadonlySet<string>;
        docArtifactIds?: ReadonlySet<string>;
        attentionAlreadyRefreshed?: boolean;
        messageChanges?: ReadonlyMap<string, DiscussionMessageChanges>;
    }>): Promise<void> => {
        const { readStateOnlyIds, docArtifactIds, messageChanges } = refresh ?? {};
        const work: Promise<unknown>[] = [];
        const anchors = [...(homeMountReferences > 0 ? [undefined] : []), ...[...mountedAnchors.values()].map(entry => entry.anchor)];
        if (attentionMountReferences > 0 && !refresh?.attentionAlreadyRefreshed && !docArtifactIds?.size) {
            for (const id of discussionIds) {
                if (!readStateOnlyIds?.has(id) && !messageChanges?.get(id)?.exactOnly) work.push(refreshAttentionDiscussion(id));
            }
        }
        // Doc discovery is qualified by its source; attention membership still
        // belongs to its own query when an Artifact changes.
        if (docArtifactIds?.size) {
            if (attentionMountReferences > 0 && !refresh?.attentionAlreadyRefreshed) work.push(refreshAttentionAfterChange());
            for (const anchor of anchors) if (isDocListAnchor(anchor) && docArtifactIds.has(anchor.anchorDocArtifactId)) work.push((async () => {
                const epoch = accessLossEpoch;
                const pending = listInFlight.get(listReadKey('active', anchor));
                if (pending) await pending;
                if (epoch === accessLossEpoch) await refreshList('active', undefined, anchor, { complete: true });
            })());
        }
        for (const discussionId of discussionIds) {
            const changed = messageChanges?.get(discussionId);
            const summary = snapshot.threads[discussionId]?.summary;
            const docSourceChanged = summary?.anchor?.kind === 'doc' && docArtifactIds?.has(summary.anchor.doc.ref.artifactId);
            if (changed?.exactOnly && !docSourceChanged) {
                if (mountedThreads.has(discussionId)) {
                    const retained = snapshot.threads[discussionId]?.messages ?? [];
                    for (const row of retained) {
                        if (changed.seqs.has(row.seq)) work.push(readExactMessage(discussionId, row.id));
                    }
                }
                continue;
            }
            if (anchors.length === 0 && attentionMountReferences === 0 && !mountedThreads.has(discussionId)
                && !mountedSummaries.has(discussionId) && !snapshot.threads[discussionId]) continue;
            work.push((async () => {
                const epoch = accessLossEpoch;
                await Promise.all(anchors.flatMap(anchor => (['active', 'archived'] as const)
                    .map(state => listInFlight.get(listReadKey(state, anchor)))));
                if (epoch !== accessLossEpoch) return;
                const retained = anchors.map(anchor => ({ anchor, collection: getListSnapshot(anchor) }));
                const retainedSummary = snapshot.threads[discussionId]?.summary;
                const root = retainedSummary?.anchor?.kind === 'doc' ? retainedSummary.firstMessage : undefined;
                if (!await refreshSummary(discussionId, undefined, revisions.get(discussionId))) return;
                const row = snapshot.threads[discussionId]?.summary;
                if (!row) return;
                if (readStateOnlyIds?.has(discussionId) && !docArtifactIds?.size) {
                    const operation = captureOperation(discussionId);
                    if (attentionInFlight) await attentionInFlight;
                    if (!isCurrentOperation(operation)) return;
                    const current = snapshot.threads[discussionId]?.summary ?? row;
                    const entry = snapshot.attention.discussions.find(entry => entry.discussion.id === discussionId);
                    if (entry) {
                        const occurrences = entry.occurrences.filter(occurrence => occurrence.type === 'decision'
                            || current.lastReadSeq !== null && occurrence.message.seq > current.lastReadSeq);
                        replaceAttentionDiscussion(discussionId, occurrences.length ? { discussion: current, occurrences } : null);
                    }
                    return;
                }
                // Detail admission alone cannot prove continued Doc-root access.
                // The exact root read withdraws all retained content on refusal.
                if (root) await readExactMessage(discussionId, root.id);
                if (epoch !== accessLossEpoch || snapshot.threads[discussionId]?.summary === null) return;
                const reads: Promise<void>[] = [];
                if (mountedThreads.has(discussionId)) reads.push(refreshMessages(discussionId, undefined, root?.id, changed?.seqs));
                for (const { anchor, collection } of retained) {
                    const known = [...collection.lists.active.items, ...collection.lists.archived.items].find(item => item.id === discussionId);
                    if (!matchesListAnchor(row, anchor)) continue;
                    const state = row.archivedAt === null ? 'active' : 'archived';
                    const list = collection.lists[state];
                    // A summary can prove archived existence without opening a
                    // disclosure the reader has not requested. Its list remains lazy.
                    if (state === 'archived' && list.status === 'idle') continue;
                    const edge = list.items.at(-1);
                    const beyondLoadedEdge = known && known.latestMessage.createdAt !== row.latestMessage.createdAt
                        && list.nextCursor !== null && edge && (row.latestMessage.createdAt < edge.latestMessage.createdAt
                            || row.latestMessage.createdAt === edge.latestMessage.createdAt && row.id < edge.id);
                    if (!known || beyondLoadedEdge) reads.push(refreshList(state, undefined, anchor, { complete: isDocListAnchor(anchor) }));
                }
                await Promise.all(reads);
            })());
        }
        await Promise.all(work);
        await Promise.all([...intents.values()].map(async (intent) => {
            const localId = intent.kind === 'create' ? intent.creationLocalId : intent.localId;
            const status = snapshot.mutations[localId]?.status;
            if (status === 'checking' || status === 'outcome_unknown' || status === 'approval_pending') {
                await reconcileRecordedIntent(intent);
            }
        }));
    };

    const publishAttention = (incoming: DiscussionRepositoryAttentionSnapshot): void => {
        const previous = snapshot.attention;
        const byId = new Map(previous.discussions.map(entry => [entry.discussion.id, entry]));
        const reconciled = incoming.discussions.map(entry => reconcileAttentionEntry(byId.get(entry.discussion.id), entry));
        const discussions = reconciled.length === previous.discussions.length
            && reconciled.every((entry, index) => entry === previous.discussions[index]) ? previous.discussions : reconciled;
        if (discussions === previous.discussions && incoming.nextCursor === previous.nextCursor
            && incoming.incomplete === previous.incomplete && incoming.status === previous.status && incoming.errorCode === previous.errorCode) return;
        publish({ ...snapshot, attention: { ...incoming, discussions } });
    };

    const readAttentionPages = async (append: boolean, signal?: AbortSignal): Promise<void> => {
        const operation = captureOperation();
        const previous = snapshot.attention;
        if (previous.status !== 'ready') publishAttention({ ...previous, status: 'loading', errorCode: null });
        const pages = append ? [...attentionPages] : [];
        const pageCount = append ? 1 : Math.max(1, attentionPages.length);
        let cursor = append ? previous.nextCursor : null;
        for (let index = 0; index < pageCount; index += 1) {
            const outcome = await client.attention(cursor ? { cursor } : {}, signal);
            if (!isCurrentOperation(operation)) return;
            if (signal?.aborted || (outcome.kind === 'failed' && outcome.errorCode === 'canceled')) {
                if (previous.status !== 'ready') publishAttention(previous);
                return;
            }
            if (outcome.kind !== 'succeeded' || outcome.value.serverId !== options.scope.serverId) {
                const code = outcome.kind === 'failed' ? outcome.errorCode : 'discussion_invalid_content';
                if (isExplicitAccessLoss(code)) purgeAccessLost(code);
                else publish({ ...snapshot, attention: { ...snapshot.attention, status: statusForFailure(code), errorCode: code } });
                return;
            }
            pages.push(outcome.value);
            cursor = outcome.value.nextCursor;
            if (!cursor) break;
        }
        const byDiscussion = new Map<string, DiscussionAttentionResultV1['discussions'][number]>();
        for (const page of pages) for (const entry of page.discussions) {
            const current = byDiscussion.get(entry.discussion.id);
            byDiscussion.set(entry.discussion.id, current ? { ...entry, occurrences: [...current.occurrences, ...entry.occurrences] } : entry);
        }
        const discussions = [...byDiscussion.values()];
        attentionPages = pages;
        publishAttention({ discussions, nextCursor: cursor,
            incomplete: pages.some(page => page.incomplete), status: 'ready', errorCode: null });
    };
    const refreshAttention = (signal?: AbortSignal): Promise<void> => {
        if (attentionInFlight) return attentionInFlight;
        const pending = readAttentionPages(false, signal).finally(() => { if (attentionInFlight === pending) attentionInFlight = null; });
        attentionInFlight = pending;
        return pending;
    };
    // A change may commit after a pending HTTP read took its snapshot. Share
    // demanded reads, but reread after that snapshot before settling a change.
    const refreshAttentionAfterChange = async (signal?: AbortSignal): Promise<void> => {
        const operation = captureOperation();
        if (attentionInFlight) await attentionInFlight;
        if (isCurrentOperation(operation)) await refreshAttention(signal);
    };

    const replaceAttentionDiscussion = (discussionId: string,
        replacement: DiscussionAttentionResultV1['discussions'][number] | null, incomplete = false): void => {
        const previous = snapshot.attention;
        const current = previous.discussions.find(entry => entry.discussion.id === discussionId);
        if (replacement) replacement = reconcileAttentionEntry(current, replacement);
        const nextIncomplete = previous.incomplete || incomplete;
        if ((replacement === current || replacement === null && current === undefined)
            && nextIncomplete === previous.incomplete && previous.status === 'ready' && previous.errorCode === null) return;
        const discussions = snapshot.attention.discussions.filter(entry => entry.discussion.id !== discussionId);
        if (replacement) {
            const newest = replacement.occurrences[0]!.message;
            const position = discussions.findIndex(entry => {
                const other = entry.occurrences[0]!.message;
                return newest.createdAt > other.createdAt || newest.createdAt === other.createdAt && newest.id > other.id;
            });
            discussions.splice(position < 0 ? discussions.length : position, 0, replacement);
        }
        // Keep page custody coherent for the next older-page demand too.
        attentionPages = attentionPages.map(page => ({ ...page,
            discussions: page.discussions.filter(entry => entry.discussion.id !== discussionId) }));
        if (replacement && attentionPages[0]) attentionPages[0] = { ...attentionPages[0],
            discussions: [replacement, ...attentionPages[0].discussions] };
        publishAttention({ ...snapshot.attention, discussions,
            incomplete: nextIncomplete, status: 'ready', errorCode: null });
    };

    // The global cursor describes the retained occurrence window, not a count
    // of Discussions. Refresh one id inside that window without moving its edge.
    const refreshAttentionDiscussion = (discussionId: string, signal?: AbortSignal): Promise<void> => {
        const preceding = attentionInFlight;
        const operation = captureOperation(discussionId);
        const pending = (async () => {
            if (preceding) await preceding;
            if (!isCurrentOperation(operation) || signal?.aborted) return;
            const afterCursor = snapshot.attention.nextCursor;
            const entries: DiscussionAttentionResultV1['discussions'][number][] = [];
            let cursor: string | null = null;
            let incomplete = false;
            do {
                const outcome = await client.attention({ discussionId, ...(afterCursor ? { afterCursor } : {}), ...(cursor ? { cursor } : {}) }, signal);
                if (!isCurrentOperation(operation) || signal?.aborted) return;
                if (outcome.kind !== 'succeeded' || outcome.value.serverId !== options.scope.serverId
                    || outcome.value.discussions.some(entry => entry.discussion.id !== discussionId)) {
                    const code = outcome.kind === 'failed' ? outcome.errorCode : 'discussion_invalid_content';
                    if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
                    else if (code !== 'canceled') publish({ ...snapshot, attention: {
                        ...snapshot.attention, status: statusForFailure(code), errorCode: code } });
                    return;
                }
                entries.push(...outcome.value.discussions);
                incomplete ||= outcome.value.incomplete;
                cursor = outcome.value.nextCursor;
            } while (cursor);
            const occurrences = entries.flatMap(entry => entry.occurrences);
            const first = entries[0];
            const replacement = first && occurrences.length > 0 ? { ...first, occurrences } : null;
            replaceAttentionDiscussion(discussionId, replacement, incomplete);
        })().finally(() => { if (attentionInFlight === pending) attentionInFlight = null; });
        attentionInFlight = pending;
        return pending;
    };

    const refreshMountedSnapshot = async (): Promise<void> => {
        const epoch = accessLossEpoch;
        const anchors = [...(homeMountReferences > 0 ? [undefined] : []), ...[...mountedAnchors.values()].map(entry => entry.anchor)];
        await Promise.all([
            ...anchors.flatMap(anchor => (['active', 'archived'] as const)
                .filter(state => state === 'active' || getListSnapshot(anchor).lists[state].status !== 'idle')
                .map(state => refreshList(state, undefined, anchor, { complete: isDocListAnchor(anchor) }))),
            ...(attentionMountReferences > 0 ? [refreshAttentionAfterChange()] : []),
        ]);
        if (epoch !== accessLossEpoch) return;
        await refreshLoaded([...new Set([...mountedThreads.keys(), ...mountedSummaries.keys()])], new Map(),
            { attentionAlreadyRefreshed: true });
    };

    return {
        scope: options.scope,
        getSnapshot: () => snapshot,
        getListSnapshot,
        getDocListSnapshot: (artifactId: string) => getListSnapshot({ anchorDocArtifactId: artifactId }).lists.active,
        subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
        /** Plugin observations borrow canonical summary custody, never a second loader. */
        async readSummaryObservation(discussionId: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<Readonly<{ discussionId: string; revision: number }>>> {
            const operation = captureOperation(discussionId);
            if (signal?.aborted) return { kind: 'failed', errorCode: 'canceled' };
            const pending = summaryInFlight.get(discussionId);
            if (pending) await pending;
            else {
                const thread = snapshot.threads[discussionId];
                // Mounted demand receives push freshness. A new unobserved read
                // or an explicit retry after a transport refusal needs a fresh
                // canonical read; concurrent consumers join its in-flight owner.
                const observed = mountedThreads.has(discussionId) || mountedSummaries.has(discussionId);
                if (!observed || !thread?.summary && !thread?.errorCode
                    || thread?.errorCode && !isExplicitAccessLoss(thread.errorCode)) await refreshSummary(discussionId);
            }
            if (!isCurrentOperation(operation)) return { kind: 'failed', errorCode: snapshot.threads[discussionId]?.errorCode ?? 'discussion_read_denied' };
            if (signal?.aborted) return { kind: 'failed', errorCode: 'canceled' };
            const thread = snapshot.threads[discussionId];
            return thread?.summary && !thread.errorCode
                ? { kind: 'succeeded', value: { discussionId, revision: thread.changeRevision ?? 0 } }
                : { kind: 'failed', errorCode: thread?.errorCode ?? 'discussion_not_found' };
        },
        subscribeSummaryObservation(discussionId: string, listener: () => void) {
            const observers = summaryObservers.get(discussionId) ?? new Set<() => void>();
            summaryObservers.set(discussionId, observers);
            observers.add(listener);
            return () => { observers.delete(listener); if (!observers.size) summaryObservers.delete(discussionId); };
        },
        subscribeSettingsChanges(discussionId: string, listener: () => void) {
            const observers = settingsObservers.get(discussionId) ?? new Set<() => void>();
            settingsObservers.set(discussionId, observers);
            observers.add(listener);
            return () => { observers.delete(listener); if (!observers.size) settingsObservers.delete(discussionId); };
        },
        /** Dependent private reads share the resource's existing currentness and access-loss owner. */
        captureReadOperation(discussionId: string) {
            const operation = captureOperation(discussionId);
            return {
                isCurrent: () => isCurrentOperation(operation),
                observeFailure(errorCode: string) {
                    if (!isCurrentOperation(operation) || !isExplicitAccessLoss(errorCode)) return;
                    purgeDiscussion(discussionId, errorCode);
                },
            };
        },
        /** Existing access epochs, not message arrivals, identify an admitted read lifetime. */
        getReadCurrentnessKey(discussionId: string) {
            return `${accessLossEpoch}:${resourceEpochs.get(discussionId) ?? 0}`;
        },
        setClient(nextClient: DiscussionRepositoryClient) { client = nextClient; },
        refreshList,
        refreshDocList: (artifactId: string, signal?: AbortSignal) => refreshList('active', signal, { anchorDocArtifactId: artifactId }, { complete: true }),
        readList,
        refreshAttention,
        async loadMoreAttention(signal?: AbortSignal) {
            while (attentionInFlight) await attentionInFlight;
            if (!snapshot.attention.nextCursor) return;
            const pending = readAttentionPages(true, signal).finally(() => { if (attentionInFlight === pending) attentionInFlight = null; });
            attentionInFlight = pending;
            return pending;
        },
        loadMoreList,
        loadCompleteList,
        refreshSummary,
        refreshAnchoredList(anchorSessionId: string, state: 'active' | 'archived', signal?: AbortSignal) { return refreshList(state, signal, anchorSessionId); },
        loadMoreAnchoredList(anchorSessionId: string, state: 'active' | 'archived', signal?: AbortSignal) { return loadMoreList(state, signal, anchorSessionId); },
        refreshDiscussion,
        /** Reopen one committed message in its own Home without acquiring unrelated history. */
        async openMessage(ref: DiscussionMessageRefV1, signal?: AbortSignal): Promise<DiscussionOpenedMessageV1 | null> {
            if (ref.discussion.serverId !== options.address.serverId) return null;
            const discussionId = ref.discussion.discussionId;
            if (!await refreshSummary(discussionId, signal)) return null;
            return readExactMessage(discussionId, ref.messageId, signal);
        },
        /** Apply an admitted removal to a message already held by this Account's projection. */
        recordAttachmentRemoval(discussionId: string, messageId: string, removal: DiscussionAttachmentRemovedV1): void {
            const thread = snapshot.threads[discussionId];
            const message = thread?.messages.find(row => row.id === messageId);
            if (!thread || !message) return;
            const messages = mergeDiscussionMessages(thread.messages, [{ ...message, removedAttachments: [removal] }]);
            updateThread(discussionId, { ...thread, messages });
        },
        refreshMessages,
        loadOlderMessages,
        create(input: Omit<CreateIntent, 'kind'>, signal?: AbortSignal) { return executeCreate({ kind: 'create', ...input }, signal); },
        post(input: Omit<PostIntent, 'kind'>, signal?: AbortSignal) { return executePost({ kind: 'post', ...input }, signal); },
        canRetryDelivery,
        /** Replay the author's committed Post Action; never allocate a second ask or disturb the draft. */
        async retryDelivery(discussionId: string, messageId: string, signal?: AbortSignal): Promise<DiscussionPostOutcome> {
            const message = snapshot.threads[discussionId]?.messages.find(message => message.id === messageId);
            if (!canRetryDelivery(message)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
            const operation = captureOperation(discussionId);
            const outcome = await client.post({ discussionId, localId: message.localId, content: message.content,
                mentionedAccountIds: message.mentionedAccountIds, replyTarget: message.replyTarget }, signal);
            if (!isCurrentOperation(operation)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
            if (outcome.kind === 'succeeded') {
                const retained = snapshot.threads[discussionId] ?? emptyThread();
                updateThread(discussionId, { ...retained, messages: mergeDiscussionMessages(retained.messages, [outcome.value.message]),
                    messageSeq: Math.max(retained.messageSeq, outcome.value.messageSeq) });
            }
            return outcome;
        },
        retry,
        adoptPendingIntent,
        acknowledgeObservedSuccess(localId: string) {
            if (snapshot.mutations[localId]?.status !== 'observed_success') return false;
            updateMutation(localId, null);
            intents.delete(localId);
            return true;
        },
        /**
         * Drops a settled failure together with its retry identity. The V2
         * draft owner still holds the text, so the next send is a fresh
         * attempt under a new local id rather than a repeat of the refused one.
         */
        dismissFailure(localId: string) {
            if (snapshot.mutations[localId]?.status !== 'failed') return false;
            updateMutation(localId, null);
            intents.delete(localId);
            return true;
        },
        async rename(discussionId: string, title: string, signal?: AbortSignal) {
            const operationEpoch = captureOperation(discussionId);
            return applyLifecycleOutcome(discussionId, await client.rename(discussionId, title, signal), operationEpoch);
        },
        async archive(discussionId: string, signal?: AbortSignal) {
            const operationEpoch = captureOperation(discussionId);
            return applyLifecycleOutcome(discussionId, await client.archive(discussionId, signal), operationEpoch);
        },
        async restore(discussionId: string, signal?: AbortSignal) {
            const operationEpoch = captureOperation(discussionId);
            return applyLifecycleOutcome(discussionId, await client.restore(discussionId, signal), operationEpoch);
        },
        participants: (discussionId: string, signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.participants(discussionId, signal), signal, false),
        getSettings: (discussionId: string, signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.getSettings(discussionId, signal), signal, false),
        setSettings: (discussionId: string, settings: Parameters<DiscussionRepositoryClient['setSettings']>[1], signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.setSettings(discussionId, settings, signal), signal, false),
        setParticipantPolicy: (input: Parameters<DiscussionRepositoryClient['setParticipantPolicy']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.setParticipantPolicy(input, signal), signal),
        listGrants: (discussionId: string, signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.listGrants(discussionId, signal), signal, false),
        invite: (input: Parameters<DiscussionRepositoryClient['invite']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.invite(input, signal), signal),
        inviteExecutableParticipant: (input: Parameters<DiscussionRepositoryClient['inviteExecutableParticipant']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.inviteExecutableParticipant(input, signal), signal),
        removeParticipant: (input: Parameters<DiscussionRepositoryClient['removeParticipant']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.removeParticipant(input, signal), signal),
        leave: (discussionId: string, signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.leave(discussionId, signal), signal),
        transferOwner: (input: Parameters<DiscussionRepositoryClient['transferOwner']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.transferOwner(input, signal), signal),
        setGrant: (input: Parameters<DiscussionRepositoryClient['setGrant']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.setGrant(input, signal), signal),
        removeGrant: (input: Parameters<DiscussionRepositoryClient['removeGrant']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.removeGrant(input, signal), signal),
        async setReadState(discussionId: string, lastReadSeq: number, signal?: AbortSignal): Promise<DiscussionReadStateWriteOutcome> {
            const operationEpoch = captureOperation(discussionId);
            const outcome = await client.readState(discussionId, lastReadSeq, signal);
            if (!isCurrentOperation(operationEpoch)) {
                return { kind: 'stopped', errorCode: 'discussion_read_denied' };
            }
            if (outcome.kind === 'succeeded') {
                if (attentionMountReferences > 0) await refreshAttentionDiscussion(discussionId, signal);
                return { kind: 'succeeded', lastReadSeq: outcome.value.cursor.lastReadSeq };
            }
            if (outcome.kind === 'approval_request_created') {
                return { kind: 'stopped', errorCode: 'approval_request_created' };
            }
            if (isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(discussionId, outcome.errorCode);
            return isPermanentReadStateRefusal(outcome.errorCode)
                ? { kind: 'stopped', errorCode: outcome.errorCode }
                : { kind: 'retryable', errorCode: outcome.errorCode };
        },
        mount(input?: Readonly<{ anchorSessionId?: string; anchorDocArtifactId?: string; commentsOnItems?: true; discussionId?: string; projection?: 'summary'; attention?: boolean }>) {
            mountReferences += 1;
            const anchor: ListAnchor | undefined = input?.anchorDocArtifactId !== undefined ? { anchorDocArtifactId: input.anchorDocArtifactId }
                : input?.commentsOnItems ? ITEM_COMMENTS_DISCUSSION_LIST_SCOPE : input?.anchorSessionId;
            const threadId = input?.discussionId;
            const threadMounts = input?.projection === 'summary' ? mountedSummaries : mountedThreads;
            if (input?.attention) attentionMountReferences += 1;
            else if (threadId !== undefined) threadMounts.set(threadId, (threadMounts.get(threadId) ?? 0) + 1);
            else if (anchor === undefined) homeMountReferences += 1;
            else { const key = listAnchorKey(anchor); mountedAnchors.set(key, { anchor, count: (mountedAnchors.get(key)?.count ?? 0) + 1 }); }
            if (!mountedWatch) {
                mountedWatch = watchMountedDiscussions({ scope: options.scope, address: options.address,
                    includeDocSourceChanges: () => attentionMountReferences > 0 || [...mountedAnchors.values()].some(entry => isDocListAnchor(entry.anchor)),
                    onSnapshotInvalidated: () => { void refreshMountedSnapshot(); },
                    readNotCurrent: () => {
                        const failed = (status: DiscussionRepositoryStatus | undefined) => status === 'offline' || status === 'error';
                        if (attentionMountReferences > 0 && failed(snapshot.attention.status)) return true;
                        const anchors = [...(homeMountReferences > 0 ? [undefined] : []), ...[...mountedAnchors.values()].map(entry => entry.anchor)];
                        if (anchors.some(anchor => failed(getListSnapshot(anchor).lists.active.status)
                            || failed(getListSnapshot(anchor).lists.archived.status))) return true;
                        return [...mountedThreads.keys(), ...mountedSummaries.keys()].some(id => failed(snapshot.threads[id]?.status));
                    },
                    onSettingsInvalidated: discussionId => {
                        for (const listener of settingsObservers.get(discussionId) ?? []) listener();
                    },
                    onInvalidated: (discussionIds, revisions, readStateOnlyIds, docArtifactIds, messageChanges) => {
                        void refreshLoaded(discussionIds, revisions, { readStateOnlyIds, docArtifactIds, messageChanges });
                    } });
            }
            let released = false;
            return () => {
                if (released) return;
                released = true;
                mountReferences -= 1;
                if (input?.attention) attentionMountReferences -= 1;
                else if (threadId !== undefined) {
                    const remaining = (threadMounts.get(threadId) ?? 1) - 1;
                    if (remaining > 0) threadMounts.set(threadId, remaining);
                    else threadMounts.delete(threadId);
                }
                else if (anchor === undefined) homeMountReferences -= 1;
                else {
                    const key = listAnchorKey(anchor);
                    const remaining = (mountedAnchors.get(key)?.count ?? 1) - 1;
                    if (remaining > 0) mountedAnchors.set(key, { anchor, count: remaining });
                    else mountedAnchors.delete(key);
                }
                if (mountReferences === 0) {
                    mountedWatch?.dispose();
                    mountedWatch = null;
                }
            };
        },
        isMounted: () => mountReferences > 0,
        clear() {
            accessLossEpoch += 1;
            mountedWatch?.dispose();
            mountedWatch = null;
            mountReferences = 0;
            homeMountReferences = 0;
            attentionMountReferences = 0;
            attentionPages = [];
            attentionInFlight = null;
            listInFlight.clear();
            summaryInFlight.clear();
            mountedAnchors.clear();
            mountedThreads.clear();
            mountedSummaries.clear();
            listPages.active = [];
            listPages.archived = [];
            anchorPages.clear();
            resourceEpochs.clear();
            intents.clear();
            publish({ address: options.address, lists: { active: EMPTY_LIST, archived: EMPTY_LIST }, archivedExistence: 'unknown',
                attention: EMPTY_ATTENTION, anchors: {}, threads: {}, mutations: {} });
            for (const id of summaryObservers.keys()) notifySummaryObservers(id);
        },
    };
}

export type DiscussionRepository = ReturnType<typeof createDiscussionRepository>;
