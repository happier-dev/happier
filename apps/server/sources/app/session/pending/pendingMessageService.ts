import { normalizeSessionMessageContentForStorage } from "@/app/session/normalizeSessionMessageContentForStorage";
import { DiscussionMessageAddressingV1Schema, type DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/references';
import { buildSessionInputAdmissionReceipt, isSameSessionInputAdmissionIssuer, readCurrentSessionInputMachineTargetInTx, readCurrentCommittedSessionInputMachineTargetInTx, readStoredSessionInputAdmissionReceipt, isSessionInputTargetCurrentForPublisherInTx, isCurrentSessionInputMachineTargetInTx, areCurrentSessionInputMachineTargetsInTx } from "@/app/session/messages/sessionInputAdmission";
import { markSessionProjectionRecipientsChanged, type SessionRecipientCursor, type SessionRecipientPublication } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { markPendingStateChangedRecipients } from "@/app/session/pending/markPendingStateChangedRecipients";
import { pendingPublicationResult, type PendingPublicationFields } from "./pendingPublicationResult";
import { isRetainedPendingContextForPublisherInTx } from './retainedPendingContext';
import { resolveSessionAccountChangePublications } from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";
import { reconcileSessionPendingQueueStateInTx } from "@/app/session/pending/reconcileSessionPendingQueueState";
import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import { mapPendingMessageRow, projectPendingDeliveryRecovery } from "@/app/session/pending/mapPendingMessageRow";
import {
    assertSessionCapabilityInTx,
    assertSessionOwnerInTx,
    resolveEffectiveSessionAccess,
    resolveStructuralSessionAccess,
    resolveSessionAccessForOperation,
    buildSessionAccessProjectionSelect,
    SESSION_ACCESS_SESSION_BATCH_SIZE,
    type SessionAccessProjectionRow,
} from "@/app/session/access/sessionAccess";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { buildSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import { PendingResetStartsReadInputV1Schema, type PendingResetStartsReadInputV1, type PendingResetStartsReadResultV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { CallerInputConstraintsV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import type { PendingMessageWithdrawOutcomeV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { PendingMessageRow, PendingMessageRowRaw } from "@/app/session/pending/mapPendingMessageRow";
import { projectSessionMessageAccountActors } from "@/app/session/messages/projectSessionMessageAccountActors";
import { db, getActivePrismaRuntime } from "@/storage/db";
import { afterTx, inReadSnapshot, inTx, isTransactionConflictExhaustedError, isTransactionAcquisitionUnavailableError, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1, isPendingDeliveryArchivedUncertaintyReasonV1, isPendingDeliveryProviderEffectPossibleV1, isPendingDeliveryStatusTransitionAllowedV1, normalizePendingDeliveryStatusV1, pendingDeliveryStatusV1ToPersistedFields, type PendingDeliveryStatusTransitionTargetV1, type PendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { isStoredContentKindAllowedForSessionByStoragePolicy, type SessionStoredContentKind } from '@happier-dev/protocol/encryption/storagePolicyDecisions';
import { isConditionalPendingSteerClaim, normalizePendingDeliveryBlockedReason, type PendingDeliveryBlockedReason } from '@happier-dev/protocol/sessions/messages/pendingDeliveryBlockedReason';
import { isSessionAgentTransitionDividerLocalId } from '@happier-dev/protocol/sessions/agentTransitionDivider';
import { normalizePendingRequestedActionV1, PendingRequestedActionV1Schema, PendingRequestedActionV1StoredSchema, type PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { isPendingLocalId, readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { PendingMessageMutationFingerprintV1Schema } from '@happier-dev/protocol/sessions/pending/pendingMessageMutationFingerprintV1';
import { SessionInputAdmissionReceiptV1Schema, SessionInputRequestEqualityEvidenceV1Schema, SESSION_MESSAGE_PROVENANCE_META_KEY, readSessionInputAuthority, readSessionInputRequest, readSessionMessageProvenance, requiresAuthenticatedMachineAdmissionForSessionInput, settleSessionInputRequestV1, settleSessionInputRequestV2, settleSessionMessageProvenanceV1, settleSessionMessageProvenanceV2, withSessionInputAuthority, deriveWorkflowSessionInputLocalIdV2, type SessionInputAdmissionReceiptV1, type SessionInputAdmissionResultV1, type SessionInputRequestEqualityEvidenceV1, type SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { deriveSessionMessageAuthorAccountIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { SessionInputAdmissionRejectionCodeV1Schema, type SessionInputAdmissionRejectionCodeV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';
import { isDeliveryMutedInTx } from '@/app/session/follow/sessionDeliveryMuteService';
import { readSessionFollowInputSuppressionInTx, retainSuppressedFollowInputInTx, retainSuppressedSessionFollowInputInTx } from '@/app/session/follow/sessionFollowSuppression';
import { reconcileAutonomousExchangeAcceptedTurnInTx } from '@/app/session/pending/reconcileAutonomousExchangeAcceptedTurnInTx';
import { backgroundDeliveryAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Fastify } from '@/app/api/types';
import { readCurrentExecutionRunFollowSource, type ExecutionRunFollowFrontierWitness } from '@/app/session/follow/executionRunFollowSource';
import { readAutonomousExchangeSourceRoot, readReceiverAutonomousExchangeRootInTx,
    isAutonomousExchangeRootReceiptForAccount } from '@/app/session/messages/readAutonomousExchangeSourceRoot';
import { AutonomousExchangeStateV1Schema, createAutonomousExchangeStateV1,
    readAutonomousExchangeAdmissionV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { supportsMachineOperationProtocolCapabilityV1, supportsMachineSessionInputAdmissionProtocolVersion } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { ExecutionRunIdSchema, SessionIdSchema, SidechainIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { readParticipantRecipientRoutingIdentityV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import { type PendingActivationFailureCodeV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { type ManagedWakeTargetV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { type SessionInputSettlementValidationV1 } from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import { type SessionStoredMessageContent } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { type SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { type SessionAccessErrorCodeV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import {
    readStoredSessionMessageDeliveryResolutionV1,
    SessionMessageAcceptedDeliveryContentV1Schema,
    SessionMessageAcceptedTurnV1Schema,
    type SessionMessageAcceptedDeliveryContentV1,
    type SessionMessageAcceptedTurnV1,
} from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { inPendingQueuePositionTx, reserveNextPendingQueuePosition } from "@/app/session/pending/reserveNextPendingQueuePosition";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { parseSessionMessageRole, resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { hasExactCurrentPublisherAuthorityInTx, hasCurrentPublisherTargetAdmissionCapabilityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import {
    createSessionMessageFromPending,
    derivePlainRequestEqualityEvidence,
    type PendingTranscriptMessage,
} from "@/app/session/pending/pendingMessageTranscriptCommit";
import { compareSessionMessageContentAndRole } from "@/app/session/sessionTranscriptWrite";
import {
    resolveReadyProjectionEventType,
    updateSessionMessageActivityProjection,
    type SessionReadyProjectionUpdate,
} from "@/app/session/sessionWriteService";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { log, warn } from "@/utils/logging/log";
import {
    armPendingActivationAuthorizationInTx,
    markPendingActivationAuthorizationFailedInTx,
    reconcilePendingActivationAuthorizationForRemovedRequestInTx,
    shouldArmPendingActivationAuthorization,
    readPendingOwnerInputAdmission,
    readPendingActivationControllerAccountIdsInTx,
    readPendingActivationHoldReasonsInTx,
    type PendingActivationTarget,
} from "@/app/session/pending/pendingActivationAuthorization";
import { emitPendingChanged } from "@/app/session/pending/publishPendingMutation";
import { readSessionMachineBindingStateInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { assertManagedWakeOriginCurrentInTx } from '@/app/machines/managed/managedWake';
import { ManagedMachineError } from '@/app/machines/managed/managedRows';
import type { PendingActivationFailureDetailsV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { SessionMessageReplyAdmissionV1Schema, SessionMessageReplyProgressV1Schema,
    deriveSessionMessageReplyReturnLocalIdV1, type SessionMessageReplyAdmissionV1, type SessionMessageReplyProgressV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createSessionInputReplyProgressInTx, bindSessionInputReplyAcceptedTurnInTx, settleUnacceptedSessionInputReplyInTx,
    isDiscussionReplyDestinationCurrentInTx, isSessionInputReplySourceCurrentInTx, readSessionMessageReplyInTx } from '@/app/session/messages/sessionMessageReply';
import { admitDiscussionFollowAddressingInTx, acknowledgeDiscussionFollowInputInTx, admitSessionFollowRelationsForInputInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { SessionPendingEnqueueByMachineRequestV1 } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { admitSessionFollowRuleOccurrenceInTx, readAdmittedSessionFollowInputInTx, resolveSessionFollowInputSelectedDelivery, sessionFollowInputFrontiers, settleSessionFollowInputReasonsInTx, settleAcceptedSessionFollowInputInTx, type SessionFollowRuleProgressAdmission } from '@/app/session/follow/sessionFollowRuleProgress';
import { deriveSessionFollowOriginalOccurrenceKeyV1, deriveSessionFollowInputLocalIdV1, isRunFollowOriginalV1, isSessionFollowQuestionHandlerV1, resolveSessionFollowTurnEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { DiscussionProducerV1Schema } from '@happier-dev/protocol/discussions/content';
import { markDiscussionReadersChangedInTx } from '@/app/discussions/changes';
import { resolveDiscussionAudienceInTx } from '@/app/discussions/access';

type RecipientCursor = SessionRecipientCursor;

/** C7 replay has not admitted foreign Discussion causes. Retain their original
 * custody without borrowing a private source's permission or receiver authority.
 * Both ingress and provider settlement consume this one Pending-owned decision. */
async function isForeignDiscussionCauseHeldInTx(tx: Tx, input: Readonly<{
    accountId: string; reply: SessionMessageReplyAdmissionV1;
}>): Promise<boolean> {
    const discussion = input.reply.discussion;
    if (!discussion || !input.reply.sourceSession) return false;
    const message = await tx.discussionMessage.findFirst({ where: { id: discussion.messageId, discussionId: discussion.discussionId,
        seq: discussion.throughSeq }, select: { addressingV1: true, producerV1: true } });
    const addressing = createStoredReadSchema(DiscussionMessageAddressingV1Schema).safeParse(message?.addressingV1);
    const producer = createStoredReadSchema(DiscussionProducerV1Schema).safeParse(message?.producerV1);
    if (!addressing.success || addressing.data.throughSeq !== discussion.throughSeq
        || !addressing.data.participantSessionIds.includes(discussion.participantSessionId)
        || !producer.success || producer.data.kind !== 'agent' || producer.data.sessionId !== input.reply.sourceSession.sourceSessionId
        || !isDeepStrictEqual(producer.data.sourceSession, input.reply.sourceSession)) return false;
    const source = await tx.session.findUnique({ where: { id: producer.data.sessionId }, select: { accountId: true } });
    return source !== null && source.accountId !== input.accountId;
}

/** Content-free read of actual Pending custody, never another causal admission
 * decision. Discussion readers have already been admitted to these originals. */
export async function readHeldDiscussionPendingInputsInTx(tx: Tx, addresses: readonly DiscussionAddressingV1[]): Promise<ReadonlySet<string>> {
    if (!addresses.length) return new Set();
    const byLocalId = new Map(addresses.map(address => [deriveDiscussionFollowInputLocalIdV1(address), address]));
    const rows = await tx.sessionPendingMessage.findMany({ where: { status: 'queued', deliveryState: 'blocked',
        deliveryBlockedReason: 'session_input_target_unavailable', OR: [...byLocalId].map(([localId, address]) => ({ localId, sessionId: address.participantSessionId })) },
        select: { localId: true, sessionId: true, inputAdmissionReceipt: true, replyProgress: true } });
    return new Set(rows.flatMap(row => {
        const address = byLocalId.get(row.localId);
        const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(row.inputAdmissionReceipt);
        const progress = createStoredReadSchema(SessionMessageReplyProgressV1Schema).safeParse(row.replyProgress);
        return address && row.sessionId === address.participantSessionId && receipt.success && receipt.data.issuer === 'authenticatedMachine'
            && receipt.data.admittedTarget?.sessionId === address.participantSessionId && isDeepStrictEqual(receipt.data.discussionAddressing, address)
            && progress.success && progress.data.disposition !== 'released' && isDeepStrictEqual(progress.data.discussion, address) ? [row.localId] : [];
    }));
}

/** Shared admission fact for reset mutation and its content-free waiting projection. */
async function readCurrentPendingResetStartTargetInTx(tx: Tx, sessionId: string, pending: Readonly<{
    messageRole: string | null; authorAccountId: string | null; inputAdmissionReceipt: unknown;
}>, actorAccountId?: string) {
    const session = await tx.session.findUnique({ where: { id: sessionId }, select: { id: true, accountId: true, archivedAt: true } });
    return (await readCurrentPendingResetStartTargetsInTx(tx, [{ sessionId, session, pending, actorAccountId }]))[0] ?? null;
}

/** Point mutations and snapshot lists consume the same exact reset-target decision. */
async function readCurrentPendingResetStartTargetsInTx(tx: Tx, inputs: readonly Readonly<{
    sessionId: string;
    session: Readonly<{ id: string; accountId: string; archivedAt: Date | null }> | null;
    pending: Readonly<{ messageRole: string | null; authorAccountId: string | null; inputAdmissionReceipt: unknown }>;
    actorAccountId?: string;
}>[]): Promise<readonly (SessionInputMachineTargetV1 | null)[]> {
    const targets = inputs.map(({ sessionId, session, pending, actorAccountId }) => {
        if (!session || session.id !== sessionId || session.archivedAt !== null
            || actorAccountId !== undefined && actorAccountId !== session.accountId) return null;
        return readPendingOwnerInputAdmission({ sessionId, accountId: session.accountId, pending })?.admittedTarget ?? null;
    });
    const admittedTargets = targets.filter((target): target is SessionInputMachineTargetV1 => target !== null);
    if (admittedTargets.length === 0) return targets;
    const currentness = await areCurrentSessionInputMachineTargetsInTx(tx, admittedTargets);
    const machineIds = [...new Set(admittedTargets.map(target => target.machineId))];
    const resetSupported = new Map<string, boolean>();
    for (let offset = 0; offset < machineIds.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
        const capabilities = await tx.machine.findMany({ where: { id: { in: machineIds.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE) } },
            select: { id: true, operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true } });
        for (const machine of capabilities) resetSupported.set(machine.id, Boolean(machine.operationProtocolCapabilitiesRevision)
            && supportsMachineOperationProtocolCapabilityV1(machine.operationProtocolCapabilities, 'sessionPendingResetStart'));
    }
    const current = new Map(admittedTargets.map((target, index) => [target, currentness[index] === true && resetSupported.get(target.machineId) === true]));
    return targets.map(target => target && current.get(target) === true ? target : null);
}

/** Reads Pending metadata, Session access and target authority from one coherent read-only view. */
export async function listPendingResetStartsForSource(params: Readonly<{
    actorUserId: string; authentication: SessionAccessAuthentication; source: PendingResetStartsReadInputV1['source'];
}>): Promise<PendingResetStartsReadResultV1> {
    const { source } = PendingResetStartsReadInputV1Schema.parse({ source: params.source });
    return inReadSnapshot(async tx => {
        const accessWhere = await buildSessionAccessWhere({ mode: 'effective_access_v1', tx,
            accountId: params.actorUserId, capability: 'readTranscript', authentication: params.authentication });
        const rows = await tx.sessionPendingMessage.findMany({ where: { status: 'queued', deliveryState: null,
            targetExecutionRunId: null, session: accessWhere },
            select: { sessionId: true, localId: true, requestedAction: true, inputAdmissionReceipt: true, messageRole: true, authorAccountId: true,
                session: { select: { id: true, accountId: true, archivedAt: true } } },
            orderBy: [{ sessionId: 'asc' }, { position: 'asc' }] });
        // Most queued rows are not reset candidates. Classify their already-read
        // metadata before loading any per-Session or installed-Machine authority.
        const candidates = rows.flatMap(row => {
            const action = PendingRequestedActionV1StoredSchema.safeParse(row.requestedAction);
            if (!action.success || action.data.kind === 'reset_start' && !isDeepStrictEqual(action.data.reset.source, source)) return [];
            const owned = row.session.accountId === params.actorUserId && row.session.archivedAt === null;
            const receipt = owned ? readPendingOwnerInputAdmission({ sessionId: row.sessionId, accountId: params.actorUserId, pending: row }) : undefined;
            if (action.data.kind !== 'reset_start' && (!owned || row.messageRole !== 'user' || row.authorAccountId !== params.actorUserId || !receipt)) return [];
            return [{ row, action: action.data }];
        });
        if (candidates.length === 0) return { entries: [] };
        const sessionIds = [...new Set(candidates.map(candidate => candidate.row.sessionId))];
        const bySession = new Map<string, SessionAccessProjectionRow>();
        for (let offset = 0; offset < sessionIds.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const sessionRows = await tx.session.findMany({ where: { id: { in: sessionIds.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE) } },
                select: buildSessionAccessProjectionSelect(params.actorUserId) });
            for (const row of sessionRows) bySession.set(row.id, row);
        }
        const currentTargets = await readCurrentPendingResetStartTargetsInTx(tx, candidates.map(({ row }) => ({
            sessionId: row.sessionId, session: row.session, pending: row, actorAccountId: params.actorUserId,
        })));
        const entries: PendingResetStartsReadResultV1['entries'] = [];
        const unboundEntries: NonNullable<PendingResetStartsReadResultV1['unboundEntries']> = [];
        for (const [index, { row, action }] of candidates.entries()) {
            const target = currentTargets[index] ?? null;
            const sessionRow = bySession.get(row.sessionId);
            if (!sessionRow) continue;
            const authorityCurrent = target !== null;
            if (action.kind === 'reset_start') {
                const authority = await resolveSessionAccessForOperation(tx, { accountId: params.actorUserId, row: sessionRow,
                    sessionId: row.sessionId, capability: 'submitAgentInput', authentication: params.authentication });
                entries.push({ sessionId: row.sessionId, localId: row.localId, reset: action.reset,
                    authorityCurrent: authority.status === 'allowed' && authorityCurrent });
            } else {
                // Listing unbound input is Account-owner-only, even when ordinary
                // shared Session input is admitted. Keep lost target authority
                // observable without disclosing input content.
                const resetAccess = await resolveSessionAccessForOperation(tx, {
                    accountId: params.actorUserId, sessionId: row.sessionId, row: sessionRow, authentication: params.authentication,
                    capability: 'submitAgentInput',
                    apiTokenAction: { actionId: 'session.pending.resetStart.set', targetMachineId: target?.machineId },
                });
                if (resetAccess.status !== 'allowed') continue;
                unboundEntries.push({ sessionId: row.sessionId, localId: row.localId, authorityCurrent });
            }
        }
        return { entries, ...(unboundEntries.length ? { unboundEntries } : {}) };
    }, { transactionClass: "pending-reset-starts-read" });
}

type PendingOperationErrorContext = Readonly<{
    operation: "enqueue" | "provider-acceptance";
    sessionId: string;
    localId: string;
    diagnosticCorrelationId?: string;
    prismaCode?: string;
    error: unknown;
}>;

function reportPendingOperationError(context: PendingOperationErrorContext, message: string): void {
    warn(
        {
            module: "session-pending-service",
            operation: context.operation,
            sessionId: context.sessionId,
            localId: context.localId,
            correlationId: context.diagnosticCorrelationId ?? null,
            ...(context.prismaCode ? { prismaCode: context.prismaCode } : {}),
            err: isTransactionConflictExhaustedError(context.error)
                ? { name: context.error.name, code: context.error.code }
                : context.error,
        },
        message,
    );
}

function pendingRequestedActionReplacementData(
    requestedAction: PendingRequestedActionV1,
    updatedAt: Date,
) {
    return {
        requestedAction,
        requestEqualityEvidenceV1: getActivePrismaRuntime().DbNull,
        providerAction: null,
        deliveryState: null,
        deliveryBlockedReason: null,
        updatedAt,
    } as const;
}
type PendingServiceTx = Tx;

function parsePendingExecutionTarget(value: string | null | undefined):
    | { ok: true; targetExecutionRunId: string | null }
    | { ok: false; error: "invalid-params" } {
    if (value == null) return { ok: true, targetExecutionRunId: null };
    const parsed = ExecutionRunIdSchema.safeParse(value);
    return parsed.success
        ? { ok: true, targetExecutionRunId: parsed.data }
        : { ok: false, error: "invalid-params" };
}

/**
 * Ordinary editor, delete, discard, restore, and reorder operations must not
 * race a delivery whose provider effect may already exist. The delivery-status
 * protocol owns that classification so newly represented uncertainty cannot
 * silently become editable here.
 */
function isOrdinaryPendingMutationFenced(fields: Readonly<{
    status: unknown;
    deliveryState?: unknown;
    deliveryBlockedReason?: unknown;
    discardedReason?: unknown;
}>): boolean {
    return isPendingDeliveryProviderEffectPossibleV1(normalizePendingDeliveryStatusV1(fields));
}

function isPendingDeliveryResolutionRaceError(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002") || isPrismaErrorCode(error, "P2025");
}

async function rejoinPendingDeliveryResolutionRace<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isPendingDeliveryResolutionRaceError(error)) {
            throw error;
        }
        return operation();
    }
}

export type { PendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";

export type PendingSessionAuthenticationError = Extract<
    SessionAccessErrorCodeV1,
    "session_access_authentication_required" | "session_access_authentication_unavailable"
>;

type PendingSessionAccessError = "session-not-found" | PendingSessionAuthenticationError;

/**
 * Pending is a Session-access consumer. Preserve the canonical credential
 * continuation while keeping ordinary absence/denial indistinguishable from a
 * missing Session.
 */
function projectPendingSessionAccessError(
    status: "authentication_required" | "authentication_unavailable" | "unavailable",
): PendingSessionAccessError {
    if (status === "authentication_required") return "session_access_authentication_required";
    if (status === "authentication_unavailable") return "session_access_authentication_unavailable";
    return "session-not-found";
}

async function projectPendingMessageRows(reader: Pick<Tx, "account">, rows: readonly PendingMessageRowRaw[]): Promise<PendingMessageRow[]> {
    const actors = await projectSessionMessageAccountActors(reader, rows.map((row) => ({
        messageRole: row.messageRole,
        inputAdmissionReceipt: row.inputAdmissionReceipt,
        authorAccountId: row.authorAccountId,
    })));
    return rows.map((row, index) => mapPendingMessageRow(row, actors[index]));
}

async function projectPendingSessionMessageRows(sessionId: string, actorAccountId: string, rows: readonly PendingMessageRowRaw[],
    authentication: SessionAccessAuthentication): Promise<PendingMessageRow[]> {
    if (rows.length === 0) return [];
    return inReadSnapshot(async tx => {
        const [pending, holds] = await Promise.all([
            projectPendingMessageRows(tx, rows),
            readPendingActivationHoldReasonsInTx(tx, { sessionId, actorAccountId, rows }),
        ]);
        // A shared viewer can inspect Pending without seeing the owning Account's
        // original input pointer. Read exact stored roots in a batch; never infer
        // an exchange from the newest transcript message.
        const roots = new Map<string, NonNullable<PendingMessageRow['autonomousExchangeRoot']>>();
        const held = rows.filter(row => row.status === 'queued' && row.deliveryState === 'blocked'
            && row.deliveryBlockedReason === 'autonomous_check_in'
            && row.autonomousExchangeRootSessionId && row.autonomousExchangeRootLocalId);
        if (held.length && !authentication.sessionRuntimePrincipal && !authentication.contentDisclosureSessionId && !authentication.apiTokenGrant
            && await tx.session.findFirst({ where: { id: sessionId, accountId: actorAccountId }, select: { id: true } })) {
            const accessWhere = await buildSessionAccessWhere({ mode: 'effective_access_v1', tx,
                accountId: actorAccountId, capability: 'readTranscript', authentication });
            for (let offset = 0; offset < held.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
                const readable = await tx.sessionMessage.findMany({ where: {
                    OR: held.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE).map(row => ({
                        sessionId: row.autonomousExchangeRootSessionId!, localId: row.autonomousExchangeRootLocalId!,
                    })), session: { AND: [{ accountId: actorAccountId, archivedAt: null }, accessWhere] },
                }, select: { sessionId: true, localId: true } });
                for (const root of readable) if (root.localId) roots.set(JSON.stringify([root.sessionId, root.localId]),
                    { sessionId: root.sessionId, localId: root.localId });
            }
        }
        const rawByLocalId = new Map(held.map(row => [row.localId, row]));
        return pending.map(row => {
            const activationHoldReason = holds.get(row.localId);
            const raw = rawByLocalId.get(row.localId);
            const autonomousExchangeRoot = raw && roots.get(JSON.stringify([raw.autonomousExchangeRootSessionId, raw.autonomousExchangeRootLocalId]));
            return { ...row, ...(activationHoldReason ? { activationHoldReason } : {}),
                ...(autonomousExchangeRoot ? { autonomousExchangeRoot } : {}) };
        });
    }, { transactionClass: 'pending-activation-holds-read' });
}

export type ListPendingMessagesResult =
    | { ok: true; pending: PendingMessageRow[]; targetPendingState?: TargetPendingState }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "internal" };

export type ReadSessionPendingStateResult =
    | { ok: true; pendingCount: number; pendingBlockedCount: number; pendingVersion: number }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "internal" };

export type QueuedExecutionRunPendingTarget = Readonly<{
    sessionId: string;
    runId: string;
}>;

/** Current owner-scoped recipient projection used by durable Account-change replay. */
export async function listQueuedExecutionRunPendingTargetsForSessions(params: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    reader?: Pick<Tx, "sessionPendingMessage">;
}>): Promise<QueuedExecutionRunPendingTarget[]> {
    if (typeof params.accountId !== "string" || params.accountId.length === 0) return [];
    const sessionIds = [...new Set(params.sessionIds.flatMap((value) => {
        const parsed = SessionIdSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
    }))];
    if (sessionIds.length === 0) return [];

    const rows = await (params.reader ?? db).sessionPendingMessage.findMany({
        where: {
            sessionId: { in: sessionIds },
            session: { is: { accountId: params.accountId } },
            status: "queued",
            targetExecutionRunId: { not: null },
        },
        orderBy: [
            { sessionId: "asc" },
            { position: "asc" },
        ],
        select: {
            sessionId: true,
            targetExecutionRunId: true,
        },
    });
    const seen = new Set<string>();
    return rows.flatMap((row) => {
        const runId = ExecutionRunIdSchema.safeParse(row.targetExecutionRunId);
        if (!runId.success) return [];
        const key = `${row.sessionId}\u0000${runId.data}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ sessionId: row.sessionId, runId: runId.data }];
    });
}

export async function readSessionPendingState(params: {
    actorUserId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
}): Promise<ReadSessionPendingStateResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const decision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
    });
    if (decision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(decision.status) };
    if (decision.access.level !== "owner") return { ok: false, error: "forbidden" };

    try {
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        if (!session) return { ok: false, error: "session-not-found" };
        return {
            ok: true,
            pendingCount: session.pendingCount ?? 0,
            pendingBlockedCount: session.pendingBlockedCount ?? 0,
            pendingVersion: session.pendingVersion ?? 0,
        };
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function listPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    includeDiscarded?: boolean;
    targetExecutionRunId?: string | null;
    authentication: SessionAccessAuthentication;
}): Promise<ListPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const includeDiscarded = params.includeDiscarded === true;
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const decision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
    });
    if (decision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(decision.status) };

    const select = {
        localId: true,
        autonomousExchangeRootSessionId: true,
        autonomousExchangeRootLocalId: true,
        targetExecutionRunId: true,
        messageRole: true,
        providerAction: true,
        replyProgress: true,
        content: true,
        requestedAction: true,
        status: true,
        deliveryState: true,
        deliveryBlockedReason: true,
        position: true,
        createdAt: true,
        updatedAt: true,
        discardedAt: true,
        discardedReason: true,
        authorAccountId: true,
        inputAdmissionReceipt: true,
    } as const;

    try {
        if (targetExecutionRunId !== null) {
            return await inReadSnapshot(async (tx) => {
                const [queued, discarded, pendingCount, pendingBlockedCount, session] = await Promise.all([
                    tx.sessionPendingMessage.findMany({
                        where: { sessionId, targetExecutionRunId, status: "queued" },
                        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                        select,
                    }),
                    includeDiscarded
                        ? tx.sessionPendingMessage.findMany({
                            where: {
                                sessionId,
                                status: "discarded",
                                targetExecutionRunId,
                                OR: [
                                    { discardedReason: null },
                                    { discardedReason: { notIn: [...PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1] } },
                                ],
                            },
                            orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
                            select,
                        })
                        : Promise.resolve([]),
                    tx.sessionPendingMessage.count({ where: { sessionId, targetExecutionRunId, status: "queued" } }),
                    tx.sessionPendingMessage.count({
                        where: { sessionId, targetExecutionRunId, status: "queued", deliveryState: "blocked" },
                    }),
                    tx.session.findUnique({ where: { id: sessionId }, select: { pendingVersion: true } }),
                ]);
                if (!session) return { ok: false, error: "session-not-found" } as const;
                return {
                    ok: true,
                    pending: await projectPendingMessageRows(tx, [...queued, ...discarded]),
                    targetPendingState: {
                        pendingCount,
                        pendingBlockedCount,
                        pendingVersion: session.pendingVersion,
                    },
                } as const;
            });
        }

        if (!includeDiscarded) {
            const rows = await db.sessionPendingMessage.findMany({
                where: { sessionId, targetExecutionRunId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            });
            return { ok: true, pending: await projectPendingSessionMessageRows(sessionId, actorUserId, rows, params.authentication) };
        }

        const [queued, discarded] = await Promise.all([
            db.sessionPendingMessage.findMany({
                where: { sessionId, targetExecutionRunId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            }),
            db.sessionPendingMessage.findMany({
                where: {
                    sessionId,
                    status: "discarded",
                    targetExecutionRunId,
                    OR: [
                        { discardedReason: null },
                        { discardedReason: { notIn: [...PENDING_DELIVERY_HIDDEN_DISCARDED_REASONS_V1] } },
                    ],
                },
                orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
                select,
            }),
        ]);

        return { ok: true, pending: await projectPendingSessionMessageRows(sessionId, actorUserId, [...queued, ...discarded], params.authentication) };
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type EnqueuePendingMessageResult =
    | {
        ok: true;
        terminal?: false;
        suppressed?: false;
        didWrite: boolean;
        pending: PendingMessageRow;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        badgeAttentionChanged: boolean;
        recipientCursors: RecipientCursor[];
        meaningfulActivityAt?: Date;
        activationTarget?: PendingActivationTarget;
      }
    | {
        ok: true;
        terminal: true;
        acceptedFollowInputLocalId?: string;
        suppressed?: false;
        didWrite: false;
        message: PendingTranscriptMessage & { requestedAction: PendingRequestedActionV1 };
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        badgeAttentionChanged: false;
        recipientCursors: [];
      }
    | {
        ok: true;
        terminal?: false;
        suppressed: true;
        didWrite: false;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        badgeAttentionChanged: false;
        recipientCursors: [];
      }
    | {
        ok: false;
        error: PendingSessionAccessError | "forbidden" | "invalid-params" | "internal";
        code?: EncryptionPolicyRejectionCode;
        admissionRejectionCode?: SessionInputAdmissionRejectionCodeV1;
      }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number; correlationId?: string };

type EnqueuePendingMessageInput = {
    nextTurnNote?: SessionInputAdmissionReceiptV1['nextTurnNote'];
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
    followSources?: SessionInputAdmissionReceiptV1['followSources'];
    followRelations?: SessionInputAdmissionReceiptV1['followRelations'];
    followDeliveryV1?: SessionInputAdmissionReceiptV1['followDeliveryV1'];
    reply?: SessionMessageReplyAdmissionV1;
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    targetMachineId?: string;
    localId: string;
    messageRole?: unknown;
    deliveryMode?: "external_handoff";
    admissionMode?: "continuation_if_no_queued_user_input";
    requestedAction: PendingRequestedActionV1;
    resumeWhenAvailable?: true;
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
    diagnosticCorrelationId?: string;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
);

type PendingMessageAdmissionContext =
    | Readonly<{
        kind: "account";
        authentication: SessionAccessAuthentication;
      }>
    | Readonly<{
        kind: "machine";
        sourceMachineId: string;
        targetMachineId: string;
        inputAdmissionReceipt: Extract<SessionInputAdmissionReceiptV1, { issuer: "authenticatedMachine" }>;
      }>;

function isAuthenticatedAccountRetryOfHostVerifiedEncryptedBytes(params: Readonly<{
    admission: PendingMessageAdmissionContext;
    actorUserId: string;
    authorAccountId: string | null;
    inputAdmissionReceipt: unknown;
    requestEqualityEvidenceV1: unknown;
    existingContent: PrismaJson.SessionMessageContent;
    candidateContent: PrismaJson.SessionMessageContent;
}>): boolean {
    if (
        params.admission.kind !== "account"
        || params.authorAccountId !== null && params.authorAccountId !== params.actorUserId
        || params.existingContent.t !== "encrypted"
        || params.candidateContent.t !== "encrypted"
        || !isDeepStrictEqual(params.existingContent, params.candidateContent)
    ) {
        return false;
    }
    const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(params.inputAdmissionReceipt);
    const evidence = createStoredReadSchema(SessionInputRequestEqualityEvidenceV1Schema).safeParse(params.requestEqualityEvidenceV1);
    return receipt.success
        && receipt.data.issuer === "authenticatedAccount"
        && receipt.data.actorAccountId === params.actorUserId
        && evidence.success
        && evidence.data.kind === "e2eeTag";
}

export async function enqueuePendingMessage(
    params: EnqueuePendingMessageInput & Readonly<{ authentication: SessionAccessAuthentication;
        followSourceApp?: Pick<Fastify, 'forwardRpcForUser'> }>,
): Promise<EnqueuePendingMessageResult> {
    // Equality evidence is host-derived E2EE correspondence carried only over
    // the authenticated machine admission route. An Account request cannot
    // author or replay that protected assertion.
    if (params.requestEqualityEvidenceV1 !== undefined) {
        return { ok: false, error: "invalid-params" };
    }
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };
    const decision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (decision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(decision.status) };
    if (!decision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };
    let executionRunFrontier: ExecutionRunFollowFrontierWitness | undefined;
    const original = params.followDeliveryV1?.original;
    if (original && isRunFollowOriginalV1(original) && original.source.kind === 'execution_run') {
        if (!params.followSourceApp) return { ok: false, error: 'forbidden' };
        const read = await readCurrentExecutionRunFollowSource({ app: params.followSourceApp, accountId: actorUserId,
            ...original.source, authentication: params.authentication });
        if (!read.ok || 'terminalEventId' in original && read.value.terminalEventId !== original.terminalEventId) return { ok: false, error: 'forbidden' };
        executionRunFrontier = read.value;
    }
    return await enqueuePendingMessageWithAdmission({ ...params, ...(executionRunFrontier ? { executionRunFrontier } : {}) }, {
        kind: "account",
        authentication: params.authentication,
    });
}

async function enqueuePendingMessageWithAdmission(
    params: EnqueuePendingMessageInput,
    admission: PendingMessageAdmissionContext,
): Promise<EnqueuePendingMessageResult> {
    const requestAccountId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const deliveryMode = params.deliveryMode === undefined || params.deliveryMode === "external_handoff"
        ? params.deliveryMode
        : null;
    const admissionMode = params.admissionMode === undefined || params.admissionMode === "continuation_if_no_queued_user_input"
        ? params.admissionMode
        : null;
    const requestedActionResult = PendingRequestedActionV1Schema.safeParse(params.requestedAction);
    const requestEqualityEvidenceResult = params.requestEqualityEvidenceV1 === undefined
        ? undefined
        : SessionInputRequestEqualityEvidenceV1Schema.safeParse(params.requestEqualityEvidenceV1);
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const rawContent =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;

    if (
        !requestAccountId
        || !sessionId
        || !localId
        || !rawContent
        || deliveryMode === null
        || admissionMode === null
        || !requestedActionResult.success
        || requestEqualityEvidenceResult !== undefined && !requestEqualityEvidenceResult.success
    ) {
        return { ok: false, error: "invalid-params" };
    }
    const requestedAction = requestedActionResult.data;
    if (params.nextTurnNote !== undefined && (params.nextTurnNote !== 'file_review_note.v1'
        || requestedAction.kind !== 'enqueue' || targetExecutionRunId !== null
        || deliveryMode !== undefined || admissionMode !== undefined || params.resumeWhenAvailable === true
        || params.reply !== undefined || params.followDeliveryV1 !== undefined)) {
        return { ok: false, error: 'invalid-params' };
    }
    if (requestedAction.kind === 'reset_start' && (targetExecutionRunId !== null || deliveryMode !== undefined
        || admissionMode !== undefined || params.resumeWhenAvailable === true)) return { ok: false, error: 'invalid-params' };
    const directTokenInput = admission.kind === "account" && admission.authentication.apiTokenGrant !== undefined;
    if (directTokenInput && params.messageRole !== undefined && params.messageRole !== null && params.messageRole !== "user") {
        return { ok: false, error: "invalid-params" };
    }
    if (targetExecutionRunId !== null && (deliveryMode !== undefined || admissionMode !== undefined)) {
        return { ok: false, error: "invalid-params" };
    }
    if (rawContent.t === "encrypted" && (!rawContent.c || typeof rawContent.c !== "string")) return { ok: false, error: "invalid-params" };
    if (rawContent.t === "plain" && !("v" in rawContent)) return { ok: false, error: "invalid-params" };
    const content = normalizeSessionMessageContentForStorage(rawContent);
    if (!content) return { ok: false, error: "invalid-params" };
    if (
        content.t === "plain" && requestEqualityEvidenceResult !== undefined
        || content.t === "encrypted"
            && requestEqualityEvidenceResult !== undefined
            && requestEqualityEvidenceResult.data.kind !== "e2eeTag"
    ) {
        return { ok: false, error: "invalid-params" };
    }
    const requestEqualityEvidenceV1 = requestEqualityEvidenceResult?.data;

    // A Pending row materializes into a transcript row under its own localId,
    // so every Pending ingress is a generic client-facing message ingress. The
    // reserved Agent-transition divider namespace is refused HERE, at the one
    // admission choke point every Pending adapter funnels through, rather than
    // at each adapter: an authenticated Machine on the same Account reaches
    // this owner without passing any route, and a row planted at the
    // deterministic divider id would permanently conflict every future cutover
    // for that Session. `invalid-params` is the already-understood typed
    // failure — the HTTP adapter answers 400 `invalid-params` and the Machine
    // adapter answers `rejected`/`session_input_invalid`.
    if (isSessionAgentTransitionDividerLocalId(localId)) {
        return { ok: false, error: "invalid-params" };
    }
    const replyDiscussionId = params.reply?.discussion?.discussionId;

    try {
        return await inPendingQueuePositionTx(sessionId, async (tx) => pendingPublicationResult<EnqueuePendingMessageResult>(async () => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    accountId: true,
                    active: true,
                    archivedAt: true,
                    encryptionMode: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                    runtimeMachineTarget: true,
                },
            });
            if (!session) return { ok: false, error: "session-not-found" } as const;
            // Hosted requester custody permits ordinary input, not authoring or
            // probing the requester's Account-private Follow rule witnesses.
            if (admission.kind === 'machine' && admission.inputAdmissionReceipt.followSources?.length
                && requestAccountId !== session.accountId) return {
                ok: false, error: 'forbidden', admissionRejectionCode: 'session_input_unauthorized',
            } as const;
            const retainedPending = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } },
                select: { replyProgress: true, status: true, discardedReason: true, inputAdmissionReceipt: true } });
            const retainedReplyRow = retainedPending
                ?? await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { replyProgress: true } });
            const suppressedReceipt = retainedPending?.status === 'discarded' && retainedPending.discardedReason === 'session_input_muted'
                ? readStoredSessionInputAdmissionReceipt(retainedPending.inputAdmissionReceipt) : undefined;
            const suppressedDiscussionReplay = suppressedReceipt?.issuer === 'authenticatedMachine'
                && suppressedReceipt.discussionAddressing !== undefined
                && isDeepStrictEqual(suppressedReceipt.discussionAddressing, params.reply?.discussion);
            // Rejected custody deliberately has no live reply obligation. Its
            // exact replay still passes Machine/target/issuer admission below.
            if (retainedReplyRow && !suppressedDiscussionReplay) {
                const retained = retainedReplyRow.replyProgress == null ? null : SessionMessageReplyProgressV1Schema.safeParse(retainedReplyRow.replyProgress);
                if (retained && (!retained.success || !matchesOriginalReplyAdmission(retained.data, params.reply))
                    || !retained && params.reply !== undefined) return { ok: false, error: 'invalid-params' } as const;
            }
            // A Machine hosting a requester Session authenticates as its
            // custodian, not the Session owner. Only the exact hosting Machine
            // may use that owner's tuple; current AccessKey/C41 admission below
            // still decides whether that tuple can receive input.
            const actorUserId = admission.kind === "machine" && admission.sourceMachineId === admission.targetMachineId
                ? session.accountId : requestAccountId;
            const access = admission.kind === "account"
                ? await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: admission.authentication })
                : await assertSessionOwnerInTx({ tx, accountId: actorUserId, sessionId });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            let inputAdmissionReceipt = admission.kind === "account"
                ? SessionInputAdmissionReceiptV1Schema.parse({
                    ...buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access: access.access,
                        callerInputConstraints: admission.authentication.callerInputConstraints ?? admission.authentication.apiTokenGrant,
                        ...(params.nextTurnNote ? { nextTurnNote: params.nextTurnNote } : {}) }),
                    ...(params.followSources ? { followSources: params.followSources } : {}),
                    ...(params.followRelations ? { followRelations: params.followRelations } : {}),
                    ...(params.followDeliveryV1 ? { followDeliveryV1: params.followDeliveryV1 } : {}),
                })
                : admission.inputAdmissionReceipt;
            if (session.archivedAt !== null) {
                return {
                    ok: false,
                    error: "invalid-params",
                    admissionRejectionCode: "session_input_archived",
                } as const;
            }
            // External handoff reserves caller-owned delivery, not input for
            // the Session's main runner. Its retained Machine placement does
            // not admit that provider; the provider/run ingress does so later.
            const requiresMachineTarget = deliveryMode !== "external_handoff";
            const committedTarget = !requiresMachineTarget || session.runtimeMachineTarget == null ? undefined
                : await readCurrentCommittedSessionInputMachineTargetInTx(tx, sessionId);
            if (requiresMachineTarget && session.runtimeMachineTarget != null && !committedTarget) return {
                ok: false, error: "session-not-found", admissionRejectionCode: "session_input_target_unavailable",
            } as const;
            if (requiresMachineTarget && (admission.kind === "machine" || targetExecutionRunId !== null || params.targetMachineId !== undefined || committedTarget)) {
                if (admission.kind === "machine" && session.accountId !== actorUserId) {
                    return {
                        ok: false,
                        error: "session-not-found",
                        admissionRejectionCode: "session_input_unauthorized",
                    } as const;
                }
                const targetMachineId = admission.kind === "machine" ? admission.targetMachineId : params.targetMachineId ?? committedTarget?.machineId;
                if (!targetMachineId) return {
                    ok: false, error: "session-not-found", admissionRejectionCode: "session_input_target_unavailable",
                } as const;
                if (committedTarget && targetMachineId !== committedTarget.machineId) return {
                    ok: false, error: "session-not-found", admissionRejectionCode: "session_input_target_unavailable",
                } as const;
                const [sourceMachine, targetAccess] = await Promise.all([
                    admission.kind === "machine" ? tx.machine.findFirst({
                        where: { accountId: requestAccountId, id: admission.sourceMachineId },
                        select: { revokedAt: true, replacedByMachineId: true },
                    }) : null,
                    tx.accessKey.findUnique({
                        where: {
                            accountId_machineId_sessionId: {
                                accountId: session.accountId,
                                machineId: targetMachineId,
                                sessionId,
                            },
                        },
                        select: {
                            session: { select: { accountId: true } },
                            machine: {
                                select: {
                                    accountId: true,
                                    installationId: true,
                                    revokedAt: true,
                                    replacedByMachineId: true,
                                    operationProtocolCapabilities: true,
                                    operationProtocolCapabilitiesRevision: true,
                                },
                            },
                        },
                    }),
                ]);
                if (
                    admission.kind === "machine" && (!sourceMachine
                    || sourceMachine.revokedAt !== null
                    || sourceMachine.replacedByMachineId !== null)
                ) {
                    return {
                        ok: false,
                        error: "forbidden",
                        admissionRejectionCode: "session_input_unauthorized",
                    } as const;
                }
                const admittedTarget = await readCurrentSessionInputMachineTargetInTx(tx, {
                    accountId: session.accountId, sessionId, machineId: targetMachineId,
                });
                // The released owned, uninstalled tuple predates installation admission.
                // It retains the old receipt/hint, never a foreign or installed fallback.
                const legacyOwnedTarget = admission.kind === 'account' && targetExecutionRunId === null
                    && targetAccess?.machine.accountId === session.accountId
                    && targetAccess.machine.installationId === null
                    && await readSessionMachineBindingStateInTx(tx, { accountId: session.accountId, sessionId,
                        machineId: targetMachineId }) === 'available';
                if (
                    !targetAccess
                    || targetAccess.session.accountId !== session.accountId
                    || targetAccess.machine.revokedAt !== null
                    || targetAccess.machine.replacedByMachineId !== null
                    || !admittedTarget && !legacyOwnedTarget
                ) {
                    if (targetExecutionRunId !== null) {
                        return {
                            ok: false,
                            error: "session-not-found",
                            admissionRejectionCode: "session_input_target_unavailable",
                        } as const;
                    }
                    return {
                        ok: false,
                        error: "session-not-found",
                        admissionRejectionCode: "session_input_target_unavailable",
                    } as const;
                }
                if (
                    !legacyOwnedTarget && (typeof targetAccess.machine.operationProtocolCapabilitiesRevision !== "number"
                    || targetAccess.machine.operationProtocolCapabilitiesRevision < 1
                    || !supportsMachineSessionInputAdmissionProtocolVersion(
                        targetAccess.machine.operationProtocolCapabilities,
                        targetExecutionRunId === null ? 1 : 2,
                    ))
                ) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: "session_input_target_update_required",
                    } as const;
                }
                if (admittedTarget) inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.parse({ ...inputAdmissionReceipt, admittedTarget });
            }

            let suppressedFollow: Pick<Parameters<typeof retainSuppressedSessionFollowInputInTx>[1], 'delivery' | 'progresses' | 'relations'> | undefined;
            if (inputAdmissionReceipt.followSources || inputAdmissionReceipt.followRelations || inputAdmissionReceipt.followDeliveryV1) {
                const delivery = inputAdmissionReceipt.followDeliveryV1;
                const questionHandler = delivery !== undefined && isSessionFollowQuestionHandlerV1(delivery, sessionId);
                if (!delivery || !inputAdmissionReceipt.admittedTarget || requestAccountId !== session.accountId
                    || (!questionHandler && !inputAdmissionReceipt.followSources?.length && !inputAdmissionReceipt.followRelations?.length)) {
                    return { ok: false, error: 'invalid-params' } as const;
                }
                if ('sourceTurn' in delivery.original && (!('event' in delivery)
                    || !isDeepStrictEqual(delivery.event, resolveSessionFollowTurnEventV1(delivery.original.sourceTurn)))) {
                    return { ok: false, error: 'forbidden' } as const;
                }
                if ((isRunFollowOriginalV1(delivery.original) || 'sourceTurn' in delivery.original) && localId !== deriveSessionFollowInputLocalIdV1({
                    destinationSessionId: sessionId, original: delivery.original,
                })) return { ok: false, error: 'invalid-params' } as const;
                const suppressed = await readSessionFollowInputSuppressionInTx(tx, {
                    accountId: session.accountId, destinationSessionId: sessionId, receipt: inputAdmissionReceipt,
                });
                if (suppressed === null) return { ok: false, error: 'forbidden' } as const;
                const progresses: SessionFollowRuleProgressAdmission[] = [];
                for (const witness of inputAdmissionReceipt.followSources ?? []) {
                    if (!('sourceSessionId' in delivery.original)) return { ok: false, error: 'invalid-params' } as const;
                    if (witness.destinationSessionId !== sessionId || witness.sourceSessionId !== delivery.original.sourceSessionId
                        || !isDeepStrictEqual(witness.sourceMessage ?? witness.sourceRequests ?? witness.sourceTurn,
                            'sourceMessage' in delivery.original ? delivery.original.sourceMessage
                                : 'sourceRequests' in delivery.original ? delivery.original.sourceRequests : delivery.original.sourceTurn)) {
                        return { ok: false, error: 'forbidden' } as const;
                    }
                    const admitted = await admitSessionFollowRuleOccurrenceInTx(tx, { accountId: session.accountId, witness,
                        ...(suppressed ? { settleSuppressedOriginal: true as const } : {}),
                        authority: admission.kind === 'machine' ? { kind: 'source_machine', machineId: admission.sourceMachineId }
                            : { kind: 'account', authentication: admission.authentication } });
                    if (!admitted) return { ok: false, error: 'forbidden' } as const;
                    progresses.push(admitted.progress);
                }
                const relations = inputAdmissionReceipt.followRelations || questionHandler ? await admitSessionFollowRelationsForInputInTx(tx, {
                    accountId: session.accountId, destinationSessionId: sessionId,
                    ...(admission.kind === 'machine' ? { sourceMachineId: admission.sourceMachineId }
                        : { authentication: admission.authentication }),
                    delivery, relations: inputAdmissionReceipt.followRelations ?? [],
                    ...(suppressed ? { settleSuppressedOriginal: true as const } : {}),
                    ...(params.executionRunFrontier ? { executionRunFrontier: params.executionRunFrontier } : {}),
                }) : [];
                if (!relations) return { ok: false, error: 'forbidden' } as const;
                if (resolveSessionFollowInputSelectedDelivery(delivery, relations,
                    (inputAdmissionReceipt.followSources ?? []).map(witness => witness.selectedDelivery), questionHandler) !== delivery.delivery) {
                    return { ok: false, error: 'forbidden' } as const;
                }
                if (suppressed) suppressedFollow = { delivery, progresses, relations };
                const originalKey = deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original);
                if (!originalKey) return { ok: false, error: 'invalid-params' } as const;
                const accepted = await tx.sessionMessage.findFirst({ where: { sessionId, acceptedFollowOriginalKey: originalKey },
                    select: { id: true, seq: true, localId: true, sidechainId: true, messageRole: true, content: true,
                        inputAdmissionReceipt: true, authorAccountId: true, deliveryResolution: true, createdAt: true, updatedAt: true,
                        acceptedTurnId: true } });
                if (accepted?.localId && accepted.messageRole === 'user' && (accepted.acceptedTurnId !== null
                    || readStoredSessionMessageDeliveryResolutionV1(accepted.deliveryResolution)?.kind === 'provider_accepted')) {
                    if (!await settleSessionFollowInputReasonsInTx(tx, { progresses, relations,
                        observed: sessionFollowInputFrontiers(delivery).observed, delivery })) throw new TransactionReplayRequiredError('follow-input-settlement-conflict');
                    return { ok: true, terminal: true, didWrite: false, acceptedFollowInputLocalId: accepted.localId,
                        message: { ...accepted, localId: accepted.localId, messageRole: parseSessionMessageRole(accepted.messageRole),
                            content: accepted.content as PrismaJson.SessionMessageContent, requestedAction,
                            inputAdmissionReceipt: readStoredSessionInputAdmissionReceipt(accepted.inputAdmissionReceipt) ?? null,
                            deliveryResolution: readStoredSessionMessageDeliveryResolutionV1(accepted.deliveryResolution) },
                        pendingCount: session.pendingCount, pendingBlockedCount: session.pendingBlockedCount,
                        pendingVersion: session.pendingVersion, badgeAttentionChanged: false, recipientCursors: [] } as const;
                }
            }

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: directTokenInput ? (content.t === "encrypted" ? "user" : undefined) : params.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-message",
                },
            }).messageRole;
            if (directTokenInput && messageRole !== "user") return { ok: false, error: "invalid-params" } as const;
            if (requestedAction.kind === 'reset_start' && !await readCurrentPendingResetStartTargetInTx(tx, sessionId, {
                messageRole, authorAccountId: actorUserId, inputAdmissionReceipt,
            }, actorUserId)) return { ok: false, error: 'invalid-params',
                admissionRejectionCode: 'session_input_target_update_required' } as const;
            if (requestedAction.kind === 'reset_start' && !await tx.providerAccountUsageHistory.findFirst({
                where: { accountId: actorUserId, recordId: requestedAction.reset.recordId,
                    id: requestedAction.reset.witness.id, observedAt: new Date(requestedAction.reset.witness.observedAtMs) },
                select: { id: true },
            })) return { ok: false, error: 'invalid-params' } as const;
            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            const policy = readEncryptionFeatureEnv(process.env);
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return {
                    ok: false,
                    error: "invalid-params",
                    code: resolveEncryptionWriteRejectionCode({
                        storagePolicy: policy.storagePolicy,
                        sessionEncryptionMode,
                        writeKind,
                    }),
                } as const;
            }

            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    localId: true,
                    targetExecutionRunId: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    position: true,
                    createdAt: true,
                    updatedAt: true,
                    discardedAt: true,
                    discardedReason: true,
                    authorAccountId: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                    providerAction: true,
                    replyProgress: true,
                },
            });
            if (existing) {
                const identityConflict = {
                    ok: false,
                    error: "invalid-params",
                    admissionRejectionCode: "session_input_idempotency_conflict",
                } as const;
                if (existing.targetExecutionRunId !== targetExecutionRunId) {
                    return identityConflict;
                }
                if (
                    deliveryMode === "external_handoff"
                    && (
                        existing.status !== "queued"
                        || existing.deliveryState !== "external_handoff"
                    )
                ) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                if (!isDeepStrictEqual(normalizePendingRequestedActionV1(existing.requestedAction, 'stored'), requestedAction)) {
                    return identityConflict;
                }
                const existingReceipt = existing.inputAdmissionReceipt == null
                    ? null
                    : createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(existing.inputAdmissionReceipt);
                const matchedAccountAdmissionIssuer = admission.kind === "account"
                    && (existing.authorAccountId === null || existing.authorAccountId === actorUserId)
                    && (existingReceipt === null
                        ? existing.authorAccountId === actorUserId
                        : existingReceipt.success
                            && existingReceipt.data.issuer === "authenticatedAccount"
                            && existingReceipt.data.actorAccountId === actorUserId
                            && isSameSessionInputAdmissionIssuer(existingReceipt.data, inputAdmissionReceipt));
                if (
                    admission.kind === "account"
                        ? !matchedAccountAdmissionIssuer
                        : existing.authorAccountId !== null
                            || existingReceipt === null
                            || !existingReceipt.success
                            || !isSameSessionInputAdmissionIssuer(existingReceipt.data, inputAdmissionReceipt)
                ) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: "session_input_idempotency_conflict",
                    } as const;
                }
                if (existing.status === 'discarded' && existing.discardedReason === 'session_input_muted'
                    && existingReceipt?.success && (existingReceipt.data.followDeliveryV1 && inputAdmissionReceipt.followDeliveryV1
                        && deriveSessionFollowOriginalOccurrenceKeyV1(existingReceipt.data.followDeliveryV1.original)
                            === deriveSessionFollowOriginalOccurrenceKeyV1(inputAdmissionReceipt.followDeliveryV1.original)
                        || suppressedDiscussionReplay)) {
                    return { ok: false, error: 'invalid-params', admissionRejectionCode: 'session_input_muted' } as const;
                }
                const retainedFollow = existingReceipt?.success && existingReceipt.data.issuer === 'authenticatedAccount'
                    ? existingReceipt.data.followDeliveryV1 : undefined;
                const currentFollow = inputAdmissionReceipt.issuer === 'authenticatedAccount'
                    ? inputAdmissionReceipt.followDeliveryV1 : undefined;
                let frozenAccountFollowReplay = false;
                if (existingReceipt?.success && retainedFollow && currentFollow) {
                    const retainedKey = deriveSessionFollowOriginalOccurrenceKeyV1(retainedFollow.original);
                    const currentKey = deriveSessionFollowOriginalOccurrenceKeyV1(currentFollow.original);
                    const sameEvent = 'event' in retainedFollow && 'event' in currentFollow
                        ? isDeepStrictEqual(retainedFollow.event, currentFollow.event)
                        : 'requestEvents' in retainedFollow && 'requestEvents' in currentFollow
                            && isDeepStrictEqual(retainedFollow.requestEvents, currentFollow.requestEvents);
                    if (!retainedKey || retainedKey !== currentKey || !sameEvent) return identityConflict;
                    frozenAccountFollowReplay = existing.status === 'queued'
                        && (existing.messageRole === null || existing.messageRole === messageRole)
                        && existing.content.t === content.t
                        && isDeepStrictEqual(existingReceipt.data, inputAdmissionReceipt)
                        && await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { id: true } }) !== null;
                    // A complete, freshly admitted fanout can change while its
                    // ordinary original is still an editable draft. Replace
                    // that draft atomically, including reasons-only changes;
                    // never treat changed sealed bytes as generic equality.
                    const changed = !isDeepStrictEqual(existingReceipt.data, inputAdmissionReceipt)
                        || !isDeepStrictEqual(existing.content, content);
                    if (!frozenAccountFollowReplay && changed) {
                        if (admission.kind !== 'account' || requestedAction.kind !== 'enqueue' || targetExecutionRunId !== null
                            || params.reply !== undefined || existing.replyProgress !== null || existing.status !== 'queued'
                            || existing.providerAction !== null || isOrdinaryPendingMutationFenced(existing)
                            || await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { id: true } })) {
                            return identityConflict;
                        }
                        const pending = await tx.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId, localId } },
                            data: { content, messageRole, inputAdmissionReceipt,
                                requestEqualityEvidenceV1: requestEqualityEvidenceV1 ?? derivePlainRequestEqualityEvidence({ content, requestedAction })
                                    ?? getActivePrismaRuntime().DbNull },
                        });
                        const state = await applyPendingSessionStateChange({ tx, sessionId });
                        return { ok: true, didWrite: true, pending: (await projectPendingMessageRows(tx, [pending]))[0]!, ...state } as const;
                    }
                }
                const existingPlainEqualityEvidence = existing.requestEqualityEvidenceV1 == null
                    ? derivePlainRequestEqualityEvidence({
                        content: existing.content as PrismaJson.SessionMessageContent,
                        requestedAction: normalizePendingRequestedActionV1(existing.requestedAction, 'stored'),
                    })
                    : undefined;
                const existingEqualityEvidence = existing.requestEqualityEvidenceV1 == null
                    ? existingPlainEqualityEvidence === undefined ? null : { success: true as const, data: existingPlainEqualityEvidence }
                    : createStoredReadSchema(SessionInputRequestEqualityEvidenceV1Schema).safeParse(existing.requestEqualityEvidenceV1);
                if (existingEqualityEvidence !== null && !existingEqualityEvidence.success) {
                    return { ok: false, error: "invalid-params" } as const;
                }
                const expectedPlainEqualityEvidence = derivePlainRequestEqualityEvidence({
                    content,
                    requestedAction,
                });
                const matchedPlainEquality = expectedPlainEqualityEvidence !== undefined
                    && existingEqualityEvidence !== null
                    && isDeepStrictEqual(existingEqualityEvidence.data, expectedPlainEqualityEvidence);
                const matchedOpaqueEquality = requestEqualityEvidenceV1?.kind === "e2eeTag"
                    && existingEqualityEvidence !== null
                    && isDeepStrictEqual(existingEqualityEvidence.data, requestEqualityEvidenceV1);
                // Account Follow content is derived from the source original;
                // re-encryption need not reproduce its ciphertext. Without a
                // supplied tag, exact original/event/receipt identity above
                // permits only a no-op rejoin of frozen custody. Plaintext and
                // tagged retries must still match their retained evidence.
                const matchedFrozenAccountFollowIdentity = frozenAccountFollowReplay
                    && content.t === "encrypted" && requestEqualityEvidenceV1 === undefined;
                const matchedAccountRetryAfterHostEquality = requestEqualityEvidenceV1 === undefined
                    && isAuthenticatedAccountRetryOfHostVerifiedEncryptedBytes({
                        admission,
                        actorUserId,
                        authorAccountId: existing.authorAccountId,
                        inputAdmissionReceipt: existing.inputAdmissionReceipt,
                        requestEqualityEvidenceV1: existing.requestEqualityEvidenceV1,
                        existingContent: existing.content as PrismaJson.SessionMessageContent,
                        candidateContent: content,
                    });
                if (
                    requestEqualityEvidenceV1 !== undefined && !matchedOpaqueEquality
                    || requestEqualityEvidenceV1 === undefined
                        && existingEqualityEvidence !== null
                        && !matchedPlainEquality
                        && !matchedAccountRetryAfterHostEquality
                        && !matchedFrozenAccountFollowIdentity
                    || !matchedPlainEquality && !matchedOpaqueEquality && !matchedFrozenAccountFollowIdentity
                        && !isDeepStrictEqual(existing.content, content)
                    || existing.messageRole !== null && existing.messageRole !== messageRole
                ) {
                    return identityConflict;
                }
                if (existing.status === "discarded") {
                    const rejection = SessionInputAdmissionRejectionCodeV1Schema.safeParse(existing.discardedReason);
                    if (!rejection.success) return { ok: false, error: "invalid-params" } as const;
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: rejection.data,
                    } as const;
                }
                let pending: PendingMessageRowRaw = existing;
                if (
                    !frozenAccountFollowReplay
                    && existing.messageRole === null
                    && messageRole !== null
                    && (matchedOpaqueEquality || isDeepStrictEqual(existing.content, content))
                ) {
                    pending = await tx.sessionPendingMessage.update({
                        where: { sessionId_localId: { sessionId, localId } },
                        data: { messageRole },
                        select: {
                            localId: true,
                            targetExecutionRunId: true,
                            messageRole: true,
                            content: true,
                            requestedAction: true,
                            replyProgress: true,
                            status: true,
                            deliveryState: true,
                            deliveryBlockedReason: true,
                            position: true,
                            createdAt: true,
                            updatedAt: true,
                            discardedAt: true,
                            discardedReason: true,
                            authorAccountId: true,
                            inputAdmissionReceipt: true,
                            requestEqualityEvidenceV1: true,
                        },
                    });
                }
                return {
                    ok: true,
                    didWrite: false,
                    pending: (await projectPendingMessageRows(tx, [pending]))[0]!,
                    pendingCount: session.pendingCount ?? 0,
                    pendingBlockedCount: session.pendingBlockedCount ?? 0,
                    pendingVersion: session.pendingVersion ?? 0,
                    badgeAttentionChanged: false,
                    recipientCursors: [],
                };
            }

            const terminalTranscript = await tx.sessionMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    sidechainId: true,
                    targetExecutionRunId: true,
                    content: true,
                    messageRole: true,
                    deliveryResolution: true,
                    inputAdmissionReceipt: true,
                    authorAccountId: true,
                    requestEqualityEvidenceV1: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });
            if (terminalTranscript) {
                const identityConflict = {
                    ok: false,
                    error: "invalid-params",
                    ...(targetExecutionRunId !== null
                        || terminalTranscript.targetExecutionRunId !== null
                        || terminalTranscript.sidechainId !== null
                        ? { admissionRejectionCode: "session_input_idempotency_conflict" as const }
                        : {}),
                } as const;
                if (terminalTranscript.targetExecutionRunId !== targetExecutionRunId) {
                    return identityConflict;
                }
                const terminalReceipt = terminalTranscript.inputAdmissionReceipt == null
                    ? null
                    : createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(terminalTranscript.inputAdmissionReceipt);
                const terminalAuthorAccountId = deriveSessionMessageAuthorAccountIdV1({
                    messageRole: terminalTranscript.messageRole,
                    inputAdmissionReceipt: terminalTranscript.inputAdmissionReceipt,
                }, 'stored');
                if (
                    terminalTranscript.authorAccountId != null
                    && terminalTranscript.authorAccountId !== terminalAuthorAccountId
                ) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: "session_input_idempotency_conflict",
                    } as const;
                }
                if (
                    terminalReceipt !== null
                    && (!terminalReceipt.success || !isSameSessionInputAdmissionIssuer(terminalReceipt.data, inputAdmissionReceipt))
                    || admission.kind === "machine" && terminalReceipt === null
                ) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        admissionRejectionCode: "session_input_idempotency_conflict",
                    } as const;
                }
                const expectedPlainEqualityEvidence = derivePlainRequestEqualityEvidence({
                    content,
                    requestedAction,
                });
                const terminalEqualityEvidence = terminalTranscript.requestEqualityEvidenceV1 == null
                    ? null
                    : createStoredReadSchema(SessionInputRequestEqualityEvidenceV1Schema).safeParse(terminalTranscript.requestEqualityEvidenceV1);
                if (terminalEqualityEvidence !== null && !terminalEqualityEvidence.success) {
                    return identityConflict;
                }
                const matchedTerminalPlainEquality = expectedPlainEqualityEvidence !== undefined
                    && terminalEqualityEvidence !== null
                    && isDeepStrictEqual(terminalEqualityEvidence.data, expectedPlainEqualityEvidence);
                const matchedTerminalOpaqueEquality = requestEqualityEvidenceV1?.kind === "e2eeTag"
                    && terminalEqualityEvidence !== null
                    && isDeepStrictEqual(terminalEqualityEvidence.data, requestEqualityEvidenceV1);
                const matchedTerminalAccountRetryAfterHostEquality = requestEqualityEvidenceV1 === undefined
                    && isAuthenticatedAccountRetryOfHostVerifiedEncryptedBytes({
                        admission,
                        actorUserId,
                        authorAccountId: terminalTranscript.authorAccountId,
                        inputAdmissionReceipt: terminalTranscript.inputAdmissionReceipt,
                        requestEqualityEvidenceV1: terminalTranscript.requestEqualityEvidenceV1,
                        existingContent: terminalTranscript.content as PrismaJson.SessionMessageContent,
                        candidateContent: content,
                    });
                if (
                    expectedPlainEqualityEvidence !== undefined
                    && terminalEqualityEvidence !== null
                    && !matchedTerminalPlainEquality
                    || requestEqualityEvidenceV1 !== undefined && !matchedTerminalOpaqueEquality
                    || requestEqualityEvidenceV1 === undefined
                        && terminalEqualityEvidence !== null
                        && !matchedTerminalPlainEquality
                        && !matchedTerminalAccountRetryAfterHostEquality
                ) {
                    return identityConflict;
                }
                let existingMessageRole: SessionMessageRole | null;
                if (matchedTerminalPlainEquality || matchedTerminalOpaqueEquality) {
                    existingMessageRole = parseSessionMessageRole(terminalTranscript.messageRole);
                } else {
                    const compatibility = compareSessionMessageContentAndRole({
                        existing: terminalTranscript,
                        candidate: { content, messageRole },
                    });
                    if (compatibility.kind !== "match") {
                        return identityConflict;
                    }
                    existingMessageRole = compatibility.existingMessageRole;
                }
                return {
                    ok: true,
                    terminal: true,
                    didWrite: false,
                    message: {
                        id: terminalTranscript.id,
                        seq: terminalTranscript.seq,
                        localId: terminalTranscript.localId ?? localId,
                        sidechainId: terminalTranscript.sidechainId,
                        inputAdmissionReceipt: terminalReceipt?.success ? terminalReceipt.data : null,
                        authorAccountId: terminalTranscript.authorAccountId,
                        messageRole: existingMessageRole,
                        content: terminalTranscript.content as PrismaJson.SessionMessageContent,
                        requestedAction,
                        deliveryResolution: readStoredSessionMessageDeliveryResolutionV1(terminalTranscript.deliveryResolution),
                        createdAt: terminalTranscript.createdAt,
                        updatedAt: terminalTranscript.updatedAt,
                    },
                    pendingCount: session.pendingCount ?? 0,
                    pendingBlockedCount: session.pendingBlockedCount ?? 0,
                    pendingVersion: session.pendingVersion ?? 0,
                    badgeAttentionChanged: false,
                    recipientCursors: [],
                } as const;
            }

            const position = await reserveNextPendingQueuePosition(tx, sessionId);
            if (suppressedFollow) {
                await retainSuppressedSessionFollowInputInTx(tx, { ...suppressedFollow,
                    destinationSessionId: sessionId, localId, content, requestedAction, receipt: inputAdmissionReceipt, position });
                return { ok: false, error: 'invalid-params', admissionRejectionCode: 'session_input_muted' } as const;
            }

            if (admissionMode === "continuation_if_no_queued_user_input") {
                const queuedUserInput = await tx.sessionPendingMessage.findFirst({
                    where: { sessionId, targetExecutionRunId: null, status: "queued", messageRole: "user" },
                    select: { localId: true },
                });
                if (queuedUserInput) {
                    return {
                        ok: true,
                        suppressed: true,
                        didWrite: false,
                        pendingCount: session.pendingCount ?? 0,
                        pendingBlockedCount: session.pendingBlockedCount ?? 0,
                        pendingVersion: session.pendingVersion ?? 0,
                        badgeAttentionChanged: false,
                        recipientCursors: [],
                    } as const;
                }
            }

            const reply = params.reply === undefined ? undefined : SessionMessageReplyAdmissionV1Schema.safeParse(params.reply);
            if (reply !== undefined && (!reply.success || admission.kind === 'machine' && reply.data.humanOrigin !== undefined
                || admission.kind === 'account' && (reply.data.mode !== 'wait' && reply.data.humanOrigin === undefined
                    || reply.data.sourceSession !== undefined || reply.data.discussion !== undefined || reply.data.workflow !== undefined || reply.data.actionRequestAttributionV1 !== undefined
                    || reply.data.humanOrigin !== undefined && admission.authentication.authority !== 'present_user'))) return { ok: false, error: 'invalid-params' } as const;
            if (reply?.success && reply.data.discussion?.participantSessionId !== undefined
                && reply.data.discussion.participantSessionId !== sessionId) return { ok: false, error: 'invalid-params' } as const;
            const foreignDiscussionHold = admission.kind === 'machine' && reply?.success
                && await isForeignDiscussionCauseHeldInTx(tx, { accountId: actorUserId, reply: reply.data });
            if ((admission.kind === 'machine' || reply?.success && reply.data.humanOrigin) && content.t === 'plain') {
                const protectedRequest = readSessionInputRequest(readPlainMessageMeta(content));
                if (reply?.success && reply.data.humanOrigin && (!protectedRequest
                    || requiresAuthenticatedMachineAdmissionForSessionInput(protectedRequest))) return { ok: false, error: 'invalid-params' } as const;
                const protectedReply = protectedRequest?.replyIntent
                    ? { mode: protectedRequest.replyIntent.mode, ...(protectedRequest.sourceSession ? { sourceSession: protectedRequest.sourceSession } : {}),
                        ...(protectedRequest.replyIntent.humanOrigin ? { humanOrigin: protectedRequest.replyIntent.humanOrigin } : {}),
                        ...(protectedRequest.discussionAddressing ? { discussion: protectedRequest.discussionAddressing } : {}),
                        ...(protectedRequest.v === 2 && protectedRequest.discussionAddressing ? { workflow: protectedRequest.workflow } : {}),
                        ...(protectedRequest.actionRequestAttributionV1 ? { actionRequestAttributionV1: protectedRequest.actionRequestAttributionV1 } : {}) } : undefined;
                // A proven foreign original may enter blocked custody before
                // private source hydration. It carries no executable authority.
                const custodyOnly = foreignDiscussionHold && readPlainMessageMeta(content) === null;
                if (!custodyOnly && !isDeepStrictEqual(protectedReply, reply?.success ? reply.data : undefined)) return { ok: false, error: 'invalid-params' } as const;
            }
            const replyProgress = reply?.success ? await createSessionInputReplyProgressInTx(tx, { accountId: actorUserId, reply: reply.data, requestSessionId: sessionId,
                ...(admission.kind === 'account' ? { authentication: admission.authentication } : {}) }) : null;
            if (reply?.success && !replyProgress) return { ok: false, error: 'invalid-params' } as const;
            if (replyProgress?.workflow && localId !== deriveWorkflowSessionInputLocalIdV2(replyProgress.workflow)) return { ok: false, error: 'invalid-params' } as const;
            if (replyProgress?.discussion && !replyProgress.workflow && (localId !== deriveDiscussionFollowInputLocalIdV1(replyProgress.discussion)
                || !await admitDiscussionFollowAddressingInTx(tx, { accountId: actorUserId, discussion: replyProgress.discussion }))) {
                return { ok: false, error: 'invalid-params' } as const;
            }
            if (replyProgress?.discussion && inputAdmissionReceipt.issuer === 'authenticatedMachine') {
                inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.parse({ ...inputAdmissionReceipt,
                    discussionAddressing: replyProgress.discussion });
            }
            const replyTargetMachineId = admission.kind === 'machine' ? admission.targetMachineId
                : replyProgress?.humanOrigin ? inputAdmissionReceipt.admittedTarget?.machineId : undefined;
            if (replyProgress?.humanOrigin && !replyTargetMachineId) return { ok: false, error: 'invalid-params',
                admissionRejectionCode: 'session_input_target_unavailable' } as const;
            if (replyProgress && replyTargetMachineId) {
                const machine = await tx.machine.findUnique({ where: { id: replyTargetMachineId },
                    select: { operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true } });
                if (!machine?.operationProtocolCapabilitiesRevision || !supportsMachineOperationProtocolCapabilityV1(machine.operationProtocolCapabilities, 'sessionMessageReply')) {
                    return { ok: false, error: 'invalid-params', admissionRejectionCode: 'session_input_target_update_required' } as const;
                }
            }
            if (replyProgress?.discussion && !replyProgress.workflow) {
                const muted = await readSessionFollowInputSuppressionInTx(tx, {
                    accountId: session.accountId, destinationSessionId: sessionId, receipt: inputAdmissionReceipt,
                });
                if (muted === null) return { ok: false, error: 'invalid-params', admissionRejectionCode: 'session_input_target_unavailable' } as const;
                if (muted) {
                    await retainSuppressedFollowInputInTx(tx, { destinationSessionId: sessionId, localId,
                        content, requestedAction, receipt: inputAdmissionReceipt, position });
                    // Keep per-original rejected custody without moving the
                    // accepted frontier past any earlier unresolved question.
                    return { ok: false, error: 'invalid-params', admissionRejectionCode: 'session_input_muted' } as const;
                }
            }
            const created = await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId,
                    targetExecutionRunId,
                    messageRole,
                    content,
                    requestedAction,
                    ...(replyProgress ? { replyProgress, replyDisposition: replyProgress.disposition,
                        replySourceSessionId: replyProgress.humanOrigin?.sessionId ?? replyProgress.sourceSession?.sourceSessionId,
                        replySourceTurnId: replyProgress.sourceSession?.sourceTurnId,
                        replyTargetMachineId: replyTargetMachineId ?? null } : {}),
                    status: "queued",
                    deliveryState: foreignDiscussionHold ? 'blocked' : deliveryMode === "external_handoff" ? "external_handoff" : undefined,
                    ...(foreignDiscussionHold ? { deliveryBlockedReason: 'session_input_target_unavailable' } : {}),
                    position,
                    authorAccountId: deriveSessionMessageAuthorAccountIdV1({ messageRole, inputAdmissionReceipt }),
                    inputAdmissionReceipt,
                    ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
                },
                select: {
                    localId: true,
                    targetExecutionRunId: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    replyProgress: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    position: true,
                    createdAt: true,
                    updatedAt: true,
                    discardedAt: true,
                    discardedReason: true,
                    authorAccountId: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });

            if (replyProgress?.discussion && !replyProgress.workflow) await acknowledgeDiscussionFollowInputInTx(tx, {
                addressing: replyProgress.discussion, localInputId: localId,
            });
            if (foreignDiscussionHold && replyProgress?.discussion) await markDiscussionReadersChangedInTx({ tx, discussionId: replyProgress.discussion.discussionId });
            const activationTarget = targetExecutionRunId === null && !foreignDiscussionHold ? await armPendingActivationAuthorizationInTx({
                tx,
                sessionId,
                requestId: localId,
                currentAccess: access.access,
                ...(params.resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
            }) : undefined;
            const { pendingCount, pendingBlockedCount, pendingVersion, recipientCursors, badgeAttentionChanged, meaningfulActivityAt } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null ? 1 : 0,
                ...(foreignDiscussionHold ? { pendingBlockedCountDelta: 1 } : {}),
                meaningfulActivityAt: created.createdAt,
                activationTarget,
            });

            return {
                ok: true,
                didWrite: true,
                pending: (await projectPendingMessageRows(tx, [created]))[0]!,
                pendingCount,
                pendingBlockedCount,
                pendingVersion,
                badgeAttentionChanged,
                recipientCursors,
                meaningfulActivityAt,
                ...(activationTarget ? { activationTarget } : {}),
            };
        }), admission.kind === "machine"
            ? admission.targetMachineId
            : params.targetMachineId,
        replyDiscussionId ? async tx => [...await resolveDiscussionAudienceInTx(tx, replyDiscussionId)].sort() : undefined);
    } catch (error) {
        // inTx owns recovery. Exhausted replay-safe conflicts prove rollback,
        // unlike an indeterminate commit response, and share its typed refusal.
        const acquisitionUnavailable = isTransactionAcquisitionUnavailableError(error);
        if (acquisitionUnavailable || isTransactionConflictExhaustedError(error)) {
            reportPendingOperationError({
                operation: "enqueue",
                sessionId,
                localId,
                diagnosticCorrelationId: params.diagnosticCorrelationId,
                ...(acquisitionUnavailable ? { prismaCode: "P2028" } : {}),
                error,
            }, acquisitionUnavailable
                ? "pending delivery transaction acquisition failed"
                : "pending delivery transaction temporarily unavailable");
            return {
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: 1_000,
                ...(params.diagnosticCorrelationId ? { correlationId: params.diagnosticCorrelationId } : {}),
            };
        }
        reportPendingOperationError({
            operation: "enqueue",
            sessionId,
            localId,
            diagnosticCorrelationId: params.diagnosticCorrelationId,
            error,
        }, "pending delivery operation failed");
        return { ok: false, error: "internal" };
    }
}

/**
 * Existing authenticated Machine socket admission. Source/target Machine ids
 * are revalidated transactionally; only the admitted exact target is retained in the receipt.
 */
export async function enqueuePendingMessageByAuthenticatedMachine(params: Readonly<{
    nextTurnNote?: SessionInputAdmissionReceiptV1['nextTurnNote'];
    followSourceApp?: Pick<Fastify, 'forwardRpcForUser'>;
    sourceAuthentication?: SessionAccessAuthentication;
    reply?: SessionMessageReplyAdmissionV1;
    accountId: string;
    sourceMachineId: string;
    targetMachineId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    content: PrismaJson.SessionPendingMessageContent;
    requestedAction: PendingRequestedActionV1;
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
    /** Server-verified immutable invocation constraints; never read from encrypted content. */
    callerInputConstraints?: CallerInputConstraintsV1;
    followSources?: SessionPendingEnqueueByMachineRequestV1['followSources'];
    followRelations?: SessionPendingEnqueueByMachineRequestV1['followRelations'];
    followDeliveryV1?: SessionPendingEnqueueByMachineRequestV1['followDeliveryV1'];
}>): Promise<SessionInputAdmissionResultV1> {
    let executionRunFrontier: ExecutionRunFollowFrontierWitness | undefined;
    const original = params.followDeliveryV1?.original;
    if (original && isRunFollowOriginalV1(original) && original.source.kind === 'execution_run') {
        if (!params.followSourceApp) return { status: 'rejected', code: 'session_input_target_unavailable' };
        const read = await readCurrentExecutionRunFollowSource({ app: params.followSourceApp, accountId: params.accountId,
            ...original.source,
            authentication: params.sourceAuthentication ?? backgroundDeliveryAuthentication() });
        if (!read.ok || 'terminalEventId' in original && read.value.terminalEventId !== original.terminalEventId)
            return { status: 'rejected', code: 'session_input_target_unavailable' };
        executionRunFrontier = read.value;
    }
    const inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.parse({
        ...buildSessionInputAdmissionReceipt({ issuer: "authenticatedMachine", callerInputConstraints: params.callerInputConstraints,
            ...(params.nextTurnNote ? { nextTurnNote: params.nextTurnNote } : {}) }),
        ...(params.followSources ? { followSources: params.followSources } : {}),
        ...(params.followRelations ? { followRelations: params.followRelations } : {}),
        ...(params.followDeliveryV1 ? { followDeliveryV1: params.followDeliveryV1 } : {}),
    });
    if (inputAdmissionReceipt.issuer !== "authenticatedMachine") {
        throw new Error("Machine admission receipt parsed to the wrong issuer arm");
    }
    const result = await enqueuePendingMessageWithAdmission({
        ...(params.nextTurnNote ? { nextTurnNote: params.nextTurnNote } : {}),
        ...(executionRunFrontier ? { executionRunFrontier } : {}),
        ...(params.reply ? { reply: params.reply } : {}),
        actorUserId: params.accountId,
        sessionId: params.sessionId,
        targetExecutionRunId: params.targetExecutionRunId,
        localId: params.localId,
        messageRole: "user",
        content: params.content,
        requestedAction: params.requestedAction,
        ...(params.requestEqualityEvidenceV1
            ? { requestEqualityEvidenceV1: params.requestEqualityEvidenceV1 }
            : {}),
    }, {
        kind: "machine",
        sourceMachineId: params.sourceMachineId,
        targetMachineId: params.targetMachineId,
        inputAdmissionReceipt,
    });

    if (result.ok) {
        if (result.didWrite) {
            await emitPendingChanged({
                sessionId: params.sessionId,
                changedByAccountId: params.accountId,
                pendingCount: result.pendingCount,
                pendingBlockedCount: result.pendingBlockedCount,
                pendingVersion: result.pendingVersion,
                meaningfulActivityAt: result.meaningfulActivityAt,
                recipientCursors: result.recipientCursors,
                ...(params.targetExecutionRunId
                    ? { recipient: { kind: "execution_run" as const, runId: params.targetExecutionRunId } }
                    : {}),
                ...(result.activationTarget ? { activationTarget: result.activationTarget } : {}),
            });
        }
        return {
            status: result.didWrite ? "accepted" : "alreadyAccepted",
            localId: result.terminal && result.acceptedFollowInputLocalId ? result.acceptedFollowInputLocalId : params.localId,
        };
    }
    if (result.error === "transaction-unavailable" || result.admissionRejectionCode === "session_input_storage_unavailable") {
        return { status: "rejected", code: "session_input_storage_unavailable" };
    }
    if (result.error === "internal") {
        return {
            status: "outcomeUnknown",
            localId: params.localId,
            code: "session_input_admission_outcome_unknown",
        };
    }
    return {
        status: "rejected",
        code: result.admissionRejectionCode
            ?? (result.code
                ? "session_input_encryption_mode_mismatch"
                : result.error === "forbidden"
                    ? "session_input_unauthorized"
                    : result.error === "session-not-found"
                        ? "session_input_target_unavailable"
                        : "session_input_invalid"),
    };
}

export type SettlePendingInputAdmissionResult =
    | Readonly<{
        ok: true;
        result: SessionInputAdmissionResultV1;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursorsPending: RecipientCursor[];
        recipientCursorsMessage: RecipientCursor[];
        badgeAttentionChanged: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }>
    | Readonly<{
        ok: false;
        error: "forbidden" | "invalid-params" | "not-found" | "conflict" | "internal";
      }>;

function readPlainMessageMeta(content: SessionStoredMessageContent): Record<string, unknown> | null {
    if (content.t !== "plain" || !content.v || typeof content.v !== "object" || Array.isArray(content.v)) return null;
    const meta = (content.v as Record<string, unknown>).meta;
    return meta && typeof meta === "object" && !Array.isArray(meta)
        ? meta as Record<string, unknown>
        : null;
}

function isExactPlainRequestToAuthorityReplacement(params: Readonly<{
    requestContent: SessionStoredMessageContent;
    finalContent: SessionStoredMessageContent;
    inputAdmissionReceipt: SessionInputAdmissionReceiptV1;
}>): boolean {
    if (params.requestContent.t !== "plain" || params.finalContent.t !== "plain") return false;
    if (
        !params.requestContent.v
        || typeof params.requestContent.v !== "object"
        || Array.isArray(params.requestContent.v)
        || !params.finalContent.v
        || typeof params.finalContent.v !== "object"
        || Array.isArray(params.finalContent.v)
    ) return false;
    const requestMeta = readPlainMessageMeta(params.requestContent);
    const finalMeta = readPlainMessageMeta(params.finalContent);
    const request = readSessionInputRequest(requestMeta, 'stored');
    const authority = readSessionInputAuthority(finalMeta);
    if (!request || !authority || request.v !== authority.v) return false;
    let expectedMeta: Record<string, unknown>;
    try {
        const expectedAuthority = request.v === 1
            ? settleSessionInputRequestV1({
                request,
                currentSessionPermissionCeiling: authority.permission.admittedPermissionCeiling,
                inputAdmissionReceipt: params.inputAdmissionReceipt,
            })
            : settleSessionInputRequestV2({
                request,
                currentSessionPermissionCeiling: authority.permission.admittedPermissionCeiling,
                inputAdmissionReceipt: params.inputAdmissionReceipt,
            });
        const expectedProvenance = request.v === 1
            ? settleSessionMessageProvenanceV1({
                request,
                requestedProvenance: readSessionMessageProvenance(requestMeta, 'stored'),
                inputAdmissionReceipt: params.inputAdmissionReceipt,
            })
            : settleSessionMessageProvenanceV2({
                request,
                requestedProvenance: readSessionMessageProvenance(requestMeta, 'stored'),
                inputAdmissionReceipt: params.inputAdmissionReceipt,
            });
        expectedMeta = {
            ...withSessionInputAuthority(requestMeta ?? {}, expectedAuthority),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: expectedProvenance,
        };
    } catch {
        return false;
    }
    const expected = {
        ...(params.requestContent.v as Record<string, unknown>),
        meta: expectedMeta,
    };
    return isDeepStrictEqual(params.finalContent.v, expected);
}

/** Retry and target settlement must preserve the same original routing facts. */
function matchesOriginalReplyAdmission(progress: SessionMessageReplyProgressV1, reply: SessionMessageReplyAdmissionV1 | undefined): boolean {
    return progress.mode === reply?.mode && isDeepStrictEqual(progress.sourceSession, reply?.sourceSession)
        && isDeepStrictEqual(progress.humanOrigin, reply?.humanOrigin)
        && isDeepStrictEqual(progress.discussion, reply?.discussion)
        && isDeepStrictEqual(progress.workflow, reply?.workflow)
        && isDeepStrictEqual(progress.actionRequestAttributionV1, reply?.actionRequestAttributionV1);
}

async function validateInputSettlementDomainFactsInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    targetSessionId: string;
    targetExecutionRunId: string | null;
    localId: string;
    validation?: SessionInputSettlementValidationV1;
}>): Promise<
    | Readonly<{ ok: true; exchangeRoot?: { sessionId: string; localId: string };
        exchangeCause?: 'agent_session' | 'returned_answer';
        exchangeRootState?: ReturnType<typeof createAutonomousExchangeStateV1> }>
    | Readonly<{ ok: false; exchangeRoot?: { sessionId: string; localId: string };
        rejectionCode?: SessionInputAdmissionRejectionCodeV1;
        holdReason?: 'autonomous_check_in' | 'session_input_target_unavailable' }>
> {
    // Every provider effect rechecks the retained original, including materialized
    // inputs. Current membership after reinvitation cannot revive a withdrawn ask.
    const originalProjection = { replyProgress: true, inputAdmissionReceipt: true, turnStartWitnessId: true,
        autonomousExchangeRootSessionId: true, autonomousExchangeRootLocalId: true } as const;
    const original = await params.tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
        sessionId: params.targetSessionId, localId: params.localId,
    } }, select: originalProjection }) ?? await params.tx.sessionMessage.findUnique({ where: { sessionId_localId: {
        sessionId: params.targetSessionId, localId: params.localId,
    } }, select: originalProjection });
    const originalProgress = SessionMessageReplyProgressV1Schema.safeParse(original?.replyProgress);
    const originalReceipt = SessionInputAdmissionReceiptV1Schema.safeParse(original?.inputAdmissionReceipt);
    // An original's materialized transcript is custody, not a surviving Follow
    // route. Reuse the Follow owner even when it can no longer expose a source
    // observation to the host (detached manager, removed rule or revoked access).
    if (originalReceipt.success && originalReceipt.data.followDeliveryV1
        && 'sourceSessionId' in originalReceipt.data.followDeliveryV1.original
        && !original?.turnStartWitnessId) {
        const custody = await readAdmittedSessionFollowInputInTx(params.tx, {
            accountId: params.accountId, destinationSessionId: params.targetSessionId, localInputId: params.localId,
            authority: { kind: 'account', authentication: backgroundDeliveryAuthentication() },
        });
        // Current policy gates a future effect, not an already verified acceptance.
        if (!custody?.nativeAccepted && !custody?.effectiveDelivery) return { ok: false, rejectionCode: 'session_input_cancelled' };
    }
    if (originalProgress.success && originalProgress.data.humanOrigin) {
        if (!originalReceipt.success || originalReceipt.data.issuer !== 'authenticatedAccount') {
            return { ok: false, rejectionCode: 'session_input_unauthorized' };
        }
        // The publisher executes its own Session; the retained authenticated
        // requester supplies the rights to ask it and receive the answer.
        const requesterAccountId = originalReceipt.data.actorAccountId;
        if (!await isSessionInputReplySourceCurrentInTx(params.tx, requesterAccountId, originalProgress.data, undefined,
            { requesterAccountId, sessionId: params.targetSessionId })
            || (await resolveSessionAccessForOperation(params.tx, { accountId: requesterAccountId,
                sessionId: params.targetSessionId, authentication: backgroundDeliveryAuthentication(),
                capability: 'submitAgentInput' })).status !== 'allowed') {
            return { ok: false, rejectionCode: 'session_input_cancelled' };
        }
    }
    const addressing = originalReceipt.success && originalReceipt.data.issuer === 'authenticatedMachine'
        ? originalReceipt.data.discussionAddressing : undefined;
    let ambientDiscussionWatch = false;
    if (addressing) {
        if (!originalProgress.success || !isDeepStrictEqual(originalProgress.data.discussion, addressing)
            || originalProgress.data.disposition === 'released') return { ok: false, rejectionCode: 'session_input_cancelled' };
        if (!await isDiscussionReplyDestinationCurrentInTx(params.tx, { accountId: params.accountId, discussion: addressing, workflow: originalProgress.data.workflow })) {
            return { ok: false, rejectionCode: 'session_input_cancelled' };
        }
        if (await isForeignDiscussionCauseHeldInTx(params.tx, { accountId: params.accountId, reply: originalProgress.data })) {
            return { ok: false, holdReason: 'session_input_target_unavailable' };
        }
        const question = await params.tx.discussionMessage.findUnique({ where: { id: addressing.messageId }, select: { addressingV1: true } });
        const snapshot = createStoredReadSchema(DiscussionMessageAddressingV1Schema).safeParse(question?.addressingV1);
        ambientDiscussionWatch = snapshot.success && snapshot.data.watcherSessionIds?.includes(params.targetSessionId) === true;
        const muted = await isDeliveryMutedInTx(params.tx, { accountId: params.accountId,
            receiver: { kind: 'session', sessionId: params.targetSessionId },
            candidate: { source: { kind: 'discussion', discussionId: addressing.discussionId },
                ...(originalProgress.data.sourceSession ? { senderSessionId: originalProgress.data.sourceSession.sourceSessionId } : {}) },
        });
        if (muted !== false) return muted ? { ok: false, rejectionCode: 'session_input_muted' }
            : { ok: false, holdReason: 'session_input_target_unavailable' };
    }
    const runDelivery = originalReceipt.success && originalReceipt.data.followDeliveryV1
        && isRunFollowOriginalV1(originalReceipt.data.followDeliveryV1.original) ? originalReceipt.data.followDeliveryV1 : undefined;
    const sourceSession = runDelivery ? undefined : params.validation?.sourceSession;
    let exchangeRoot: { sessionId: string; localId: string } | undefined;
    const runWake = runDelivery?.delivery === 'wake';
    if (runWake && params.targetExecutionRunId === null) {
        exchangeRoot = original?.turnStartWitnessId && original.autonomousExchangeRootSessionId && original.autonomousExchangeRootLocalId
            ? { sessionId: original.autonomousExchangeRootSessionId, localId: original.autonomousExchangeRootLocalId }
            : await readReceiverAutonomousExchangeRootInTx(params.tx, {
                accountId: params.accountId, sessionId: params.targetSessionId, selection: 'latest_person',
            }) ?? { sessionId: params.targetSessionId, localId: params.localId };
    }
    if (ambientDiscussionWatch && !sourceSession && params.targetExecutionRunId === null) {
        // Opt-in consideration is an agent-started turn even when the original
        // was human conversation. Reuse the receiver's existing check-in root.
        exchangeRoot = await readReceiverAutonomousExchangeRootInTx(params.tx, {
            accountId: params.accountId, sessionId: params.targetSessionId,
        }) ?? { sessionId: params.targetSessionId, localId: params.localId };
    }
    if (sourceSession) {
        const source = await params.tx.session.findUnique({
            where: { id: sourceSession.sourceSessionId }, select: { accountId: true },
        });
        if (!source) return { ok: false };
        if (params.targetExecutionRunId === null && source.accountId === params.accountId) {
            const sourceTurn = await params.tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
                sessionId: sourceSession.sourceSessionId, turnId: sourceSession.sourceTurnId,
            } }, select: { id: true } });
            if (!sourceTurn) return { ok: false };
        }
        const muted = await isDeliveryMutedInTx(params.tx, { accountId: params.accountId,
            receiver: { kind: 'session', sessionId: params.targetSessionId },
            candidate: { senderSessionId: sourceSession.sourceSessionId,
                source: { kind: 'session', sessionId: sourceSession.sourceSessionId } },
        });
        if (muted !== false) return { ok: false, rejectionCode: muted ? 'session_input_muted' : 'session_input_target_unavailable' };
        // Foreign causes use only the receiving side's existing facts. In
        // particular a private source Run need not manufacture a SessionTurn.
        // Exact Run targets have their own lifecycle and no Session allowance.
        if (params.targetExecutionRunId === null && source.accountId !== params.accountId) {
            exchangeRoot = await readReceiverAutonomousExchangeRootInTx(params.tx, {
                accountId: params.accountId, sessionId: params.targetSessionId,
            }) ?? { sessionId: params.targetSessionId, localId: params.localId };
        } else if (params.targetExecutionRunId === null) {
            const sourceInputs = sourceSession.sourceInputId
                ? await params.tx.sessionMessage.findMany({
                    where: { sessionId: sourceSession.sourceSessionId,
                        localId: sourceSession.sourceInputId },
                    select: {
                        localId: true,
                        acceptedTurnId: true,
                        targetExecutionRunId: true,
                        inputAdmissionReceipt: true,
                        autonomousExchangeRootSessionId: true,
                        autonomousExchangeRootLocalId: true,
                    },
                })
                : await params.tx.sessionMessage.findMany({
                    where: { sessionId: sourceSession.sourceSessionId,
                        acceptedTurnId: sourceSession.sourceTurnId },
                    select: {
                        localId: true,
                        acceptedTurnId: true,
                        targetExecutionRunId: true,
                        inputAdmissionReceipt: true,
                        autonomousExchangeRootSessionId: true,
                        autonomousExchangeRootLocalId: true,
                    },
                });
            const resolved = await readAutonomousExchangeSourceRoot({
                tx: params.tx,
                sourceSessionId: sourceSession.sourceSessionId,
                actorAccountId: params.accountId,
                expectedTurnId: sourceSession.sourceTurnId,
                sourceInputs,
            });
            if (resolved.status !== 'found') return resolved.status === 'invalid'
                ? { ok: false, rejectionCode: 'session_input_invalid' }
                : { ok: false, holdReason: 'session_input_target_unavailable' };
            exchangeRoot = resolved.root;
        }
    }
    const returnedAnswer = runDelivery ? undefined : params.validation?.returnedAnswer;
    if (returnedAnswer && !sourceSession) {
        // The original reply owner already holds the protected request and
        // destination. A caller's return annotation alone cannot create a root.
        const [originalPending, originalMessage] = await Promise.all([params.tx.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: returnedAnswer.requestSessionId,
                localId: returnedAnswer.requestLocalId } },
            select: { replyProgress: true, autonomousExchangeRootSessionId: true,
                autonomousExchangeRootLocalId: true },
        }), params.tx.sessionMessage.findUnique({
            where: { sessionId_localId: { sessionId: returnedAnswer.requestSessionId,
                localId: returnedAnswer.requestLocalId } },
            select: { replyProgress: true, localId: true, acceptedTurnId: true, targetExecutionRunId: true, inputAdmissionReceipt: true,
                autonomousExchangeRootSessionId: true,
                autonomousExchangeRootLocalId: true },
        })]);
        const original = originalPending ?? originalMessage;
        const progress = original?.replyProgress == null ? null
            : createStoredReadSchema(SessionMessageReplyProgressV1Schema).safeParse(original.replyProgress);
        if (original && progress?.success && progress.data.mode === 'return'
            && (progress.data.humanOrigin?.sessionId ?? progress.data.sourceSession?.sourceSessionId) === params.targetSessionId
            && progress.data.outcome?.kind === returnedAnswer.outcome
            && ['return_pending', 'returned'].includes(progress.data.disposition)
            && returnedAnswer.senderSessionId === returnedAnswer.requestSessionId
            && params.localId === deriveSessionMessageReplyReturnLocalIdV1({
                sessionId: returnedAnswer.requestSessionId,
                localId: returnedAnswer.requestLocalId,
                acceptedTurnId: progress.data.acceptedTurnId,
            })) {
            if (progress.data.humanOrigin && (await readSessionMessageReplyInTx(params.tx, { accountId: params.accountId,
                sessionId: returnedAnswer.requestSessionId, localId: returnedAnswer.requestLocalId,
                authentication: backgroundDeliveryAuthentication() })).status !== 'available') {
                return { ok: false, rejectionCode: 'session_input_cancelled' };
            }
            if (originalMessage && progress.data.acceptedTurnId) {
                // Pending keeps reply custody; the materialized input witnesses
                // acceptance and the shared owner derives inherited or human roots.
                const resolved = await readAutonomousExchangeSourceRoot({ tx: params.tx, sourceSessionId: returnedAnswer.requestSessionId,
                    actorAccountId: params.accountId, expectedTurnId: progress.data.acceptedTurnId,
                    sourceInputs: [{ ...originalMessage,
                        autonomousExchangeRootSessionId: original.autonomousExchangeRootSessionId,
                        autonomousExchangeRootLocalId: original.autonomousExchangeRootLocalId }] });
                if (resolved.status === 'invalid') return { ok: false };
                const rootOwner = resolved.status === 'found' ? await params.tx.session.findUnique({ where: { id: resolved.root.sessionId },
                    select: { accountId: true } }) : null;
                // A returned answer carries the original human cause across
                // Accounts without counting or acquiring control of that root.
                if (resolved.status === 'found' && (rootOwner?.accountId === params.accountId || progress.data.humanOrigin)) {
                    exchangeRoot = resolved.root;
                }
            }
        }
    }
    const automation = runDelivery ? undefined : params.validation?.automation;
    if (automation) {
        const run = await params.tx.automationRun.findUnique({
            where: { id: automation.runId },
            select: { accountId: true, automationId: true, state: true },
        });
        if (
            !run
            || run.accountId !== params.accountId
            || run.automationId !== automation.automationId
        ) return { ok: false };
        if (run.state === "cancelled") {
            return { ok: false, rejectionCode: "session_input_cancelled" };
        }
    }
    let exchangeRootState: ReturnType<typeof createAutonomousExchangeStateV1> | undefined;
    if (exchangeRoot && !returnedAnswer) {
        const choice = params.validation?.autonomousCheckIn;
        if (!choice) return { ok: false, holdReason: 'session_input_target_unavailable', exchangeRoot };
        const root = await params.tx.sessionMessage.findUnique({
            where: { sessionId_localId: { sessionId: exchangeRoot.sessionId,
                localId: exchangeRoot.localId } },
            select: { id: true, rowRevision: true, inputAdmissionReceipt: true,
                autonomousExchangeState: true, session: { select: { accountId: true } } },
        });
        // With no local input yet, the protected incoming input itself becomes
        // the receiving Account's root when this admission materializes it.
        if (!root && exchangeRoot.sessionId === params.targetSessionId && exchangeRoot.localId === params.localId
            && originalReceipt.success && isAutonomousExchangeRootReceiptForAccount(
                originalReceipt.data, params.accountId, params.targetSessionId)) {
            exchangeRootState = createAutonomousExchangeStateV1(choice.afterTurns);
        } else if (!root || root.session.accountId !== params.accountId
            || !isAutonomousExchangeRootReceiptForAccount(root.inputAdmissionReceipt, params.accountId, exchangeRoot.sessionId)) {
            return { ok: false, holdReason: 'session_input_target_unavailable', exchangeRoot };
        } else {
            const state = createStoredReadSchema(AutonomousExchangeStateV1Schema).safeParse(root.autonomousExchangeState);
            // An admitted local input may predate an available Account choice.
            // Initialize only this Account's existing root once it is available.
            if (!state.success && root.autonomousExchangeState !== null) return { ok: false };
            if (state.success && state.data.stopped) return { ok: false, rejectionCode: 'session_input_cancelled' };
            const current = state.success
                ? state.data.afterTurns === choice.afterTurns ? state.data
                    : { ...state.data, afterTurns: choice.afterTurns }
                : createAutonomousExchangeStateV1(choice.afterTurns);
            if (!state.success || current !== state.data) {
                const updated = await params.tx.sessionMessage.updateMany({
                    where: { id: root.id, rowRevision: root.rowRevision },
                    data: { autonomousExchangeState: current, rowRevision: { increment: BigInt(1) } },
                });
                if (updated.count !== 1) throw new TransactionReplayRequiredError('autonomous-exchange-root-changed');
            }
            const exchangeAdmission = readAutonomousExchangeAdmissionV1(current);
            if (exchangeAdmission === 'stopped') {
                return { ok: false, rejectionCode: 'session_input_cancelled' };
            }
            if (exchangeAdmission === 'check_in') {
                return { ok: false, holdReason: 'autonomous_check_in', exchangeRoot };
            }
        }
    }
    return { ok: true, ...(exchangeRoot ? { exchangeRoot } : {}),
        ...(exchangeRootState ? { exchangeRootState } : {}),
        ...(returnedAnswer ? { exchangeCause: 'returned_answer' as const }
            : exchangeRoot ? { exchangeCause: 'agent_session' as const } : {}) };
}

/** Bind prepared input custody; only an unstarted Run wake may follow a newer receiver person root. */
async function bindAutonomousExchangeInputRootInTx(tx: Tx, input: Readonly<{
    sessionId: string; localId: string; receipt: SessionInputAdmissionReceiptV1;
    root: { sessionId: string; localId: string };
    state?: ReturnType<typeof createAutonomousExchangeStateV1>;
}>): Promise<boolean> {
    const materialized = await tx.sessionMessage.findUnique({
        where: { sessionId_localId: { sessionId: input.sessionId, localId: input.localId } },
        select: { autonomousExchangeRootSessionId: true, autonomousExchangeRootLocalId: true, turnStartWitnessId: true },
    });
    const canReanchor = input.receipt.followDeliveryV1?.delivery === 'wake'
        && isRunFollowOriginalV1(input.receipt.followDeliveryV1.original) && materialized?.turnStartWitnessId === null;
    if (!materialized || materialized.autonomousExchangeRootSessionId !== null
        && (materialized.autonomousExchangeRootSessionId !== input.root.sessionId
            || materialized.autonomousExchangeRootLocalId !== input.root.localId) && !canReanchor) return false;
    const data = { autonomousExchangeRootSessionId: input.root.sessionId, autonomousExchangeRootLocalId: input.root.localId,
        ...(input.state ? { autonomousExchangeState: input.state } : {}) };
    await tx.sessionMessage.update({ where: { sessionId_localId: { sessionId: input.sessionId, localId: input.localId } }, data });
    await tx.sessionPendingMessage.updateMany({ where: { sessionId: input.sessionId, localId: input.localId }, data });
    return true;
}

type QueuedPendingInputForRejection = Readonly<{
    targetExecutionRunId?: string | null;
    status: string;
    deliveryState: string | null;
    content: unknown;
    requestedAction: unknown;
    requestEqualityEvidenceV1: unknown;
}>;

async function rejectQueuedPendingInputInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    localId: string;
    existing: QueuedPendingInputForRejection;
    code: SessionInputAdmissionRejectionCodeV1;
}>) {
    if (params.existing.status !== "queued") return null;
    const requestContent = params.existing.content as PrismaJson.SessionPendingMessageContent;
    const requestedAction = PendingRequestedActionV1StoredSchema.safeParse(params.existing.requestedAction);
    if (!requestedAction.success) return null;

    let requestEqualityEvidenceV1: SessionInputRequestEqualityEvidenceV1 | undefined;
    if (requestContent.t === "plain") {
        const derived = derivePlainRequestEqualityEvidence({
            content: requestContent,
            requestedAction: requestedAction.data,
        });
        if (!derived) return null;
        requestEqualityEvidenceV1 = derived;
    } else if (requestContent.t !== "encrypted" || params.code !== "session_input_cancelled"
        || params.existing.requestEqualityEvidenceV1 != null) {
        const parsed = createStoredReadSchema(SessionInputRequestEqualityEvidenceV1Schema).safeParse(
            params.existing.requestEqualityEvidenceV1,
        );
        if (!parsed.success || parsed.data.kind !== "e2eeTag") return null;
        requestEqualityEvidenceV1 = parsed.data;
    }

    // Main encrypted inputs can enter custody before an equality tag exists.
    // Cancelling that exact retained row introduces no replacement content to
    // compare. Keep its missing tag rather than blocking withdrawal or inventing one.

    const discardedFields = pendingDeliveryStatusV1ToPersistedFields({
        status: "discarded",
        reason: params.code,
    });
    await params.tx.sessionPendingMessage.update({
        where: {
            sessionId_localId: {
                sessionId: params.sessionId,
                localId: params.localId,
            },
        },
        data: {
            ...discardedFields,
            discardedAt: new Date(),
            ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
        },
    });
    await settleUnacceptedSessionInputReplyInTx(params.tx, params.sessionId, params.localId, 'failed');
    await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
        tx: params.tx,
        sessionId: params.sessionId,
        requestId: params.localId,
    });
    return applyPendingSessionStateChange({
        tx: params.tx,
        sessionId: params.sessionId,
        pendingCountDelta: params.existing.targetExecutionRunId == null ? -1 : 0,
        pendingBlockedCountDelta: params.existing.targetExecutionRunId == null && params.existing.deliveryState === "blocked" ? -1 : 0,
    });
}

/** Retires the exact deterministic queued Session input owned by one Automation Run. */
export async function retireAutomationPendingInputInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sessionId: string;
    runId: string;
}>): Promise<boolean> {
    const localId = `automation:run:${params.runId}`;
    const existing = await params.tx.sessionPendingMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId } },
        select: {
            status: true,
            deliveryState: true,
            content: true,
            requestedAction: true,
            requestEqualityEvidenceV1: true,
        },
    });
    if (!existing || existing.status !== "queued") return false;
    const state = await rejectQueuedPendingInputInTx({
        tx: params.tx,
        sessionId: params.sessionId,
        localId,
        existing,
        code: "session_input_cancelled",
    });
    if (!state) throw new Error("Automation pending input could not be retired");
    afterTx(params.tx, () => {
        void emitPendingChanged({
            sessionId: params.sessionId,
            changedByAccountId: params.accountId,
            pendingCount: state.pendingCount,
            pendingBlockedCount: state.pendingBlockedCount,
            pendingVersion: state.pendingVersion,
            recipientCursors: resolveSessionAccountChangePublications(state.recipientCursors),
        }).catch((error) => {
            warn(
                {
                    module: "session-pending-service",
                    operation: "automation-input-cancellation",
                    sessionId: params.sessionId,
                    localId,
                    err: error,
                },
                "failed to publish Automation pending input cancellation",
            );
        });
    });
    return true;
}

/** Target-only protected request settlement, before any Agent/provider effect. */
export async function settlePendingInputAdmission(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    localId: string;
    publisherAuthority: CurrentSessionPublisherAuthority;
    decision:
        | Readonly<{
            kind: "admit";
            finalContent: SessionStoredMessageContent;
            requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
            validation?: SessionInputSettlementValidationV1;
          }>
        | Readonly<{
            kind: "reject";
            code: SessionInputAdmissionRejectionCodeV1;
            validation?: SessionInputSettlementValidationV1;
          }>;
}>): Promise<SettlePendingInputAdmissionResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";
    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    try {
        return await inTx(async (tx) => pendingPublicationResult<SettlePendingInputAdmissionResult>(async () => {
            // Custody-only recovery has no caller-authored request/validation.
            // Fence the actual retained original's publication audience before
            // any Account/Session write, just as ordinary admission does.
            const original = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { replyProgress: true } })
                ?? await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { replyProgress: true } });
            const originalReplyProgress = createStoredReadSchema(SessionMessageReplyProgressV1Schema).safeParse(original?.replyProgress);
            const discussionId = originalReplyProgress.success ? originalReplyProgress.data.discussion?.discussionId : undefined;
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId], discussionId
                ? await resolveDiscussionAudienceInTx(tx, discussionId) : []);
            if (!await hasExactCurrentPublisherAuthorityInTx(
                tx,
                params.publisherAuthority,
                actorUserId,
                sessionId,
            )) return { ok: false, error: "forbidden" } as const;
            const targetMachine = await tx.machine.findFirst({
                where: { id: params.publisherAuthority.machineId },
                select: {
                    operationProtocolCapabilities: true,
                    operationProtocolCapabilitiesRevision: true,
                    revokedAt: true,
                    replacedByMachineId: true,
                },
            });
            if (
                !targetMachine
                || targetMachine.revokedAt !== null
                || targetMachine.replacedByMachineId !== null
                || typeof targetMachine.operationProtocolCapabilitiesRevision !== "number"
                || targetMachine.operationProtocolCapabilitiesRevision < 1
                || !supportsMachineOperationProtocolCapabilityV1(
                    targetMachine.operationProtocolCapabilities,
                    "sessionInputAdmission",
                )
            ) return { ok: false, error: "forbidden" } as const;

            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    targetExecutionRunId: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    position: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });
            if (!existing) {
                const committed = await tx.sessionMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId } },
                    select: { id: true, seq: true, localId: true, sidechainId: true, targetExecutionRunId: true, messageRole: true, content: true, inputAdmissionReceipt: true, authorAccountId: true, deliveryResolution: true, replyProgress: true, turnStartWitnessId: true, createdAt: true, updatedAt: true },
                });
                const state = await readCurrentPendingMutationState(tx, sessionId);
                if (!committed) return { ok: false, error: "not-found" } as const;
                const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(committed.inputAdmissionReceipt);
                const progress = committed.replyProgress == null ? null : SessionMessageReplyProgressV1Schema.safeParse(committed.replyProgress);
                if (progress && (!progress.success || !matchesOriginalReplyAdmission(progress.data, params.decision.validation?.reply))
                    || !progress && params.decision.validation?.reply !== undefined) return { ok: false, error: 'conflict' } as const;
                // Materialization is custody, not permission for a later provider
                // effect. Reuse the original destination admission decision here.
                const unstartedRunWake = receipt.success && receipt.data.followDeliveryV1?.delivery === 'wake'
                    && isRunFollowOriginalV1(receipt.data.followDeliveryV1.original) && committed.turnStartWitnessId === null
                    && readStoredSessionMessageDeliveryResolutionV1(committed.deliveryResolution)?.kind !== 'provider_accepted';
                const unstartedSessionFollow = receipt.success && receipt.data.followDeliveryV1
                    && 'sourceSessionId' in receipt.data.followDeliveryV1.original && committed.turnStartWitnessId === null
                    && readStoredSessionMessageDeliveryResolutionV1(committed.deliveryResolution)?.kind !== 'provider_accepted';
                if (receipt.success && (receipt.data.issuer === 'authenticatedMachine' && receipt.data.discussionAddressing
                    || progress?.success && progress.data.humanOrigin || unstartedRunWake || unstartedSessionFollow)) {
                    if (!await isSessionInputTargetCurrentForPublisherInTx(tx, receipt.data, params.publisherAuthority)) {
                        return { ok: false, error: 'forbidden' } as const;
                    }
                    const validation = await validateInputSettlementDomainFactsInTx({
                        tx, accountId: actorUserId, targetSessionId: sessionId,
                        targetExecutionRunId: committed.targetExecutionRunId, localId,
                        ...(params.decision.validation ? { validation: params.decision.validation } : {}),
                    });
                    if (!validation.ok) {
                        if (!validation.rejectionCode && !validation.holdReason) return { ok: false, error: 'conflict' } as const;
                        return {
                            ok: true,
                            result: validation.rejectionCode
                                ? { status: 'rejected', code: validation.rejectionCode } as const
                                : { status: 'held', localId, code: validation.holdReason! } as const,
                            ...state,
                            recipientCursorsPending: state.recipientCursors,
                            recipientCursorsMessage: [],
                        } as const;
                    }
                    if (unstartedRunWake && validation.exchangeRoot && !await bindAutonomousExchangeInputRootInTx(tx, {
                        sessionId, localId, receipt: receipt.data, root: validation.exchangeRoot,
                        ...(validation.exchangeRootState ? { state: validation.exchangeRootState } : {}),
                    })) return { ok: false, error: 'conflict' } as const;
                }
                const { targetExecutionRunId: _targetExecutionRunId, replyProgress: _replyProgress,
                    turnStartWitnessId: _turnStartWitnessId, ...committedMessage } = committed;
                return {
                    ok: true,
                    result: { status: "alreadyAccepted", localId },
                    ...state,
                    recipientCursorsPending: state.recipientCursors,
                    recipientCursorsMessage: [],
                    message: {
                        ...committedMessage,
                        localId: committed.localId ?? localId,
                        messageRole: parseSessionMessageRole(committed.messageRole),
                        content: committed.content as PrismaJson.SessionMessageContent,
                        inputAdmissionReceipt: receipt.data ?? null,
                        deliveryResolution: readStoredSessionMessageDeliveryResolutionV1(committed.deliveryResolution),
                    },
                } as const;
            }
            if (existing.status === "discarded") {
                const rejection = SessionInputAdmissionRejectionCodeV1Schema.safeParse(existing.discardedReason);
                if (!rejection.success) return { ok: false, error: "conflict" } as const;
                const state = await readCurrentPendingMutationState(tx, sessionId);
                return {
                    ok: true,
                    result: { status: "rejected", code: rejection.data },
                    ...state,
                    recipientCursorsPending: state.recipientCursors,
                    recipientCursorsMessage: [],
                } as const;
            }
            if (existing.deliveryState !== "delivering") return { ok: false, error: "conflict" } as const;
            if (existing.targetExecutionRunId !== null && !supportsMachineSessionInputAdmissionProtocolVersion(targetMachine.operationProtocolCapabilities, 2)) {
                return { ok: false, error: "forbidden" } as const;
            }
            const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(existing.inputAdmissionReceipt);
            if (!receipt.success) return { ok: false, error: "conflict" } as const;
            if (!await isSessionInputTargetCurrentForPublisherInTx(tx, receipt.data, params.publisherAuthority)) {
                return { ok: false, error: "forbidden" } as const;
            }
            const domainValidation = await validateInputSettlementDomainFactsInTx({
                tx,
                accountId: actorUserId,
                targetSessionId: sessionId,
                targetExecutionRunId: existing.targetExecutionRunId,
                localId,
                ...(params.decision.validation ? { validation: params.decision.validation } : {}),
            });
            if (!domainValidation.ok && domainValidation.holdReason) {
                const blocked = pendingDeliveryStatusV1ToPersistedFields({ status: 'blocked',
                    reason: domainValidation.holdReason });
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { status: blocked.status, deliveryState: blocked.deliveryState,
                        deliveryBlockedReason: blocked.deliveryBlockedReason,
                        discardedReason: blocked.discardedReason,
                        ...(domainValidation.exchangeRoot ? {
                            autonomousExchangeRootSessionId: domainValidation.exchangeRoot.sessionId,
                            autonomousExchangeRootLocalId: domainValidation.exchangeRoot.localId,
                            autonomousExchangeCause: 'agent_session',
                        } : {}) },
                });
                if (receipt.data.issuer === 'authenticatedMachine' && receipt.data.discussionAddressing) {
                    await markDiscussionReadersChangedInTx({ tx, discussionId: receipt.data.discussionAddressing.discussionId });
                }
                const state = await applyPendingSessionStateChange({ tx, sessionId,
                    pendingBlockedCountDelta: 1 });
                return { ok: true, result: { status: 'held', localId,
                    code: domainValidation.holdReason }, ...state,
                    recipientCursorsPending: state.recipientCursors,
                    recipientCursorsMessage: [] } as const;
            }
            const retainedReply = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { replyProgress: true } });
            const progress = retainedReply?.replyProgress == null ? null : SessionMessageReplyProgressV1Schema.safeParse(retainedReply.replyProgress);
            if (progress && (!progress.success || !matchesOriginalReplyAdmission(progress.data, params.decision.validation?.reply))
                || !progress && params.decision.validation?.reply !== undefined) return { ok: false, error: 'conflict' } as const;
            if (!domainValidation.ok && !domainValidation.rejectionCode) {
                return { ok: false, error: "conflict" } as const;
            }
            const decision = !domainValidation.ok && domainValidation.rejectionCode
                ? {
                    kind: "reject" as const,
                    code: domainValidation.rejectionCode,
                    ...(params.decision.validation ? { validation: params.decision.validation } : {}),
                }
                : params.decision;
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { accountId: true, encryptionMode: true },
            });
            if (!session || session.accountId !== actorUserId) return { ok: false, error: "not-found" } as const;
            const requestContent = existing.content as PrismaJson.SessionPendingMessageContent;
            const requestedAction = PendingRequestedActionV1StoredSchema.safeParse(existing.requestedAction);
            if (!requestedAction.success) return { ok: false, error: "conflict" } as const;

            if (decision.kind === "reject") {
                const state = await rejectQueuedPendingInputInTx({
                    tx,
                    sessionId,
                    localId,
                    existing,
                    code: decision.code,
                });
                if (!state) return { ok: false, error: "conflict" } as const;
                return {
                    ok: true,
                    result: { status: "rejected", code: decision.code },
                    ...state,
                    recipientCursorsPending: state.recipientCursors,
                    recipientCursorsMessage: [],
                } as const;
            }

            const finalContent = decision.finalContent as PrismaJson.SessionMessageContent;
            const publisherEquality = decision.requestEqualityEvidenceV1 === undefined
                ? undefined
                : SessionInputRequestEqualityEvidenceV1Schema.safeParse(decision.requestEqualityEvidenceV1);
            const existingEquality = existing.requestEqualityEvidenceV1 == null
                ? undefined
                : createStoredReadSchema(SessionInputRequestEqualityEvidenceV1Schema).safeParse(existing.requestEqualityEvidenceV1);
            if (publisherEquality !== undefined && (
                !publisherEquality.success
                || publisherEquality.data.kind !== "e2eeTag"
                || finalContent.t !== "encrypted"
                || existing.targetExecutionRunId === null
            )) return { ok: false, error: "conflict" } as const;
            if (existing.targetExecutionRunId !== null && requestContent.t === "encrypted" && !publisherEquality?.success) {
                return { ok: false, error: "conflict" } as const;
            }
            if (publisherEquality?.success && existingEquality !== undefined
                && (!existingEquality.success || !isDeepStrictEqual(publisherEquality.data, existingEquality.data))) {
                return { ok: false, error: "conflict" } as const;
            }
            if (existing.targetExecutionRunId === null && isDeepStrictEqual(requestContent, finalContent)) {
                const committed = await tx.sessionMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId } },
                    select: { content: true, inputAdmissionReceipt: true },
                });
                // Admission may have committed while its ACK was lost. Only the
                // exact committed admission can rejoin without admitting again.
                if (committed && isDeepStrictEqual(committed.content, finalContent)
                    && isDeepStrictEqual(createStoredReadSchema(SessionInputAdmissionReceiptV1Schema)
                        .safeParse(committed.inputAdmissionReceipt).data, receipt.data)) {
                    if (receipt.data.followDeliveryV1?.delivery === 'wake' && isRunFollowOriginalV1(receipt.data.followDeliveryV1.original)
                        && domainValidation.ok && domainValidation.exchangeRoot && !await bindAutonomousExchangeInputRootInTx(tx, {
                            sessionId, localId, receipt: receipt.data, root: domainValidation.exchangeRoot,
                            ...(domainValidation.exchangeRootState ? { state: domainValidation.exchangeRootState } : {}),
                        })) return { ok: false, error: 'conflict' } as const;
                    const state = await readCurrentPendingMutationState(tx, sessionId);
                    return { ok: true, result: { status: "alreadyAccepted", localId }, ...state, recipientCursorsPending: [], recipientCursorsMessage: [] } as const;
                }
            }
            if (existing.targetExecutionRunId !== null && existingEquality !== undefined
                && isDeepStrictEqual(requestContent, finalContent)) {
                if (!existingEquality.success || (requestContent.t === "plain" && !readSessionInputAuthority(readPlainMessageMeta(requestContent), 'stored'))) {
                    return { ok: false, error: "conflict" } as const;
                }
                const state = await readCurrentPendingMutationState(tx, sessionId);
                return { ok: true, result: { status: "alreadyAccepted", localId }, ...state, recipientCursorsPending: [], recipientCursorsMessage: [] } as const;
            }
            if (
                requestContent.t !== finalContent.t
                || requestContent.t === "plain"
                    && !isExactPlainRequestToAuthorityReplacement({
                        requestContent,
                        finalContent,
                        inputAdmissionReceipt: receipt.data,
                    })
            ) return { ok: false, error: "conflict" } as const;
            if (existing.targetExecutionRunId !== null) {
                const recipient = finalContent.t === "plain" ? readParticipantRecipientRoutingIdentityV1(readPlainMessageMeta(finalContent)) : null;
                if (finalContent.t === "plain" && (recipient?.kind !== "execution_run" || recipient.runId !== existing.targetExecutionRunId)) {
                    return { ok: false, error: "conflict" } as const;
                }
                const equality = requestContent.t === "plain"
                    ? derivePlainRequestEqualityEvidence({ content: requestContent, requestedAction: requestedAction.data })
                    : publisherEquality?.data;
                if (!equality) return { ok: false, error: "conflict" } as const;
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId: existing.targetExecutionRunId, deliveryState: "delivering" },
                    data: { content: finalContent, requestEqualityEvidenceV1: equality },
                });
                const state = await applyPendingSessionStateChange({ tx, sessionId });
                return { ok: true, result: { status: "accepted", localId }, ...state, recipientCursorsPending: state.recipientCursors, recipientCursorsMessage: [] } as const;
            }
            const policy = readEncryptionFeatureEnv(process.env);
            const sessionEncryptionMode = session.encryptionMode === "plain" ? "plain" : "e2ee";
            if (existingEquality !== undefined && !existingEquality.success) return { ok: false, error: "conflict" } as const;
            const committed = await createSessionMessageFromPending(tx, {
                sessionId,
                sessionEncryptionMode,
                storagePolicy: policy.storagePolicy,
                localId,
                targetExecutionRunId: existing.targetExecutionRunId,
                requestContentForEquality: requestContent,
                content: finalContent,
                messageRole: "user",
                pendingRequestedAction: requestedAction.data,
                inputAdmissionReceipt: receipt.data,
                ...(existingEquality === undefined
                    ? {}
                    : { requestEqualityEvidenceV1: existingEquality.data }),
            });
            if (!committed.ok) return { ok: false, error: "conflict" } as const;
            if (domainValidation.ok && domainValidation.exchangeCause) {
                await tx.sessionMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { autonomousExchangeCause: domainValidation.exchangeCause },
                });
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { autonomousExchangeCause: domainValidation.exchangeCause },
                });
            }
            if (domainValidation.ok && !domainValidation.exchangeRoot
                && !domainValidation.exchangeCause && !params.decision.validation?.automation
                && params.decision.validation?.autonomousCheckIn
                && receipt.data.issuer === 'authenticatedAccount'
                && receipt.data.actorAccountId === actorUserId) {
                const state = createAutonomousExchangeStateV1(
                    params.decision.validation.autonomousCheckIn.afterTurns);
                await tx.sessionMessage.update({ where: { sessionId_localId: { sessionId, localId } },
                    data: { autonomousExchangeState: state } });
                await tx.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId, localId } },
                    data: { autonomousExchangeState: state } });
            }
            if (domainValidation.ok && domainValidation.exchangeRoot) {
                if (!await bindAutonomousExchangeInputRootInTx(tx, { sessionId, localId, receipt: receipt.data,
                    root: domainValidation.exchangeRoot,
                    ...(domainValidation.exchangeRootState ? { state: domainValidation.exchangeRootState } : {}),
                })) return { ok: false, error: 'conflict' } as const;
            }
            const readyProjection = committed.didWrite
                ? await updateSessionMessageActivityProjection(tx, {
                    sessionId,
                    created: committed.message,
                    trustedSessionEventType: resolveReadyProjectionEventType({
                        actorUserId,
                        sessionOwnerId: session.accountId,
                        content: finalContent,
                    }),
                })
                : undefined;
            // Host admission is not provider acceptance. Keep the frozen claim
            // with its settled envelope so an ACK loss rejoins it and a provider
            // rejection can block it. Exact provider settlement owns retirement.
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    content: finalContent,
                    ...(requestContent.t === "plain" ? {
                        requestEqualityEvidenceV1: derivePlainRequestEqualityEvidence({ content: requestContent, requestedAction: requestedAction.data }),
                    } : {}),
                },
            });
            const state = await applyPendingSessionStateChange({
                tx,
                sessionId,
                meaningfulActivityAt: committed.didWrite ? committed.message.createdAt : undefined,
            });
            const recipientCursorsMessage = committed.didWrite || committed.didUpdate
                ? await markSessionProjectionRecipientsChanged({
                    tx,
                    sessionId,
                    hint: { lastMessageSeq: committed.message.seq, lastMessageId: committed.message.id },
                })
                : [];
            return {
                ok: true,
                result: { status: "accepted", localId },
                ...state,
                recipientCursorsPending: state.recipientCursors,
                recipientCursorsMessage,
                message: committed.message,
                ...(readyProjection ? { readyProjection } : {}),
            } as const;
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdatePendingMessageResult =
    | { ok: true; localId: string; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "local-id-conflict" | "pending-mutation-conflict" | "delivery-settlement-conflict" | "internal"; code?: EncryptionPolicyRejectionCode };

export type UpdatePendingRequestedActionResult =
    | {
        ok: true;
        didUpdate: boolean;
        requestedAction: PendingRequestedActionV1;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        activationTarget?: PendingActivationTarget;
      }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "already-sent" | "action-conflict" | "reset-start-unsupported" | "internal" };

export async function updatePendingRequestedAction(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    requestedAction: PendingRequestedActionV1;
    expectedRequestedAction?: PendingRequestedActionV1;
    /** Verified installed Machine socket identity; never accepted from an HTTP body. */
    automaticResetReleaseTarget?: Readonly<{ machineId: string; installationId: string }>;
    resumeWhenAvailable?: boolean;
    authentication: SessionAccessAuthentication;
}>): Promise<UpdatePendingRequestedActionResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    if (targetExecutionRunId !== null && params.resumeWhenAvailable !== undefined) {
        return { ok: false, error: "invalid-params" };
    }
    const localId = readPendingLocalId(params.localId) ?? "";
    const requestedActionResult = PendingRequestedActionV1Schema.safeParse(params.requestedAction);
    const expectedActionResult = params.expectedRequestedAction === undefined ? undefined
        : PendingRequestedActionV1Schema.safeParse(params.expectedRequestedAction);
    if (!actorUserId || !sessionId || !localId || !requestedActionResult.success) {
        return { ok: false, error: "invalid-params" };
    }
    if (expectedActionResult && !expectedActionResult.success) return { ok: false, error: "invalid-params" };
    if (requestedActionResult.data.kind === "reset_start"
        && (targetExecutionRunId !== null || params.resumeWhenAvailable !== undefined)) {
        return { ok: false, error: "invalid-params" };
    }
    if (params.automaticResetReleaseTarget && (targetExecutionRunId !== null || requestedActionResult.data.kind !== "enqueue"
        || !expectedActionResult?.success || expectedActionResult.data.kind !== "reset_start")) {
        return { ok: false, error: "invalid-params" };
    }
    if (!params.automaticResetReleaseTarget) {
        const accessDecision = await resolveSessionAccessForOperation(db, {
            accountId: actorUserId,
            sessionId,
            authentication: params.authentication,
            capability: "submitAgentInput",
        });
        if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
        if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };
    }

    try {
        // Freeze the request's observed revision before transaction acquisition. `inTx` may
        // replay its callback after a serialization/SQLite conflict; rereading inside that
        // callback would silently reinterpret a stale writer as a fresh/idempotent writer.
        const existing = await db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
            select: {
                status: true,
                deliveryState: true,
                deliveryBlockedReason: true,
                providerAction: true,
                requestedAction: true,
                inputAdmissionReceipt: true,
                updatedAt: true,
                messageRole: true,
                authorAccountId: true,
            },
        });
        if (!existing) {
            // Provider settlement retires Pending but retains the exact accepted
            // input in the transcript. A stale confirmation must not infer
            // delivery from absence, manual handling, or another recipient.
            const committed = !params.automaticResetReleaseTarget
                ? await db.sessionMessage.findFirst({
                    where: { sessionId, localId, targetExecutionRunId, messageRole: "user" },
                    select: { deliveryResolution: true },
                })
                : null;
            return { ok: false, error: readStoredSessionMessageDeliveryResolutionV1(committed?.deliveryResolution)?.kind === "provider_accepted"
                ? "already-sent" : "not-found" } as const;
        }
        const currentActionResult = PendingRequestedActionV1StoredSchema.safeParse(
            existing.requestedAction ?? { v: 1, kind: "enqueue" },
        );
        if (!currentActionResult.success) return { ok: false, error: "invalid-params" } as const;
        const currentAction = currentActionResult.data;
        if (expectedActionResult?.success && !isDeepStrictEqual(expectedActionResult.data, currentAction)) {
            return { ok: false, error: "action-conflict" } as const;
        }
        if (currentAction.kind === "reset_start" && requestedActionResult.data.kind !== "reset_start"
            && !params.automaticResetReleaseTarget) return { ok: false, error: "action-conflict" } as const;
        const canReplaceQueued = existing.status === "queued" && existing.deliveryState === null;
        const canReplaceBlocked = existing.status === "queued"
            && existing.deliveryState === "blocked"
            && !isPendingDeliveryProviderEffectPossibleV1(normalizePendingDeliveryStatusV1({
                status: existing.status,
                deliveryState: existing.deliveryState,
                deliveryBlockedReason: existing.deliveryBlockedReason,
            }));
        if (!canReplaceQueued && !canReplaceBlocked) {
            return { ok: false, error: "action-conflict" } as const;
        }
        const frozenWhere = {
            sessionId,
            localId,
            targetExecutionRunId,
            status: "queued" as const,
            deliveryState: canReplaceBlocked ? "blocked" as const : null,
            deliveryBlockedReason: existing.deliveryBlockedReason,
            providerAction: existing.providerAction,
            updatedAt: existing.updatedAt,
            ...(existing.requestedAction === null
                ? {}
                : { requestedAction: { equals: existing.requestedAction } }),
        };
        const nextUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));

        return await inTx(async (tx) => pendingPublicationResult<UpdatePendingRequestedActionResult>(async () => {
            const controllerAccountIds = await readPendingActivationControllerAccountIdsInTx(
                tx, readStoredSessionInputAdmissionReceipt(existing.inputAdmissionReceipt)?.admittedTarget?.machineId,
            );
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId], controllerAccountIds);
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!params.automaticResetReleaseTarget && !access.ok) {
                return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            }
            if (requestedActionResult.data.kind === "reset_start" || params.automaticResetReleaseTarget) {
                const target = await readCurrentPendingResetStartTargetInTx(tx, sessionId, existing,
                    params.automaticResetReleaseTarget ? undefined : actorUserId);
                if (!target
                    || params.automaticResetReleaseTarget && (target.machineId !== params.automaticResetReleaseTarget.machineId
                        || target.installationId !== params.automaticResetReleaseTarget.installationId)) {
                    return { ok: false, error: "reset-start-unsupported" } as const;
                }
                if (params.automaticResetReleaseTarget) {
                    // The installed custodian releases an already admitted requester input;
                    // it does not gain requester Account or arbitrary Session authority.
                    const custodian = await tx.machine.findFirst({ where: { id: target.machineId,
                        accountId: actorUserId, installationId: target.installationId }, select: { id: true } });
                    if (!custodian) return { ok: false, error: "reset-start-unsupported" } as const;
                }
            }
            if (!canReplaceBlocked && existing.providerAction === null && isDeepStrictEqual(currentAction, requestedActionResult.data)) {
                const retained = await tx.sessionPendingMessage.count({ where: frozenWhere });
                if (retained !== 1) {
                    return { ok: false, error: "action-conflict" } as const;
                }
                const shouldArmActivation = access.ok && targetExecutionRunId === null && shouldArmPendingActivationAuthorization({
                    requestedAction: requestedActionResult.data,
                    resumeWhenAvailable: params.resumeWhenAvailable,
                });
                if (shouldArmActivation || targetExecutionRunId === null && params.resumeWhenAvailable === false) {
                    await reconcileSessionPendingQueueStateInTx(tx, sessionId);
                    const activationTarget = shouldArmActivation
                        ? await armPendingActivationAuthorizationInTx({
                            tx,
                            sessionId,
                            requestId: localId,
                            currentAccess: access.access,
                            ...(params.resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
                        })
                        : undefined;
                    if (!shouldArmActivation) {
                        await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
                    }
                    const state = await applyPendingSessionStateChange({ tx, sessionId, activationTarget });
                    return {
                        ok: true,
                        didUpdate: true,
                        requestedAction: currentAction,
                        ...(activationTarget ? { activationTarget } : {}),
                        ...state,
                    } as const;
                }
                const session = await reconcileSessionPendingQueueStateInTx(tx, sessionId);
                const recipientCursors = session.didRepair
                    ? await markPendingStateChangedRecipients({
                        tx,
                        sessionId,
                        pendingCount: session.pendingCount,
                        pendingBlockedCount: session.pendingBlockedCount,
                        pendingVersion: session.pendingVersion,
                    })
                    : [];
                return {
                    ok: true,
                    didUpdate: false,
                    requestedAction: currentAction,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                    recipientCursors,
                } as const;
            }
            const updatedCount = (await tx.sessionPendingMessage.updateMany({
                where: frozenWhere,
                data: {
                    ...pendingRequestedActionReplacementData(requestedActionResult.data, nextUpdatedAt),
                },
            })).count;
            if (updatedCount !== 1) {
                return { ok: false, error: "action-conflict" } as const;
            }
            const shouldArmActivation = access.ok && targetExecutionRunId === null && shouldArmPendingActivationAuthorization({
                requestedAction: requestedActionResult.data,
                resumeWhenAvailable: params.resumeWhenAvailable,
            });
            const activationTarget = shouldArmActivation
                ? await armPendingActivationAuthorizationInTx({
                    tx,
                    sessionId,
                    requestId: localId,
                    currentAccess: access.access,
                    ...(params.resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
                })
                : undefined;
            if (targetExecutionRunId === null && !shouldArmActivation) {
                await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            }
            const pendingCount = await tx.sessionPendingMessage.count({ where: { sessionId, targetExecutionRunId: null, status: "queued" } });
            const pendingBlockedCount = await tx.sessionPendingMessage.count({
                where: { sessionId, targetExecutionRunId: null, status: "queued", deliveryState: "blocked" },
            });
            const session = await tx.session.update({
                where: { id: sessionId },
                data: { pendingCount, pendingBlockedCount, pendingVersion: { increment: 1 } },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
            const recipientCursors = await markPendingStateChangedRecipients({
                tx,
                sessionId,
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                pendingVersion: session.pendingVersion,
                activationTarget,
            });
            return {
                ok: true,
                didUpdate: true,
                requestedAction: requestedActionResult.data,
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                pendingVersion: session.pendingVersion,
                recipientCursors,
                ...(activationTarget ? { activationTarget } : {}),
            } as const;
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function updatePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    /**
     * A daemon-prepared changed attachment snapshot needs a new admission
     * identity. Rotate the existing row in this transaction so its queue
     * position and durable row id remain unchanged.
     */
    replacementLocalId?: string;
    /**
     * Canonical admitted payload digest for the one response-loss rejoin
     * associated with replacementLocalId. This is not a Message identity.
     */
    replacementMutationFingerprint?: string;
    messageRole?: unknown;
    authentication: SessionAccessAuthentication;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
)): Promise<UpdatePendingMessageResult> {
    const directTokenInput = params.authentication.apiTokenGrant !== undefined;
    if (directTokenInput && params.messageRole !== undefined && params.messageRole !== null && params.messageRole !== "user") {
        return { ok: false, error: "invalid-params" };
    }
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";
    const replacementLocalId = typeof params.replacementLocalId === "undefined"
        ? null
        : readPendingLocalId(params.replacementLocalId);
    const replacementMutationFingerprint = typeof params.replacementMutationFingerprint === "undefined"
        ? null
        : PendingMessageMutationFingerprintV1Schema.safeParse(params.replacementMutationFingerprint);
    const replacementMutationFingerprintValue = replacementMutationFingerprint?.success
        ? replacementMutationFingerprint.data
        : null;
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const rawContent =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;

    const requestsReplacement = params.replacementLocalId !== undefined || params.replacementMutationFingerprint !== undefined;
    if (
        !actorUserId
        || !sessionId
        || !localId
        || !rawContent
        || requestsReplacement
            && (
                !replacementLocalId
                || replacementLocalId === localId
                || replacementMutationFingerprintValue === null
            )
    ) {
        return { ok: false, error: "invalid-params" };
    }
    if (rawContent.t === "encrypted" && (!rawContent.c || typeof rawContent.c !== "string")) return { ok: false, error: "invalid-params" };
    if (rawContent.t === "plain" && !("v" in rawContent)) return { ok: false, error: "invalid-params" };
    const content = normalizeSessionMessageContentForStorage(rawContent);
    if (!content) return { ok: false, error: "invalid-params" };
    if (targetExecutionRunId !== null && content.t === "plain") {
        const recipient = readParticipantRecipientRoutingIdentityV1(readPlainMessageMeta(content));
        if (recipient?.kind !== "execution_run" || recipient.runId !== targetExecutionRunId) {
            return { ok: false, error: "invalid-params" };
        }
    }

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => pendingPublicationResult<UpdatePendingMessageResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    encryptionMode: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                },
            });
            if (!session) return { ok: false, error: "session-not-found" } as const;

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: directTokenInput ? (content.t === "encrypted" ? "user" : undefined) : params.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-message",
                },
            }).messageRole;
            if (directTokenInput && messageRole !== "user") return { ok: false, error: "invalid-params" } as const;
            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            const policy = readEncryptionFeatureEnv(process.env);
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return {
                    ok: false,
                    error: "invalid-params",
                    code: resolveEncryptionWriteRejectionCode({
                        storagePolicy: policy.storagePolicy,
                        sessionEncryptionMode,
                        writeKind,
                    }),
                } as const;
            }

            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                select: {
                    id: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    providerAction: true,
                    inputAdmissionReceipt: true,
                    replyProgress: true,
                },
            });
            if (!existing) {
                if (!replacementLocalId || replacementMutationFingerprintValue === null) {
                    return { ok: false, error: "not-found" } as const;
                }
                const replayed = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId: replacementLocalId }, targetExecutionRunId },
                    select: {
                        status: true,
                        deliveryState: true,
                        deliveryBlockedReason: true,
                        predecessorLocalId: true,
                        replacementMutationFingerprint: true,
                    },
                });
                if (
                    !replayed
                    || isOrdinaryPendingMutationFenced(replayed)
                    || replayed.predecessorLocalId !== localId
                    || replayed.replacementMutationFingerprint !== replacementMutationFingerprintValue
                ) {
                    return { ok: false, error: "pending-mutation-conflict" } as const;
                }
                return {
                    ok: true,
                    localId: replacementLocalId,
                    pendingVersion: session.pendingVersion ?? 0,
                    pendingCount: session.pendingCount ?? 0,
                    pendingBlockedCount: session.pendingBlockedCount ?? 0,
                    recipientCursors: [],
                    badgeAttentionChanged: false,
                } as const;
            }
            if (existing.replyProgress !== null) return { ok: false, error: 'delivery-settlement-conflict' } as const;
            if (isOrdinaryPendingMutationFenced(existing)) {
                // Exact provider custody (a real claim with providerAction) has
                // consumed the editable draft: the ordinary editor sees the
                // same absence the in-flight message has, and only the
                // delivery settlement owners may still mutate the row. Rows
                // that are provider-effect-possible without an exact claim
                // keep the explicit settlement fence.
                if (existing.deliveryState === "delivering" && existing.providerAction !== null) {
                    return { ok: false, error: "not-found" } as const;
                }
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            if (replacementLocalId) {
                const replacementCollision = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId: replacementLocalId } },
                    select: { id: true },
                });
                if (replacementCollision) return { ok: false, error: "local-id-conflict" } as const;
            }

            const retainedReceipt = readStoredSessionInputAdmissionReceipt(existing.inputAdmissionReceipt);
            if (existing.inputAdmissionReceipt != null && !retainedReceipt) return { ok: false, error: "invalid-params" } as const;

            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    content,
                    messageRole,
                    requestEqualityEvidenceV1: getActivePrismaRuntime().DbNull,
                    inputAdmissionReceipt: buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access: access.access,
                        admittedTarget: retainedReceipt?.admittedTarget,
                        callerInputConstraints: params.authentication.callerInputConstraints ?? params.authentication.apiTokenGrant }),
                    ...(replacementLocalId
                        ? {
                            localId: replacementLocalId,
                            predecessorLocalId: localId,
                            replacementMutationFingerprint: replacementMutationFingerprintValue,
                        }
                        : {
                            predecessorLocalId: null,
                            replacementMutationFingerprint: null,
                        }),
                },
            });
            if (replacementLocalId) {
                await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return {
                ok: true,
                localId: replacementLocalId ?? localId,
                pendingVersion,
                pendingCount,
                pendingBlockedCount,
                recipientCursors,
                badgeAttentionChanged,
            };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DeletePendingMessageResult =
    | { ok: true; outcome?: PendingMessageWithdrawOutcomeV1; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "delivery-settlement-conflict" | "internal" };

export async function deletePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    withdraw?: boolean;
    authentication: SessionAccessAuthentication;
}): Promise<DeletePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => pendingPublicationResult<DeletePendingMessageResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const alreadyDelivered = params.withdraw === true
                ? await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { id: true, deliveryResolution: true } })
                : null;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true, providerAction: true, replyProgress: true },
            });
            // Host admission writes the user transcript before provider acceptance.
            // Pending custody, or its terminal delivery resolution, decides withdrawal.
            if (alreadyDelivered && (!existing || existing.status !== 'queued'
                || readStoredSessionMessageDeliveryResolutionV1(alreadyDelivered.deliveryResolution) !== null)) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), outcome: 'already_delivered' } as const;
            }

            if (!existing) {
                const committed = params.withdraw === true
                    ? await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { id: true } })
                    : null;
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    pendingBlockedCount: session?.pendingBlockedCount ?? 0,
                    recipientCursors: [],
                    badgeAttentionChanged: false,
                    ...(params.withdraw === true ? { outcome: committed ? 'already_delivered' as const : 'delivery_unknown' as const } : {}),
                };
            }
            if (isOrdinaryPendingMutationFenced(existing)
                || (existing.status === "discarded" && isPendingDeliveryArchivedUncertaintyReasonV1(existing.discardedReason))) {
                if (params.withdraw === true) return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), outcome: 'delivery_unknown' } as const;
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (existing.replyProgress !== null) {
                const progress = SessionMessageReplyProgressV1Schema.safeParse(existing.replyProgress);
                if (!progress.success) return { ok: false, error: 'delivery-settlement-conflict' } as const;
                if (progress.data.acceptedTurnId) return params.withdraw === true
                    ? { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), outcome: 'already_delivered' } as const
                    : { ok: false, error: 'delivery-settlement-conflict' } as const;
                if (existing.status === 'discarded') {
                    await settleUnacceptedSessionInputReplyInTx(tx, sessionId, localId, 'cancelled');
                    return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)),
                        ...(params.withdraw === true ? { outcome: 'removed' as const } : {}) } as const;
                }
                // Keep original outcome/identity custody while removing the input from the executable queue.
                const removed = await tx.sessionPendingMessage.updateMany({ where: {
                    sessionId, localId, targetExecutionRunId, status: existing.status, deliveryState: existing.deliveryState,
                    providerAction: existing.providerAction, deliveryBlockedReason: existing.deliveryBlockedReason, discardedReason: existing.discardedReason,
                }, data: { status: 'discarded', deliveryState: null, deliveryBlockedReason: null, discardedAt: new Date(), discardedReason: 'cancelled' } });
                if (removed.count !== 1) return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)),
                    ...(params.withdraw === true ? { outcome: 'delivery_unknown' as const } : {}) } as const;
                await settleUnacceptedSessionInputReplyInTx(tx, sessionId, localId, 'cancelled');
            } else if (params.withdraw === true) {
                // Delivery claim and removal contend on this same row; a stale read cannot withdraw claimed input.
                const removed = await tx.sessionPendingMessage.deleteMany({ where: {
                    sessionId, localId, targetExecutionRunId, status: existing.status,
                    deliveryState: existing.deliveryState, providerAction: existing.providerAction,
                    deliveryBlockedReason: existing.deliveryBlockedReason, discardedReason: existing.discardedReason,
                } });
                if (removed.count !== 1) {
                    const committed = await tx.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId, localId } }, select: { id: true } });
                    return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)),
                        outcome: committed ? 'already_delivered' as const : 'delivery_unknown' as const };
                }
            } else {
                await tx.sessionPendingMessage.delete({ where: { sessionId_localId: { sessionId, localId } } });
            }
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null && existing.status === "queued" ? -1 : 0,
                pendingBlockedCountDelta: targetExecutionRunId === null && existing.status === "queued" && existing.deliveryState === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged,
                ...(params.withdraw === true ? { outcome: 'removed' as const } : {}) };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type MarkPendingActivationFailedResult =
    | { ok: true; didFail: boolean; pendingCount: number; pendingBlockedCount: number; pendingVersion: number; recipientCursors: RecipientCursor[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

/** Marks only the exact current waiting activation terminal-failed; stale reports are no-ops. */
export async function markPendingActivationFailed(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    requestId: string;
    requestedAt: number;
    failureCode: PendingActivationFailureCodeV1;
    failureDetails?: PendingActivationFailureDetailsV1;
    /** Only the installation-proof HTTP owner supplies this authenticated authority. */
    managedController?: Readonly<{ custodianAccountId: string; target: ManagedWakeTargetV1 }>;
    /** Authenticated route facts only; an Account bearer has no Machine identity. */
    diagnosticContext?: Readonly<{ route: string; callerMachineId: string | null; callerInstallationId: string | null }>;
}>): Promise<MarkPendingActivationFailedResult> {
    log({ module: 'pending-activation', event: 'pending.activation_failure_report',
        route: params.diagnosticContext?.route ?? 'internal', failureCode: params.failureCode,
        callerMachineId: params.diagnosticContext?.callerMachineId ?? null,
        callerInstallationId: params.diagnosticContext?.callerInstallationId ?? null,
        sessionId: params.sessionId, pendingId: params.requestId, requestedAt: params.requestedAt });
    if (
        !params.actorUserId
        || !params.sessionId
        || !params.requestId
        || !Number.isSafeInteger(params.requestedAt)
        || params.requestedAt < 0
    ) return { ok: false, error: "invalid-params" };
    if (!params.managedController) {
        const access = await resolveStructuralSessionAccess(db, { accountId: params.actorUserId, sessionId: params.sessionId });
        if (!access) return { ok: false, error: "session-not-found" };
        if (access.level !== "owner") return { ok: false, error: "forbidden" };
    }
    try {
        return await inTx(async (tx) => pendingPublicationResult<MarkPendingActivationFailedResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId]);
            if (params.managedController) {
                const { target, custodianAccountId } = params.managedController;
                const row = await tx.managedMachine.findUnique({ where: { id: target.managedId } });
                if (!row || custodianAccountId !== params.actorUserId || row.custodianAccountId !== custodianAccountId
                    || target.origin.kind !== 'session-input' || target.origin.session.sessionId !== params.sessionId
                    || target.origin.pendingRequestId !== params.requestId || target.origin.requestedAt !== params.requestedAt) {
                    throw new ManagedMachineError('permission_denied');
                }
                const current = await tx.session.findUnique({ where: { id: params.sessionId }, select: {
                    pendingActivationStatus: true, pendingActivationRequestId: true, pendingActivationRequestedAt: true,
                    pendingCount: true, pendingBlockedCount: true, pendingVersion: true,
                } });
                if (!current) return { ok: false, error: 'session-not-found' } as const;
                if (current.pendingActivationStatus !== 'waiting' || current.pendingActivationRequestId !== params.requestId
                    || current.pendingActivationRequestedAt?.getTime() !== params.requestedAt) return {
                    ok: true, didFail: false, pendingCount: current.pendingCount, pendingBlockedCount: current.pendingBlockedCount,
                    pendingVersion: current.pendingVersion, recipientCursors: [],
                } as const;
                await assertManagedWakeOriginCurrentInTx(tx, { row, target, allowUnavailableObservation: true });
            } else {
                const authority = await assertSessionOwnerInTx({ tx, accountId: params.actorUserId, sessionId: params.sessionId });
                if (!authority.ok) return { ok: false, error: "session-not-found" } as const;
            }
            const didFail = await markPendingActivationAuthorizationFailedInTx({
                tx,
                sessionId: params.sessionId,
                requestId: params.requestId,
                requestedAt: new Date(params.requestedAt),
                failureCode: params.failureCode,
                failureDetails: params.failureDetails,
            });
            const session = await tx.session.findUniqueOrThrow({
                where: { id: params.sessionId },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
            const recipientCursors = didFail
                ? await markPendingStateChangedRecipients({
                    tx,
                    sessionId: params.sessionId,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                })
                : [];
            return { ok: true, didFail, ...session, recipientCursors } as const;
        }));
    } catch (error) {
        if (params.managedController && error instanceof ManagedMachineError) throw error;
        return { ok: false, error: "internal" };
    }
}

type PendingMutationState = {
    pendingVersion: number;
    pendingCount: number;
    pendingBlockedCount: number;
    recipientCursors: SessionRecipientPublication[];
    badgeAttentionChanged: boolean;
};

type TargetPendingState = Pick<PendingMutationState, "pendingCount" | "pendingBlockedCount" | "pendingVersion">;

/** Target ACK counts are separate from the main Session projection published after commit. */
async function withTargetPendingStateInTx<T extends { ok: boolean; pendingVersion?: number }>(
    tx: Tx,
    sessionId: string,
    targetExecutionRunId: string | null,
    result: T,
): Promise<T & { targetPendingState?: TargetPendingState }> {
    if (!result.ok || targetExecutionRunId === null || result.pendingVersion === undefined) return result;
    const [pendingCount, pendingBlockedCount] = await Promise.all([
        tx.sessionPendingMessage.count({ where: { sessionId, targetExecutionRunId, status: "queued" } }),
        tx.sessionPendingMessage.count({ where: { sessionId, targetExecutionRunId, status: "queued", deliveryState: "blocked" } }),
    ]);
    return { ...result, targetPendingState: { pendingCount, pendingBlockedCount, pendingVersion: result.pendingVersion } };
}

async function readCurrentPendingMutationState(tx: Tx, sessionId: string): Promise<PendingMutationState> {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
    });
    return {
        pendingVersion: session?.pendingVersion ?? 0,
        pendingCount: session?.pendingCount ?? 0,
        pendingBlockedCount: session?.pendingBlockedCount ?? 0,
        recipientCursors: [],
        badgeAttentionChanged: false,
    };
}

export type ResolveAcceptedPendingDeliveryResult =
    | {
        ok: true;
        targetPendingState?: TargetPendingState;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        recipientCursorsPending?: RecipientCursor[];
        recipientCursorsMessage?: RecipientCursor[];
        badgeAttentionChanged: boolean;
        didResolve: boolean;
        didWrite?: boolean;
        didUpdate?: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: false;
        error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "not-materialized" | "blocked-by-earlier-pending" | "transcript-conflict" | "internal";
        pendingStateChanged?: boolean;
        pendingVersion?: number;
        pendingCount?: number;
        pendingBlockedCount?: number;
        recipientCursors?: RecipientCursor[];
        badgeAttentionChanged?: boolean;
      }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number; correlationId?: string };

type PendingDeliveryResolutionInput = Readonly<{
    targetExecutionRunId?: string | null;
    status: string;
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
    discardedReason?: string | null;
    messageRole: string | null;
    content: unknown;
    requestedAction: unknown;
    position: number;
    inputAdmissionReceipt?: unknown;
    requestEqualityEvidenceV1?: unknown;
}>;

type PendingDeliveryBlockRowInput = Readonly<{
    localId: string;
    status: string;
    deliveryState: string | null;
    deliveryBlockedReason?: string | null;
    discardedReason?: string | null;
}>;

type PendingDeliveryPersistedFieldsInput = Readonly<{
    status: string;
    deliveryState: string | null;
    deliveryBlockedReason?: string | null;
    discardedReason?: string | null;
}>;

function readPendingDeliveryStatus(fields: PendingDeliveryPersistedFieldsInput): PendingDeliveryStatusV1 {
    return normalizePendingDeliveryStatusV1({
        status: fields.status,
        deliveryState: fields.deliveryState,
        deliveryBlockedReason: fields.deliveryBlockedReason ?? null,
        discardedReason: fields.discardedReason ?? null,
    });
}

function canTransitionPendingDeliveryStatus(
    fields: PendingDeliveryPersistedFieldsInput,
    target: PendingDeliveryStatusTransitionTargetV1,
): boolean {
    return isPendingDeliveryStatusTransitionAllowedV1(readPendingDeliveryStatus(fields), target);
}

async function markPendingDeliveryRowsBlocked(
    tx: PendingServiceTx,
    params: Readonly<{
        sessionId: string;
        rows: readonly PendingDeliveryBlockRowInput[];
        reason: PendingDeliveryBlockedReason;
    }>,
): Promise<Readonly<{ updatedCount: number; pendingBlockedCountDelta: number }>> {
    const target = { status: "blocked", reason: params.reason } as const;
    const allowedRows = params.rows.filter((row) => isPendingLocalId(row.localId) && canTransitionPendingDeliveryStatus(row, target));
    const localIds = [...new Set(allowedRows.map((row) => row.localId))];
    if (localIds.length === 0) return { updatedCount: 0, pendingBlockedCountDelta: 0 };

    const pendingBlockedCountDelta = allowedRows.filter((row) =>
        readPendingDeliveryStatus(row).status !== "blocked",
    ).length;
    const persisted = pendingDeliveryStatusV1ToPersistedFields(target);
    const updated = await tx.sessionPendingMessage.updateMany({
        where: {
            sessionId: params.sessionId,
            localId: { in: localIds },
            status: "queued",
        },
        data: {
            status: persisted.status,
            deliveryState: persisted.deliveryState,
            deliveryBlockedReason: persisted.deliveryBlockedReason,
            discardedReason: persisted.discardedReason,
        },
    });

    return {
        updatedCount: updated.count,
        pendingBlockedCountDelta,
    };
}

async function commitResolvedPendingDelivery(
    tx: PendingServiceTx,
    params: Readonly<{
        actorUserId: string;
        sessionId: string;
        localId: string;
        existing: PendingDeliveryResolutionInput;
        expectedSidechainId?: string | null;
        target: Extract<PendingDeliveryStatusTransitionTargetV1, { status: "resolved" }>;
        acceptedDelivery?: SessionMessageAcceptedDeliveryContentV1;
        acceptedTurn?: SessionMessageAcceptedTurnV1;
    }>,
): Promise<PendingPublicationFields<
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        recipientCursorsPending: RecipientCursor[];
        recipientCursorsMessage: RecipientCursor[];
        badgeAttentionChanged: boolean;
        didWrite: boolean;
        didUpdate: boolean;
        message: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | { ok: false; error: "session-not-found" | "invalid-params" }
    | {
        ok: false;
        error: "transcript-conflict";
        pendingStateChanged: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        badgeAttentionChanged: boolean;
      }
>> {
    if (!canTransitionPendingDeliveryStatus(params.existing, params.target)) {
        return { ok: false, error: "invalid-params" };
    }

    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, encryptionMode: true },
    });
    if (!session) return { ok: false, error: "session-not-found" };

    const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
    if (params.acceptedDelivery !== undefined && params.acceptedDelivery.t !== (
        sessionEncryptionMode === "plain" ? "plain" : "encrypted"
    )) {
        return { ok: false, error: "invalid-params" };
    }
    const content = params.existing.content as PrismaJson.SessionPendingMessageContent;
    const messageRole = resolveSessionMessageRole({
        content,
        suppliedRole: params.existing.messageRole,
        telemetry: {
            sessionId: params.sessionId,
            storageMode: sessionEncryptionMode,
            source: "pending-materialization",
        },
    }).messageRole;
    const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
    const policy = readEncryptionFeatureEnv(process.env);
    if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
        return { ok: false, error: "invalid-params" };
    }
    const inputAdmissionReceipt = params.existing.inputAdmissionReceipt == null
        ? undefined
        : createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(params.existing.inputAdmissionReceipt);
    const requestEqualityEvidenceV1 = params.existing.requestEqualityEvidenceV1 == null
        ? undefined
        : createStoredReadSchema(SessionInputRequestEqualityEvidenceV1Schema).safeParse(params.existing.requestEqualityEvidenceV1);
    if (
        inputAdmissionReceipt !== undefined && !inputAdmissionReceipt.success
        || requestEqualityEvidenceV1 !== undefined && !requestEqualityEvidenceV1.success
    ) {
        return { ok: false, error: "invalid-params" };
    }

    if (params.target.reason === 'provider_accepted' && !await bindSessionInputReplyAcceptedTurnInTx(tx, {
        sessionId: params.sessionId, localId: params.localId,
        acceptedTurnId: params.acceptedTurn?.turnId ?? (params.acceptedDelivery?.t === 'plain' ? params.acceptedDelivery.v.delivery.turnId : undefined),
    })) return { ok: false, error: 'invalid-params' };
    const committed = await createSessionMessageFromPending(tx, {
        sessionId: params.sessionId,
        sessionEncryptionMode,
        storagePolicy: policy.storagePolicy,
        localId: params.localId,
        expectedSidechainId: params.expectedSidechainId ?? null,
        targetExecutionRunId: params.existing.targetExecutionRunId,
        content,
        messageRole,
        pendingRequestedAction: params.existing.requestedAction,
        ...(inputAdmissionReceipt === undefined
            ? {}
            : { inputAdmissionReceipt: inputAdmissionReceipt.data }),
        ...(requestEqualityEvidenceV1 === undefined
            ? {}
            : { requestEqualityEvidenceV1: requestEqualityEvidenceV1.data }),
        ...(params.target.reason === "manual_handled"
            ? { deliveryResolution: { v: 1, kind: "manual_handled" } as const }
            : params.acceptedDelivery === undefined ? {} : {
                deliveryResolution: { v: 1, kind: "provider_accepted", content: params.acceptedDelivery } as const,
            }),
    });
    if (!committed.ok) {
        if (committed.error === "storage-mode-conflict") {
            return { ok: false, error: "invalid-params" };
        }
        const blocked = await markPendingDeliveryRowsBlocked(tx, {
            sessionId: params.sessionId,
            rows: [{
                localId: params.localId,
                status: params.existing.status,
                deliveryState: params.existing.deliveryState,
                deliveryBlockedReason: params.existing.deliveryBlockedReason,
                discardedReason: params.existing.discardedReason,
            }],
            reason: "unknown",
        });
        await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
            tx,
            sessionId: params.sessionId,
            requestId: params.localId,
        });
        const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
            tx,
            sessionId: params.sessionId,
            pendingBlockedCountDelta: params.existing.targetExecutionRunId == null ? blocked.pendingBlockedCountDelta : 0,
        });
        return {
            ok: false,
            error: committed.error,
            pendingStateChanged: true,
            pendingVersion,
            pendingCount,
            pendingBlockedCount,
            recipientCursors,
            badgeAttentionChanged,
        };
    }
    if (params.target.reason === 'provider_accepted') {
        const receipt = inputAdmissionReceipt?.data;
        const originalKey = receipt?.followDeliveryV1
            ? deriveSessionFollowOriginalOccurrenceKeyV1(receipt.followDeliveryV1.original) : null;
        if (originalKey && receipt && (params.acceptedDelivery || params.acceptedTurn)) {
            await tx.sessionMessage.update({ where: { id: committed.message.id }, data: { acceptedFollowOriginalKey: originalKey } });
            await settleAcceptedSessionFollowInputInTx(tx, { destinationSessionId: params.sessionId, receipt });
        }
        const acceptedTurn = params.acceptedTurn
            ?? (params.acceptedDelivery?.t === 'plain' ? params.acceptedDelivery.v.delivery : undefined);
        if (acceptedTurn) {
            const stamped = await tx.sessionMessage.updateMany({
                where: { sessionId: params.sessionId, localId: params.localId, acceptedTurnId: null },
                data: { acceptedTurnKind: acceptedTurn.kind, acceptedTurnId: acceptedTurn.turnId },
            });
            if (stamped.count !== 1) {
                const existingTurn = await tx.sessionMessage.findUnique({
                    where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
                    select: { acceptedTurnKind: true, acceptedTurnId: true },
                });
                if (existingTurn?.acceptedTurnKind !== acceptedTurn.kind
                    || existingTurn.acceptedTurnId !== acceptedTurn.turnId) {
                    return { ok: false, error: 'invalid-params' };
                }
            }
            await reconcileAutonomousExchangeAcceptedTurnInTx(tx, {
                sessionId: params.sessionId, turnId: acceptedTurn.turnId,
            });
        }
    }
    const readyProjection = committed.didWrite
        ? await updateSessionMessageActivityProjection(tx, {
            sessionId: params.sessionId,
            created: committed.message,
            trustedSessionEventType: resolveReadyProjectionEventType({
                actorUserId: params.actorUserId,
                sessionOwnerId: session.accountId,
                content,
            }),
        })
        : undefined;

    await tx.sessionPendingMessage.delete({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
    });
    await reconcilePendingActivationAuthorizationForRemovedRequestInTx({
        tx,
        sessionId: params.sessionId,
        requestId: params.localId,
    });

    const previousDeliveryStatus = readPendingDeliveryStatus(params.existing);
    const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
        tx,
        sessionId: params.sessionId,
        pendingCountDelta: params.existing.targetExecutionRunId != null || previousDeliveryStatus.status === "discarded" ? 0 : -1,
        pendingBlockedCountDelta: params.existing.targetExecutionRunId == null && previousDeliveryStatus.status === "blocked" ? -1 : 0,
        meaningfulActivityAt: committed.didWrite ? committed.message.createdAt : undefined,
    });
    const recipientCursorsMessage = committed.didWrite || committed.didUpdate
        ? await markSessionProjectionRecipientsChanged({
            tx,
            sessionId: params.sessionId,
            hint: { lastMessageSeq: committed.message.seq, lastMessageId: committed.message.id },
        })
        : [];

    return {
        ok: true,
        pendingVersion,
        pendingCount,
        pendingBlockedCount,
        recipientCursors,
        recipientCursorsPending: recipientCursors,
        recipientCursorsMessage,
        badgeAttentionChanged,
        didWrite: committed.didWrite,
        didUpdate: committed.didUpdate,
        message: committed.message,
        ...(readyProjection ? { readyProjection } : {}),
    };
}

export async function resolveAcceptedPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    expectedSidechainId?: string | null;
    localId: string;
    publisherAuthority: CurrentSessionPublisherAuthority;
    diagnosticCorrelationId?: string;
    acceptedDelivery?: SessionMessageAcceptedDeliveryContentV1;
    acceptedTurn?: SessionMessageAcceptedTurnV1;
}): Promise<ResolveAcceptedPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const acceptedDelivery = params.acceptedDelivery === undefined
        ? undefined : SessionMessageAcceptedDeliveryContentV1Schema.safeParse(params.acceptedDelivery);
    if (acceptedDelivery !== undefined && !acceptedDelivery.success) return { ok: false, error: "invalid-params" };
    const acceptedTurn = params.acceptedTurn === undefined
        ? undefined : SessionMessageAcceptedTurnV1Schema.safeParse(params.acceptedTurn);
    if (acceptedTurn !== undefined && !acceptedTurn.success) return { ok: false, error: "invalid-params" };
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const sidechain = params.expectedSidechainId == null ? null : SidechainIdSchema.safeParse(params.expectedSidechainId);
    if (sidechain !== null && !sidechain.success) return { ok: false, error: "invalid-params" };
    const expectedSidechainId = sidechain?.data ?? null;
    if ((targetExecutionRunId === null) !== (expectedSidechainId === null)) return { ok: false, error: "invalid-params" };
    const localId = readPendingLocalId(params.localId) ?? "";
    if (!actorUserId || !sessionId || !localId) {
        return { ok: false, error: "invalid-params" };
    }

    const access = await resolveStructuralSessionAccess(db, { accountId: actorUserId, sessionId: sessionId });
    if (!access) return { ok: false, error: "session-not-found" };
    if (access.level !== "owner") return { ok: false, error: "forbidden" };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => pendingPublicationResult<ResolveAcceptedPendingDeliveryResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
            const result: PendingPublicationFields<ResolveAcceptedPendingDeliveryResult> = await (async () => {
                const access = await assertSessionOwnerInTx({ tx, accountId: actorUserId, sessionId });
                if (!access.ok) return { ok: false, error: "session-not-found" } as const;
                if (!await hasExactCurrentPublisherAuthorityInTx(
                    tx,
                    params.publisherAuthority,
                    actorUserId,
                    sessionId,
                )) {
                    return { ok: false, error: "forbidden" } as const;
                }
                if (targetExecutionRunId !== null && !await hasCurrentPublisherTargetAdmissionCapabilityInTx(tx, params.publisherAuthority)) {
                    return { ok: false, error: "forbidden" } as const;
                }
                const existing = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                    select: {
                        targetExecutionRunId: true,
                        status: true,
                        deliveryState: true,
                        deliveryBlockedReason: true,
                        discardedReason: true,
                        messageRole: true,
                        content: true,
                        requestedAction: true,
                        position: true,
                        inputAdmissionReceipt: true,
                        requestEqualityEvidenceV1: true,
                    },
                });

                if (!existing) {
                    const committed = await tx.sessionMessage.findFirst({
                        where: {
                            sessionId,
                            localId,
                            sidechainId: expectedSidechainId,
                            OR: [
                                { messageRole: "user" },
                                { messageRole: null },
                            ],
                        },
                        select: { id: true, seq: true, localId: true, sidechainId: true, targetExecutionRunId: true, messageRole: true, content: true, inputAdmissionReceipt: true, authorAccountId: true, deliveryResolution: true, createdAt: true, updatedAt: true },
                    });
                    if (!committed) {
                        return { ok: false, error: "not-found" } as const;
                    }
                    if (committed.targetExecutionRunId !== targetExecutionRunId) {
                        return { ok: false, error: "transcript-conflict" } as const;
                    }
                    if (targetExecutionRunId !== null) {
                        const content = committed.content as PrismaJson.SessionMessageContent;
                        const recipient = readParticipantRecipientRoutingIdentityV1(readPlainMessageMeta(content), 'stored');
                        if (content.t === "plain" && (recipient?.kind !== "execution_run" || recipient.runId !== targetExecutionRunId)) {
                            return { ok: false, error: "transcript-conflict" } as const;
                        }
                    }

                    return {
                        ok: true,
                        ...(await readCurrentPendingMutationState(tx, sessionId)),
                        didResolve: false,
                        message: {
                            id: committed.id,
                            seq: committed.seq,
                            localId: committed.localId ?? localId,
                            sidechainId: committed.sidechainId,
                            inputAdmissionReceipt: createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(committed.inputAdmissionReceipt).data ?? null,
                            authorAccountId: committed.authorAccountId,
                            messageRole: parseSessionMessageRole(committed.messageRole),
                            content: committed.content as PrismaJson.SessionMessageContent,
                            deliveryResolution: readStoredSessionMessageDeliveryResolutionV1(committed.deliveryResolution),
                            createdAt: committed.createdAt,
                            updatedAt: committed.updatedAt,
                        },
                    } as const;
                }

                if (!await isSessionInputTargetCurrentForPublisherInTx(tx, existing.inputAdmissionReceipt, params.publisherAuthority)) {
                    return { ok: false, error: "forbidden" } as const;
                }
                if (targetExecutionRunId !== null) {
                    if (existing.status !== "queued" || existing.deliveryState !== "delivering") {
                        return { ok: false, error: "not-materialized" } as const;
                    }
                    const content = existing.content as PrismaJson.SessionPendingMessageContent;
                    const recipient = readParticipantRecipientRoutingIdentityV1(readPlainMessageMeta(content), 'stored');
                    if (content.t === "plain" && (
                        recipient?.kind !== "execution_run"
                        || recipient.runId !== targetExecutionRunId
                        || readSessionInputRequest(readPlainMessageMeta(content), 'stored') !== null
                    )) return { ok: false, error: "transcript-conflict" } as const;
                }
                if (!canTransitionPendingDeliveryStatus(existing, { status: "resolved", reason: "provider_accepted" })) {
                    return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false };
                }

                const requestedAction = PendingRequestedActionV1StoredSchema.safeParse(existing.requestedAction);
                const isExactAction = requestedAction.success && requestedAction.data.kind !== "enqueue";
                const earlierUnresolved = isExactAction ? [] : await tx.sessionPendingMessage.findMany({
                    where: {
                        sessionId,
                        targetExecutionRunId,
                        status: "queued",
                        position: { lt: existing.position },
                    },
                    select: { status: true, targetExecutionRunId: true, deliveryState: true, deliveryBlockedReason: true,
                        inputAdmissionReceipt: true, autonomousExchangeCause: true },
                });
                for (const row of earlierUnresolved) {
                    if (!await isRetainedPendingContextForPublisherInTx(tx, row, params.publisherAuthority)) {
                        return { ok: false, error: "blocked-by-earlier-pending" } as const;
                    }
                }

                const resolved = await commitResolvedPendingDelivery(tx, {
                    actorUserId,
                    sessionId,
                    localId,
                    existing,
                    expectedSidechainId,
                    target: { status: "resolved", reason: "provider_accepted" },
                    ...(acceptedDelivery === undefined ? {} : { acceptedDelivery: acceptedDelivery.data }),
                    ...(acceptedTurn === undefined ? {} : { acceptedTurn: acceptedTurn.data }),
                });
                if (!resolved.ok) return resolved;
                return { ...resolved, didResolve: true };
            })();
            return await withTargetPendingStateInTx(tx, sessionId, targetExecutionRunId, result);
        }), { transactionClass: "pending-provider-acceptance" }));
    } catch (error) {
        const acquisitionUnavailable = isTransactionAcquisitionUnavailableError(error);
        if (acquisitionUnavailable || isTransactionConflictExhaustedError(error)) {
            reportPendingOperationError({
                operation: "provider-acceptance",
                sessionId,
                localId,
                diagnosticCorrelationId: params.diagnosticCorrelationId,
                ...(acquisitionUnavailable ? { prismaCode: "P2028" } : {}),
                error,
            }, acquisitionUnavailable
                ? "pending delivery transaction acquisition failed"
                : "pending delivery transaction temporarily unavailable");
            return {
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: 1_000,
                ...(params.diagnosticCorrelationId ? { correlationId: params.diagnosticCorrelationId } : {}),
            };
        }
        return { ok: false, error: "internal" };
    }
}

export type BlockPendingDeliveryResult =
    | { ok: true; targetPendingState?: TargetPendingState; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; didUpdate: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function blockPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    authentication?: SessionAccessAuthentication;
    targetExecutionRunId?: string | null;
    publisherAuthority?: CurrentSessionPublisherAuthority;
    localId: string;
    reason: PendingDeliveryBlockedReason;
}): Promise<BlockPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";
    const reason = normalizePendingDeliveryBlockedReason(params.reason);

    if (!actorUserId || !sessionId || !localId || !reason) return { ok: false, error: "invalid-params" };

    if (params.authentication) {
        const decision = await resolveSessionAccessForOperation(db, {
            accountId: actorUserId,
            sessionId,
            authentication: params.authentication,
            capability: "editSessionRecords",
        });
        if (decision.status !== "allowed") return { ok: false, error: "session-not-found" };
    } else {
        const access = await resolveStructuralSessionAccess(db, { accountId: actorUserId, sessionId });
        if (!access) return { ok: false, error: "session-not-found" };
        if (access.level !== "owner") return { ok: false, error: "forbidden" };
    }

    try {
        return await inTx(async (tx) => pendingPublicationResult<BlockPendingDeliveryResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
            const result: PendingPublicationFields<BlockPendingDeliveryResult> = await (async () => {
                const access = params.authentication
                    ? await assertSessionCapabilityInTx({
                        tx,
                        accountId: actorUserId,
                        sessionId,
                        capability: "editSessionRecords",
                        authentication: params.authentication,
                    })
                    : await assertSessionOwnerInTx({ tx, accountId: actorUserId, sessionId });
                if (!access.ok) return { ok: false, error: "session-not-found" } as const;
                if (targetExecutionRunId !== null && (
                    !params.publisherAuthority
                    || !await hasExactCurrentPublisherAuthorityInTx(tx, params.publisherAuthority, actorUserId, sessionId)
                    || !await hasCurrentPublisherTargetAdmissionCapabilityInTx(tx, params.publisherAuthority)
                )) return { ok: false, error: "forbidden" } as const;
                if (targetExecutionRunId === null && reason === "session_input_target_unavailable") {
                    return { ok: false, error: "invalid-params" } as const;
                }
                const existing = await tx.sessionPendingMessage.findUnique({
                    where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                    select: {
                        status: true,
                        deliveryState: true,
                        deliveryBlockedReason: true,
                        discardedReason: true,
                        requestedAction: true,
                        providerAction: true,
                        updatedAt: true,
                    },
                });
                if (!existing) return { ok: false, error: "not-found" } as const;
                if (reason === "host_retired_before_dispatch" && (existing.status !== "queued"
                    || existing.deliveryState !== "delivering" && !(existing.deliveryState === "blocked"
                        && existing.deliveryBlockedReason === "host_retired_before_dispatch"))) {
                    // A delayed retiring host cannot turn a successor's
                    // uncertainty (or a terminal disposition) into replay proof.
                    return { ok: false, error: "delivery-settlement-conflict" } as const;
                }
                if (reason === "conditional_steer_unavailable") {
                    const requestedAction = PendingRequestedActionV1StoredSchema.safeParse(existing.requestedAction);
                    if (
                        existing.status === "queued"
                        && existing.deliveryState === null
                        && existing.deliveryBlockedReason === null
                        && existing.providerAction === null
                        && requestedAction.success
                        && requestedAction.data.kind === "enqueue"
                    ) {
                        return {
                            ok: true,
                            ...(await readCurrentPendingMutationState(tx, sessionId)),
                            didUpdate: false,
                        } as const;
                    }
                    if (
                        existing.status !== "queued"
                        || existing.deliveryState !== "delivering"
                        || !requestedAction.success
                        || !isConditionalPendingSteerClaim({
                            requestedAction: requestedAction.data,
                            providerAction: existing.providerAction,
                        })
                    ) {
                        return { ok: false, error: "delivery-settlement-conflict" } as const;
                    }
                    const nextUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
                    const updated = await tx.sessionPendingMessage.updateMany({
                        where: {
                            sessionId,
                            localId,
                            status: "queued",
                            deliveryState: "delivering",
                            deliveryBlockedReason: existing.deliveryBlockedReason,
                            providerAction: "steer",
                            updatedAt: existing.updatedAt,
                        },
                        data: pendingRequestedActionReplacementData(
                            { v: 1, kind: "enqueue" },
                            nextUpdatedAt,
                        ),
                    });
                    if (updated.count !== 1) {
                        return { ok: false, error: "delivery-settlement-conflict" } as const;
                    }
                    await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
                    const state = await applyPendingSessionStateChange({ tx, sessionId });
                    return { ok: true, ...state, didUpdate: true } as const;
                }
                const target = { status: "blocked", reason } as const;
                if (!canTransitionPendingDeliveryStatus(existing, target)) {
                    return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
                }
                if (existing.deliveryState === "blocked" && existing.deliveryBlockedReason === reason) {
                    return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
                }

                const persisted = pendingDeliveryStatusV1ToPersistedFields(target);
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: {
                        status: persisted.status,
                        deliveryState: persisted.deliveryState,
                        deliveryBlockedReason: persisted.deliveryBlockedReason,
                        discardedReason: persisted.discardedReason,
                    },
                });
                await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });

                const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                    tx,
                    sessionId,
                    pendingBlockedCountDelta: targetExecutionRunId !== null || readPendingDeliveryStatus(existing).status === "blocked" ? 0 : 1,
                });
                return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged, didUpdate: true };
            })();
            return await withTargetPendingStateInTx(tx, sessionId, targetExecutionRunId, result);
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type SendPendingDeliveryAsNewResult =
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        badgeAttentionChanged: boolean;
        didWrite: boolean;
        newLocalId: string;
      }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "identity-conflict" | "internal" };

function derivePendingSendAsNewLocalId(sessionId: string, localId: string): string {
    const digest = createHash("sha256")
        .update(`happier.pending.send-as-new.v1\0${sessionId}\0${localId}`, "utf8")
        .digest("hex");
    return `send-as-new-${digest}`;
}

export async function sendPendingDeliveryAsNew(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    authentication: SessionAccessAuthentication;
}): Promise<SendPendingDeliveryAsNewResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) {
        return { ok: false, error: "invalid-params" };
    }
    const newLocalId = derivePendingSendAsNewLocalId(sessionId, localId);

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inPendingQueuePositionTx(sessionId, async (tx) => pendingPublicationResult<SendPendingDeliveryAsNewResult>(async () => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                select: {
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    authorAccountId: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                    replyProgress: true,
                },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (!projectPendingDeliveryRecovery(existing).canSendAsNew) return { ok: false, error: 'delivery-settlement-conflict' } as const;
            const existingStatus = readPendingDeliveryStatus(existing);

            const replacement = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId: newLocalId } },
                select: { targetExecutionRunId: true, status: true, deliveryState: true, messageRole: true, content: true, requestedAction: true },
            });
            const replacementAction = { v: 1, kind: "enqueue" } as const;
            if (existingStatus.status === "discarded" && existingStatus.reason === "resent_as_new") {
                if (
                    replacement
                    && replacement.targetExecutionRunId === targetExecutionRunId
                    && replacement.status === "queued"
                    && replacement.deliveryState === null
                    && replacement.messageRole === existing.messageRole
                    && isDeepStrictEqual(replacement.content, existing.content)
                    && isDeepStrictEqual(normalizePendingRequestedActionV1(replacement.requestedAction, 'stored'), replacementAction)
                ) {
                    return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didWrite: false, newLocalId };
                }
                return { ok: false, error: "identity-conflict" } as const;
            }
            if (existingStatus.status !== "blocked" || !isPendingDeliveryProviderEffectPossibleV1(existingStatus)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (replacement) return { ok: false, error: "identity-conflict" } as const;
            const transcriptCollision = await tx.sessionMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId: newLocalId } },
                select: { id: true },
            });
            if (transcriptCollision) return { ok: false, error: "identity-conflict" } as const;

            const position = await reserveNextPendingQueuePosition(tx, sessionId);
            const persisted = pendingDeliveryStatusV1ToPersistedFields({ status: "discarded", reason: "resent_as_new" });
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: persisted.status,
                    deliveryState: persisted.deliveryState,
                    deliveryBlockedReason: persisted.deliveryBlockedReason,
                    discardedReason: persisted.discardedReason,
                    discardedAt: new Date(),
                },
            });
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId: newLocalId,
                    targetExecutionRunId,
                    messageRole: existing.messageRole,
                    content: existing.content,
                    requestedAction: replacementAction,
                    status: "queued",
                    position,
                    authorAccountId: existing.authorAccountId,
                    ...(existing.inputAdmissionReceipt == null
                        ? {}
                        : { inputAdmissionReceipt: existing.inputAdmissionReceipt }),
                },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingBlockedCountDelta: targetExecutionRunId === null ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged, didWrite: true, newLocalId };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type MarkPendingDeliveryHandledResult =
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        recipientCursors: RecipientCursor[];
        recipientCursorsPending?: RecipientCursor[];
        recipientCursorsMessage?: RecipientCursor[];
        badgeAttentionChanged: boolean;
        didResolve: boolean;
        didWrite?: boolean;
        didUpdate?: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: false;
        error: PendingSessionAccessError | "forbidden" | "invalid-params" | "transcript-conflict" | "internal";
        pendingStateChanged?: boolean;
        pendingVersion?: number;
        pendingCount?: number;
        pendingBlockedCount?: number;
        recipientCursors?: RecipientCursor[];
        badgeAttentionChanged?: boolean;
      };

export async function markPendingDeliveryHandled(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    authentication: SessionAccessAuthentication;
}): Promise<MarkPendingDeliveryHandledResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => pendingPublicationResult<MarkPendingDeliveryHandledResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId: null },
                select: {
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    discardedReason: true,
                    messageRole: true,
                    content: true,
                    requestedAction: true,
                    position: true,
                    inputAdmissionReceipt: true,
                    requestEqualityEvidenceV1: true,
                },
            });
            if (!existing || !canTransitionPendingDeliveryStatus(existing, { status: "resolved", reason: "manual_handled" })) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false };
            }

            const resolved = await commitResolvedPendingDelivery(tx, {
                actorUserId,
                sessionId,
                localId,
                existing,
                target: { status: "resolved", reason: "manual_handled" },
            });
            if (!resolved.ok) return resolved;
            return { ...resolved, didResolve: true };
        })));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DismissPendingDeliveryResult =
    | { ok: true; didDismiss: boolean; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function dismissPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    now?: Date;
    authentication: SessionAccessAuthentication;
}): Promise<DismissPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";
    const now = params.now instanceof Date ? params.now : new Date();
    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await rejoinPendingDeliveryResolutionRace(() => inTx(async (tx) => pendingPublicationResult<DismissPendingDeliveryResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            const status = readPendingDeliveryStatus(existing);
            if (status.status === "discarded" && status.reason === "dismissed_uncertain") {
                return { ok: true, didDismiss: false, ...(await readCurrentPendingMutationState(tx, sessionId)) } as const;
            }
            if (!isPendingDeliveryProviderEffectPossibleV1(status)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            const persisted = pendingDeliveryStatusV1ToPersistedFields({ status: "discarded", reason: "dismissed_uncertain" });
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: persisted.status,
                    deliveryState: persisted.deliveryState,
                    deliveryBlockedReason: persisted.deliveryBlockedReason,
                    discardedAt: now,
                    discardedReason: persisted.discardedReason,
                },
            });
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });
            const state = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null ? -1 : 0,
                pendingBlockedCountDelta: targetExecutionRunId === null && status.status === "blocked" ? -1 : 0,
            });
            return { ok: true, didDismiss: true, ...state } as const;
        })));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DiscardPendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" };

export async function discardPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    reason?: string;
    now?: Date;
    authentication: SessionAccessAuthentication;
}): Promise<DiscardPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";
    const reason = typeof params.reason === "string" ? params.reason : null;
    const now = params.now instanceof Date ? params.now : new Date();

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };
    if (isPendingDeliveryArchivedUncertaintyReasonV1(reason)) {
        return { ok: false, error: "delivery-settlement-conflict" };
    }

    try {
        return await inTx(async (tx) => pendingPublicationResult<DiscardPendingMessageResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            // Explicit discard is a durable user cancellation, so the delivery
            // status transition protocol owns the decision below: delivering
            // and external-handoff custody may be discarded, while archived
            // uncertainty identities stay reserved by the reason guard above.
            const target = { status: "discarded", reason } as const;
            if (readPendingDeliveryStatus(existing).status === "discarded" || !canTransitionPendingDeliveryStatus(existing, target)) {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    pendingBlockedCount: session?.pendingBlockedCount ?? 0,
                    recipientCursors: [],
                    badgeAttentionChanged: false,
                } as const;
            }

            const persisted = pendingDeliveryStatusV1ToPersistedFields(target);
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: {
                    status: persisted.status,
                    deliveryState: persisted.deliveryState,
                    deliveryBlockedReason: persisted.deliveryBlockedReason,
                    discardedAt: now,
                    discardedReason: persisted.discardedReason,
                },
            });
            await settleUnacceptedSessionInputReplyInTx(tx, sessionId, localId, 'cancelled');
            await reconcilePendingActivationAuthorizationForRemovedRequestInTx({ tx, sessionId, requestId: localId });

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null ? -1 : 0,
                pendingBlockedCountDelta: targetExecutionRunId === null && readPendingDeliveryStatus(existing).status === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type RestorePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "not-found" | "delivery-settlement-conflict" | "internal" }
    | { ok: false; error: "transaction-unavailable"; retryAfterMs: number };

export async function restorePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    localId: string;
    authentication: SessionAccessAuthentication;
}): Promise<RestorePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const localId = readPendingLocalId(params.localId) ?? "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inPendingQueuePositionTx(sessionId, async (tx) => pendingPublicationResult<RestorePendingMessageResult>(async () => {
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId }, targetExecutionRunId },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true, replyProgress: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (existing.replyProgress !== null && existing.status === 'discarded') return { ok: false, error: 'delivery-settlement-conflict' } as const;
            if (existing.status === "discarded" && isPendingDeliveryArchivedUncertaintyReasonV1(existing.discardedReason)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }
            if (isOrdinaryPendingMutationFenced(existing)) {
                return { ok: false, error: "delivery-settlement-conflict" } as const;
            }

            const target = { status: "queued" } as const;
            if (canTransitionPendingDeliveryStatus(existing, target) && readPendingDeliveryStatus(existing).status === "discarded") {
                const position = await reserveNextPendingQueuePosition(tx, sessionId);
                const persisted = pendingDeliveryStatusV1ToPersistedFields(target);

                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: {
                        status: persisted.status,
                        deliveryState: persisted.deliveryState,
                        deliveryBlockedReason: persisted.deliveryBlockedReason,
                        discardedAt: null,
                        discardedReason: persisted.discardedReason,
                        position,
                    },
                });
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: targetExecutionRunId === null && existing.status === "discarded" ? 1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged };
        }));
    } catch (error) {
        if (isTransactionAcquisitionUnavailableError(error) || isTransactionConflictExhaustedError(error)) {
            return { ok: false, error: "transaction-unavailable", retryAfterMs: 1_000 };
        }
        return { ok: false, error: "internal" };
    }
}

export type ReorderPendingMessagesResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; meaningfulActivityAt?: Date }
    | { ok: false; error: PendingSessionAccessError | "forbidden" | "invalid-params" | "internal" };

export async function reorderPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    targetExecutionRunId?: string | null;
    orderedLocalIds: string[];
    authentication: SessionAccessAuthentication;
}): Promise<ReorderPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const target = parsePendingExecutionTarget(params.targetExecutionRunId);
    if (!target.ok) return target;
    const { targetExecutionRunId } = target;
    const orderedLocalIds = Array.isArray(params.orderedLocalIds) ? params.orderedLocalIds.filter(isPendingLocalId) : [];

    if (!actorUserId || !sessionId || orderedLocalIds.length === 0) return { ok: false, error: "invalid-params" };
    if (new Set(orderedLocalIds).size !== orderedLocalIds.length) return { ok: false, error: "invalid-params" };

    const accessDecision = await resolveSessionAccessForOperation(db, {
        accountId: actorUserId,
        sessionId,
        authentication: params.authentication,
        capability: "submitAgentInput",
    });
    if (accessDecision.status !== "allowed") return { ok: false, error: projectPendingSessionAccessError(accessDecision.status) };
    if (!accessDecision.access.capabilities.submitAgentInput) return { ok: false, error: "forbidden" };

    try {
        return await inTx(async (tx) => pendingPublicationResult<ReorderPendingMessagesResult>(async () => {
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId]);
            const access = await assertSessionCapabilityInTx({ tx, accountId: actorUserId, sessionId, capability: "submitAgentInput", authentication: params.authentication });
            if (!access.ok) return { ok: false, error: projectPendingSessionAccessError(access.reason) } as const;
            const queued = await tx.sessionPendingMessage.findMany({
                where: { sessionId, targetExecutionRunId, status: "queued" },
                select: { localId: true, deliveryState: true, deliveryBlockedReason: true, position: true },
                orderBy: { position: "asc" },
            });
            const queuedIds = queued.map((v) => v.localId);
            if (queuedIds.length !== orderedLocalIds.length) return { ok: false, error: "invalid-params" } as const;

            const a = new Set(queuedIds);
            for (const id of orderedLocalIds) {
                if (!a.has(id)) return { ok: false, error: "invalid-params" } as const;
            }
            const queuedByLocalId = new Map(queued.map((row) => [row.localId, row]));
            const orderedIndexByLocalId = new Map(orderedLocalIds.map((localId, index) => [localId, index]));
            for (let existingIndex = 0; existingIndex < queued.length; existingIndex++) {
                const row = queued[existingIndex];
                if (
                    isOrdinaryPendingMutationFenced({ status: "queued", ...row })
                    && orderedIndexByLocalId.get(row.localId) !== existingIndex
                ) {
                    // A provider-effect-possible row keeps its queue slot, so
                    // an ordering that would move it is invalid for the
                    // current queue rather than a settlement conflict.
                    return { ok: false, error: "invalid-params" } as const;
                }
            }

            for (const [index, localId] of orderedLocalIds.entries()) {
                const position = queued[index].position;
                const row = queuedByLocalId.get(localId);
                if (
                    (row && isOrdinaryPendingMutationFenced({ status: "queued", ...row }))
                    || row?.position === position
                ) {
                    continue;
                }
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { position },
                });
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, recipientCursors, badgeAttentionChanged };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type { MaterializeNextPendingMessageResult } from "@/app/session/pending/materializeNextPendingMessage";
export {
    mapPendingMaterializationError,
    materializeNextPendingMessage,
    materializeNextPendingMessageInTx,
} from "@/app/session/pending/materializeNextPendingMessage";
