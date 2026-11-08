import { DISCUSSION_DEFAULT_PAGE_SIZE_V1, DISCUSSION_MAX_PAGE_SIZE_V1, DiscussionListQueryV1Schema, isDiscussionMessagesSelectionValidV1, type DiscussionDetailsResponseV1, type DiscussionListResponseV1, type DiscussionMessagesResponseV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import type { DiscussionSummaryV1, DiscussionMessageV1 } from '@happier-dev/protocol/discussions/models';
import { validateDiscussionDocContentSource, type DiscussionDocSource } from './docPassages';
import { admitDiscussionQuoteSourcesInTx, discussionQuoteSourceKey, resolveDiscussionQuoteSourcesInTx, type DiscussionQuoteSource } from './quoteReadAdmission';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resolveDiscussionContextInTx, resolveDiscussionContextsInTx, discussionCandidateWhere, discussionCandidateSql,
    isDiscussionRecipientKeyPreparationRequiredInTx, type DiscussionContext } from './access';
import { buildDiscussionListCursorPredicate, decodeDiscussionListCursorV1, encodeDiscussionListCursorV1 } from './pagination';
import { DISCUSSION_MESSAGE_SELECT, DISCUSSION_SELECT, loadDiscussionViewerFactsInTx, projectDiscussionAccountActorsInTx, projectDiscussionCapabilitiesV1, projectDiscussionMessageV1, projectDiscussionSummaryV1, validateDiscussionStoredContent, admitDiscussionStoredMessage, type AdmittedDiscussionMessageRow, type DiscussionRow, type DiscussionMessageRow } from './projection';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';
import { projectDiscussionMessageDeliveriesInTx } from './deliveryProjection';
import { prismaRuntime as sql } from '@/storage/prisma';
import { discussionJsonText, discussionSqlName as name, discussionSqlTimestamp } from './readSql';

/** Only the authenticated runtime/original supplies an executable destination. */
function contentDestination(authentication: SessionAccessAuthentication) {
    return authentication.contentDisclosureSessionId
        ? { kind: 'session' as const, sessionId: authentication.contentDisclosureSessionId } : undefined;
}

function pageSize(limit?: number): number {
    return limit === undefined || !Number.isSafeInteger(limit) || limit < 1
        ? DISCUSSION_DEFAULT_PAGE_SIZE_V1 : Math.min(limit, DISCUSSION_MAX_PAGE_SIZE_V1);
}

/** Mutation and read responses project the same live grant, key and private cursor facts. */
export async function projectDiscussionForViewerInTx(tx: Tx, input: Readonly<{
    context: DiscussionContext; viewerAccountId: string; authentication: SessionAccessAuthentication; discussion: DiscussionRow;
    messageAdmissions?: Map<string, AdmittedDiscussionMessageRow>;
    recipientKeyPreparationRequired?: boolean;
}>): Promise<DiscussionResult<DiscussionSummaryV1>> {
    const result = await projectDiscussionsForViewerInTx(tx, { viewerAccountId: input.viewerAccountId, authentication: input.authentication,
        discussions: [input.discussion], contexts: new Map([[input.discussion.id, input.context]]), messageAdmissions: input.messageAdmissions,
        ...(input.recipientKeyPreparationRequired === undefined ? {} : { recipientKeyPreparationRequiredByDiscussionId:
            new Map([[input.discussion.id, input.recipientKeyPreparationRequired]]) }) });
    return result.ok ? discussionSuccess(result.value[0]!) : result;
}

/** Summary pages keep latest rows, actors, authors and private cursor reads set-oriented. */
export async function projectDiscussionsForViewerInTx(tx: Tx, input: Readonly<{
    viewerAccountId: string; authentication: SessionAccessAuthentication;
    discussions: readonly DiscussionRow[]; contexts: ReadonlyMap<string, DiscussionContext>;
    anchorDocArtifactId?: string;
    docSourceAdmissions?: DiscussionDocSourceAdmissions;
    messageAdmissions?: Map<string, AdmittedDiscussionMessageRow>;
    recipientKeyPreparationRequiredByDiscussionId?: ReadonlyMap<string, boolean>;
    messages?: readonly DiscussionMessageRow[];
}>): Promise<DiscussionResult<DiscussionSummaryV1[]>> {
    const firstMessages = new Map<string, DiscussionMessageV1 | null>();
    const unavailableLatestContent = new Set<string>();
    const docSourceAdmissions: DiscussionDocSourceAdmissions = input.docSourceAdmissions ?? new Map();
    const latestSources = new Map<string, DiscussionQuoteSource | null>();
    const latestGroups: Array<{ discussionId: string; rows: AdmittedDiscussionMessageRow[]; discussion: DiscussionRow }> = [];
    const roots: ReadableDiscussionMessageGroup[] = [];
    const messageAdmissions = input.messageAdmissions ?? new Map<string, AdmittedDiscussionMessageRow>();
    const knownMessages = new Map<string, AdmittedDiscussionMessageRow[]>();
    // Attention already holds these rows. Admit the complete supplied set before
    // resolving latest-message ancestry, so a known parent never re-enters storage.
    for (const row of input.messages ?? []) {
        const context = input.contexts.get(row.discussionId);
        if (!context) return discussionFailure('discussion_invalid_content');
        const admitted = admitDiscussionStoredMessage(row, context.storageMode, messageAdmissions);
        if (!admitted.ok) return admitted;
        const known = knownMessages.get(row.discussionId) ?? [];
        known.push(admitted.value);
        knownMessages.set(row.discussionId, known);
    }
    const facts = await loadDiscussionViewerFactsInTx(tx, { viewerAccountId: input.viewerAccountId, discussions: input.discussions, tracked: true,
        includeFirstMessage: input.anchorDocArtifactId !== undefined, messages: input.messages, messageAdmissions });
    for (const discussion of input.discussions) {
        const context = input.contexts.get(discussion.id), current = facts.get(discussion.id);
        if (!context || !current) return discussionFailure('discussion_invalid_content');
        const failure = validateDiscussionStoredContent(discussion.titleContent, context.storageMode, 'title');
        if (failure) return discussionFailure(failure);
        const latest = admitDiscussionStoredMessage(current.latestMessage, context.storageMode, messageAdmissions);
        if (!latest.ok) return latest;
        if (input.anchorDocArtifactId !== undefined) {
            const root = current.firstMessage;
            if (!root || root.discussionId !== discussion.id || root.seq !== 1) return discussionFailure('discussion_invalid_content');
            const admittedRoot = admitDiscussionStoredMessage(root, context.storageMode, messageAdmissions);
            if (!admittedRoot.ok) return admittedRoot;
            const target = admittedRoot.value.replyTargetV1;
            if (target?.kind !== 'doc_passage'
                || target.doc.ref.artifactId !== input.anchorDocArtifactId
                || !validateDiscussionDocContentSource({ content: admittedRoot.value.content, source: target.doc, root: true })) {
                return discussionFailure('discussion_invalid_content');
            }
            if (!context.keyReadiness) firstMessages.set(discussion.id, null);
            else roots.push({ discussionId: discussion.id, context, rows: [root], discussion });
            // Scoped summaries disclose only the exact admitted root, never latest content.
            continue;
        }
        const known = (knownMessages.get(discussion.id) ?? []).filter(row => row.id !== latest.value.id);
        latestGroups.push({ discussionId: discussion.id, rows: [latest.value, ...known], discussion });
    }
    const latestQuotes = await resolveDiscussionQuoteSourcesInTx(tx, latestGroups);
    if (!latestQuotes.ok) return latestQuotes;
    for (const group of latestGroups) latestSources.set(group.discussionId, latestQuotes.value.get(group.discussionId)!.get(group.rows[0]!.id) ?? null);
    await admitDiscussionQuoteSourcesInTx(tx, { actorAccountId: input.viewerAccountId, authentication: input.authentication,
        sources: latestSources.values(), admissions: docSourceAdmissions });
    for (const [discussionId, source] of latestSources) {
        if (source && !docSourceAdmissions.get(discussionQuoteSourceKey(source))!.ok) unavailableLatestContent.add(discussionId);
    }
    if (roots.length) {
        const readable = await projectReadableMessageGroupsInTx(tx, { actorAccountId: input.viewerAccountId,
            authentication: input.authentication, groups: roots, unavailableDocSources: 'omit', docSourceAdmissions, messageAdmissions });
        if (!readable.ok && readable.error !== 'discussion_content_unavailable' && readable.error !== 'discussion_access_forbidden') return readable;
        for (const root of roots) firstMessages.set(root.discussionId,
            readable.ok ? readable.value.get(root.discussionId)!.messages[0] ?? null : null);
    }
    const actorAudiences = new Map([...input.contexts].flatMap(([discussionId, context]) => context.audienceAccountIds
        ? [[discussionId, context.audienceAccountIds] as const] : []));
    const participantSubjects = input.discussions.flatMap(row => facts.get(row.id)!.participantAccountSubjects);
    const actors = await projectDiscussionAccountActorsInTx(tx,
        input.discussions.map(row => messageAdmissions.get(facts.get(row.id)!.latestMessage.id)!), participantSubjects, actorAudiences);
    const participantActorsByDiscussion = new Map<string, Map<string, NonNullable<(typeof actors.participants)[number]>>>();
    participantSubjects.forEach((subject, index) => {
        const actor = actors.participants[index];
        if (!actor) return;
        const byAccountId = participantActorsByDiscussion.get(subject.discussionId) ?? new Map();
        byAccountId.set(actor.accountId, actor);
        participantActorsByDiscussion.set(subject.discussionId, byAccountId);
    });
    return discussionSuccess(input.discussions.map((discussion, i) => {
        const context = input.contexts.get(discussion.id)!;
        const current = facts.get(discussion.id)!;
        const summary = projectDiscussionSummaryV1({ context, discussion, viewerAccountId: input.viewerAccountId,
            facts: { ...current, latestMessage: messageAdmissions.get(current.latestMessage.id)! },
            includeLatestMessageContent: input.anchorDocArtifactId === undefined && !unavailableLatestContent.has(discussion.id),
            latestMessageAccountActor: actors.messages[i]?.accountActor ?? null,
            latestMessageRequesterAccountActor: actors.messages[i]?.requesterAccountActor ?? null,
            participantAccounts: [...(participantActorsByDiscussion.get(discussion.id)?.values() ?? [])],
            recipientKeyPreparationRequired: input.recipientKeyPreparationRequiredByDiscussionId?.get(discussion.id),
            capabilities: projectDiscussionCapabilitiesV1({ access: context.access, keyReadiness: context.keyReadiness, discussionArchived: discussion.archivedAt !== null }) });
        return input.anchorDocArtifactId === undefined ? summary : { ...summary, firstMessage: firstMessages.get(discussion.id)! };
    }));
}

export async function readDiscussionRowInTx(tx: Tx, input: Readonly<{ discussionId: string }>): Promise<DiscussionRow | null> {
    return tx.discussion.findUnique({ where: { id: input.discussionId }, select: DISCUSSION_SELECT });
}

type Reader = Readonly<{ actorAccountId: string; authentication: SessionAccessAuthentication }>;

// These results belong only to one snapshot and one caller/disclosure destination.
type DiscussionDocSourceAdmissions = Map<string, DiscussionResult<void>>;

type ReadableDiscussionMessageGroup = Readonly<{
    discussionId: string; context: DiscussionContext; rows: readonly DiscussionMessageRow[];
    discussion?: Pick<DiscussionRow, 'anchorV1'>;
}>;
type ReadableDiscussionMessages = Readonly<{
    messages: DiscussionMessageV1[]; docSources: ReadonlyMap<string, DiscussionDocSource | null>;
}>;

/** Exact and paged reads share admission; pages may withhold independently unavailable Doc rows. */
export async function projectReadableMessagesInTx(tx: Tx, input: Reader & ReadableDiscussionMessageGroup & Readonly<{
    unavailableDocSources?: 'omit';
}>): Promise<DiscussionResult<ReadableDiscussionMessages>> {
    const projected = await projectReadableMessageGroupsInTx(tx, { ...input, groups: [input] });
    return projected.ok ? discussionSuccess(projected.value.get(input.discussionId)!) : projected;
}

/** Resolve group inheritance, then admit distinct sources and project all readable actors once. */
export async function projectReadableMessageGroupsInTx(tx: Tx, input: Reader & Readonly<{
    groups: readonly ReadableDiscussionMessageGroup[]; unavailableDocSources?: 'omit';
    docSourceAdmissions?: DiscussionDocSourceAdmissions;
    messageAdmissions?: Map<string, AdmittedDiscussionMessageRow>;
}>): Promise<DiscussionResult<ReadonlyMap<string, ReadableDiscussionMessages>>> {
    const destination = contentDestination(input.authentication);
    const sourcesByDiscussion = new Map<string, ReadonlyMap<string, DiscussionDocSource | null>>();
    const groups: Array<{ discussionId: string; rows: AdmittedDiscussionMessageRow[]; discussion?: Pick<DiscussionRow, 'anchorV1'> }> = [];
    const messageAdmissions = input.messageAdmissions ?? new Map<string, AdmittedDiscussionMessageRow>();
    for (const group of input.groups) {
        const admittedRows: AdmittedDiscussionMessageRow[] = [];
        for (const row of group.rows) {
            const admitted = admitDiscussionStoredMessage(row, group.context.storageMode, messageAdmissions);
            if (!admitted.ok) return admitted;
            admittedRows.push(admitted.value);
        }
        groups.push({ discussionId: group.discussionId, rows: admittedRows, discussion: group.discussion });
    }
    const quoteSources = await resolveDiscussionQuoteSourcesInTx(tx, groups);
    if (!quoteSources.ok) return quoteSources;
    for (const [discussionId, sources] of quoteSources.value) sourcesByDiscussion.set(discussionId,
        new Map([...sources].map(([id, source]) => [id, source?.kind === 'doc' ? source.doc : null])));
    const admissions: DiscussionDocSourceAdmissions = input.docSourceAdmissions ?? new Map();
    const sources = [...quoteSources.value.values()].flatMap(group => [...group.values()]);
    await admitDiscussionQuoteSourcesInTx(tx, { ...input, sources, admissions });
    for (const source of sources) {
        if (!source) continue;
        const access = admissions.get(discussionQuoteSourceKey(source))!;
        // Human history can omit unavailable quoted rows. An executable disclosure
        // must report refusal, not silently return a partial protected context.
        if (!access.ok && (destination || input.unavailableDocSources !== 'omit')) return access;
    }
    const readable = input.groups.flatMap(group => group.rows.filter(row => {
        const source = quoteSources.value.get(group.discussionId)!.get(row.id);
        return !source || admissions.get(discussionQuoteSourceKey(source))!.ok;
    }).map(row => messageAdmissions.get(row.id)!));
    const actorAudiences = new Map(input.groups.flatMap(group => group.context.audienceAccountIds
        ? [[group.discussionId, group.context.audienceAccountIds] as const] : []));
    const actors = await projectDiscussionAccountActorsInTx(tx, readable, [], actorAudiences);
    const messages = readable.map((row, index) => projectDiscussionMessageV1(row, input.actorAccountId,
        actors.messages[index]?.accountActor ?? null, actors.messages[index]?.requesterAccountActor ?? null));
    const projected = await projectDiscussionMessageDeliveriesInTx(tx, messages);
    const byDiscussion = new Map<string, ReadableDiscussionMessages>(input.groups.map(group => [group.discussionId,
        { docSources: sourcesByDiscussion.get(group.discussionId)!, messages: [] }]));
    for (const message of projected) byDiscussion.get(message.discussionId)!.messages.push(message);
    return discussionSuccess(byDiscussion);
}

type ExactDiscussionMessageSelection = Readonly<{ messageId: string; localId?: never } | { localId: string; messageId?: never }>;

/** The same exact-row query and disclosure admission serve internal and public reads. */
async function readSelectedDiscussionMessageInTx(tx: Tx, input: Reader & ExactDiscussionMessageSelection & Readonly<{
    discussionId: string; throughSeq?: number; context: DiscussionContext;
}>): Promise<DiscussionResult<DiscussionMessageV1 | null>> {
    const row = await tx.discussionMessage.findFirst({ where: {
        discussionId: input.discussionId,
        ...(input.messageId !== undefined ? { id: input.messageId } : { localId: input.localId, authorAccountId: input.actorAccountId }),
        ...(input.throughSeq === undefined ? {} : { seq: { lte: input.throughSeq } }),
    }, select: DISCUSSION_MESSAGE_SELECT });
    if (!row) return discussionSuccess(null);
    const projected = await projectReadableMessagesInTx(tx, { ...input, rows: [row] });
    return projected.ok ? discussionSuccess(projected.value.messages[0]!) : projected;
}

/** Exact message disclosure and its admitted resource facts share one context acquisition. */
export async function readDiscussionMessageWithContextInTx(tx: Tx, input: Reader & Readonly<{
    discussionId: string; messageId: string; throughSeq?: number;
}>): Promise<DiscussionResult<Readonly<{ message: DiscussionMessageV1; context: DiscussionContext }>>> {
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId,
        accountId: input.actorAccountId, authentication: input.authentication, includeActorAudience: true });
    if (!context) return discussionFailure('discussion_not_found');
    const selected = await readSelectedDiscussionMessageInTx(tx, { ...input, context });
    if (!selected.ok) return selected;
    return selected.value === null ? discussionFailure('discussion_not_found') : discussionSuccess({ message: selected.value, context });
}

/** Internal exact read retains its typed absence result and supplied transaction. */
export async function readDiscussionMessageInTx(tx: Tx, input: Reader & Readonly<{
    discussionId: string; messageId: string;
}>): Promise<DiscussionResult<DiscussionMessageV1>> {
    const read = await readDiscussionMessageWithContextInTx(tx, input);
    return read.ok ? discussionSuccess(read.value.message) : read;
}

/** Candidate grants narrow before paging; current admission still decides every returned row. */
export async function listDiscussions(input: Reader & Readonly<{
    state?: 'active' | 'archived'; cursor?: string; limit?: number; anchorSessionId?: string; creationLocalId?: string; anchorDocArtifactId?: string;
}>): Promise<DiscussionResult<DiscussionListResponseV1>> {
    if (input.anchorDocArtifactId !== undefined && !DiscussionListQueryV1Schema.safeParse({
        anchorDocArtifactId: input.anchorDocArtifactId, state: input.state,
    }).success) return discussionFailure('discussion_invalid_content');
    const cursor = input.cursor === undefined ? null : decodeDiscussionListCursorV1(input.cursor);
    if (input.cursor !== undefined && !cursor) return discussionFailure('discussion_invalid_content');
    return inReadSnapshot(async tx => {
        const take = pageSize(input.limit);
        const docSourceAdmissions: DiscussionDocSourceAdmissions = new Map();
        const discussions: DiscussionSummaryV1[] = [];
        let frontier = cursor;
        // Access may disappear between candidate discovery and read. Continue
        // keyset traversal rather than making a denied row hide later results.
        for (;;) {
            // SQLite's Prisma connector has no JSON-path filter. Select exact
            // Doc candidates in SQL on every provider before ORM/page admission.
            const position = frontier ? discussionSqlTimestamp(new Date(frontier.at)) : sql.empty;
            const scopedIds = input.anchorDocArtifactId === undefined ? null : await tx.$queryRaw<{ id: string }[]>(sql.sql`
                SELECT d.${name('id')} AS id FROM ${name('Discussion')} d
                WHERE ${discussionCandidateSql(input.actorAccountId)} AND d.${name('archivedAt')} IS NULL
                    AND ${discussionJsonText(sql.sql`d.${name('anchorV1')}`, ['kind'])} = 'doc'
                    AND ${discussionJsonText(sql.sql`d.${name('anchorV1')}`, ['doc', 'ref', 'artifactId'])} = ${input.anchorDocArtifactId}
                    ${input.anchorSessionId ? sql.sql`AND d.${name('anchorSessionId')} = ${input.anchorSessionId}` : sql.empty}
                    ${input.creationLocalId ? sql.sql`AND d.${name('createdByAccountId')} = ${input.actorAccountId} AND d.${name('creationLocalId')} = ${input.creationLocalId}` : sql.empty}
                    ${frontier ? sql.sql`AND (d.${name('lastMessageAt')} < ${position} OR (d.${name('lastMessageAt')} = ${position} AND d.${name('id')} < ${frontier.id}))` : sql.empty}
                ORDER BY d.${name('lastMessageAt')} DESC, d.${name('id')} DESC LIMIT ${take + 1}`);
            if (scopedIds?.length === 0) return discussionSuccess({ discussions, nextCursor: null });
            const rows = await tx.discussion.findMany({
                where: {
                    AND: [discussionCandidateWhere(input.actorAccountId), ...(frontier ? [buildDiscussionListCursorPredicate(frontier)] : [])],
                    archivedAt: input.state === 'archived' ? { not: null } : null,
                    ...(scopedIds ? { id: { in: scopedIds.map(row => row.id) } } : {}),
                    ...(input.anchorSessionId ? { anchorSessionId: input.anchorSessionId } : {}),
                    ...(input.creationLocalId ? { createdByAccountId: input.actorAccountId, creationLocalId: input.creationLocalId } : {}),
                }, select: DISCUSSION_SELECT, orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }], take: take + 1,
            });
            if (rows.length === 0) return discussionSuccess({ discussions, nextCursor: null });
            const contexts = await resolveDiscussionContextsInTx(tx, { discussionIds: rows.map(row => row.id), accountId: input.actorAccountId,
                authentication: input.authentication, includeActorAudience: true });
            const admitted = rows.filter(row => {
                if (!contexts.has(row.id)) return false;
                if (input.anchorDocArtifactId === undefined) return true;
                const anchor = DiscussionAnchorV1Schema.safeParse(row.anchorV1);
                return row.archivedAt === null && anchor.success && anchor.data.kind === 'doc'
                    && anchor.data.doc.ref.artifactId === input.anchorDocArtifactId;
            });
            const selected = admitted.slice(0, take - discussions.length);
            const projected = await projectDiscussionsForViewerInTx(tx, { contexts, discussions: selected, docSourceAdmissions,
                viewerAccountId: input.actorAccountId, authentication: input.authentication,
                ...(input.anchorDocArtifactId === undefined ? {} : { anchorDocArtifactId: input.anchorDocArtifactId }) });
            if (!projected.ok) return projected;
            discussions.push(...projected.value);
            const lastSelected = selected[selected.length - 1];
            if (lastSelected) frontier = { v: 1, at: lastSelected.lastMessageAt.getTime(), id: lastSelected.id };
            if (admitted.length > selected.length) return discussionSuccess({ discussions, nextCursor: frontier ? encodeDiscussionListCursorV1(frontier) : null });
            const last = rows[rows.length - 1]!;
            frontier = { v: 1, at: last.lastMessageAt.getTime(), id: last.id };
            if (rows.length <= take) return discussionSuccess({ discussions, nextCursor: null });
        }
    });
}

/** Exact reads never confirm identity to an unauthorized principal. */
export async function getDiscussion(input: Reader & Readonly<{ discussionId: string }>): Promise<DiscussionResult<DiscussionDetailsResponseV1>> {
    return inReadSnapshot(async tx => {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId,
            authentication: input.authentication, includeActorAudience: true });
        if (!context) return discussionFailure('discussion_not_found');
        const discussion = await readDiscussionRowInTx(tx, input);
        if (!discussion) return discussionFailure('discussion_not_found');
        const recipientKeyPreparationRequired = context.storageMode === 'e2ee' && context.keyReadiness
            ? await isDiscussionRecipientKeyPreparationRequiredInTx(tx, { discussionId: discussion.id, context }) : undefined;
        const projected = await projectDiscussionForViewerInTx(tx, { context, discussion,
            viewerAccountId: input.actorAccountId, authentication: input.authentication,
            ...(recipientKeyPreparationRequired === undefined ? {} : { recipientKeyPreparationRequired }) });
        return projected.ok ? discussionSuccess({ discussion: projected.value }) : projected;
    });
}

/** Exact and ordered cursor-neutral reads apply the sequence ceiling before disclosure. */
export async function readDiscussionMessages(input: Reader & Readonly<{
    discussionId: string; beforeSeq?: number; afterSeq?: number; throughSeq?: number; limit?: number;
    messageId?: string; localId?: string;
}>): Promise<DiscussionResult<DiscussionMessagesResponseV1>> {
    if (!isDiscussionMessagesSelectionValidV1(input)) return discussionFailure('discussion_invalid_content');
    return inReadSnapshot(async tx => {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId,
            authentication: input.authentication, includeActorAudience: true });
        if (!context) return discussionFailure('discussion_not_found');
        const discussion = await readDiscussionRowInTx(tx, input);
        if (!discussion) return discussionFailure('discussion_not_found');
        const selection = input.messageId !== undefined ? { messageId: input.messageId }
            : input.localId !== undefined ? { localId: input.localId } : null;
        if (selection) {
            const selected = await readSelectedDiscussionMessageInTx(tx, { ...selection, context,
                actorAccountId: input.actorAccountId, authentication: input.authentication, discussionId: discussion.id,
                ...(input.throughSeq === undefined ? {} : { throughSeq: input.throughSeq }) });
            if (!selected.ok) return selected;
            return discussionSuccess({ messages: selected.value ? [selected.value] : [], hasMoreOlder: false,
                messageSeq: input.throughSeq === undefined ? discussion.messageSeq : Math.min(discussion.messageSeq, input.throughSeq) });
        }
        const ascending = input.afterSeq !== undefined;
        const take = pageSize(input.limit);
        const messages: DiscussionMessageV1[] = [];
        let frontier = input.afterSeq ?? input.beforeSeq;
        // Withheld Doc rows must not consume a visible slot or strand the caller
        // on an empty page before independently authorized conversation history.
        while (messages.length < take) {
            const remaining = take - messages.length;
            const rows = await tx.discussionMessage.findMany({
                where: { discussionId: discussion.id, seq: {
                    ...(frontier === undefined ? {} : ascending ? { gt: frontier } : { lt: frontier }),
                    ...(input.throughSeq === undefined ? {} : { lte: input.throughSeq }),
                } }, select: DISCUSSION_MESSAGE_SELECT, orderBy: { seq: ascending ? 'asc' : 'desc' }, take: remaining,
            });
            if (rows.length === 0) break;
            const projected = await projectReadableMessagesInTx(tx, { ...input, context, rows, discussion, unavailableDocSources: 'omit' });
            if (!projected.ok) return projected;
            messages.push(...projected.value.messages);
            frontier = rows[rows.length - 1]!.seq;
            if (rows.length < remaining) break;
        }
        const ordered = ascending ? messages : messages.reverse();
        const first = ordered[0];
        const hasMoreOlder = first !== undefined && await tx.discussionMessage.findFirst({
            where: { discussionId: discussion.id, seq: { lt: first.seq } }, select: { id: true },
        }) !== null;
        return discussionSuccess({ messages: ordered,
            hasMoreOlder, messageSeq: input.throughSeq === undefined ? discussion.messageSeq : Math.min(discussion.messageSeq, input.throughSeq) });
    });
}
