import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1, isSessionFollowFrontierEqualV1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { buildSessionFollowRulePhysicalKeyV1, type SessionFollowRuleStoredRowV1, type SessionFollowRuleWitnessV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import type { SessionFollowSourceOccurrenceWitnessV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { mutateReservedAccountScopedKvRowInTx } from '@/app/kv/reservedAccountScopedKvRow';
import { UserKvMutationConflictError } from '@/app/kv/kvMutate';
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { assertSessionFollowSourceReadInTx, evaluateCurrentSessionContextPairInTx, mayInjectSessionContextInTx, type SessionFollowRuntimePrincipalV1 } from '@/app/session/access/sessionContextInjection';
import { readCurrentCommittedSessionInputMachineTargetInTx, readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { isDeepStrictEqual } from 'node:util';
import { deriveSessionFollowOriginalOccurrenceKeyV1, isRunFollowOriginalV1, isSessionFollowQuestionHandlerV1, resolveSessionFollowTurnEventV1, type SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { admitSessionFollowRelationsForInputInTx, readStoredPolicy } from './sessionFollowEdgeService';
import { resolveSessionFollowRuntimePrincipalAuthenticationInTx } from '@/app/session/access/sessionContextInjection';
import { readStoredSessionFollowFrontier, writeSessionFollowFrontierColumns, type SessionFollowDeliveredColumns } from '@/app/session/relations/sessionEdgeFrontier';
import { invalidateSessionRelationProjectionsInTx } from '@/app/session/relations/sessionRelationChanges';
import { TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { accountFollowRuleRowDomain, readAccountFollowRuleInTx } from './accountFollowRuleService';
import { isDeliveryMutedInTx } from './sessionDeliveryMuteService';
import { hasCanonicalFollowProviderInputAcceptanceInTx } from './providerInputAcceptance';
import { markAccountChangesForSessionAccounts } from '@/app/session/changeTracking/markAccountChangesForSessionAccounts';
import { deriveSessionMessageAuthorAccountIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { mergeSessionFollowSelectedDeliveriesV1, resolveSessionFollowSelectedDeliveryV1,
    type SessionFollowSelectedDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

export interface SessionFollowRuleProgressAdmission {
    accountId: string;
    rule: SessionFollowRuleWitnessV1;
    destinationSessionId: string;
    sourceSessionId: string;
    revision: number;
    envelope: SessionFollowRuleStoredRowV1;
    delivered: SessionFollowFrontierV1;
    encountered: boolean;
}
export type AccountFollowRuleProgressAdmission = Omit<SessionFollowRuleProgressAdmission, 'destinationSessionId'> & Readonly<{ destinationSessionId?: never }>;

/** Reads a named rule's consumption cursor; it grants neither membership nor source access. */
export function readSessionFollowRuleProgressInTx(tx: Tx, input: Readonly<{
    accountId: string; rule: SessionFollowRuleWitnessV1; destinationSessionId: string; sourceSessionId: string;
}>): Promise<SessionFollowRuleProgressAdmission | null>;
export function readSessionFollowRuleProgressInTx(tx: Tx, input: Readonly<{
    accountId: string; rule: SessionFollowRuleWitnessV1; destinationSessionId?: never; sourceSessionId: string;
}>): Promise<AccountFollowRuleProgressAdmission | null>;
export async function readSessionFollowRuleProgressInTx(tx: Tx, input: Readonly<{
    accountId: string; rule: SessionFollowRuleWitnessV1; destinationSessionId?: string; sourceSessionId: string;
}>): Promise<SessionFollowRuleProgressAdmission | AccountFollowRuleProgressAdmission | null> {
    const row = await readAccountFollowRuleInTx(tx, { accountId: input.accountId, ruleId: input.rule.ruleId });
    if (row.status !== 'present' || row.envelope.version !== input.rule.ruleVersion
        || (input.destinationSessionId === undefined ? row.envelope.receiver.kind !== 'account'
            : row.envelope.receiver.kind !== 'session' || row.envelope.receiver.sessionId !== input.destinationSessionId)) return null;
    const progress = row.envelope.sources?.find(source => source.sourceSessionId === input.sourceSessionId);
    const admitted = { accountId: input.accountId, rule: input.rule, sourceSessionId: input.sourceSessionId,
        revision: row.revision, envelope: row.envelope,
        delivered: progress?.delivered ?? SESSION_FOLLOW_ZERO_FRONTIER_V1, encountered: progress !== undefined };
    return input.destinationSessionId === undefined ? admitted : { ...admitted, destinationSessionId: input.destinationSessionId };
}

/** Uses the existing Account-mode fence/physical CAS without changing the rule's authoring version. */
export async function writeSessionFollowRuleProgressInTx(tx: Tx, admission: SessionFollowRuleProgressAdmission | AccountFollowRuleProgressAdmission,
    delivered: SessionFollowFrontierV1): Promise<boolean> {
    if (admission.encountered && isSessionFollowFrontierEqualV1(admission.delivered, delivered)) return true;
    const sources = (admission.envelope.sources ?? []).filter(source => source.sourceSessionId !== admission.sourceSessionId);
    const previous = admission.envelope.sources?.find(source => source.sourceSessionId === admission.sourceSessionId);
    sources.push({ ...previous, sourceSessionId: admission.sourceSessionId, delivered });
    const physicalKey = buildSessionFollowRulePhysicalKeyV1(admission.rule.ruleId);
    const result = await mutateReservedAccountScopedKvRowInTx(tx, {
        accountId: admission.accountId, physicalKey,
        expectedRevision: admission.revision, envelope: { ...admission.envelope, sources }, domain: accountFollowRuleRowDomain,
        // Progress wakes the existing destination reconciler, never the rule-configuration cache.
        markChanged: async ({ tx: changedTx }) => {
            if (admission.destinationSessionId === undefined) {
                const [change] = await markAccountChangesForSessionAccounts({ tx: changedTx,
                    sessionId: admission.sourceSessionId, accountIds: [admission.accountId] });
                return change!;
            }
            const publications = await invalidateSessionRelationProjectionsInTx(changedTx, [admission.destinationSessionId]);
            const change = publications.find(publication => publication.accountId === admission.accountId);
            if (!change) throw new Error('Follow progress publication requires its receiver Account');
            return change;
        },
    }).catch((error: unknown) => {
        // This existing-row CAS refused before any mutation/publication. Keep
        // the established false contract; callers own rollback and replay.
        if (error instanceof UserKvMutationConflictError
            && error.accountId === admission.accountId && error.key === physicalKey) return null;
        throw error;
    });
    return result?.status === 'updated';
}

type RuleOccurrenceAuthority =
    | Readonly<{ kind: 'account'; authentication: SessionAccessAuthentication; admitted?: true }>
    | Readonly<{ kind: 'source_machine'; machineId: string }>
    | Readonly<{ kind: 'admitted_input'; principal: SessionFollowRuntimePrincipalV1 }>;

/**
 * One original-source admission, shared by observation and Machine input admission.
 * An admitted receipt preserves historical producer identity across source restarts;
 * source access, rule identity, receiver and the original record remain current.
 * Encrypted filters/request maps are opened by the authorized executor, never here.
 */
export async function admitSessionFollowRuleOccurrenceInTx(tx: Tx, input: Readonly<{
    accountId: string; witness: SessionFollowSourceOccurrenceWitnessV1; authority: RuleOccurrenceAuthority;
    /** Only the Pending owner may validate a muted original for discarded custody. */
    settleSuppressedOriginal?: true;
}>) {
    const { witness, authority } = input;
    if (authority.kind === 'account' && !authority.admitted && (authority.authentication.sessionRuntimePrincipal
        || authority.authentication.apiTokenGrant && isApiTokenGrantRestrictedV1(authority.authentication.apiTokenGrant))) return null;
    const [source, destination, account, progress] = await Promise.all([
        tx.session.findUnique({ where: { id: witness.sourceSessionId }, select: {
            id: true, accountId: true, archivedAt: true, publisherGeneration: true, encryptionMode: true,
            seq: true, agentStateVersion: true,
        } }),
        tx.session.findUnique({ where: { id: witness.destinationSessionId }, select: {
            id: true, accountId: true, archivedAt: true, publisherGeneration: true,
        } }),
        tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } }),
        readSessionFollowRuleProgressInTx(tx, { accountId: input.accountId, rule: witness.rule,
            destinationSessionId: witness.destinationSessionId, sourceSessionId: witness.sourceSessionId }),
    ]);
    if (!source || !destination || !progress || account?.status !== 'active'
        || destination.accountId !== input.accountId
        || source.archivedAt !== null || destination.archivedAt !== null) return null;
    if (authority.kind !== 'admitted_input' && !(authority.kind === 'account' && authority.admitted)) {
        if (witness.evaluation !== 'receiver' && source.publisherGeneration.toString() !== witness.expectedSourcePublisherGeneration) return null;
        if (authority.kind === 'source_machine') {
            // Source production stays own-Account. Receiver-side evaluation of
            // foreign work proves current read/pair authority, not source custody.
            const [sourceTarget, destinationTarget] = await Promise.all([
                source.accountId === input.accountId ? readCurrentCommittedSessionInputMachineTargetInTx(tx, source.id) : null,
                readCurrentCommittedSessionInputMachineTargetInTx(tx, destination.id),
            ]);
            const sourceProducer = sourceTarget?.accountId === input.accountId && sourceTarget.machineId === authority.machineId
                && sourceTarget.machineId === witness.machineId && sourceTarget.installationId === witness.installationId;
            const receiverEvaluator = destinationTarget?.accountId === input.accountId && destinationTarget.machineId === authority.machineId;
            if (witness.evaluation === 'receiver' ? !receiverEvaluator : !sourceProducer) return null;
        }
    }
    const pair = { sourceSessionId: source.id, destinationSessionId: destination.id };
    const allowed = authority.kind === 'account'
        ? !authority.authentication.sessionRuntimePrincipal && (await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId, ...pair, authentication: authority.authentication,
        })).ok
        : authority.kind === 'admitted_input'
            ? (await assertSessionFollowSourceReadInTx(tx, { principal: authority.principal,
                sourceSessionId: source.id, edge: pair })).ok
            : (await evaluateCurrentSessionContextPairInTx(tx, pair)).ok;
    if (!allowed) return null;
    for (const scope of input.settleSuppressedOriginal ? [] : [{ kind: 'session', sessionId: source.id }, { kind: 'rule', ruleId: witness.rule.ruleId }] as const) {
        if (await isDeliveryMutedInTx(tx, { accountId: input.accountId, receiver: { kind: 'session', sessionId: destination.id },
            candidate: { senderSessionId: source.id, source: scope } }) !== false) return null;
    }

    const frontiers = await readSessionFollowOriginalOccurrenceFrontiersInTx(tx, {
        source, occurrence: witness, delivered: progress.delivered,
        ...(authority.kind === 'admitted_input' || authority.kind === 'account' && authority.admitted
            ? { allowHistoricalRequests: true as const } : {}),
    });
    if (!frontiers || progress.envelope.inception
        && frontiers.originalCreatedAt < progress.envelope.inception.createdAt) return null;
    return { source, destination, progress, ...frontiers };
}

/** Original-record identity only; callers retain source, publisher and receiver admission. */
export async function readSessionFollowOriginalOccurrenceFrontiersInTx(tx: Tx, input: Readonly<{
    source: Readonly<{ id: string; seq: number; agentStateVersion: number; encryptionMode: string }>;
    occurrence: Pick<SessionFollowSourceOccurrenceWitnessV1, 'sourceMessage' | 'sourceRequests' | 'sourceTurn'>;
    delivered: SessionFollowFrontierV1;
    /** Stored custody only: native admission still verifies current opened request identity. */
    allowHistoricalRequests?: true;
}>): Promise<Readonly<{ baseline: SessionFollowFrontierV1; observed: SessionFollowFrontierV1; originalCreatedAt: number;
    originalAuthorAccountId?: string }> | null> {
    const { source, occurrence, delivered } = input;
    let baseline: SessionFollowFrontierV1;
    let observed: SessionFollowFrontierV1;
    let originalCreatedAt: number;
    let originalAuthorAccountId: string | null = null;
    if (occurrence.sourceMessage) {
        const original = await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
            sessionId: source.id, localId: occurrence.sourceMessage.localId,
        } }, select: { seq: true, content: true, sidechainId: true, createdAt: true, messageRole: true, inputAdmissionReceipt: true } });
        const content = SessionStoredMessageContentSchema.safeParse(original?.content);
        if (!original || original.seq !== occurrence.sourceMessage.seq || original.seq > source.seq || original.sidechainId !== null
            || !content.success || (source.encryptionMode === 'plain') !== (content.data.t === 'plain')) return null;
        baseline = { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: original.seq - 1 };
        observed = { ...delivered, transcriptSeq: original.seq };
        originalCreatedAt = original.createdAt.getTime();
        originalAuthorAccountId = deriveSessionMessageAuthorAccountIdV1(original, 'stored');
    } else if (occurrence.sourceRequests) {
        const version = occurrence.sourceRequests.agentStateVersion;
        if (input.allowHistoricalRequests ? source.agentStateVersion < version : source.agentStateVersion !== version) return null;
        baseline = { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, agentStateVersion: version - 1 };
        observed = { ...delivered, agentStateVersion: version };
        originalCreatedAt = occurrence.sourceRequests.requests.reduce((oldest, request) => Math.min(oldest, request.createdAt), Infinity);
    } else if (occurrence.sourceTurn) {
        const turn = await tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
            sessionId: source.id, turnId: occurrence.sourceTurn.id,
        } }, select: { status: true, terminalAt: true, updatedAt: true } });
        if (!turn || turn.status !== occurrence.sourceTurn.status) return null;
        baseline = delivered;
        observed = { ...delivered, turn: occurrence.sourceTurn };
        originalCreatedAt = Number(turn.terminalAt ?? turn.updatedAt);
    } else return null;
    return { baseline, observed, originalCreatedAt, ...(originalAuthorAccountId ? { originalAuthorAccountId } : {}) };
}

/** The admission owner resolves private witnesses; native callers name only the original input. */
export async function readAdmittedSessionFollowInputInTx(tx: Tx, input: Readonly<{
    accountId: string; destinationSessionId: string;
    localInputId: string; sourceSessionId?: string;
} & ({ principal: SessionFollowRuntimePrincipalV1; authority?: never }
    | { principal?: never; authority: Extract<RuleOccurrenceAuthority, { kind: 'account' }> })>) {
    const key = { sessionId: input.destinationSessionId, localId: input.localInputId };
    const pending = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: key },
        select: { inputAdmissionReceipt: true, status: true, discardedReason: true } });
    const materialized = pending ? null : await tx.sessionMessage.findUnique({ where: { sessionId_localId: key },
        select: { inputAdmissionReceipt: true, acceptedFollowOriginalKey: true, seq: true } });
    const receipt = readStoredSessionInputAdmissionReceipt((pending ?? materialized)?.inputAdmissionReceipt);
    const suppressed = pending?.status === 'discarded' && pending.discardedReason === 'session_input_muted';
    const destination = await tx.session.findUnique({ where: { id: input.destinationSessionId },
        select: { accountId: true, archivedAt: true } });
    if (!receipt?.followDeliveryV1
        || !destination || destination.archivedAt !== null
        || receipt.admittedTarget?.accountId !== destination.accountId
        || receipt.admittedTarget.sessionId !== input.destinationSessionId) return null;
    if ((input.principal || receipt.followSources?.length) && input.accountId !== destination.accountId) return null;
    const delivery = receipt.followDeliveryV1;
    if ('sourceTurn' in delivery.original && (!('event' in delivery)
        || !isDeepStrictEqual(delivery.event, resolveSessionFollowTurnEventV1(delivery.original.sourceTurn)))) return null;
    const nativeAccepted = materialized?.acceptedFollowOriginalKey != null
        && materialized.acceptedFollowOriginalKey === deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original)
        && await hasCanonicalFollowProviderInputAcceptanceInTx(tx, { destinationSessionId: input.destinationSessionId,
            localInputId: input.localInputId, userMessageSeq: materialized.seq, requireProviderAccepted: true });
    if (!('sourceSessionId' in delivery.original)) {
        if (input.sourceSessionId !== undefined || receipt.followSources?.length || !receipt.followRelations?.length) return null;
        const authentication = input.principal
            ? await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal)
            : input.authority.authentication;
        const relations = await admitSessionFollowRelationsForInputInTx(tx, {
            accountId: destination.accountId, destinationSessionId: input.destinationSessionId,
            delivery, relations: receipt.followRelations, authentication, admittedOriginal: true,
        });
        const effectiveDelivery = !suppressed && relations ? resolveSessionFollowInputSelectedDelivery(delivery, relations, []) : null;
        return relations && (effectiveDelivery || nativeAccepted || suppressed)
            ? { delivery, receipt, admissions: [], relations, nativeAccepted, effectiveDelivery } : null;
    }
    if (input.sourceSessionId !== undefined && delivery.original.sourceSessionId !== input.sourceSessionId) return null;
    const pair = { sourceSessionId: delivery.original.sourceSessionId, destinationSessionId: input.destinationSessionId };
    const source = await tx.session.findUnique({ where: { id: pair.sourceSessionId },
        select: { id: true, seq: true, agentStateVersion: true, encryptionMode: true, archivedAt: true } });
    if (!source || source.archivedAt !== null || !await readSessionFollowOriginalOccurrenceFrontiersInTx(tx, {
        source, occurrence: delivery.original, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1, allowHistoricalRequests: true,
    })) return null;
    const allowed = input.principal
        ? (await assertSessionFollowSourceReadInTx(tx, { principal: input.principal, sourceSessionId: pair.sourceSessionId, edge: pair })).ok
        : (await mayInjectSessionContextInTx(tx, { configuringAccountId: input.accountId,
            authentication: input.authority.authentication, ...pair })).ok;
    if (!allowed || await isDeliveryMutedInTx(tx, { accountId: destination.accountId, receiver: { kind: 'session', sessionId: pair.destinationSessionId },
            candidate: { senderSessionId: pair.sourceSessionId, source: { kind: 'session', sessionId: pair.sourceSessionId } } }) !== false) return null;
    const admissions: NonNullable<Awaited<ReturnType<typeof admitSessionFollowRuleOccurrenceInTx>>>[] = [];
    const privateVotes: SessionFollowSelectedDeliveryV1[] = [];
    for (const witness of receipt.followSources ?? []) {
        if (witness.sourceSessionId !== delivery.original.sourceSessionId || witness.destinationSessionId !== input.destinationSessionId
            || !isDeepStrictEqual(witness.sourceMessage ?? witness.sourceRequests ?? witness.sourceTurn,
                'sourceMessage' in delivery.original ? delivery.original.sourceMessage
                    : 'sourceRequests' in delivery.original ? delivery.original.sourceRequests : delivery.original.sourceTurn)) return null;
        const admitted = await admitSessionFollowRuleOccurrenceInTx(tx, { accountId: destination.accountId, witness,
            authority: input.principal ? { kind: 'admitted_input', principal: input.principal } : { ...input.authority, admitted: true } });
        // Keep only current reasons from the original union. One removed route
        // cannot veto a surviving route; accepted native custody can also rejoin
        // with no current reason. Source/pair access still controls every read.
        if (!admitted) continue;
        admissions.push(admitted);
        privateVotes.push(witness.selectedDelivery);
    }
    const relations = [];
    for (const reason of receipt.followRelations ?? []) {
        const edge = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceSessionId_relation: {
            ...pair, relation: reason.relation,
        } } });
        if (!edge || reason.relation === 'manager' && edge.attachedAt.getTime() !== reason.attachedAt) {
            continue;
        }
        if (!resolveSessionFollowInputSelectedDelivery(delivery, [edge], [])) continue;
        relations.push(edge);
    }
    // An exact owner-assigned question uses its existing admitted input custody,
    // not a permanent worker → ancestor edge or a fabricated private rule.
    const effectiveDelivery = suppressed ? null : resolveSessionFollowInputSelectedDelivery(delivery, relations, privateVotes,
        isSessionFollowQuestionHandlerV1(delivery, input.destinationSessionId));
    if (!nativeAccepted && !effectiveDelivery && !suppressed) return null;
    return { delivery, receipt, admissions, relations, nativeAccepted, effectiveDelivery };
}

/** Private votes are pinned to admitted rule versions; visible relation policy stays current. */
export function resolveSessionFollowInputSelectedDelivery(delivery: SessionFollowInputV1,
    relations: readonly Pick<SessionFollowInputRelation, 'policyJson'>[],
    privateVotes: readonly SessionFollowSelectedDeliveryV1[], questionHandler = false): SessionFollowSelectedDeliveryV1 | null {
    const policies = relations.flatMap(relation => {
        const policy = readStoredPolicy(relation.policyJson);
        return policy ? [policy] : [];
    });
    const events = 'requestEvents' in delivery ? delivery.requestEvents.map(request => request.event) : [delivery.event];
    return mergeSessionFollowSelectedDeliveriesV1([
        ...privateVotes,
        ...events.map(event => resolveSessionFollowSelectedDeliveryV1({ policies, event })),
        questionHandler ? delivery.delivery : null,
    ]);
}

/** A public input represents one original, never an unbounded current source suffix. */
export function sessionFollowInputFrontiers(delivery: SessionFollowInputV1) {
    const expected = { ...SESSION_FOLLOW_ZERO_FRONTIER_V1 };
    const observed = { ...SESSION_FOLLOW_ZERO_FRONTIER_V1 };
    if ('sourceMessage' in delivery.original) {
        expected.transcriptSeq = delivery.original.sourceMessage.seq - 1;
        observed.transcriptSeq = delivery.original.sourceMessage.seq;
    } else if ('sourceRequests' in delivery.original) {
        expected.agentStateVersion = delivery.original.sourceRequests.agentStateVersion - 1;
        observed.agentStateVersion = delivery.original.sourceRequests.agentStateVersion;
    } else if ('sourceTurn' in delivery.original) {
        observed.turn = delivery.original.sourceTurn;
    }
    return { expected, observed };
}

export type SessionFollowInputRelation = SessionFollowDeliveredColumns & Readonly<{
    destinationSessionId: string; sourceSessionId: string | null; relation: string; attachedAt: Date;
    policyJson: string;
    sourceKey?: string;
    deliveredWorkflowRunRevision?: number | null;
    deliveredExecutionRunTerminalEventId?: string | null;
}>;

/** Shared settlement for native ACK and indexed late-route rejoin; callers supply actual acceptance. */
export async function settleSessionFollowInputReasonsInTx(tx: Tx, input: Readonly<{
    progresses: readonly SessionFollowRuleProgressAdmission[];
    relations: readonly SessionFollowInputRelation[];
    observed: SessionFollowFrontierV1;
    delivery: SessionFollowInputV1;
}>): Promise<boolean> {
    const original = input.delivery.original;
    if (isRunFollowOriginalV1(original)) {
        // Permission originals settle in the existing accepted-input key and
        // provider ACK. They must never advance the Run's terminal cursor.
        if ('permissionRequests' in original) return true;
        for (const edge of input.relations) {
            if (!edge.sourceKey) return false;
            if ('revision' in original && (edge.deliveredWorkflowRunRevision ?? 0) >= original.revision) continue;
            if ('terminalEventId' in original && edge.deliveredExecutionRunTerminalEventId === original.terminalEventId) continue;
            const updated = await tx.sessionFollowEdge.updateMany({ where: {
                destinationSessionId: edge.destinationSessionId, sourceKey: edge.sourceKey,
                relation: edge.relation, attachedAt: edge.attachedAt,
                ...('revision' in original ? { deliveredWorkflowRunRevision: edge.deliveredWorkflowRunRevision }
                    : { deliveredExecutionRunTerminalEventId: edge.deliveredExecutionRunTerminalEventId }),
            }, data: 'revision' in original ? { deliveredWorkflowRunRevision: original.revision }
                : { deliveredExecutionRunTerminalEventId: original.terminalEventId } });
            if (updated.count !== 1) throw new TransactionReplayRequiredError('follow-relation-progress-conflict');
        }
        return true;
    }
    const waitingTurn = await readExactFollowWaitingTurnInTx(tx, input.delivery);
    const advance = (current: SessionFollowFrontierV1, manager = false) => ({ ...current,
        transcriptSeq: Math.max(current.transcriptSeq, input.observed.transcriptSeq),
        agentStateVersion: Math.max(current.agentStateVersion, input.observed.agentStateVersion),
        ...('sourceTurn' in original ? { turn: original.sourceTurn }
            : manager && waitingTurn ? { turn: waitingTurn } : {}) });
    for (const progress of input.progresses) {
        if (!await writeSessionFollowRuleProgressInTx(tx, progress, advance(progress.delivered))) throw new TransactionReplayRequiredError('follow-rule-progress-conflict');
    }
    for (const edge of input.relations) {
        const current = readStoredSessionFollowFrontier(edge);
        const updated = await tx.sessionFollowEdge.updateMany({ where: { destinationSessionId: edge.destinationSessionId,
            sourceSessionId: edge.sourceSessionId, relation: edge.relation, attachedAt: edge.attachedAt,
            ...writeSessionFollowFrontierColumns(current) }, data: writeSessionFollowFrontierColumns(advance(current, edge.relation === 'manager')) });
        if (updated.count !== 1) throw new TransactionReplayRequiredError('follow-relation-progress-conflict');
    }
    return true;
}

async function readExactFollowWaitingTurnInTx(tx: Tx, delivery: SessionFollowInputV1) {
    if (!('sourceRequests' in delivery.original)) return null;
    const source = await tx.session.findUnique({ where: { id: delivery.original.sourceSessionId },
        select: { latestTurnId: true, latestTurnStatus: true } });
    if (!source?.latestTurnId || source.latestTurnStatus !== 'waiting'
        || !delivery.original.sourceRequests.requests.some(request => request.turnId === source.latestTurnId)) return null;
    const turn = await tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
        sessionId: delivery.original.sourceSessionId, turnId: source.latestTurnId,
    } }, select: { status: true } });
    return turn?.status === 'waiting' ? { id: source.latestTurnId, status: 'waiting' as const } : null;
}

/**
 * Provider acceptance settles an original terminal Turn, Run cursor or exactly
 * witnessed manager waiting fact in the same transaction. Optional Follow ACK loss cannot
 * reoffer that accepted occurrence; stale attachments remain pending.
 */
export async function settleAcceptedSessionFollowInputInTx(tx: Tx, input: Readonly<{
    destinationSessionId: string;
    receipt: SessionInputAdmissionReceiptV1;
}>): Promise<void> {
    const delivery = input.receipt.followDeliveryV1;
    if (!delivery) return;
    if ('sourceTurn' in delivery.original && input.receipt.admittedTarget) {
        const accountId = input.receipt.admittedTarget.accountId;
        const relations = await admitSessionFollowRelationsForInputInTx(tx, {
            accountId, destinationSessionId: input.destinationSessionId, delivery,
            relations: input.receipt.followRelations ?? [],
            authentication: backgroundDeliveryAuthentication(), admittedOriginal: true,
        });
        if (!relations) return;
        const progresses: SessionFollowRuleProgressAdmission[] = [];
        for (const witness of input.receipt.followSources ?? []) {
            const admitted = await admitSessionFollowRuleOccurrenceInTx(tx, { accountId, witness,
                authority: { kind: 'account', authentication: backgroundDeliveryAuthentication(), admitted: true } });
            if (admitted) progresses.push(admitted.progress);
        }
        await settleSessionFollowInputReasonsInTx(tx, { progresses, relations, delivery,
            observed: sessionFollowInputFrontiers(delivery).observed });
        return;
    }
    if (isRunFollowOriginalV1(delivery.original) && input.receipt.admittedTarget) {
        const relations = await admitSessionFollowRelationsForInputInTx(tx, {
            accountId: input.receipt.admittedTarget.accountId, destinationSessionId: input.destinationSessionId,
            delivery, relations: input.receipt.followRelations ?? [],
            authentication: backgroundDeliveryAuthentication(), admittedOriginal: true,
        });
        if (relations) await settleSessionFollowInputReasonsInTx(tx, {
            progresses: [], relations, delivery, observed: SESSION_FOLLOW_ZERO_FRONTIER_V1,
        });
        return;
    }
    if (!('sourceRequests' in delivery.original)) return;
    const relations: SessionFollowInputRelation[] = [];
    for (const reason of input.receipt.followRelations ?? []) {
        if (reason.relation !== 'manager') continue;
        const edge = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceSessionId_relation: {
            destinationSessionId: input.destinationSessionId, sourceSessionId: delivery.original.sourceSessionId, relation: 'manager',
        } } });
        if (edge && edge.attachedAt.getTime() === reason.attachedAt) relations.push(edge);
    }
    if (!relations.length) return;
    await settleSessionFollowInputReasonsInTx(tx, { progresses: [], relations,
        observed: SESSION_FOLLOW_ZERO_FRONTIER_V1, delivery });
}

export async function encounterSessionFollowRuleOccurrenceInTx(tx: Tx,
    input: Parameters<typeof admitSessionFollowRuleOccurrenceInTx>[1]) {
    const admitted = await admitSessionFollowRuleOccurrenceInTx(tx, input);
    if (!admitted) return null;
    if (!admitted.progress.encountered) {
        if (!await writeSessionFollowRuleProgressInTx(tx, admitted.progress, admitted.baseline)) return null;
        admitted.progress.delivered = admitted.baseline;
        admitted.observed = { ...admitted.observed,
            ...(input.witness.sourceMessage ? { transcriptSeq: input.witness.sourceMessage.seq }
                : input.witness.sourceRequests ? { agentStateVersion: admitted.source.agentStateVersion } : {}) };
    }
    return admitted;
}
