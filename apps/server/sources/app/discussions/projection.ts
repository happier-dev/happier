import { DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1, DiscussionRoundOutcomeV1StoredSchema, DocEditProposalDispositionV1Schema, type DiscussionCapabilitiesV1, type DiscussionMessageV1, type DiscussionSummaryV1 } from '@happier-dev/protocol/discussions/models';
import { DiscussionMessageContentV1Schema, DiscussionProducerV1StoredSchema, DiscussionTitleV1Schema } from '@happier-dev/protocol/discussions/content';
import { DiscussionMessageAddressingV1Schema } from '@happier-dev/protocol/discussions/participants';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { type SessionMessageAccountActorV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';

import { resolveDiscussionAudiencesInTx, type DiscussionContext } from './access';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { getActivePrismaRuntime } from "@/storage/prisma";
import { prismaRuntime as sql } from '@/storage/prisma';
import { discussionSqlName as name } from './readSql';
import type { Tx } from "@/storage/inTx";
import type { Prisma } from '@prisma/client';
import { projectAuthenticatedAccountActorsById } from '@/app/session/messages/projectSessionMessageAccountActors';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';

export type DiscussionStoredContentFailure =
    | "discussion_encryption_mode_mismatch"
    | "discussion_invalid_content";

/**
 * Validates an opaque persisted envelope before any caller can receive it.
 *
 * The resource mode, admitted against its owner's Account mode, is authoritative. A structurally valid envelope
 * of the opposite mode is therefore a typed consistency failure, while an
 * envelope that is not part of the strict wire union is invalid content. The
 * message admission carries its parsed envelope into projections in the same
 * transaction.
 */
export function validateDiscussionStoredContent(
    value: unknown,
    storageMode: "plain" | "e2ee",
    semanticKind: "title" | "message",
): DiscussionStoredContentFailure | null {
    const admitted = admitDiscussionStoredContent(value, storageMode, semanticKind);
    return admitted.ok ? null : admitted.error;
}

export function admitDiscussionStoredContent(
    value: unknown,
    storageMode: 'plain' | 'e2ee',
    semanticKind: 'title' | 'message',
): Readonly<{ ok: true; value: DiscussionMessageV1['content'] }> | Readonly<{ ok: false; error: DiscussionStoredContentFailure }> {
    const parsed = createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema).safeParse(value);
    if (!parsed.success) return { ok: false, error: 'discussion_invalid_content' };
    const expectedKind = storageMode === "e2ee" ? "encrypted" : "plain";
    if (parsed.data.t !== expectedKind) return { ok: false, error: 'discussion_encryption_mode_mismatch' };
    if (parsed.data.t === "plain") {
        const semanticSchema = semanticKind === "title"
            ? DiscussionTitleV1Schema
            : DiscussionMessageContentV1Schema;
        if (!createStoredReadSchema(semanticSchema).safeParse(parsed.data.v).success) {
            return { ok: false, error: 'discussion_invalid_content' };
        }
    }
    return { ok: true, value: parsed.data };
}

export const DISCUSSION_SELECT = {
    id: true,
    ownerAccountId: true,
    encryptionMode: true,
    dataEncryptionKey: true,
    anchorV1: true,
    roundOutcomeV1: true,
    openCommentCount: true,
    anchorSessionId: true,
    creationLocalId: true,
    createdByAccountId: true,
    titleContent: true,
    messageSeq: true,
    lastMessageAt: true,
    archivedAt: true,
} as const;

export const DISCUSSION_MESSAGE_SELECT = {
    id: true,
    discussionId: true,
    localId: true,
    seq: true,
    authorAccountId: true,
    producerV1: true,
    replyTargetV1: true,
    addressingV1: true,
    docEditProposalDispositionV1: true,
    content: true,
    createdAt: true,
    mentions: { select: { accountId: true }, orderBy: { accountId: "asc" } },
    attachments: { where: { removedByAccountId: { not: null } }, select: { blobId: true, removedByAccountId: true } },
} as const;

export type DiscussionRow = Readonly<{
    id: string;
    ownerAccountId: string;
    encryptionMode: string;
    dataEncryptionKey: Uint8Array;
    anchorV1: unknown;
    roundOutcomeV1: unknown;
    openCommentCount: number;
    anchorSessionId: string | null;
    creationLocalId: string;
    createdByAccountId: string | null;
    titleContent: unknown;
    messageSeq: number;
    lastMessageAt: Date;
    archivedAt: Date | null;
}>;

export type DiscussionMessageRow = Readonly<{
    id: string;
    discussionId: string;
    localId: string;
    seq: number;
    authorAccountId: string | null;
    producerV1: unknown;
    replyTargetV1: unknown;
    addressingV1?: unknown;
    docEditProposalDispositionV1?: unknown;
    content: unknown;
    createdAt: Date;
    mentions: readonly Readonly<{ accountId: string }>[];
    attachments?: readonly Readonly<{ blobId: string; removedByAccountId: string | null }>[];
}>;

export type AdmittedDiscussionMessageRow = Omit<DiscussionMessageRow,
    'content' | 'producerV1' | 'replyTargetV1' | 'addressingV1' | 'docEditProposalDispositionV1'> & Readonly<{
    content: DiscussionMessageV1['content'];
    producerV1: DiscussionMessageV1['producerV1'];
    replyTargetV1: NonNullable<DiscussionMessageV1['replyTarget']> | null;
    addressingV1: DiscussionMessageV1['addressingV1'];
    docEditProposalDispositionV1: DiscussionMessageV1['docEditProposalDispositionV1'];
}>;

/** Admit storage once; every downstream actor/content projection consumes these validated fields. */
export function admitDiscussionStoredMessage(row: DiscussionMessageRow, storageMode: 'plain' | 'e2ee',
    admissions?: Map<string, AdmittedDiscussionMessageRow>):
    DiscussionResult<AdmittedDiscussionMessageRow> {
    // Shared only within one response's read snapshot, never across access checks or reads.
    const admitted = admissions?.get(row.id);
    if (admitted) return discussionSuccess(admitted);
    const content = admitDiscussionStoredContent(row.content, storageMode, 'message');
    if (!content.ok) return content;
    const disposition = row.docEditProposalDispositionV1 == null ? null : DocEditProposalDispositionV1Schema.safeParse(row.docEditProposalDispositionV1);
    if (disposition && !disposition.success) return discussionFailure('discussion_invalid_content');
    const reply = row.replyTargetV1 == null ? null : DiscussionReplyTargetV1Schema.safeParse(row.replyTargetV1);
    if (reply && !reply.success) return discussionFailure('discussion_invalid_content');
    const addressing = row.addressingV1 == null ? null : DiscussionMessageAddressingV1Schema.safeParse(row.addressingV1);
    if (addressing && (!addressing.success || addressing.data.throughSeq !== row.seq)) return discussionFailure('discussion_invalid_content');
    const producer = row.producerV1 == null ? null : admitDiscussionStoredProducer(row.producerV1);
    if (producer && !producer.success) return discussionFailure('discussion_invalid_content');
    const value: AdmittedDiscussionMessageRow = { ...row, content: content.value, producerV1: producer?.data ?? null,
        replyTargetV1: reply?.data ?? null, addressingV1: addressing?.data ?? null,
        docEditProposalDispositionV1: disposition?.data };
    admissions?.set(row.id, value);
    return discussionSuccess(value);
}

function readEnvelope(value: unknown) {
    return createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema).parse(value);
}

function admitDiscussionStoredProducer(value: unknown) {
    return DiscussionProducerV1StoredSchema.safeParse(value);
}

export type DiscussionAccountActorSubject = Readonly<{ discussionId: string; accountId: string; serverId?: string }>;

function addDiscussionAccountActorSubject(bucket: Map<string, DiscussionAccountActorSubject>, subject: DiscussionAccountActorSubject): void {
    const existing = bucket.get(subject.accountId);
    if (subject.serverId !== undefined && existing && existing.serverId === undefined) return;
    bucket.set(subject.accountId, subject);
}

/** One sanitized, batched projection for admitted message rows and their explicit roster. */
export async function projectDiscussionAccountActorsInTx(tx: Tx, rows: readonly AdmittedDiscussionMessageRow[], participants: readonly DiscussionAccountActorSubject[] = [],
    admittedAudiences?: ReadonlyMap<string, readonly string[]>): Promise<{
    messages: { accountActor: SessionMessageAccountActorV1 | null; requesterAccountActor: SessionMessageAccountActorV1 | null }[];
    participants: (SessionMessageAccountActorV1 | null)[];
}> {
    const discussionIds = [...new Set([...rows.map(row => row.discussionId), ...participants.map(participant => participant.discussionId)])];
    const missingDiscussionIds = discussionIds.filter(discussionId => !admittedAudiences?.has(discussionId));
    const loadedAudiences = await resolveDiscussionAudiencesInTx(tx, missingDiscussionIds);
    const audiences = new Map<string, readonly string[]>([...(admittedAudiences ?? []), ...loadedAudiences]);
    const audienceByDiscussionId = new Map([...audiences].map(([discussionId, accountIds]) => [discussionId, new Set(accountIds)]));
    const accessibility = (discussionId: string, accountId: string | null | undefined): SessionMessageAccountActorV1['accessibility'] =>
        accountId && audienceByDiscussionId.get(discussionId)?.has(accountId) ? 'current' : 'former';
    const requesters = rows.map(row => {
        const producer = row.producerV1;
        return producer?.kind === 'agent' ? producer.actionRequestAttributionV1?.requester : undefined;
    });
    const home = requesters.some(requester => requester != null) || participants.some(participant => participant.serverId !== undefined)
        ? await readCurrentServerIdentityId(undefined, tx) : null;
    // A matching Account id on another Home is not this Home's person.
    const requesterIds = requesters.map(requester => home && requester?.serverId === home ? requester.accountId : null);
    const participantIds = participants.map(participant => participant.serverId === undefined || participant.serverId === home
        ? participant.accountId : null);
    const actors = await projectAuthenticatedAccountActorsById(tx, [
        ...rows.map(row => row.authorAccountId), ...requesterIds, ...participantIds,
    ], [
        ...rows.map(row => accessibility(row.discussionId, row.authorAccountId)),
        ...rows.map((row, index) => accessibility(row.discussionId, requesterIds[index])),
        ...participants.map((participant, index) => accessibility(participant.discussionId, participantIds[index])),
    ]);
    return {
        messages: rows.map((_, index) => ({ accountActor: actors[index] ?? null, requesterAccountActor: actors[rows.length + index] ?? null })),
        participants: actors.slice(rows.length * 2),
    };
}

/**
 * Known actors use server-written authorship and canonically admitted producers inside the viewer's admitted Discussion;
 * message-content validity does not gate authorship, so this owner never reads historical bodies or ciphertext.
 */
export async function loadDiscussionKnownAccountActorFactsInTx(tx: Tx, discussionIds: readonly string[],
    messageAdmissions?: ReadonlyMap<string, AdmittedDiscussionMessageRow>): Promise<Readonly<{
    subjectsByDiscussion: ReadonlyMap<string, readonly DiscussionAccountActorSubject[]>;
    recentAuthorAccountIdsByDiscussion: ReadonlyMap<string, readonly string[]>;
}>> {
    const subjectBuckets = new Map(discussionIds.map(discussionId => [discussionId, new Map<string, DiscussionAccountActorSubject>()]));
    const recentAuthors = new Map(discussionIds.map(discussionId => [discussionId, new Map<string, number>()]));
    if (discussionIds.length === 0) return { subjectsByDiscussion: new Map(), recentAuthorAccountIdsByDiscussion: new Map() };
    const [authorGroups, producerRows] = await Promise.all([
        tx.discussionMessage.groupBy({
            by: ['discussionId', 'authorAccountId'],
            where: { discussionId: { in: [...discussionIds] }, NOT: { authorAccountId: null } },
            _max: { seq: true },
        }),
        tx.discussionMessage.findMany({
            where: { discussionId: { in: [...discussionIds] }, producerV1: { not: getActivePrismaRuntime().DbNull } },
            select: { id: true, discussionId: true, producerV1: true },
        }),
    ]);
    for (const group of authorGroups) {
        if (group.authorAccountId === null) continue;
        const subjects = subjectBuckets.get(group.discussionId);
        const authors = recentAuthors.get(group.discussionId);
        if (!subjects || !authors) continue;
        addDiscussionAccountActorSubject(subjects, { discussionId: group.discussionId, accountId: group.authorAccountId });
        authors.set(group.authorAccountId, group._max.seq ?? 0);
    }
    for (const row of producerRows) {
        const subjects = subjectBuckets.get(row.discussionId);
        if (!subjects) continue;
        const admitted = messageAdmissions?.get(row.id);
        const parsed = admitted || row.producerV1 == null ? undefined : admitDiscussionStoredProducer(row.producerV1);
        const producer = admitted ? admitted.producerV1 : parsed?.success ? parsed.data : null;
        const requester = producer?.kind === 'agent' ? producer.actionRequestAttributionV1?.requester : undefined;
        if (requester) addDiscussionAccountActorSubject(subjects, {
            discussionId: row.discussionId, accountId: requester.accountId, serverId: requester.serverId,
        });
    }
    return {
        subjectsByDiscussion: new Map([...subjectBuckets].map(([discussionId, subjects]) => [discussionId, [...subjects.values()]])),
        recentAuthorAccountIdsByDiscussion: new Map([...recentAuthors].map(([discussionId, authors]) => [discussionId,
            [...authors].sort((left, right) => right[1] - left[1]).slice(0, DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1).map(([accountId]) => accountId)])),
    };
}

/**
 * Effective, server-evaluated discussion capabilities.
 *
 * Capabilities project the shared resource grant and current key readiness;
 * they are not a second ACL or inherited source-Session permissions.
 */
export function projectDiscussionCapabilitiesV1(params: Readonly<{
    access: DiscussionContext['access'];
    discussionArchived: boolean;
    keyReadiness?: boolean;
    inheritedAudience?: boolean;
}>): DiscussionCapabilitiesV1 {
    const canSubmit = params.access.level !== 'view' && params.keyReadiness !== false;
    const canManage = params.access.level === 'owner' || params.access.level === 'admin';
    return {
        postMessages: canSubmit && !params.discussionArchived,
        rename: canManage && !params.discussionArchived,
        archive: canManage && !params.discussionArchived,
        restore: canManage && params.discussionArchived,
        askAgent: canSubmit && !params.discussionArchived,
        sendToSession: canSubmit && !params.discussionArchived,
        manageAccess: canManage && !params.inheritedAudience,
        leave: params.access.level !== 'owner' && !params.inheritedAudience,
    };
}

/** A client-chosen local request identity is projected only back to its author. */
export function projectDiscussionMessageV1(
    row: AdmittedDiscussionMessageRow,
    viewerAccountId: string,
    accountActor: SessionMessageAccountActorV1 | null,
    requesterAccountActor: SessionMessageAccountActorV1 | null = null,
): DiscussionMessageV1 {
    const removedAttachments = row.attachments?.flatMap(({ blobId, removedByAccountId }) =>
        removedByAccountId === null ? [] : [{ blobId, removedByAccountId }]);
    return {
        id: row.id,
        discussionId: row.discussionId,
        localId: row.authorAccountId === viewerAccountId ? row.localId : null,
        seq: row.seq,
        authorAccountId: row.authorAccountId,
        accountActor,
        requesterAccountActor,
        producerV1: row.producerV1,
        ...(row.replyTargetV1 == null ? {} : { replyTarget: row.replyTargetV1 }),
        content: row.content,
        mentionedAccountIds: row.mentions.map((mention) => mention.accountId),
        ...(removedAttachments?.length ? { removedAttachments } : {}),
        addressingV1: row.addressingV1 ?? null,
        ...(row.docEditProposalDispositionV1 == null ? {} : { docEditProposalDispositionV1: row.docEditProposalDispositionV1 }),
        createdAt: row.createdAt.getTime(),
    };
}

export type DiscussionViewerFacts = Readonly<{
    lastReadSeq: number | null;
    unreadCount: number;
    unreadMentionCount: number;
    recentAuthorAccountIds: readonly string[];
    participantAccountSubjects: readonly DiscussionAccountActorSubject[];
    participantSessionIds: readonly string[];
    latestMessage: DiscussionMessageRow;
    firstMessage?: DiscussionMessageRow;
}>;

/**
 * Loads every viewer-dependent summary fact for one page of discussions.
 *
 * All of it is derived, never stored: unread comes from the viewer's private
 * cursor, mentions from the sparse attention rows, and recent authors from the
 * actual message authors. Roster display reads the explicit grants and active
 * Session bindings; there is no separate summary or human-membership store.
 */
export async function loadDiscussionViewerFactsInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    discussions: readonly DiscussionRow[];
    tracked: boolean;
    includeFirstMessage?: boolean;
    messages?: readonly DiscussionMessageRow[];
    messageAdmissions?: ReadonlyMap<string, AdmittedDiscussionMessageRow>;
}>): Promise<ReadonlyMap<string, DiscussionViewerFacts>> {
    const facts = new Map<string, DiscussionViewerFacts>();
    if (params.discussions.length === 0) return facts;
    const discussionIds = params.discussions.map((discussion) => discussion.id);

    // Match the explicit roster's disclosure boundary. Collective grants do not
    // disclose membership; only Accounts already disclosed by content join the roster.
    const [accountGrants, participants, knownActors] = await Promise.all([
        tx.discussionGrant.findMany({ where: { principalKind: 'account', discussionId: { in: discussionIds } },
            select: { discussionId: true, accountId: true }, orderBy: { accountId: 'asc' } }),
        tx.discussionParticipant.findMany({ where: { discussionId: { in: discussionIds }, removedAt: null, sessionId: { not: null } },
            select: { discussionId: true, sessionId: true }, orderBy: { participantSlotId: 'asc' } }),
        loadDiscussionKnownAccountActorFactsInTx(tx, discussionIds, params.messageAdmissions),
    ]);
    const accountSubjectsByDiscussion = new Map(params.discussions.map(discussion => {
        const subjects = new Map<string, DiscussionAccountActorSubject>();
        addDiscussionAccountActorSubject(subjects, { discussionId: discussion.id, accountId: discussion.ownerAccountId });
        return [discussion.id, subjects] as const;
    }));
    for (const grant of accountGrants) {
        const subjects = accountSubjectsByDiscussion.get(grant.discussionId);
        if (subjects) addDiscussionAccountActorSubject(subjects, { discussionId: grant.discussionId, accountId: grant.accountId! });
    }
    for (const [discussionId, known] of knownActors.subjectsByDiscussion) {
        const subjects = accountSubjectsByDiscussion.get(discussionId);
        if (subjects) for (const subject of known) addDiscussionAccountActorSubject(subjects, subject);
    }
    const sessionsByDiscussion = new Map<string, string[]>();
    for (const participant of participants) {
        if (participant.sessionId === null) continue;
        const sessions = sessionsByDiscussion.get(participant.discussionId) ?? [];
        sessions.push(participant.sessionId);
        sessionsByDiscussion.set(participant.discussionId, sessions);
    }

    // Attention already holds some exact rows in this snapshot. Reuse them;
    // fetch only missing latest/root tuples, never the same message twice.
    const required = params.discussions.flatMap(discussion => [{ discussionId: discussion.id, seq: discussion.messageSeq },
        ...(params.includeFirstMessage && discussion.messageSeq !== 1 ? [{ discussionId: discussion.id, seq: 1 }] : [])]);
    const supplied = new Map((params.messages ?? []).map(row => [JSON.stringify([row.discussionId, row.seq]), row]));
    const summaryMessages: DiscussionMessageRow[] = [];
    const missing = required.filter(tuple => {
        const row = supplied.get(JSON.stringify([tuple.discussionId, tuple.seq]));
        if (row) summaryMessages.push(row);
        return row === undefined;
    });
    if (missing.length) summaryMessages.push(...await tx.discussionMessage.findMany({
        where: { OR: missing }, select: DISCUSSION_MESSAGE_SELECT,
    }));
    const latestSeqByDiscussion = new Map(params.discussions.map(discussion => [discussion.id, discussion.messageSeq]));
    const latestByDiscussion = new Map(summaryMessages.filter(row => latestSeqByDiscussion.get(row.discussionId) === row.seq)
        .map(row => [row.discussionId, row as DiscussionMessageRow]));
    const firstByDiscussion = new Map(summaryMessages.filter(row => row.seq === 1).map(row => [row.discussionId, row as DiscussionMessageRow]));

    const cursors = params.tracked
        ? await tx.discussionReadState.findMany({
            where: { accountId: params.viewerAccountId, discussionId: { in: discussionIds } },
            select: { discussionId: true, lastReadSeq: true },
        })
        : [];
    const cursorByDiscussion = new Map(cursors.map((row) => [row.discussionId, row.lastReadSeq]));

    const unreadCounts = await countUnreadMessagesInTx(tx, {
        viewerAccountId: params.viewerAccountId,
        cursors,
    });
    const unreadMentionCounts = await countUnreadMentionsInTx(tx, {
        viewerAccountId: params.viewerAccountId,
        cursors,
    });

    for (const discussion of params.discussions) {
        const latestMessage = latestByDiscussion.get(discussion.id);
        if (!latestMessage) continue;
        facts.set(discussion.id, {
            lastReadSeq: cursorByDiscussion.get(discussion.id) ?? null,
            unreadCount: unreadCounts.get(discussion.id) ?? 0,
            unreadMentionCount: unreadMentionCounts.get(discussion.id) ?? 0,
            recentAuthorAccountIds: knownActors.recentAuthorAccountIdsByDiscussion.get(discussion.id) ?? [],
            participantAccountSubjects: [...accountSubjectsByDiscussion.get(discussion.id)!.values()],
            participantSessionIds: sessionsByDiscussion.get(discussion.id) ?? [],
            latestMessage,
            ...(params.includeFirstMessage ? { firstMessage: firstByDiscussion.get(discussion.id) } : {}),
        });
    }
    return facts;
}

export type DiscussionCursorRow = Readonly<{ discussionId: string; lastReadSeq: number }>;

/**
 * Unread excludes the viewer's own direct human posts, which are never news to
 * their author. An Agent-produced row on the viewer's execution Account is not a
 * self-send and therefore still counts.
 *
 * The predicate is written positively so an erased (`NULL`) author still counts:
 * `NOT (author = viewer AND producer IS NULL)` would evaluate to `NULL` for those
 * rows and silently drop them.
 */
export function discussionUnreadMessagesWhere(params: Readonly<{
    viewerAccountId: string;
    cursors: readonly DiscussionCursorRow[];
}>): Prisma.DiscussionMessageWhereInput {
    return { AND: [{ OR: buildBeyondCursorPredicates(params.cursors) }, {
        OR: [{ authorAccountId: { not: params.viewerAccountId } }, { authorAccountId: null },
            { producerV1: { not: getActivePrismaRuntime().DbNull } }],
    }] };
}

/** Correlated equivalent of the cursor predicate for demand-bounded attention.
 * The cheap author predicate precedes cursor demand; own human posts need no
 * read-state join. m is the message in the calling attention query.
 */
export function discussionUnreadMessageSql(viewerAccountId: string): Prisma.Sql {
    return sql.sql`((m.${name('authorAccountId')} <> ${viewerAccountId} OR m.${name('authorAccountId')} IS NULL
            OR m.${name('producerV1')} IS NOT NULL)
        AND EXISTS (SELECT 1 FROM ${name('DiscussionReadState')} c
            WHERE c.${name('discussionId')} = m.${name('discussionId')} AND c.${name('accountId')} = ${viewerAccountId}
                AND c.${name('lastReadSeq')} < m.${name('seq')}))`;
}

export async function countUnreadMessagesInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    cursors: readonly DiscussionCursorRow[];
}>): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (params.cursors.length === 0) return counts;
    const groups = await tx.discussionMessage.groupBy({
        by: ["discussionId"],
        where: discussionUnreadMessagesWhere(params),
        _count: { _all: true },
    });
    for (const group of groups) counts.set(group.discussionId, group._count._all);
    return counts;
}

/** Sparse mention rows beyond the established cursor; absence never replays history. */
export async function countUnreadMentionsInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    cursors: readonly DiscussionCursorRow[];
}>): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (params.cursors.length === 0) return counts;
    const groups = await tx.discussionMessage.groupBy({
        by: ["discussionId"],
        where: {
            AND: [
                discussionUnreadMessagesWhere(params),
                { mentions: { some: { accountId: params.viewerAccountId } } },
            ],
        },
        _count: { _all: true },
    });
    for (const group of groups) counts.set(group.discussionId, group._count._all);
    return counts;
}

function buildBeyondCursorPredicates(cursors: readonly DiscussionCursorRow[]) {
    return cursors.map((cursor) => ({
        discussionId: cursor.discussionId,
        seq: { gt: cursor.lastReadSeq },
    }));
}

export function projectDiscussionSummaryV1(params: Readonly<{
    context: DiscussionContext;
    discussion: DiscussionRow;
    viewerAccountId: string;
    includeLatestMessageContent: boolean;
    facts: Omit<DiscussionViewerFacts, 'latestMessage'> & Readonly<{ latestMessage: AdmittedDiscussionMessageRow }>;
    latestMessageAccountActor: SessionMessageAccountActorV1 | null;
    latestMessageRequesterAccountActor?: SessionMessageAccountActorV1 | null;
    participantAccounts: readonly SessionMessageAccountActorV1[];
    capabilities: DiscussionCapabilitiesV1;
    recipientKeyPreparationRequired?: boolean;
}>): DiscussionSummaryV1 {
    const { discussion, facts, viewerAccountId } = params;
    const latest = facts.latestMessage;
    const round = DiscussionRoundOutcomeV1StoredSchema.safeParse(discussion.roundOutcomeV1);
    const anchor = discussion.anchorV1 == null ? null : DiscussionAnchorV1Schema.parse(discussion.anchorV1);
    return {
        id: discussion.id,
        ownerAccountId: discussion.ownerAccountId,
        encryptionMode: params.context.storageMode,
        anchor,
        roundOutcomeV1: round.success ? round.data : null,
        openCommentCount: anchor?.kind === 'doc' ? discussion.archivedAt === null ? discussion.openCommentCount : 0 : null,
        access: params.context.access.level,
        keyReadiness: params.context.keyReadiness,
        dataEncryptionKey: params.context.dataEncryptionKey,
        ...(params.context.taskKey ? { taskKey: params.context.taskKey } : {}),
        ...(params.recipientKeyPreparationRequired === undefined ? {}
            : { recipientKeyPreparationRequired: params.recipientKeyPreparationRequired }),
        creationLocalId: discussion.createdByAccountId === viewerAccountId ? discussion.creationLocalId : null,
        titleContent: readEnvelope(discussion.titleContent),
        latestMessage: {
            id: latest.id,
            localId: latest.authorAccountId === viewerAccountId ? latest.localId : null,
            seq: latest.seq,
            authorAccountId: latest.authorAccountId,
            accountActor: params.latestMessageAccountActor,
            requesterAccountActor: params.latestMessageRequesterAccountActor ?? null,
            producerV1: latest.producerV1,
            ...(params.includeLatestMessageContent ? { content: latest.content } : {}),
            createdAt: latest.createdAt.getTime(),
        },
        messageSeq: discussion.messageSeq,
        lastReadSeq: facts.lastReadSeq,
        unreadCount: facts.unreadCount,
        unreadMentionCount: facts.unreadMentionCount,
        recentAuthorAccountIds: [...facts.recentAuthorAccountIds],
        participantAccounts: [...params.participantAccounts],
        participantSessionIds: [...facts.participantSessionIds],
        archivedAt: discussion.archivedAt ? discussion.archivedAt.getTime() : null,
        capabilities: params.capabilities,
    };
}
