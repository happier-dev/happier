import { projectSessionRuntimeIssueMetadataV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueMetadataV1';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { isDeepStrictEqual } from 'node:util';
import { SessionMessageReplyProgressV1Schema, deriveSessionMessageReplyReturnLocalIdV1, deriveSessionMessageReplyAnswerLocalIdV1, type SessionMessageReplyAdmissionV1, type SessionMessageReplyMutationV1,
    type SessionMessageReplyMutationResultV1, type SessionMessageReplyOutcomeV1, type SessionMessageReplyProgressV1,
    type SessionMessageReplyReadResultV1, type SessionMessageReplyPendingPageV1, type SessionMessageReplyOperationV1,
    type SessionMessageReplyMachineMutationV1, type SessionMessageReplyMachinePendingPageV1,
    type SessionMessageReplySourceTurnReleaseV1, type SessionMessageReplySourceTurnReleaseResultV1, type SessionMessageReplyAccountMutationV1,
    SessionMessageReplyPendingHintV1Schema, type SessionMessageDiscussionReplyReturnV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { parseStoredSessionTurnTranscriptAnchors } from '@/app/session/turns/parseSessionTurnState';
import { resolveEffectiveSessionAccessForSessionsInTx, resolveSessionAccessForOperation, type EffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { backgroundDeliveryAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resolveDiscussionContextInTx, discussionContextStorageAdapter, resolveDiscussionAudienceInTx } from '@/app/discussions/access';
import { mayInjectResourceContextInTx } from '@/app/session/access/sessionContextInjection';
import { discussionParticipantCanAnswerV1, DiscussionMessageAddressingV1Schema, type DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/participants';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionProducerV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import { hasExactCurrentPublisherAuthorityInTx } from '@/app/session/pending/hasExactCurrentPublisherAuthorityInTx';
import type { CurrentSessionPublisherAuthority } from '@/app/presence/sessionPublisherPresence';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { buildSessionMessagePublicationWhere, loadSessionTranscriptPublication } from '@/app/session/sessionTranscriptPublicationPolicy';
import { afterTx, inTx, TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { eventRouter } from '@/app/events/eventRouter';
import { SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/messages/sessionTranscriptPageLimits';
import { SessionInputAdmissionReceiptV1Schema, deriveWorkflowSessionInputLocalIdV2, type SessionInputWorkflowV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import type { Prisma } from '@prisma/client';
import { log } from '@/utils/logging/log';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { markDiscussionReadersChangedInTx } from '@/app/discussions/changes';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { SessionMessageReplyPublicationFailureV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

const selection = { id: true, replyProgress: true, targetExecutionRunId: true, inputAdmissionReceipt: true } as const;
type Original = { sessionId: string; localId: string; pendingId?: string; messageId?: string; progress: SessionMessageReplyProgressV1 | null; malformed: boolean;
    storedProgress: Prisma.JsonValue; messageSeq?: number; targetExecutionRunId: string | null; sidechainId: string | null; targetMachineId: string | null;
    requesterAccountId: string | null };

function parseProgress(value: unknown): SessionMessageReplyProgressV1 | null {
    const parsed = SessionMessageReplyProgressV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

type ReplyKey = Readonly<{ sessionId: string; localId: string }>;
const replyKey = (key: ReplyKey) => JSON.stringify([key.sessionId, key.localId]);

/** Exact demanded keys only; the shared provider boundary chunks bindings, never results. */
async function readOriginals(tx: Tx, keys: readonly ReplyKey[]): Promise<ReadonlyMap<string, Original>> {
    const originals = new Map<string, Original>();
    const unique = [...new Map(keys.map(key => [replyKey(key), key])).values()];
    for (const chunk of portableQueryChunks({ values: unique, bindingsPerValue: 2 })) {
        const where = { OR: chunk.map(({ sessionId, localId }) => ({ sessionId, localId })) };
        const [pendingRows, messages] = await Promise.all([
            tx.sessionPendingMessage.findMany({ where, select: { ...selection, sessionId: true, localId: true } }),
            tx.sessionMessage.findMany({ where, select: { ...selection, sessionId: true, localId: true, sidechainId: true, seq: true } }),
        ]);
        const pendingByKey = new Map(pendingRows.map(row => [replyKey(row), row]));
        const messagesByKey = new Map(messages.flatMap(row => row.localId === null ? [] : [[replyKey({ ...row, localId: row.localId }), row] as const]));
        for (const { sessionId, localId } of chunk) {
            const key = replyKey({ sessionId, localId });
            const pending = pendingByKey.get(key);
            const message = messagesByKey.get(key);
            if (!pending && !message) continue;
            // Pending retains custody until its retirement; a materialized copy is not a second authority.
            const raw = pending?.replyProgress ?? message?.replyProgress;
            const progress = parseProgress(raw);
            const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(pending?.inputAdmissionReceipt ?? message?.inputAdmissionReceipt);
            originals.set(key, { sessionId, localId, ...(pending ? { pendingId: pending.id } : {}), ...(message ? { messageId: message.id } : {}), progress,
                storedProgress: raw ?? null, ...(message ? { messageSeq: message.seq } : {}), malformed: raw != null && progress === null,
                targetExecutionRunId: pending?.targetExecutionRunId ?? message?.targetExecutionRunId ?? null,
                sidechainId: message?.sidechainId ?? null,
                requesterAccountId: receipt.success && receipt.data.issuer === 'authenticatedAccount'
                    ? receipt.data.actorAccountId : null,
                targetMachineId: receipt.success && (receipt.data.issuer === 'authenticatedMachine'
                    || receipt.data.issuer === 'authenticatedAccount' && progress?.humanOrigin !== undefined)
                    ? receipt.data.admittedTarget?.machineId ?? null : null });
        }
    }
    return originals;
}

async function readOriginal(tx: Tx, sessionId: string, localId: string): Promise<Original | null> {
    return (await readOriginals(tx, [{ sessionId, localId }])).get(replyKey({ sessionId, localId })) ?? null;
}

async function writeOriginal(tx: Tx, original: Original, progress: SessionMessageReplyProgressV1): Promise<SessionMessageReplyProgressV1> {
    if (progress.returnPublication?.kind === 'failed' && progress.returnPublication.failure.retryable
        && original.progress && (progress.acceptedTurnId !== original.progress.acceptedTurnId
        || !isDeepStrictEqual(progress.outcome, original.progress.outcome))) {
        const { returnPublication: _previousPublication, ...advanced } = progress;
        progress = advanced;
    }
    if (isDeepStrictEqual(original.progress, progress)) return progress;
    const data = { replyProgress: SessionMessageReplyProgressV1Schema.parse(progress),
        replySourceSessionId: progress.humanOrigin?.sessionId ?? progress.sourceSession?.sourceSessionId ?? null,
        replySourceTurnId: progress.sourceSession?.sourceTurnId ?? null,
        replyDisposition: progress.disposition };
    if (!original.progress || original.storedProgress === null) throw new Error('Original reply custody is unavailable');
    // Source-turn release and target completion can touch different Session locks.
    // CAS the canonical original, replaying through the existing transaction owner.
    const changed = original.pendingId
        ? await tx.sessionPendingMessage.updateMany({ where: { id: original.pendingId, replyProgress: { equals: original.storedProgress } }, data })
        : await tx.sessionMessage.updateMany({ where: { id: original.messageId, replyProgress: { equals: original.storedProgress } }, data });
    if (changed.count !== 1) throw new TransactionReplayRequiredError('session-input-reply-progress-changed');
    if (original.pendingId && original.messageId) await tx.sessionMessage.update({ where: { id: original.messageId }, data });
    const visibleFailure = (value: SessionMessageReplyProgressV1['returnPublication']) =>
        value?.kind === 'failed' && !value.failure.retryable ? value.failure : null;
    if (progress.discussion && progress.disposition !== 'returned'
        && !isDeepStrictEqual(visibleFailure(progress.returnPublication), visibleFailure(original.progress.returnPublication))) {
        await markDiscussionReadersChangedInTx({ tx, discussionId: progress.discussion.discussionId });
    }
    const workflowPublicationChanged = progress.workflow !== undefined
        && !isDeepStrictEqual(progress.returnPublication, original.progress.returnPublication);
    const outcomeChanged = !isDeepStrictEqual(progress.outcome, original.progress.outcome);
    if (progress.acceptedTurnId !== original.progress.acceptedTurnId
        || outcomeChanged
        || progress.disposition === 'return_pending' && original.progress.disposition !== 'return_pending'
        || workflowPublicationChanged) {
        afterTx(tx, async () => {
            try {
                const session = await db.session.findUnique({ where: { id: original.sessionId }, select: { accountId: true } });
                if (session) {
                    const payload = SessionMessageReplyPendingHintV1Schema.parse({ type: 'session-message-reply-pending-v1', v: 1,
                        sessionId: original.sessionId, requestLocalId: original.localId,
                        ...(progress.workflow ? { workflowRunId: progress.workflow.runId } : {}) });
                    await eventRouter.emitEphemeral({ userId: session.accountId, payload,
                        recipientFilter: { type: 'all-interested-in-session', sessionId: original.sessionId } });
                    // A shared Account wait has no source Session socket. Wake the
                    // admitted requester through the existing access-qualified delivery.
                    if (progress.mode === 'wait' && progress.disposition === 'observing' && outcomeChanged && progress.outcome
                        && original.requesterAccountId && original.requesterAccountId !== session.accountId) {
                        await eventRouter.emitEphemeral({ userId: original.requesterAccountId, payload,
                            recipientFilter: { type: 'all-interested-in-session', sessionId: original.sessionId } });
                    }
                    const sourceSessionId = progress.humanOrigin?.sessionId ?? progress.sourceSession?.sourceSessionId;
                    if (sourceSessionId && sourceSessionId !== original.sessionId) {
                        const source = await db.session.findUnique({ where: { id: sourceSessionId }, select: { accountId: true } });
                        // User-scoped UI sockets already receive the target
                        // Account's hint. Only a different source Account needs
                        // another publication; otherwise one change arrives twice.
                        if (source && source.accountId !== session.accountId) await eventRouter.emitEphemeral({ userId: source.accountId, payload,
                            recipientFilter: { type: 'all-interested-in-session', sessionId: sourceSessionId } });
                    }
                    if ((progress.disposition === 'return_pending' || workflowPublicationChanged) && original.targetMachineId) {
                        const machine = await inTx(tx => resolveMachineAdmissionInTx(tx, {
                            actorAccountId: session.accountId, machineId: original.targetMachineId!,
                        }));
                        if (machine.kind === 'admitted') await eventRouter.emitEphemeral({ userId: machine.custodianAccountId,
                            payload, recipientFilter: { type: 'machine-only', machineId: machine.machineId } });
                    }
                    // The requester's Account supplies return credentials;
                    // recovery need not run on the destination's host. A hint
                    // wakes the existing finite recovery read, without handing
                    // the execution Account source keys or delivery authority.
                    if (progress.disposition === 'return_pending' && progress.humanOrigin && original.requesterAccountId) {
                        const requesterAccountId = original.requesterAccountId;
                        const machines = await inTx(async tx => {
                            if (!await isSessionInputReplySourceCurrentInTx(tx, requesterAccountId, progress, undefined,
                                { requesterAccountId, sessionId: original.sessionId })) return [];
                            const candidates = await tx.machine.findMany({ where: { accountId: requesterAccountId }, select: { id: true } });
                            const admitted = [];
                            for (const candidate of candidates) {
                                const machine = await resolveMachineAdmissionInTx(tx, { actorAccountId: requesterAccountId, machineId: candidate.id });
                                if (machine.kind === 'admitted') admitted.push(machine);
                            }
                            return admitted;
                        });
                        for (const machine of machines) await eventRouter.emitEphemeral({ userId: machine.custodianAccountId,
                            payload, recipientFilter: { type: 'machine-only', machineId: machine.machineId } });
                    }
                }
            } catch {
                log({ module: 'session-message-reply', level: 'warn', event: 'reply-pending-hint-failed' },
                    'Reply custody is retained after its pending hint could not be published');
            }
        });
    }
    return progress;
}

/** Discussion read admission owns the displayed questions; return only their non-content refusal. */
export async function readDiscussionReplyPublicationFailuresInTx(tx: Tx,
    addresses: readonly DiscussionAddressingV1[]): Promise<ReadonlyMap<string, SessionMessageReplyPublicationFailureV1>> {
    const keys = addresses.map(address => ({ sessionId: address.participantSessionId,
        localId: deriveDiscussionFollowInputLocalIdV1(address) }));
    const originals = await readOriginals(tx, keys);
    const failures = new Map<string, SessionMessageReplyPublicationFailureV1>();
    for (const [index, address] of addresses.entries()) {
        const key = keys[index]!;
        const progress = originals.get(replyKey(key))?.progress;
        if (progress?.returnPublication?.kind === 'failed' && !progress.returnPublication.failure.retryable
            && progress.disposition === 'released' && isDeepStrictEqual(progress.discussion, address)) {
            failures.set(key.localId, progress.returnPublication.failure);
        }
    }
    return failures;
}

/** Keep UNION ordering and cursor comparison at the database's own identifier collation. */
async function listOriginalReplyKeysInTx(tx: Tx, scope: Readonly<{ sessionId: string } | { machineId: string; accountId: string }>,
    after?: Readonly<{ sessionId: string; localId: string }>): Promise<Array<{ sessionId: string; localId: string }>> {
    const provider = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const quote = (identifier: string) => provider === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`;
    const values: Array<string | number> = [];
    const bind = (value: string | number) => { values.push(value); return provider === 'postgres' ? `$${values.length}` : '?'; };
    const select = (table: 'SessionPendingMessage' | 'SessionMessage') => `SELECT ${quote('sessionId')}, ${quote('localId')} FROM ${quote(table)}
        WHERE ${quote('replyDisposition')} = ${bind('return_pending')} AND ${quote('localId')} IS NOT NULL AND ${'sessionId' in scope
            ? `${quote('sessionId')} = ${bind(scope.sessionId)}`
            : `((${quote('replyTargetMachineId')} = ${bind(scope.machineId)} AND ${quote('sessionId')} IN (SELECT ${quote('id')} FROM ${quote('Session')} WHERE ${quote('accountId')} = ${bind(scope.accountId)}))
                OR (${quote('authorAccountId')} = ${bind(scope.accountId)} AND ${quote('replySourceSessionId')} IN
                    (SELECT ${quote('id')} FROM ${quote('Session')} WHERE ${quote('accountId')} = ${bind(scope.accountId)})))`}`;
    const union = `${select('SessionPendingMessage')} UNION ${select('SessionMessage')}`;
    const cursor = after ? `WHERE (${quote('sessionId')} > ${bind(after.sessionId)} OR (${quote('sessionId')} = ${bind(after.sessionId)} AND ${quote('localId')} > ${bind(after.localId)}))` : '';
    // Identifiers above are server constants. Every caller value remains a bound parameter.
    return tx.$queryRawUnsafe<Array<{ sessionId: string; localId: string }>>(`SELECT ${quote('sessionId')}, ${quote('localId')} FROM (${union}) ${quote('originals')}
        ${cursor} ORDER BY ${quote('sessionId')}, ${quote('localId')} LIMIT ${bind(SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 + 1)}`, ...values);
}

/** The existing admitted Machine is only a recovery executor for its original inputs. */
export async function isSessionMessageReplyMachineCurrentInTx(tx: Tx, params: Readonly<{
    accountId: string; machineId: string; installationId?: string;
}>): Promise<boolean> {
    const machine = await resolveMachineAdmissionInTx(tx, { actorAccountId: params.accountId, machineId: params.machineId });
    return machine.kind === 'admitted'
        && (params.installationId === undefined || machine.installationId === params.installationId);
}

export async function listSessionMessageRepliesPendingForMachineInTx(tx: Tx, params: Readonly<{
    accountId: string; machineId: string; after?: { sessionId: string; localId: string }; authentication: SessionAccessAuthentication;
}>): Promise<SessionMessageReplyMachinePendingPageV1> {
    const empty = { v: 1 as const, entries: [], nextAfter: null };
    if (!await isSessionMessageReplyMachineCurrentInTx(tx, params)) return empty;
    const originals = await listOriginalReplyKeysInTx(tx, { machineId: params.machineId, accountId: params.accountId }, params.after);
    const entries: SessionMessageReplyMachinePendingPageV1['entries'] = [];
    const replies = await readSessionMessageRepliesInTx(tx, { ...params, recoveryMachineId: params.machineId,
        requests: originals.slice(0, SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1) });
    for (const { sessionId, localId, reply: visible } of replies) {
        if (visible.status === 'available' && visible.progress.disposition === 'return_pending' && visible.progress.outcome) {
            entries.push({ requestSessionId: sessionId, requestLocalId: localId, progress: visible.progress,
                ...(visible.returnRecipient ? { returnRecipient: visible.returnRecipient } : {}) });
        }
    }
    return { v: 1, entries, nextAfter: originals.length > SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 ? originals[SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 - 1]! : null };
}

/** Execution custody never confers access to a person's private return Session. */
async function canRecoverOriginalReplyInTx(tx: Tx, original: Original, params: Readonly<{ accountId: string; machineId: string }>,
    sessionOwned?: boolean): Promise<boolean> {
    if (original.progress?.humanOrigin && original.requesterAccountId === params.accountId) {
        // Account credentials recover the request; ordinary send admission
        // independently resolves the destination's current execution Machine.
        return true;
    }
    return original.targetMachineId === params.machineId
        && (sessionOwned ?? await tx.session.findFirst({ where: { id: original.sessionId, accountId: params.accountId }, select: { id: true } }) !== null)
        && (!original.progress?.humanOrigin || original.requesterAccountId === params.accountId);
}

/** Indexed original-input recovery page; it neither scans transcript content nor creates delivery custody. */
export async function listSessionMessageRepliesPendingInTx(tx: Tx, params: Readonly<{
    accountId: string; sessionId: string; afterLocalId?: string; authentication: SessionAccessAuthentication;
}>): Promise<SessionMessageReplyPendingPageV1> {
    const access = await resolveEffectiveSessionAccessForSessionsInTx(tx, { ...params, sessionIds: [params.sessionId] });
    if (!access.get(params.sessionId)?.capabilities.readTranscript) return { v: 1, entries: [], nextAfterLocalId: null };
    const originals = await listOriginalReplyKeysInTx(tx, { sessionId: params.sessionId }, params.afterLocalId
        ? { sessionId: params.sessionId, localId: params.afterLocalId } : undefined);
    const entries: SessionMessageReplyPendingPageV1['entries'] = [];
    const replies = await readSessionMessageRepliesWithAccessInTx(tx, { ...params,
        requests: originals.slice(0, SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1) }, access);
    for (const { localId, reply: result } of replies) {
        if (result.status === 'available' && result.progress.disposition === 'return_pending') entries.push({ requestLocalId: localId, progress: result.progress,
            ...(result.returnRecipient ? { returnRecipient: result.returnRecipient } : {}) });
    }
    return { v: 1, entries, nextAfterLocalId: originals.length > SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 ? originals[SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 - 1]!.localId : null };
}

/** Authenticated original input admission binds the destination without inventing a causal turn. */
export async function createSessionInputReplyProgressInTx(tx: Tx, params: Readonly<{
    accountId: string; reply: SessionMessageReplyAdmissionV1; authentication?: SessionAccessAuthentication; requestSessionId?: string;
}>): Promise<SessionMessageReplyProgressV1 | null> {
    if (params.reply.humanOrigin) {
        if (params.reply.mode !== 'return' || params.reply.sourceSession || params.reply.discussion || params.reply.actionRequestAttributionV1
            || params.authentication?.authority !== 'present_user' || !params.requestSessionId) return null;
        const progress: SessionMessageReplyProgressV1 = { v: 1, ...params.reply, disposition: 'return_pending' };
        return await isSessionInputReplySourceCurrentInTx(tx, params.accountId, progress, params.authentication,
            { requesterAccountId: params.accountId, sessionId: params.requestSessionId }) ? progress : null;
    }
    if (params.reply.discussion) {
        if ((params.reply.workflow ? params.reply.mode !== 'wait' : params.reply.mode !== 'return')
            || params.requestSessionId !== undefined && params.reply.discussion.participantSessionId !== params.requestSessionId
            || !await isDiscussionReplyDestinationCurrentInTx(tx, {
            accountId: params.accountId, discussion: params.reply.discussion, workflow: params.reply.workflow,
        })) return null;
        // The accepted Workflow chooses its executing leaf; the original
        // message's producer is not that leaf's causal admission authority.
        if (params.reply.workflow) return { v: 1, ...params.reply, disposition: 'observing' };
        const question = await tx.discussionMessage.findUnique({ where: { id: params.reply.discussion.messageId }, select: { producerV1: true } });
        const producer = question?.producerV1 == null ? null : DiscussionProducerV1StoredSchema.safeParse(question.producerV1);
        if (producer && !producer.success || !isDeepStrictEqual(producer?.success && producer.data.kind === 'agent' ? producer.data.sourceSession : undefined,
            params.reply.sourceSession)) return null;
        return { v: 1, ...params.reply, disposition: 'return_pending' };
    }
    if (!params.reply.sourceSession) return params.reply.mode === 'wait' ? { v: 1, ...params.reply, disposition: 'observing' } : null;
    const sourceInput = params.reply.sourceSession.sourceInputId ? await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
        sessionId: params.reply.sourceSession.sourceSessionId, localId: params.reply.sourceSession.sourceInputId,
    } }, select: { targetExecutionRunId: true, acceptedTurnId: true } }) : null;
    if (sourceInput?.targetExecutionRunId && sourceInput.acceptedTurnId !== params.reply.sourceSession.sourceTurnId) return null;
    const source = await tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
        sessionId: params.reply.sourceSession.sourceSessionId, turnId: params.reply.sourceSession.sourceTurnId,
    } }, select: { status: true, session: { select: { accountId: true, archivedAt: true } } } });
    if (!source) {
        // Run-native turns have no primary SessionTurn row. Their accepted input
        // is already stamped by the canonical Pending acceptance owner.
        const input = params.reply.sourceSession.sourceInputId ? await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
            sessionId: params.reply.sourceSession.sourceSessionId, localId: params.reply.sourceSession.sourceInputId,
        } }, select: { targetExecutionRunId: true, acceptedTurnId: true, session: { select: { accountId: true, archivedAt: true } } } }) : null;
        if (!input?.targetExecutionRunId || input.acceptedTurnId !== params.reply.sourceSession.sourceTurnId
            || input.session.accountId !== params.accountId || input.session.archivedAt !== null) return null;
        return { v: 1, ...params.reply, disposition: 'observing' };
    }
    if (source.session.accountId !== params.accountId || source.session.archivedAt !== null) return null;
    return { v: 1, ...params.reply, disposition: source.status === 'in_progress' ? 'observing'
        : params.reply.mode === 'return' ? 'return_pending' : 'released' };
}

/** The existing provider-accepted Pending owner supplies the witnessed native turn for primary and Run inputs. */
export async function bindSessionInputReplyAcceptedTurnInTx(tx: Tx, params: Readonly<{
    sessionId: string; localId: string; acceptedTurnId?: string;
}>): Promise<boolean> {
    const original = await readOriginal(tx, params.sessionId, params.localId);
    if (original?.malformed) return false;
    if (!original?.progress) return true;
    if (!params.acceptedTurnId || original.progress.acceptedTurnId && original.progress.acceptedTurnId !== params.acceptedTurnId) return false;
    await writeOriginal(tx, original, { ...original.progress, acceptedTurnId: params.acceptedTurnId });
    return true;
}

async function canRead(tx: Tx, accountId: string, sessionId: string, authentication: SessionAccessAuthentication): Promise<boolean> {
    return (await resolveSessionAccessForOperation(tx, { accountId, sessionId, authentication, capability: 'readTranscript' })).status === 'allowed';
}

/** Original answer routing is not a grant to the source transcript. */
export async function isSessionInputReplySourceCurrentInTx(tx: Tx, accountId: string, progress: SessionMessageReplyProgressV1,
    authentication?: SessionAccessAuthentication,
    humanRequest?: Readonly<{ requesterAccountId: string | null; sessionId: string }>): Promise<boolean> {
    if (progress.humanOrigin) {
        const requesterAccountId = humanRequest ? humanRequest.requesterAccountId : accountId;
        if (!requesterAccountId) return false;
        const requesterAuthentication = requesterAccountId === accountId ? authentication : backgroundDeliveryAuthentication();
        return await isHumanReplyDestinationCurrentInTx(tx, requesterAccountId, progress.humanOrigin.sessionId, requesterAuthentication)
            && (!humanRequest || (await mayInjectResourceContextInTx(tx, {
                configuringAccountId: requesterAccountId, authentication: requesterAuthentication ?? backgroundDeliveryAuthentication(),
                source: { kind: 'session', sessionId: humanRequest.sessionId },
                destination: { kind: 'session', sessionId: progress.humanOrigin.sessionId },
            })).ok);
    }
    if (progress.discussion) return isDiscussionReplyDestinationCurrentInTx(tx, { accountId, discussion: progress.discussion, workflow: progress.workflow });
    if (!progress.sourceSession) return true;
    return isSessionInputSourceCurrentInTx(tx, accountId, progress.sourceSession);
}

async function isHumanReplyDestinationCurrentInTx(tx: Tx, accountId: string, sessionId: string,
    authentication: SessionAccessAuthentication = backgroundDeliveryAuthentication()): Promise<boolean> {
    const source = await tx.session.findUnique({ where: { id: sessionId },
        select: { accountId: true, archivedAt: true, account: { select: { status: true } } } });
    return source?.accountId === accountId && source.archivedAt === null && source.account.status === 'active'
        && (await resolveSessionAccessForOperation(tx, { accountId, sessionId, authentication, capability: 'submitAgentInput' })).status === 'allowed';
}

/** The trusted Workflow host validates sealed execution bindings; the Home owns its durable index and live resource admission. */
async function readWorkflowReplyInvocationInTx(tx: Tx, accountId: string, workflow: SessionInputWorkflowV2) {
    return tx.workflowRunInvocation.findFirst({ where: { id: workflow.invocationRecordId, runId: workflow.runId,
        run: { accountId, workflowAcceptedSnapshotEnvelope: { not: null } } }, select: { attempt: true, lifecycle: true } });
}

/** Ordinary asks consume the addressed snapshot; accepted Workflow leaves consume their existing invocation authority. */
export async function isDiscussionReplyDestinationCurrentInTx(tx: Tx, params: Readonly<{
    accountId: string; discussion: DiscussionAddressingV1; authentication?: SessionAccessAuthentication; workflow?: SessionInputWorkflowV2;
}>): Promise<boolean> {
    return isDiscussionReplyDestinationAdmittedInTx(tx, params, false);
}

/** Retained original reads preserve custody; only write admission requires a live participant Session. */
async function isDiscussionReplyDestinationAdmittedInTx(tx: Tx, params: Readonly<{
    accountId: string; discussion: DiscussionAddressingV1; authentication?: SessionAccessAuthentication; workflow?: SessionInputWorkflowV2;
}>, readRetainedCustody: boolean): Promise<boolean> {
    const { discussion } = params;
    const authentication = params.authentication ?? backgroundDeliveryAuthentication();
    const [question, participant, resource, context] = await Promise.all([
        tx.discussionMessage.findFirst({ where: { id: discussion.messageId, discussionId: discussion.discussionId },
            select: { seq: true, addressingV1: true } }),
        tx.discussionParticipant.findUnique({ where: { discussionId_sessionId: {
            discussionId: discussion.discussionId, sessionId: discussion.participantSessionId,
        } }, select: { answerPolicy: true, removedAt: true, session: { select: { accountId: true, archivedAt: true, originKind: true, originRunId: true } } } }),
        tx.discussion.findUnique({ where: { id: discussion.discussionId }, select: { archivedAt: true } }),
        resolveDiscussionContextInTx(tx, { discussionId: discussion.discussionId, accountId: params.accountId, authentication }),
    ]);
    const snapshot = DiscussionMessageAddressingV1Schema.safeParse(question?.addressingV1);
    const workflowInvocation = params.workflow ? await readWorkflowReplyInvocationInTx(tx, params.accountId, params.workflow) : null;
    const session = participant?.session ?? (params.workflow ? await tx.session.findUnique({ where: { id: discussion.participantSessionId },
        select: { accountId: true, archivedAt: true, originKind: true, originRunId: true } }) : null);
    if (!question || question.seq !== discussion.throughSeq
        || (params.workflow ? !workflowInvocation : !snapshot.success || snapshot.data.throughSeq !== discussion.throughSeq
        || !snapshot.data.participantSessionIds.includes(discussion.participantSessionId)
        || !participant || snapshot.data.watcherSessionIds?.includes(discussion.participantSessionId) && participant.answerPolicy !== 'watches_and_speaks_up')
        || participant && (participant.removedAt !== null
            || !discussionParticipantCanAnswerV1(participant.answerPolicy))
        // A removed selected Session is not an implicit Workflow leaf. The
        // native birth owner already binds legitimate implicit leaves to this Run.
        || !participant && params.workflow && (session?.originKind !== 'run_step' || session.originRunId !== params.workflow.runId)
        || session?.accountId !== params.accountId || !readRetainedCustody && session.archivedAt !== null
        || !resource || resource.archivedAt !== null || !context?.keyReadiness || context.access.level === 'view') return false;
    return (await mayInjectResourceContextInTx(tx, { configuringAccountId: params.accountId, authentication,
        source: { kind: 'resource', resourceId: discussion.discussionId, adapter: discussionContextStorageAdapter },
        destination: { kind: 'session', sessionId: discussion.participantSessionId } })).ok;
}

/** Only protected original custody can classify a Discussion publication as an informational return. */
export async function readSessionInputDiscussionReplyReturnInTx(tx: Tx, params: Readonly<{
    accountId: string; sessionId: string; requestLocalId: string; acceptedTurnId?: string;
    discussionId: string; parentMessageId: string; localId: string; workflow?: SessionMessageDiscussionReplyReturnV1['workflow'];
}>): Promise<SessionMessageReplyProgressV1 | null> {
    const original = await readOriginal(tx, params.sessionId, params.requestLocalId);
    const progress = original?.progress;
    const workflow = progress?.workflow;
    const invocation = workflow && params.workflow ? await readWorkflowReplyInvocationInTx(tx, params.accountId, workflow) : null;
    const workflowReturn = workflow !== undefined && params.workflow !== undefined && progress?.mode === 'wait'
        && params.workflow.runId === workflow.runId && params.workflow.invocationRecordId === workflow.invocationRecordId
        && params.requestLocalId === deriveWorkflowSessionInputLocalIdV2(workflow)
        && (invocation?.lifecycle === 'completed' || invocation?.lifecycle === 'failed' || invocation?.lifecycle === 'cancelled')
        && invocation.attempt.toString() === params.workflow.invocationAttempt
        && progress.outcome !== undefined;
    if (!progress?.discussion || (workflow ? !workflowReturn : progress.mode !== 'return' || params.workflow !== undefined)
        || progress.discussion.participantSessionId !== params.sessionId || progress.discussion.discussionId !== params.discussionId
        || progress.discussion.messageId !== params.parentMessageId || progress.acceptedTurnId !== params.acceptedTurnId
        || !params.acceptedTurnId && (!progress.outcome || !['failed', 'cancelled'].includes(progress.outcome.kind))
        || !(workflowReturn ? ['observing', 'inline', 'returned'] : ['return_pending', 'returned']).includes(progress.disposition)
        || params.localId !== deriveSessionMessageReplyReturnLocalIdV1({ sessionId: params.sessionId,
            localId: params.requestLocalId, acceptedTurnId: params.acceptedTurnId })
        || !await isDiscussionReplyDestinationCurrentInTx(tx, { accountId: params.accountId, discussion: progress.discussion, workflow })) return null;
    // The accepted Workflow result owns the outward terminal fact, even when
    // its native turn completed before result validation failed or Stop won.
    return workflowReturn && (invocation?.lifecycle === 'failed' || invocation?.lifecycle === 'cancelled')
        ? { ...progress, outcome: { kind: invocation.lifecycle } } : progress;
}

/** Called by the sole Discussion writer inside its publication transaction, never by a caller ACK. */
export async function settleSessionInputDiscussionReplyReturnInTx(tx: Tx, params: Readonly<{
    accountId: string; sessionId: string; requestLocalId: string; acceptedTurnId?: string;
    publicationRef: DiscussionMessageRefV1; localId: string; workflow?: SessionMessageDiscussionReplyReturnV1['workflow'];
    outcome: SessionMessageReplyOutcomeV1;
}>): Promise<boolean> {
    const original = await readOriginal(tx, params.sessionId, params.requestLocalId);
    const progress = original?.progress;
    if (!original || !progress?.discussion || !await readSessionInputDiscussionReplyReturnInTx(tx, {
        ...params, discussionId: params.publicationRef.discussion.discussionId, parentMessageId: progress.discussion.messageId,
    })) return false;
    if (progress.outcome?.kind === 'answer' && 'publicationRef' in progress.outcome
        && !isDeepStrictEqual(progress.outcome.publicationRef, params.publicationRef)) return false;
    const { returnPublication: _publication, ...captured } = progress;
    await writeOriginal(tx, original, { ...captured, outcome: params.outcome,
        disposition: 'returned', returnedInputLocalId: params.localId });
    return true;
}

/** Removal/archive withdraws outstanding obligations in their original custody, so reinvitation cannot revive them. */
export async function withdrawDiscussionInputRepliesInTx(tx: Tx, params: Readonly<{
    discussionId: string; participantSessionId?: string;
}>): Promise<void> {
    const sessionIds = params.participantSessionId ? [params.participantSessionId]
        : (await tx.discussionParticipant.findMany({ where: { discussionId: params.discussionId }, select: { sessionId: true } }))
            .flatMap(row => row.sessionId ? [row.sessionId] : []);
    if (!sessionIds.length) return;
    const where = { sessionId: { in: sessionIds }, replyDisposition: { in: ['observing', 'return_pending', 'inline'] } };
    const [pending, messages] = await Promise.all([
        tx.sessionPendingMessage.findMany({ where, select: { sessionId: true, localId: true } }),
        tx.sessionMessage.findMany({ where, select: { sessionId: true, localId: true } }),
    ]);
    const seen = new Set<string>();
    for (const row of [...pending, ...messages]) {
        if (!row.localId) continue;
        const key = JSON.stringify([row.sessionId, row.localId]);
        if (seen.has(key)) continue;
        seen.add(key);
        const original = await readOriginal(tx, row.sessionId, row.localId);
        if (!original?.progress?.discussion || original.progress.discussion.discussionId !== params.discussionId) continue;
        if (original.progress.disposition === 'inline' && !original.progress.workflow) continue;
        await writeOriginal(tx, original, { ...original.progress, disposition: 'released',
            outcome: original.progress.outcome ?? { kind: 'cancelled' } });
    }
}

/** One current causal-Session check for input custody and trusted resource publication. */
export async function isSessionInputSourceCurrentInTx(tx: Tx, accountId: string, sourceSession: SessionInputSourceSessionV1): Promise<boolean> {
    const sourceInput = sourceSession.sourceInputId ? await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
        sessionId: sourceSession.sourceSessionId, localId: sourceSession.sourceInputId,
    } }, select: { seq: true, targetExecutionRunId: true, acceptedTurnId: true } }) : null;
    if (sourceInput?.targetExecutionRunId && sourceInput.acceptedTurnId !== sourceSession.sourceTurnId) return false;
    if (sourceInput?.acceptedTurnId && sourceInput.acceptedTurnId !== sourceSession.sourceTurnId) return false;
    const source = await tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
        sessionId: sourceSession.sourceSessionId, turnId: sourceSession.sourceTurnId,
    } }, select: { transcriptAnchorsJson: true, session: { select: { accountId: true, archivedAt: true, account: { select: { status: true } } } } } });
    if (source) {
        // Accepted input custody binds ordinary native turns before their
        // transcript anchors publish. Historical inputs without that binding
        // still require the exact transcript correspondence below.
        if (sourceSession.sourceInputId && !sourceInput?.targetExecutionRunId
            && sourceInput?.acceptedTurnId !== sourceSession.sourceTurnId) {
            const anchors = parseStoredSessionTurnTranscriptAnchors(source.transcriptAnchorsJson);
            if (!sourceInput || !(anchors?.startUserMessageSeq === sourceInput.seq || anchors?.userMessageSeqs?.includes(sourceInput.seq))) return false;
        }
        return source.session.accountId === accountId && source.session.archivedAt === null && source.session.account.status === 'active';
    }
    if (!sourceSession.sourceInputId) return false;
    const input = await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
        sessionId: sourceSession.sourceSessionId, localId: sourceSession.sourceInputId,
    } }, select: { targetExecutionRunId: true, acceptedTurnId: true, session: { select: { accountId: true, archivedAt: true, account: { select: { status: true } } } } } });
    return input?.targetExecutionRunId != null && input.acceptedTurnId === sourceSession.sourceTurnId
        && input.session.accountId === accountId && input.session.archivedAt === null && input.session.account.status === 'active';
}

async function resolveReturnExecutionRunIdInTx(tx: Tx, progress: SessionMessageReplyProgressV1): Promise<string | null> {
    if (progress.discussion) return null;
    if (!progress.sourceSession?.sourceInputId) return null;
    const source = await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
        sessionId: progress.sourceSession.sourceSessionId, localId: progress.sourceSession.sourceInputId,
    } }, select: { targetExecutionRunId: true, acceptedTurnId: true } });
    return source?.acceptedTurnId === progress.sourceSession.sourceTurnId ? source.targetExecutionRunId : null;
}

/** Reads custody only; observation never consumes an outcome or changes a disposition. */
export async function readSessionMessageReplyInTx(tx: Tx, params: Readonly<{
    accountId: string; sessionId: string; localId: string; authentication: SessionAccessAuthentication;
}>): Promise<SessionMessageReplyReadResultV1> {
    return (await readSessionMessageRepliesInTx(tx, { ...params, requests: [params] }))[0]!.reply;
}

type ReplyReadParams = Readonly<{
    accountId: string; requests: readonly ReplyKey[]; authentication: SessionAccessAuthentication;
    /** Recovery additionally requires original-input custody; Machine admission stays with its caller. */
    recoveryMachineId?: string;
}>;

/** Single and batch transports share original custody and one snapshot's exact access/currentness facts. */
export async function readSessionMessageRepliesInTx(tx: Tx, params: ReplyReadParams): Promise<Array<ReplyKey & { reply: SessionMessageReplyReadResultV1 }>> {
    if (!params.requests.length) return [];
    const access = await resolveEffectiveSessionAccessForSessionsInTx(tx, { ...params,
        sessionIds: params.requests.map(key => key.sessionId) });
    return readSessionMessageRepliesWithAccessInTx(tx, params, access);
}

/** Recovery may already have admitted access before listing its cursor; reuse that same snapshot. */
async function readSessionMessageRepliesWithAccessInTx(tx: Tx, params: ReplyReadParams,
    access: ReadonlyMap<string, EffectiveSessionAccess>): Promise<Array<ReplyKey & { reply: SessionMessageReplyReadResultV1 }>> {
    const originals = await readOriginals(tx, params.requests.filter(key => access.get(key.sessionId)?.capabilities.readTranscript));
    // These are shared decisions inside this read snapshot, not retained result caches.
    const currentness = new Map<string, Promise<boolean>>();
    const returnRecipients = new Map<string, Promise<string | null>>();
    const read = async (key: ReplyKey): Promise<SessionMessageReplyReadResultV1> => {
        const original = originals.get(replyKey(key));
        if (!original || original.malformed) return { v: 1, status: 'unavailable' };
        if (params.recoveryMachineId !== undefined && !await canRecoverOriginalReplyInTx(tx, original,
            { accountId: params.accountId, machineId: params.recoveryMachineId }, access.get(key.sessionId)?.level === 'owner')) {
            return { v: 1, status: 'unavailable' };
        }
        const progress = original.progress;
        if (!progress) return { v: 1, status: 'none' };
        const retainedWorkflowCustody = progress.mode === 'wait' && progress.workflow !== undefined
            && progress.outcome !== undefined && progress.discussion?.participantSessionId === key.sessionId
            && key.localId === deriveWorkflowSessionInputLocalIdV2(progress.workflow);
        const sourceKey = JSON.stringify(progress.humanOrigin
            ? ['human', progress.humanOrigin.sessionId, original.requesterAccountId, original.sessionId]
            : progress.discussion ? ['discussion', progress.discussion, progress.workflow, retainedWorkflowCustody]
                : ['session', progress.sourceSession]);
        let current = currentness.get(sourceKey);
        if (!current) {
            current = retainedWorkflowCustody && progress.discussion
                ? isDiscussionReplyDestinationAdmittedInTx(tx, { accountId: params.accountId,
                    discussion: progress.discussion, workflow: progress.workflow }, true)
                : isSessionInputReplySourceCurrentInTx(tx, params.accountId, progress, params.authentication,
                    { requesterAccountId: original.requesterAccountId, sessionId: original.sessionId });
            currentness.set(sourceKey, current);
        }
        if (!await current) return { v: 1, status: 'unavailable' };
        const recipientKey = JSON.stringify(progress.discussion ? null : progress.sourceSession ?? null);
        let recipient = returnRecipients.get(recipientKey);
        if (!recipient) {
            recipient = resolveReturnExecutionRunIdInTx(tx, progress);
            returnRecipients.set(recipientKey, recipient);
        }
        const returnExecutionRunId = await recipient;
        return { v: 1, status: 'available', progress,
            ...(original.targetExecutionRunId ? { recipient: { kind: 'execution_run', runId: original.targetExecutionRunId } as const } : {}),
            ...(returnExecutionRunId ? { returnRecipient: { kind: 'execution_run', runId: returnExecutionRunId } as const } : {}),
            ...(original.sidechainId ? { sidechainId: original.sidechainId } : {}) };
    };
    const results = [];
    for (const key of params.requests) results.push({ sessionId: key.sessionId, localId: key.localId, reply: await read(key) });
    return results;
}

/** Original-requester observation or non-publishing person review, never a raw metadata actor. */
export async function mutateSessionMessageReplyForAccountInTx(tx: Tx, params: Readonly<{
    accountId: string; sessionId: string; localId: string; authentication: SessionAccessAuthentication;
}> & SessionMessageReplyAccountMutationV1): Promise<SessionMessageReplyMutationResultV1> {
    const personDecision = params.kind === 'discussion_review'
        || params.kind === 'discussion_publication' && params.approvalArtifactId !== undefined;
    if (personDecision && (params.authentication.authority !== 'present_user'
        || params.authentication.sessionRuntimePrincipal || params.authentication.apiTokenGrant
        || params.authentication.externalActionExecutionAuthorized && !params.authentication.approvalDecisionAdmission)) {
        return { v: 1, ok: false, error: 'forbidden' };
    }
    // Publication failure (or clearing one on decline) also invalidates the
    // Discussion's readers, who need not have access to the participant Session.
    const discussionAccountIds = params.kind === 'discussion_review' || params.kind === 'discussion_publication'
        ? await resolveDiscussionAudienceInTx(tx, params.discussionId) : [];
    await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId], discussionAccountIds);
    if (!await canRead(tx, params.accountId, params.sessionId, params.authentication)) return { v: 1, ok: false, error: 'unavailable' };
    const original = await readOriginal(tx, params.sessionId, params.localId);
    if (!original?.progress) return { v: 1, ok: false, error: 'unavailable' };
    const decisionAdmission = params.authentication.approvalDecisionAdmission;
    if (decisionAdmission && personDecision) {
        const current = original.progress;
        // The demanded Session/localId selects canonical pending custody (or
        // its materialized row). Only that row's pending Artifact may advance.
        if (current.returnPublication?.kind === 'approval_pending') {
            if (current.returnPublication.artifactId !== decisionAdmission.artifactId) return { v: 1, ok: false, error: 'forbidden' };
        } else {
            // A response-lost repeat can observe the same terminal state; it
            // cannot replace a failure or advance unrelated settled custody.
            const unchanged = params.kind === 'discussion_review'
                ? current.disposition === 'released' && current.outcome?.kind === 'declined'
                : params.kind === 'discussion_publication' && isDeepStrictEqual(current.returnPublication, params.publication);
            if (!unchanged) return { v: 1, ok: false, error: 'forbidden' };
        }
    }
    if (params.kind === 'discussion_publication') {
        const session = await tx.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true } });
        if (session?.accountId !== params.accountId || (await resolveSessionAccessForOperation(tx, {
            accountId: params.accountId, sessionId: params.sessionId, authentication: params.authentication,
            capability: 'submitAgentInput' })).status !== 'allowed') return { v: 1, ok: false, error: 'forbidden' };
        const current = original.progress;
        const workflowReturn = current.mode === 'wait' && current.workflow !== undefined;
        if ((!workflowReturn && current.mode !== 'return') || !current.outcome || current.outcome.kind === 'declined'
            || current.discussion?.discussionId !== params.discussionId || current.discussion.messageId !== params.messageId
            || current.discussion.participantSessionId !== params.sessionId || current.acceptedTurnId !== params.acceptedTurnId) {
            return { v: 1, ok: false, error: 'conflict' };
        }
        // The append may have committed before its acknowledgement was lost.
        // Rejoin only after current owner admission and the exact original tuple.
        if (current.disposition === 'returned') return { v: 1, ok: true, progress: current };
        if (current.outcome.kind === 'answer' && 'publicationRef' in current.outcome) return { v: 1, ok: false, error: 'conflict' };
        if (params.approvalArtifactId && current.returnPublication?.kind === 'approval_pending'
            && current.returnPublication.artifactId !== params.approvalArtifactId) return { v: 1, ok: false, error: 'conflict' };
        if (current.returnPublication && isDeepStrictEqual(current.returnPublication, params.publication)) return { v: 1, ok: true, progress: current };
        if (!(workflowReturn ? ['observing', 'inline'] : ['return_pending']).includes(current.disposition)
            || current.returnPublication?.kind === 'approval_pending' && !params.approvalArtifactId) return { v: 1, ok: false, error: 'conflict' };
        const progress: SessionMessageReplyProgressV1 = { ...current, returnPublication: params.publication,
            disposition: params.publication.kind === 'failed' && !params.publication.failure.retryable ? 'released' : current.disposition };
        return { v: 1, ok: true, progress: await writeOriginal(tx, original, progress) };
    }
    if (params.kind === 'discussion_review') {
        const session = await tx.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true } });
        if (session?.accountId !== params.accountId || (await resolveSessionAccessForOperation(tx, {
            accountId: params.accountId, sessionId: params.sessionId, authentication: params.authentication,
            capability: 'submitAgentInput' })).status !== 'allowed') return { v: 1, ok: false, error: 'forbidden' };
        const current = original.progress;
        const workflowDraft = current.mode === 'wait' && current.workflow !== undefined;
        if ((!workflowDraft && current.mode !== 'return') || current.discussion?.discussionId !== params.discussionId
            || current.discussion.messageId !== params.messageId || current.discussion.participantSessionId !== params.sessionId
            || current.acceptedTurnId !== params.acceptedTurnId) return { v: 1, ok: false, error: 'conflict' };
        if (current.disposition === 'released' && current.outcome?.kind === 'declined') return { v: 1, ok: true, progress: current };
        if (!(workflowDraft ? ['observing', 'inline'] : ['return_pending']).includes(current.disposition) || current.outcome?.kind === 'declined'
            || current.outcome?.kind === 'answer' && (!('result' in current.outcome)
                || current.outcome.result.sessionId !== params.sessionId)) return { v: 1, ok: false, error: 'conflict' };
        // Rejection discloses no source/body and needs no source-key admission.
        // The private Artifact retains reject versus cancel; C2 only closes the return.
        const { returnPublication: _publication, ...captured } = current;
        const progress: SessionMessageReplyProgressV1 = { ...captured, disposition: 'released', outcome: { kind: 'declined' } };
        return { v: 1, ok: true, progress: await writeOriginal(tx, original, progress) };
    }
    if (original.progress.sourceSession || original.progress.discussion) return { v: 1, ok: false, error: 'forbidden' };
    if (!await isSessionInputReplySourceCurrentInTx(tx, params.accountId, original.progress, params.authentication,
        { requesterAccountId: original.requesterAccountId, sessionId: original.sessionId })) return { v: 1, ok: false, error: 'unavailable' };
    const row = original.pendingId ? await tx.sessionPendingMessage.findUnique({ where: { id: original.pendingId }, select: { inputAdmissionReceipt: true } })
        : await tx.sessionMessage.findUnique({ where: { id: original.messageId }, select: { inputAdmissionReceipt: true } });
    const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(row?.inputAdmissionReceipt);
    const accountRequester = receipt.success && receipt.data.issuer === 'authenticatedAccount' && receipt.data.actorAccountId === params.accountId;
    const machineRequester = receipt.success && receipt.data.issuer === 'authenticatedMachine'
        && !original.progress.humanOrigin
        && receipt.data.admittedTarget?.accountId === params.accountId
        && await tx.session.findFirst({ where: { id: params.sessionId, accountId: params.accountId }, select: { id: true } }) !== null;
    if (!accountRequester && !machineRequester) {
        return { v: 1, ok: false, error: 'forbidden' };
    }
    const current = original.progress;
    if (params.kind === 'inline' && (!current.outcome || !['observing', 'inline'].includes(current.disposition))) return { v: 1, ok: false, error: 'conflict' };
    const progress: SessionMessageReplyProgressV1 = params.kind === 'inline' ? { ...current, disposition: 'inline' }
        : current.disposition === 'observing' ? { ...current, disposition: 'released' } : current;
    return { v: 1, ok: true, progress: await writeOriginal(tx, original, progress) };
}

async function isCommittedResultInTx(tx: Tx, original: Original, turnId: string, messageId: string,
    status: 'completed' | 'cancelled' = 'completed',
    nativeResult?: Extract<SessionMessageReplyOperationV1, { kind: 'fulfill' }>['nativeResult']): Promise<boolean> {
    if (nativeResult && (!original.targetExecutionRunId || !original.sidechainId || original.messageSeq === undefined
        || original.targetExecutionRunId !== nativeResult.runId || original.sidechainId !== nativeResult.sidechainId)) return false;
    const publication = await loadSessionTranscriptPublication(tx, original.sessionId);
    const result = await tx.sessionMessage.findFirst({ where: buildSessionMessagePublicationWhere({
        where: { id: messageId, sessionId: original.sessionId, sidechainId: original.sidechainId, messageRole: { in: ['agent', 'assistant'] } }, publication,
    }), select: { localId: true, seq: true } });
    if (!result) return false;
    // The current host owns native turn evidence. Its exact committed-row
    // witness is admitted only for this original's accepted Run/sidechain;
    // neither encrypted metadata nor a later row in the parent proves it.
    if (nativeResult) return result.localId === nativeResult.localId && result.seq > original.messageSeq!;
    if (result.localId === deriveSessionMessageReplyAnswerLocalIdV1({ sessionId: original.sessionId, localId: original.localId, acceptedTurnId: turnId })) return true;
    // Only the ordinary terminal owner can prove a primary final. A Run's
    // encrypted native marker is not readable server evidence for an unrelated row.
    if (original.targetExecutionRunId !== null || original.sidechainId !== null || original.messageSeq === undefined) return false;
    const turn = await tx.sessionTurn.findUnique({ where: { sessionId_turnId: { sessionId: original.sessionId, turnId } },
        select: { status: true, transcriptAnchorsJson: true } });
    const anchors = turn ? parseStoredSessionTurnTranscriptAnchors(turn.transcriptAnchorsJson) : null;
    return turn?.status === status && anchors?.finalAssistantMessageSeq === result.seq
        && anchors.userMessageSeqs?.includes(original.messageSeq) === true;
}

async function acknowledgeReturnedInputInTx(tx: Tx, original: Original, returnedInputLocalId: string): Promise<SessionMessageReplyMutationResultV1> {
    const current = original.progress;
    const destinationSessionId = current?.humanOrigin?.sessionId ?? current?.sourceSession?.sourceSessionId;
    if (!destinationSessionId || current?.discussion || !current?.outcome || !['return_pending', 'returned'].includes(current.disposition)
        || !current.acceptedTurnId && !['failed', 'cancelled'].includes(current.outcome.kind)) return { v: 1, ok: false, error: 'conflict' };
    if (returnedInputLocalId !== deriveSessionMessageReplyReturnLocalIdV1({ sessionId: original.sessionId,
        localId: original.localId, acceptedTurnId: current.acceptedTurnId })
        || current.returnedInputLocalId && current.returnedInputLocalId !== returnedInputLocalId) return { v: 1, ok: false, error: 'conflict' };
    // An ACK alone is not delivery evidence. Rejoin the actual admitted original destination.
    const returned = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
        sessionId: destinationSessionId, localId: returnedInputLocalId,
    } }, select: { inputAdmissionReceipt: true, targetExecutionRunId: true } }) ?? await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
        sessionId: destinationSessionId, localId: returnedInputLocalId,
    } }, select: { inputAdmissionReceipt: true, targetExecutionRunId: true } });
    const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(returned?.inputAdmissionReceipt);
    if (!receipt.success || receipt.data.issuer !== 'authenticatedMachine'
        || returned?.targetExecutionRunId !== await resolveReturnExecutionRunIdInTx(tx, current)) return { v: 1, ok: false, error: 'conflict' };
    const progress: SessionMessageReplyProgressV1 = { ...current, disposition: 'returned', returnedInputLocalId };
    return { v: 1, ok: true, progress: await writeOriginal(tx, original, progress) };
}

export async function mutateSessionMessageReplyForMachineInTx(tx: Tx, params: Readonly<{
    accountId: string; installationId: string; mutation: SessionMessageReplyMachineMutationV1; authentication: SessionAccessAuthentication;
}>): Promise<SessionMessageReplyMutationResultV1> {
    const { mutation } = params;
    await acquireSessionAccountCursorLocksInTx(tx, [mutation.requestSessionId]);
    if (!await isSessionMessageReplyMachineCurrentInTx(tx, { ...params, machineId: mutation.machineId })) return { v: 1, ok: false, error: 'forbidden' };
    const original = await readOriginal(tx, mutation.requestSessionId, mutation.requestLocalId);
    if (!original || !await canRecoverOriginalReplyInTx(tx, original, { ...params, machineId: mutation.machineId })) {
        return { v: 1, ok: false, error: 'forbidden' };
    }
    const visible = await readSessionMessageReplyInTx(tx, { ...params, sessionId: mutation.requestSessionId, localId: mutation.requestLocalId });
    if (visible.status !== 'available') return { v: 1, ok: false, error: 'unavailable' };
    return acknowledgeReturnedInputInTx(tx, original, mutation.operation.returnedInputLocalId);
}

/** Every mutation is authenticated as the current publisher of its actual role. */
export async function mutateSessionMessageReplyInTx(tx: Tx, params: Readonly<{
    accountId: string; mutation: SessionMessageReplyMutationV1; publisherAuthority: CurrentSessionPublisherAuthority;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionMessageReplyMutationResultV1> {
    const { mutation } = params;
    await acquireSessionAccountCursorLocksInTx(tx, [mutation.sessionId, mutation.requestSessionId]);
    if (!await hasExactCurrentPublisherAuthorityInTx(tx, params.publisherAuthority, params.accountId, mutation.sessionId,
        undefined, { admittedWork: true })) {
        return { v: 1, ok: false, error: 'forbidden' };
    }
    const visible = await readSessionMessageReplyInTx(tx, { accountId: params.accountId, sessionId: mutation.requestSessionId,
        localId: mutation.requestLocalId, authentication: params.authentication });
    if (visible.status !== 'available') return { v: 1, ok: false, error: 'unavailable' };
    const original = await readOriginal(tx, mutation.requestSessionId, mutation.requestLocalId);
    if (!original?.progress) return { v: 1, ok: false, error: 'unavailable' };
    const current = original.progress;
    const { operation } = mutation;
    const sourceActor = mutation.sessionId === current.sourceSession?.sourceSessionId;
    let progress = current;
    if (operation.kind === 'fulfill') {
        if (operation.outcome.kind === 'declined') return { v: 1, ok: false, error: 'forbidden' };
        if (mutation.sessionId !== mutation.requestSessionId) return { v: 1, ok: false, error: 'forbidden' };
        if (current.acceptedTurnId !== operation.turnId) return { v: 1, ok: false, error: 'conflict' };
        const outcome = operation.outcome;
        if ('result' in outcome) {
            if (outcome.result.sessionId !== mutation.requestSessionId
                || original.targetExecutionRunId !== null && original.sidechainId === null
                || !await isCommittedResultInTx(tx, original, operation.turnId, outcome.result.messageId,
                    outcome.kind === 'cancelled' ? 'cancelled' : 'completed', operation.nativeResult)) return { v: 1, ok: false, error: 'conflict' };
        } else if (outcome.kind === 'answer') {
            // Native resource publications are fulfilled in their own committed transaction,
            // where that owner proves actor, addressing and access before calling the hook.
            return { v: 1, ok: false, error: 'forbidden' };
        }
        if (current.outcome && !isDeepStrictEqual(current.outcome, outcome)) return { v: 1, ok: false, error: 'conflict' };
        progress = await releaseDiscussionWatchReturnInTx(tx, { ...current, outcome });
    } else {
        if (!sourceActor && !(operation.kind === 'returned' && mutation.sessionId === mutation.requestSessionId)) {
            return { v: 1, ok: false, error: 'forbidden' };
        }
        if (operation.kind === 'inline') {
            if (!current.outcome || !['observing', 'inline'].includes(current.disposition)) return { v: 1, ok: false, error: 'conflict' };
            progress = { ...current, disposition: 'inline' };
        } else if (operation.kind === 'release') {
            if (current.disposition === 'observing') progress = { ...current, disposition: current.mode === 'return' ? 'return_pending' : 'released' };
        } else {
            return acknowledgeReturnedInputInTx(tx, original, operation.returnedInputLocalId);
        }
    }
    return { v: 1, ok: true, progress: await writeOriginal(tx, original, progress) };
}

/** Resource owners call this only after a successful named publication in the same transaction. */
export async function fulfillSessionInputReplyPublicationInTx(tx: Tx, params: Readonly<{
    accountId: string; sessionId: string; localId: string; acceptedTurnId: string;
    outcome: SessionMessageReplyOutcomeV1;
}>): Promise<boolean> {
    const original = await readOriginal(tx, params.sessionId, params.localId);
    if (!original?.progress || original.progress.acceptedTurnId !== params.acceptedTurnId
        || !await isSessionInputReplySourceCurrentInTx(tx, params.accountId, original.progress, undefined,
            { requesterAccountId: original.requesterAccountId, sessionId: original.sessionId })) return false;
    if (original.progress.outcome) return isDeepStrictEqual(original.progress.outcome, params.outcome);
    await writeOriginal(tx, original, { ...original.progress, outcome: params.outcome });
    return true;
}

/** Watch consideration settles privately; an explicit committed reply is already `returned`. */
async function releaseDiscussionWatchReturnInTx(tx: Tx, progress: SessionMessageReplyProgressV1): Promise<SessionMessageReplyProgressV1> {
    if (!progress.discussion || progress.disposition !== 'return_pending') return progress;
    const participant = await tx.discussionParticipant.findUnique({ where: { discussionId_sessionId: {
        discussionId: progress.discussion.discussionId, sessionId: progress.discussion.participantSessionId } }, select: { answerPolicy: true } });
    return participant?.answerPolicy === 'watches_and_speaks_up' ? { ...progress, disposition: 'released' } : progress;
}

/** Runs inside the canonical turn transaction: exact inputs, exact final, no latest-text inference. */
export async function projectSessionInputRepliesFromTurnInTx(tx: Tx, turn: Readonly<{
    sessionId: string; turnId: string; status: string; transcriptAnchorsJson: string | null;
}>, lateAcceptedLocalId?: string): Promise<void> {
    const terminal = ['completed', 'failed', 'cancelled'].includes(turn.status);
    if (!terminal && lateAcceptedLocalId !== undefined) return;
    const anchors = parseStoredSessionTurnTranscriptAnchors(turn.transcriptAnchorsJson);
    const anchoredInputs = anchors?.userMessageSeqs ?? [];
    // The accepted foreground input can be committed before a terminal turn
    // with no transcript anchors. Its indexed turn and start witness still
    // identify the exact reply to settle.
    const inputs = terminal || anchoredInputs.length > 0 ? await tx.sessionMessage.findMany({
        where: { sessionId: turn.sessionId, messageRole: 'user', targetExecutionRunId: null,
            sidechainId: null, replyDisposition: { not: null },
            ...(lateAcceptedLocalId === undefined ? {} : { localId: lateAcceptedLocalId }),
            OR: [
                ...(anchoredInputs.length > 0 ? [{ seq: { in: [...anchoredInputs] } }] : []),
                ...(terminal ? [{ acceptedTurnId: turn.turnId, turnStartWitnessId: turn.turnId }] : []),
            ] },
        select: { localId: true },
    }) : [];
    const final = inputs.length > 0 && terminal && typeof anchors?.finalAssistantMessageSeq === 'number'
        ? await tx.sessionMessage.findFirst({ where: { sessionId: turn.sessionId, seq: anchors.finalAssistantMessageSeq,
            sidechainId: null, messageRole: { in: ['agent', 'assistant'] } }, select: { id: true } }) : null;
    for (const input of inputs) {
        if (!input.localId) continue;
        const original = await readOriginal(tx, turn.sessionId, input.localId);
        if (!original?.progress || original.progress.acceptedTurnId && original.progress.acceptedTurnId !== turn.turnId) continue;
        let progress: SessionMessageReplyProgressV1 = { ...original.progress, acceptedTurnId: turn.turnId };
        // Cancellation can precede durable partial-answer custody. Enrich the
        // same unreturned outcome when its exact anchor arrives; never replay
        // a returned reply or replace an explicit answer/pass.
        const receivesCancelledPartial = turn.status === 'cancelled' && final
            && progress.outcome?.kind === 'cancelled' && !('result' in progress.outcome)
            && progress.disposition !== 'returned';
        if (terminal && (!progress.outcome || receivesCancelledPartial)) {
            progress = { ...progress, outcome: turn.status === 'failed' ? { kind: 'failed' }
                : turn.status === 'cancelled' ? { kind: 'cancelled', ...(final ? { result: { sessionId: turn.sessionId, messageId: final.id } } : {}) }
                : final ? { kind: 'answer', result: { sessionId: turn.sessionId, messageId: final.id } } : { kind: 'terminal_no_result' } };
        }
        if (terminal) progress = await releaseDiscussionWatchReturnInTx(tx, progress);
        await writeOriginal(tx, original, progress);
    }
    if (terminal && lateAcceptedLocalId === undefined) await releaseSessionInputReplyObserversForSourceInTx(tx, turn.sessionId, turn.turnId);
}

async function releaseSessionInputReplyObserversForSourceInTx(tx: Tx, sessionId: string, turnId: string): Promise<void> {
    const where = { replySourceSessionId: sessionId, replySourceTurnId: turnId, replyDisposition: 'observing' };
    const [pending, messages] = await Promise.all([
        tx.sessionPendingMessage.findMany({ where, select: { sessionId: true, localId: true } }),
        tx.sessionMessage.findMany({ where, select: { sessionId: true, localId: true } }),
    ]);
    const visited = new Set<string>();
    for (const input of [...pending, ...messages]) {
        if (!input.localId) continue;
        const key = JSON.stringify([input.sessionId, input.localId]);
        if (visited.has(key)) continue;
        visited.add(key);
        const original = await readOriginal(tx, input.sessionId, input.localId);
        if (original?.progress?.disposition === 'observing') await writeOriginal(tx, original, { ...original.progress,
            disposition: original.progress.mode === 'return' ? 'return_pending' : 'released' });
    }
}

/** The native Run lifecycle supplies its actual accepted source input, not a fabricated primary turn. */
export async function releaseSessionMessageReplySourceTurnInTx(tx: Tx, params: Readonly<{
    accountId: string; request: SessionMessageReplySourceTurnReleaseV1; publisherAuthority: CurrentSessionPublisherAuthority;
}>): Promise<SessionMessageReplySourceTurnReleaseResultV1> {
    const { request } = params;
    await acquireSessionAccountCursorLocksInTx(tx, [request.sessionId]);
    if (!await hasExactCurrentPublisherAuthorityInTx(tx, params.publisherAuthority, params.accountId, request.sessionId,
        undefined, { admittedWork: true })) return { v: 1, ok: false, error: 'forbidden' };
    const input = await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: request.sessionId, localId: request.sourceInputId } },
        select: { targetExecutionRunId: true, acceptedTurnId: true, session: { select: { accountId: true, archivedAt: true, account: { select: { status: true } } } } } });
    if (!input?.targetExecutionRunId || input.acceptedTurnId !== request.sourceTurnId || input.session.accountId !== params.accountId
        || input.session.archivedAt !== null || input.session.account.status !== 'active') return { v: 1, ok: false, error: 'unavailable' };
    await releaseSessionInputReplyObserversForSourceInTx(tx, request.sessionId, request.sourceTurnId);
    return { v: 1, ok: true };
}

/** Pre-provider cancellation/rejection stays on the original admitted row without inventing a turn. */
export async function settleUnacceptedSessionInputReplyInTx(tx: Tx, sessionId: string, localId: string, kind: 'cancelled' | 'failed', runtimeIssueV1?: SessionRuntimeIssueV1): Promise<void> {
    const original = await readOriginal(tx, sessionId, localId);
    if (!original?.progress || original.progress.acceptedTurnId || original.progress.outcome) return;
    await writeOriginal(tx, original, { ...original.progress, outcome: kind === 'failed' && runtimeIssueV1
        ? { kind, runtimeIssueV1: projectSessionRuntimeIssueMetadataV1(runtimeIssueV1) } : { kind } });
}
