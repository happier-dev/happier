import { DISCUSSION_DEFAULT_PAGE_SIZE_V1, DISCUSSION_MAX_PAGE_SIZE_V1, DiscussionListQueryV1Schema, isDiscussionMessagesSelectionValidV1, type DiscussionDetailsResponseV1, type DiscussionExactMessagesRequestV1, type DiscussionExactMessagesResponseV1, type DiscussionListQueryV1, type DiscussionListResponseV1, type DiscussionMessagesResponseV1 } from '@happier-dev/protocol/discussions/api';
import { DISCUSSION_ITEM_COMMENT_ANCHOR_KINDS_V1 } from '@happier-dev/protocol/discussions/listing/discussionListFilterV1';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import type { DiscussionSummaryV1, DiscussionMessageV1 } from '@happier-dev/protocol/discussions/models';
import { validateDiscussionDocContentSource, type DiscussionDocSource } from './docPassages';
import { admitDiscussionQuoteSourcesInTx, discussionQuoteSourceKey, resolveDiscussionQuoteReadabilityInTx, resolveDiscussionQuoteSourcesInTx, type DiscussionQuoteSource } from './quoteReadAdmission';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resolveDiscussionContextInTx, resolveDiscussionContextsInTx, discussionCandidateWhere, discussionCandidateSql,
    isDiscussionRecipientKeyPreparationRequiredInTx, isDiscussionCredentialCurrentInTx, readDiscussionTeamScopedIdsInTx, type DiscussionContext } from './access';
import { buildDiscussionListCursorPredicate, decodeDiscussionListCursorV1, encodeDiscussionListCursorV1 } from './pagination';
import { DISCUSSION_MESSAGE_SELECT, DISCUSSION_SELECT, loadDiscussionViewerFactsInTx, projectDiscussionAccountActorsInTx, projectDiscussionCapabilitiesV1, projectDiscussionMessageV1, projectDiscussionSummaryV1, validateDiscussionStoredContent, admitDiscussionStoredContent, admitDiscussionStoredMessage, type AdmittedDiscussionMessageRow, type DiscussionRow, type DiscussionMessageRow } from './projection';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';
import { projectDiscussionMessageDeliveriesInTx } from './deliveryProjection';
import { prismaRuntime as sql } from '@/storage/prisma';
import { discussionJsonText, discussionSqlName as name, discussionSqlTimestamp } from './readSql';
import { isServerFeatureEnabledForHome } from '@/app/features/catalog/serverFeatureGate';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { EXTERNAL_TASK_DISCUSSION_ID_PREFIX, isExternalTaskDiscussionId } from '@happier-dev/protocol/discussions/references';
import { isInternalTaskReferenceV1, type TriageEntryRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import { resolveTaskAnchorInTx, type TaskAnchorAdmission } from '@/app/todos/taskGrantStorageAdapter';
import { isManagedTaskDiscussionId, matchesExternalTaskAnchor, readTaskDiscussionIdForAnchorInTx, taskDiscussionId } from './taskDiscussionIdentity';
import type { DiscussionFailureCode } from './serviceTypes';

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
            capabilities: projectDiscussionCapabilitiesV1({ access: context.access, keyReadiness: context.keyReadiness,
                discussionArchived: discussion.archivedAt !== null, inheritedAudience: isManagedTaskDiscussionId(discussion.id) }) });
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
    const quotes = await resolveDiscussionQuoteReadabilityInTx(tx, { ...input, groups, admissions: input.docSourceAdmissions });
    if (!quotes.ok) return quotes;
    const { sources, failures } = quotes.value;
    for (const [discussionId, group] of sources) sourcesByDiscussion.set(discussionId,
        new Map([...group].map(([id, source]) => [id, source?.kind === 'doc' ? source.doc : null])));
    // Human history can omit unavailable quoted rows. Executable disclosure must report the refusal.
    const firstFailure = failures.values().next().value;
    if (firstFailure && (destination || input.unavailableDocSources !== 'omit')) return discussionFailure(firstFailure);
    const readable = input.groups.flatMap(group => group.rows
        .filter(row => !failures.has(row.id)).map(row => messageAdmissions.get(row.id)!));
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

type ExactMessageReference = DiscussionExactMessagesRequestV1['messages'][number];

async function readExactDiscussionMessageRowsInTx(
    tx: Tx, references: readonly ExactMessageReference[], throughSeq?: number,
): Promise<DiscussionMessageRow[]> {
    const rows: DiscussionMessageRow[] = [];
    for (const chunk of portableQueryChunks({ values: references, bindingsPerValue: 2, fixedBindings: throughSeq === undefined ? 0 : 1 })) {
        rows.push(...await tx.discussionMessage.findMany({ where: {
            OR: chunk.map(({ discussionId, messageId }) => ({ discussionId, id: messageId })),
            ...(throughSeq === undefined ? {} : { seq: { lte: throughSeq } }),
        }, select: DISCUSSION_MESSAGE_SELECT }));
    }
    return rows;
}

function discussionMessageKeyContext(context: DiscussionContext): NonNullable<DiscussionMessagesResponseV1['keyContext']> {
    return { encryptionMode: context.storageMode, keyReadiness: context.keyReadiness, dataEncryptionKey: context.dataEncryptionKey,
        ...(context.taskKey ? { taskKey: context.taskKey } : {}) };
}

/** The same exact-row query and disclosure admission serve internal and public reads. */
async function readSelectedDiscussionMessageInTx(tx: Tx, input: Reader & ExactDiscussionMessageSelection & Readonly<{
    discussionId: string; throughSeq?: number; context: DiscussionContext;
}>): Promise<DiscussionResult<DiscussionMessageV1 | null>> {
    const row = input.messageId !== undefined
        ? (await readExactDiscussionMessageRowsInTx(tx, [{ discussionId: input.discussionId, messageId: input.messageId }], input.throughSeq))[0]
        : await tx.discussionMessage.findFirst({ where: {
            discussionId: input.discussionId, localId: input.localId, authorAccountId: input.actorAccountId,
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
    const refusals = new Map<string, DiscussionFailureCode>();
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId,
        accountId: input.actorAccountId, authentication: input.authentication, includeActorAudience: true, refusals });
    if (!context) return discussionFailure(refusals.get(input.discussionId) ?? 'discussion_not_found');
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

/** Read exact messages and their title envelopes without refreshing Discussion history. */
export async function readExactDiscussionMessages(input: Reader & Readonly<DiscussionExactMessagesRequestV1>):
    Promise<DiscussionResult<DiscussionExactMessagesResponseV1>> {
    return inReadSnapshot(async tx => {
        const refusals = new Map<string, DiscussionFailureCode>();
        const contexts = await resolveDiscussionContextsInTx(tx, {
            discussionIds: [...new Set(input.messages.map(reference => reference.discussionId))],
            accountId: input.actorAccountId, authentication: input.authentication, includeActorAudience: true, refusals,
        });
        const readableReferences = new Map<string, ExactMessageReference>();
        for (const reference of input.messages) {
            if (contexts.get(reference.discussionId)?.keyReadiness) {
                readableReferences.set(JSON.stringify([reference.discussionId, reference.messageId]), reference);
            }
        }
        if (readableReferences.size === 0 && refusals.size > 0) return discussionFailure(refusals.values().next().value!);
        const rows = await readExactDiscussionMessageRowsInTx(tx, [...readableReferences.values()]);
        if (rows.length === 0) return discussionSuccess({ discussions: [] });

        const byDiscussion = new Map<string, DiscussionMessageRow[]>();
        for (const row of rows) {
            const group = byDiscussion.get(row.discussionId);
            if (group) group.push(row);
            else byDiscussion.set(row.discussionId, [row]);
        }
        const discussions: Array<Pick<DiscussionRow, 'id' | 'titleContent' | 'anchorV1'>> = [];
        for (const ids of portableQueryChunks({ values: [...byDiscussion.keys()], bindingsPerValue: 1 })) {
            discussions.push(...await tx.discussion.findMany({
                where: { id: { in: [...ids] } }, select: { id: true, titleContent: true, anchorV1: true },
            }));
        }
        const projected = await projectReadableMessageGroupsInTx(tx, { ...input, unavailableDocSources: 'omit',
            groups: discussions.map(discussion => ({
                discussionId: discussion.id, context: contexts.get(discussion.id)!, discussion, rows: byDiscussion.get(discussion.id)!,
            })),
        });
        if (!projected.ok) return projected;
        const readable: DiscussionExactMessagesResponseV1['discussions'] = [];
        for (const discussion of discussions) {
            const { messages } = projected.value.get(discussion.id)!;
            if (messages.length === 0) continue;
            const context = contexts.get(discussion.id)!;
            const title = admitDiscussionStoredContent(discussion.titleContent, context.storageMode, 'title');
            if (!title.ok) return title;
            readable.push({ discussionId: discussion.id, titleContent: title.value, keyContext: discussionMessageKeyContext(context), messages });
        }
        return discussionSuccess({ discussions: readable });
    });
}

/** Summary counts active admitted identities without title, message or key reads. */
export async function countDiscussionsInTx(tx: Tx, input: Parameters<typeof readDiscussionTeamScopedIdsInTx>[1]) {
    if (!await isServerFeatureEnabledForHome('sessions.conversations', { tx })) {
        return { ok: false as const, error: 'discussions_unavailable' as const };
    }
    if (!await isDiscussionCredentialCurrentInTx(tx, { accountId: input.actorAccountId, authentication: input.authentication })) {
        return { ok: false as const, error: 'discussion_not_found' as const };
    }
    const scoped = await readDiscussionTeamScopedIdsInTx(tx, input);
    if (!scoped.ok) return scoped;
    let count = 0;
    for (const ids of portableQueryChunks({ values: scoped.resourceIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        count += await tx.discussion.count({ where: { id: { in: [...ids] }, archivedAt: null,
            ...(input.authentication.sessionRuntimePrincipal ? { participants: { some: {
                sessionId: input.authentication.sessionRuntimePrincipal.sessionId, removedAt: null,
            } } } : {}) } });
    }
    return { ok: true as const, count };
}

/** Candidate prefilter for external Internal threads anchored on one exact TriageEntryRefV1. */
async function findExternalTaskDiscussionCandidateIdsInTx(tx: Tx, input: Readonly<{
    accountId: string; ref: TriageEntryRefV1; state?: 'active' | 'archived';
}>): Promise<string[]> {
    const anchor = sql.sql`d.${name('anchorV1')}`;
    const statePredicate = input.state === undefined ? sql.empty
        : sql.sql`AND d.${name('archivedAt')} ${input.state === 'archived' ? sql.sql`IS NOT NULL` : sql.sql`IS NULL`}`;
    const rows = await tx.$queryRaw<{ id: string }[]>(sql.sql`
        SELECT d.${name('id')} AS id FROM ${name('Discussion')} d
        WHERE ${discussionCandidateSql(input.accountId)}
            AND d.${name('id')} LIKE ${`${EXTERNAL_TASK_DISCUSSION_ID_PREFIX}%`}
            ${statePredicate}
            AND ${discussionJsonText(anchor, ['kind'])} = 'task'
            AND ${discussionJsonText(anchor, ['entry', 'source', 'pluginId'])} = ${input.ref.source.pluginId}
            AND ${discussionJsonText(anchor, ['entry', 'source', 'localId'])} = ${input.ref.source.localId}
            AND ${discussionJsonText(anchor, ['entry', 'kindId'])} = ${input.ref.kindId}
            AND ${discussionJsonText(anchor, ['entry', 'collisionScope'])} = ${input.ref.collisionScope}
            AND ${discussionJsonText(anchor, ['entry', 'entryId'])} = ${input.ref.entryId}
        ORDER BY d.${name('lastMessageAt')} DESC, d.${name('id')} DESC`);
    return rows.map(row => row.id);
}

/** Admitted external Internal thread ids on one exact external ref (owned or shared via DiscussionGrant). */
export async function findAdmittedExternalTaskDiscussionIdsInTx(tx: Tx, input: Reader & Readonly<{
    ref: TriageEntryRefV1; state?: 'active' | 'archived';
}>): Promise<string[]> {
    if (!await isDiscussionCredentialCurrentInTx(tx, { accountId: input.actorAccountId, authentication: input.authentication })) return [];
    const candidateIds = await findExternalTaskDiscussionCandidateIdsInTx(tx, {
        accountId: input.actorAccountId, ref: input.ref, state: input.state,
    });
    if (candidateIds.length === 0) return [];
    const [rows, contexts] = await Promise.all([
        (async () => {
            const found: Array<{ id: string; anchorV1: unknown }> = [];
            for (const ids of portableQueryChunks({ values: candidateIds, bindingsPerValue: 1 })) {
                found.push(...await tx.discussion.findMany({
                    where: { id: { in: [...ids] } },
                    select: { id: true, anchorV1: true },
                }));
            }
            return found;
        })(),
        resolveDiscussionContextsInTx(tx, {
            discussionIds: candidateIds, accountId: input.actorAccountId, authentication: input.authentication,
        }),
    ]);
    const matchingById = new Set(rows.filter(row => matchesExternalTaskAnchor(row.anchorV1, input.ref)).map(row => row.id));
    return candidateIds.filter(id => matchingById.has(id) && contexts.has(id));
}

/** Verify that a requested Discussion id is admitted for the given Task or external anchor ref. */
export async function readAdmittedTaskDiscussionIdForAnchorInTx(tx: Tx, input: Reader & Readonly<{
    ref: TriageEntryRefV1; requestedDiscussionId?: string;
}>): Promise<string | null> {
    if (isInternalTaskReferenceV1(input.ref)) {
        return readTaskDiscussionIdForAnchorInTx(tx, input.actorAccountId, input.ref);
    }
    const requestedId = input.requestedDiscussionId;
    if (!requestedId || !isExternalTaskDiscussionId(requestedId)) return null;
    const row = await tx.discussion.findUnique({ where: { id: requestedId }, select: { id: true, anchorV1: true } });
    if (!row || !matchesExternalTaskAnchor(row.anchorV1, input.ref)) return null;
    const context = await resolveDiscussionContextInTx(tx, {
        discussionId: row.id, accountId: input.actorAccountId, authentication: input.authentication,
    });
    return context ? row.id : null;
}

/** Candidate grants narrow before paging; current admission still decides every returned row. */
async function listExactTaskDiscussionInTx(tx: Tx, input: Reader & Readonly<{ anchorTask: TriageEntryRefV1; state?: 'active' | 'archived' }>):
    Promise<DiscussionResult<DiscussionListResponseV1>> {
    const empty = discussionSuccess({ discussions: [], nextCursor: null });
    if (!await isDiscussionCredentialCurrentInTx(tx, { accountId: input.actorAccountId, authentication: input.authentication })) return empty;
    const ref = input.anchorTask;
    if (isInternalTaskReferenceV1(ref)) {
        const admitted = await resolveTaskAnchorInTx(tx, { ...input, ref, includeKey: true, includeAudience: true });
        if (!admitted.ok) return admitted.error === 'team_authentication_required' ? discussionFailure(admitted.error) : empty;
        const discussionId = taskDiscussionId(admitted.value.row.id);
        const discussion = await readDiscussionRowInTx(tx, { discussionId });
        if (!discussion || (input.state !== undefined && (discussion.archivedAt !== null) !== (input.state === 'archived'))) return empty;
        const taskAdmissions = new Map<string, TaskAnchorAdmission>([[discussionId, admitted]]);
        const context = await resolveDiscussionContextInTx(tx, { discussionId, accountId: input.actorAccountId, authentication: input.authentication,
            includeActorAudience: true, taskAdmissions });
        if (!context) return empty;
        const projected = await projectDiscussionForViewerInTx(tx, { context, discussion, viewerAccountId: input.actorAccountId,
            authentication: input.authentication });
        return projected.ok ? discussionSuccess({ discussions: [projected.value], nextCursor: null }) : projected;
    }
    const candidateIds = await findExternalTaskDiscussionCandidateIdsInTx(tx, {
        accountId: input.actorAccountId, ref, state: input.state,
    });
    if (candidateIds.length === 0) return empty;
    const [rows, contexts] = await Promise.all([
        (async () => {
            const found: DiscussionRow[] = [];
            for (const ids of portableQueryChunks({ values: candidateIds, bindingsPerValue: 1 })) {
                found.push(...await tx.discussion.findMany({
                    where: { id: { in: [...ids] } },
                    select: DISCUSSION_SELECT,
                }));
            }
            return found;
        })(),
        resolveDiscussionContextsInTx(tx, {
            discussionIds: candidateIds,
            accountId: input.actorAccountId,
            authentication: input.authentication,
            includeActorAudience: true,
        }),
    ]);
    const rowsById = new Map(rows.map(row => [row.id, row]));
    const admitted = candidateIds.flatMap(id => {
        const row = rowsById.get(id);
        return row && matchesExternalTaskAnchor(row.anchorV1, ref) && contexts.has(id) ? [row] : [];
    });
    if (admitted.length === 0) return empty;
    const projected = await projectDiscussionsForViewerInTx(tx, {
        contexts,
        discussions: admitted,
        viewerAccountId: input.actorAccountId,
        authentication: input.authentication,
    });
    return projected.ok ? discussionSuccess({ discussions: projected.value, nextCursor: null }) : projected;
}

export async function listDiscussions(input: Reader & Readonly<DiscussionListQueryV1>): Promise<DiscussionResult<DiscussionListResponseV1>> {
    if (input.anchorTask !== undefined) {
        const anchorTask = input.anchorTask;
        return inReadSnapshot(tx => listExactTaskDiscussionInTx(tx, { ...input, anchorTask }));
    }
    if (input.anchorDocArtifactId !== undefined && !DiscussionListQueryV1Schema.safeParse({
        anchorDocArtifactId: input.anchorDocArtifactId, state: input.state,
    }).success) return discussionFailure('discussion_invalid_content');
    const cursor = input.cursor === undefined ? null : decodeDiscussionListCursorV1(input.cursor);
    if (input.cursor !== undefined && !cursor) return discussionFailure('discussion_invalid_content');
    return inReadSnapshot(async tx => {
        const scope = input.sharedWithTeamId === undefined ? null : await readDiscussionTeamScopedIdsInTx(tx, {
            ...input, sharedWithTeamId: input.sharedWithTeamId,
        });
        if (scope && !scope.ok) return scope;
        const take = pageSize(input.limit);
        const docSourceAdmissions: DiscussionDocSourceAdmissions = new Map();
        const discussions: DiscussionSummaryV1[] = [];
        const anchorKind = discussionJsonText(sql.sql`d.${name('anchorV1')}`, ['kind']);
        const exactSelector = input.anchorDocArtifactId !== undefined || input.anchorSessionId !== undefined
            || input.creationLocalId !== undefined || input.sharedWithTeamId !== undefined;
        const kindPredicate = input.anchorKinds !== undefined
            ? sql.sql`AND ${anchorKind} IN (${sql.join(input.anchorKinds)})`
            : exactSelector ? sql.empty
                : sql.sql`AND COALESCE(${anchorKind}, '') NOT IN (${sql.join([...DISCUSSION_ITEM_COMMENT_ANCHOR_KINDS_V1])})`;
        const usesJsonWindow = input.anchorDocArtifactId !== undefined || input.anchorKinds !== undefined || !exactSelector;
        let frontier = cursor;
        // Access may disappear between candidate discovery and read. Continue
        // keyset traversal rather than making a denied row hide later results.
        for (;;) {
            // SQLite's Prisma connector has no JSON-path filter. Narrow the
            // bounded candidate window before reading full rows or admitting content.
            const position = frontier ? discussionSqlTimestamp(new Date(frontier.at)) : sql.empty;
            const readJsonWindow = (candidateIds?: readonly string[]) => tx.$queryRaw<{ id: string }[]>(sql.sql`
                SELECT d.${name('id')} AS id FROM ${name('Discussion')} d
                WHERE ${candidateIds ? sql.sql`d.${name('id')} IN (${sql.join([...candidateIds])})`
                    : input.creationLocalId ? sql.sql`d.${name('createdByAccountId')} = ${input.actorAccountId}`
                        : discussionCandidateSql(input.actorAccountId, input.anchorKinds?.includes('task') === true)}
                    AND d.${name('archivedAt')} ${input.state === 'archived' ? sql.sql`IS NOT NULL` : sql.sql`IS NULL`}
                    ${kindPredicate}
                    ${input.anchorDocArtifactId === undefined ? sql.empty : sql.sql`AND ${anchorKind} = 'doc'
                        AND ${discussionJsonText(sql.sql`d.${name('anchorV1')}`, ['doc', 'ref', 'artifactId'])} = ${input.anchorDocArtifactId}`}
                    ${input.anchorSessionId ? sql.sql`AND d.${name('anchorSessionId')} = ${input.anchorSessionId}` : sql.empty}
                    ${input.creationLocalId ? sql.sql`AND d.${name('createdByAccountId')} = ${input.actorAccountId} AND d.${name('creationLocalId')} = ${input.creationLocalId}` : sql.empty}
                    ${frontier ? sql.sql`AND (d.${name('lastMessageAt')} < ${position} OR (d.${name('lastMessageAt')} = ${position} AND d.${name('id')} < ${frontier.id}))` : sql.empty}
                ORDER BY d.${name('lastMessageAt')} DESC, d.${name('id')} DESC LIMIT ${take + 1}`);
            let scopedIds: Awaited<ReturnType<typeof readJsonWindow>> | null = null;
            if (usesJsonWindow) {
                if (scope?.ok) {
                    scopedIds = [];
                    for (const ids of portableQueryChunks({ values: scope.resourceIds, bindingsPerValue: 1,
                        fixedBindings: take + 1 + (input.anchorKinds?.length ?? DISCUSSION_ITEM_COMMENT_ANCHOR_KINDS_V1.length) + 16 })) {
                        scopedIds = await readJsonWindow([...ids, ...scopedIds.map(row => row.id)]);
                    }
                } else scopedIds = await readJsonWindow();
            }
            if (scopedIds?.length === 0) return discussionSuccess({ discussions, nextCursor: null });
            const readWindow = (candidateIds?: readonly string[]) => tx.discussion.findMany({
                where: {
                    AND: [candidateIds ? { id: { in: [...candidateIds] } } : input.creationLocalId === undefined ? discussionCandidateWhere(input.actorAccountId) : {},
                        ...(frontier ? [buildDiscussionListCursorPredicate(frontier)] : [])],
                    archivedAt: input.state === 'archived' ? { not: null } : null,
                    ...(input.anchorSessionId ? { anchorSessionId: input.anchorSessionId } : {}),
                    ...(input.creationLocalId ? { createdByAccountId: input.actorAccountId, creationLocalId: input.creationLocalId } : {}),
                }, select: DISCUSSION_SELECT, orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }], take: take + 1,
            });
            let rows: Awaited<ReturnType<typeof readWindow>> = [];
            if (scopedIds) rows = await readWindow(scopedIds.map(row => row.id));
            else if (scope?.ok) {
                // The next window merges each identity chunk with the current
                // leading window. Its bind budget includes both that window
                // and the optional Doc/cursor filters; valid large Teams page
                // without exceeding SQLite's portable parameter boundary.
                for (const ids of portableQueryChunks({ values: scope.resourceIds, bindingsPerValue: 1,
                    fixedBindings: take + 1 + 12 })) {
                    rows = await readWindow([...ids, ...rows.map(row => row.id)]);
                }
            } else rows = await readWindow();
            if (rows.length === 0) return discussionSuccess({ discussions, nextCursor: null });
            const contexts = await resolveDiscussionContextsInTx(tx, { discussionIds: rows.map(row => row.id), accountId: input.actorAccountId,
                authentication: input.authentication, includeActorAudience: true,
                ...(input.sharedWithTeamId === undefined ? {} : { qualifiedTeamIds: new Set([input.sharedWithTeamId]) }) });
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
            discussions.push(...projected.value.map(row => scope?.ok
                ? { ...row, sharedWithTeamScope: scope.shareScopes.get(row.id) } : row));
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
        const refusals = new Map<string, DiscussionFailureCode>();
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId,
            authentication: input.authentication, includeActorAudience: true, refusals });
        if (!context) return discussionFailure(refusals.get(input.discussionId) ?? 'discussion_not_found');
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
    messageId?: string; localId?: string; includeKeyContext?: boolean;
}>): Promise<DiscussionResult<DiscussionMessagesResponseV1>> {
    if (!isDiscussionMessagesSelectionValidV1(input)) return discussionFailure('discussion_invalid_content');
    return inReadSnapshot(async tx => {
        const refusals = new Map<string, DiscussionFailureCode>();
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId,
            authentication: input.authentication, includeActorAudience: true, refusals });
        if (!context) return discussionFailure(refusals.get(input.discussionId) ?? 'discussion_not_found');
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
                messageSeq: input.throughSeq === undefined ? discussion.messageSeq : Math.min(discussion.messageSeq, input.throughSeq),
                ...(input.includeKeyContext && input.messageId !== undefined && selected.value
                    ? { keyContext: discussionMessageKeyContext(context) } : {}),
            });
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
