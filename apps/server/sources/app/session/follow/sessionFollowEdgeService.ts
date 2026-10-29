import { compareSessionFollowFrontierProgressV1, isSessionFollowFrontierEqualV1, isSessionFollowTurnEqualV1, isSessionFollowConsumptionWithinCurrentV1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { deriveSessionFollowWakeEventLocalIdV1, normalizeSessionFollowWakeObservationsV1,
    type SessionFollowAcknowledgeRequestV1, type SessionFollowObserveInactiveResponseV1,
    type SessionFollowObservePendingRequestV1, type SessionFollowObservePendingResponseV1,
    type SessionFollowPendingObservationV1, type SessionFollowSessionPendingObservationV1,
    type SessionFollowObserveSourceRoutesRequestV1, type SessionFollowObserveSourceRoutesResponseV1,
    SessionFollowRunOccurrenceRoutesResponseV1Schema, type SessionFollowRunOccurrenceRoutesRequestV1,
    type SessionFollowRunOccurrenceRoutesResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { FollowPolicyV1Schema, isFollowPolicyEqualV1, serializeFollowPolicyV1, resolveFollowDeliveryV1, FOLLOW_EVENT_KINDS_V1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { SessionPendingEnqueueByMachineRequestV1 } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { isDeepStrictEqual } from 'node:util';
import { AutonomousExchangeStateV1Schema, createAutonomousExchangeStateV1,
    readAutonomousExchangeAdmissionV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { isPlainMachineDataKeyMarker } from '@happier-dev/protocol/machines/machineStoredContent';
import { type FollowSourceRelationV1, type SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { type SessionFollowSourceProjectionRequestV1, type SessionFollowSourceProjectionResponseV1, SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { deriveSessionFollowOriginalOccurrenceKeyV1, deriveSessionFollowInputLocalIdV1, isRunFollowOriginalV1, resolveExecutionRunFollowOccurrenceV1, resolveSessionFollowTurnEventV1, type SessionFollowInputV1, type RunFollowOriginalV1, type RunFollowOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { ExecutionRunOutputRefV1 } from '@happier-dev/protocol/reviews/reviewNarration';
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";

import {
    resolveEffectiveSessionAccess,
} from "@/app/session/access/sessionAccess";
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import {
    assertSessionFollowSourceReadInTx,
    assertSessionFollowSourceReadsInTx,
    evaluateCurrentSessionContextPairInTx,
    mayInjectSessionContextInTx,
    mayInjectSessionContextForSourcesInTx,
    resolveSessionFollowRuntimePrincipalAuthenticationInTx,
    type SessionFollowRuntimePrincipalV1,
} from "@/app/session/access/sessionContextInjection";
import { AccountStatus } from "@/storage/prisma";
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { readSnapshotWithCurrentAdmission } from "@/storage/readSnapshotWithCurrentAdmission";
import {
    readCurrentSourceSessionFollowFrontier,
    readStoredSessionFollowFrontier,
    writeSessionFollowFrontierColumns,
} from "@/app/session/relations/sessionEdgeFrontier";
import {
    hasCanonicalFollowProviderInputAcceptanceInTx,
    hasCanonicalFollowWakeEventAcceptanceInTx,
} from "./providerInputAcceptance";
import { projectSessionMessageAccountActors } from "@/app/session/messages/projectSessionMessageAccountActors";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from "@/app/session/access/sessionRecipients";
import { readSessionPendingReviewRunCountsInTx } from '@/app/session/awareness/sessionManagerProjection';
import { parseStoredSessionRuntimeIssue, parseStoredSessionTurnTranscriptAnchors } from '@/app/session/turns/parseSessionTurnState';
import { createDeliveryMuteReaderInTx, isDeliveryMutedInTx } from './sessionDeliveryMuteService';
import { sourceForSessionFollowEdgeV1, sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { discussionContextStorageAdapter } from '@/app/discussions/access';
import { mayInjectResourceContextInTx } from '@/app/session/access/sessionContextInjection';
import { resolveWorkflowRunAccessInTx } from '@/app/workflows/workflowRunAccess';
import { isPublicSessionShareActive } from '@/app/share/publicSessionSharePublication';
import { canReadFollowSourceInTx, readExecutionRunFollowMachineAdmissionInTx } from './followSourceAdmission';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isExecutionRunFollowFrontierWitnessCurrentInTx, type ExecutionRunFollowFrontierWitness } from './executionRunFollowSource';
import { pageFollowListV1, readFollowListCursorV1, parseFollowListRequestV1, type FollowListRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowListV1';
import { openSessionFollowListCursor, sealSessionFollowListCursor } from './sessionFollowListCursor';
import { readCurrentCommittedSessionInputMachineTargetInTx, readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { readAdmittedSessionFollowInputInTx, readSessionFollowOriginalOccurrenceFrontiersInTx, resolveSessionFollowInputSelectedDelivery, sessionFollowInputFrontiers, settleSessionFollowInputReasonsInTx, type SessionFollowInputRelation } from './sessionFollowRuleProgress';
import { readAutonomousExchangeSourceRoot, readReceiverAutonomousExchangeRootInTx,
    isAutonomousExchangeRootReceiptForAccount, type AutonomousExchangeRoot } from '@/app/session/messages/readAutonomousExchangeSourceRoot';
import { observeDiscussionFollowSourcesInTx } from './discussionFollowSource';
import { observeAccountDiscussionFollowOccurrenceInTx, type DiscussionFollowOccurrenceUnavailableCode } from './discussionFollowSource';
import { SessionFollowRunOccurrenceRoutesRequestV1Schema, type SessionFollowSourceOccurrenceRoutesRequestV1,
    type SessionFollowSourceOccurrenceRoutesResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { readExactCurrentPublisherAuthorityInTx } from '@/app/session/pending/hasExactCurrentPublisherAuthorityInTx';
import { readStalledSessionFollowRulesInTx, acknowledgeStalledSessionFollowRulesInTx } from './sessionFollowStalledRule';
import { isSessionFollowStalledOccurrenceCurrentV1, type SessionFollowStalledOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import type { SessionFollowSelectedDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { readSessionFollowRouteDestinationsInTx } from './sessionFollowRouteAdmission';
import { projectSessionFollowDefaultRelationshipsV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveSessionFollowFactsInTx } from '@/app/session/personal/followFacts';
import { readOtherPersonalFollowerCensusInTx, readSessionPersonalFollowerCensusInTx, readAccountRunFollowDeliveryInTx } from './accountFollowService';
import type { SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { resolveWorkflowRunFollowEventV1 } from '@happier-dev/protocol/workflows/composeWorkflowRunWorkerUpdateV1';
import { workflowRunAttentionWhere } from '@/app/workflows/workflowRunAttention';
import type { Fastify } from '@/app/api/types';
import { readStoredPolicy, projectOtherFollowSourceInTx, hasPendingRunFollowOccurrenceInTx,
    readExecutionRunFollowProjectionFrontiers, type SessionFollowProjectionEdge } from './sessionFollowSourceProjection';
export { readStoredPolicy } from './sessionFollowSourceProjection';
export { attachDiscussionFollowSourceInTx, detachDiscussionFollowSourceInTx,
    admitDiscussionFollowAddressingInTx, acknowledgeDiscussionFollowInputInTx } from './discussionFollowSource';
import {
    invalidateSessionRelationProjectionsInTx as invalidateSessionFollowDestinationsInTx,
} from "@/app/session/relations/sessionRelationChanges";

/**
 * The canonical `SessionFollowEdge` owner.
 *
 * Every HTTP route, generated Action, and internal Session-socket operation
 * delegates here, so authorization, seeding, dormancy and the acknowledgment
 * compare-and-set have exactly one implementation. This module stores no
 * content, no delivery Account, no configuring author, and no runtime state.
 */

const SESSION_SELECT = {
    id: true,
    accountId: true,
    archivedAt: true,
    publisherGeneration: true,
    seq: true,
    latestReadyEventSeq: true,
    agentStateVersion: true,
    latestTurnId: true,
    latestTurnStatus: true,
    active: true,
    lastActiveAt: true,
} as const;

const EDGE_SELECT = {
    sourceKey: true,
    sourceSessionId: true,
    sourceDiscussionId: true,
    sourceExecutionRunSessionId: true,
    sourceExecutionRunMachineId: true,
    sourceExecutionRunId: true,
    sourceWorkflowRunId: true,
    destinationSessionId: true,
    relation: true,
    attachedAt: true,
    deliveredTranscriptSeq: true,
    deliveredReadyEventSeq: true,
    deliveredAgentStateVersion: true,
    deliveredTurnId: true,
    deliveredTurnStatus: true,
    deliveredWorkflowRunRevision: true,
    deliveredExecutionRunTerminalEventId: true,
    policyJson: true,
} as const;

type OtherFollowSource = Extract<FollowSourceRefV1, { kind: 'discussion' | 'execution_run' | 'workflow_run' }>;

async function canReadOtherFollowSourceInTx(tx: Tx, input: Readonly<{
    accountId: string; source: OtherFollowSource; authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    return canReadFollowSourceInTx(tx, input);
}

async function mayInjectOtherFollowSourceInTx(tx: Tx, input: Readonly<{
    accountId: string; source: OtherFollowSource; destinationSessionId: string; authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    if (input.source.kind === 'discussion') {
        const participant = await tx.discussionParticipant.findUnique({ where: { discussionId_sessionId: {
            discussionId: input.source.discussionId, sessionId: input.destinationSessionId,
        } }, select: { removedAt: true } });
        if (!participant || participant.removedAt !== null) return false;
        return (await mayInjectResourceContextInTx(tx, { configuringAccountId: input.accountId,
            authentication: input.authentication,
            source: { kind: 'resource', resourceId: input.source.discussionId, adapter: discussionContextStorageAdapter },
            destination: { kind: 'session', sessionId: input.destinationSessionId },
        })).ok;
    }
    if (input.source.kind === 'execution_run' && 'sessionId' in input.source) {
        return (await mayInjectResourceContextInTx(tx, { configuringAccountId: input.accountId,
            authentication: input.authentication,
            source: { kind: 'session', sessionId: input.source.sessionId },
            destination: { kind: 'session', sessionId: input.destinationSessionId },
        })).ok;
    }
    const destination = await tx.session.findUnique({ where: { id: input.destinationSessionId },
        select: { id: true, accountId: true, publicShare: { select: { expiresAt: true } } } });
    if (!destination || isPublicSessionShareActive(destination.publicShare)) return false;
    const audience = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [destination.id] });
    const accounts = new Set([destination.accountId, ...(audience.get(destination.id) ?? [])]);
    if (input.source.kind === 'execution_run') {
        const machineId = input.source.machineId;
        const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
            machineIds: [machineId], accountIds: [...accounts], rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
        });
        return [...accounts].every(accountId => access.get(machineId)?.get(accountId) != null);
    }
    for (const accountId of accounts) if (!await resolveWorkflowRunAccessInTx(tx, {
        actorAccountId: accountId, runId: input.source.runId })) return false;
    return true;
}

type SessionFollowSourceRunnerInput = Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    destinationSessionId: string;
    request: SessionFollowSourceProjectionRequestV1;
}>;

async function admitSessionFollowSourceForRunnerInTx(
    tx: Tx,
    input: SessionFollowSourceRunnerInput,
) {
    if (input.principal.kind === 'ephemeral_session_runner' && input.principal.sessionId !== input.destinationSessionId) return null;
    if (input.request.sourceSessionId === input.destinationSessionId) return null;
    if (input.principal.kind === 'ephemeral_session_runner' && !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)) return null;
    const accountId = input.principal.kind === 'destination_runtime'
        ? input.principal.destinationRuntimeAccountId : input.principal.accountId;
    const custody = input.request.localInputId ? await readAdmittedSessionFollowInputInTx(tx, {
        principal: input.principal, accountId, sourceSessionId: input.request.sourceSessionId,
        destinationSessionId: input.destinationSessionId, localInputId: input.request.localInputId,
    }) : null;
    const rule = input.request.relation === 'rule' ? (await readStalledSessionFollowRulesInTx(tx, {
        accountId, destinationSessionId: input.destinationSessionId, sourceSessionId: input.request.sourceSessionId,
    }))[0] : null;
    const edge = input.request.localInputId || input.request.relation === 'rule' ? null : readSessionEdge(await tx.sessionFollowEdge.findUnique({
        where: { destinationSessionId_sourceSessionId_relation: {
            destinationSessionId: input.destinationSessionId,
            sourceSessionId: input.request.sourceSessionId,
            relation: input.request.relation ?? 'follower',
        } },
        select: EDGE_SELECT,
    }));
    if (input.request.localInputId ? !custody : !edge && !rule) return null;
    if (custody && !custody.nativeAccepted && custody.effectiveDelivery === null) return null;
    if (edge?.relation === 'manager' && edge.attachedAt.getTime() !== input.request.attachedAt) return null;
    if (!(await assertSessionFollowSourceReadInTx(tx, {
        principal: input.principal,
        sourceSessionId: input.request.sourceSessionId,
        edge: { sourceSessionId: input.request.sourceSessionId, destinationSessionId: input.destinationSessionId },
    })).ok) return null;
    const destination = await loadSession(tx, input.destinationSessionId);
    if (!destination || destination.accountId !== accountId || destination.archivedAt !== null || !await isActingAccountActive(tx, accountId)) return null;
    if (!await canSubmitDestinationInput(
        tx,
        accountId,
        input.destinationSessionId,
        await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal),
    )) return null;
    if (await isDeliveryMutedInTx(tx, { accountId,
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
        candidate: { senderSessionId: input.request.sourceSessionId,
            source: { kind: 'session', sessionId: input.request.sourceSessionId } },
    }) !== false) return null;

    const source = await tx.session.findUnique({
        where: { id: input.request.sourceSessionId },
        select: {
            id: true, seq: true, encryptionMode: true, metadata: true, metadataLayoutVersion: true,
            archivedAt: true, createdAt: true, updatedAt: true, active: true, lastActiveAt: true,
            thinking: true, thinkingAt: true, latestTurnStatus: true, latestTurnStatusObservedAt: true,
            latestTurnId: true, lastRuntimeIssue: true,
            latestReadyEventSeq: true, latestReadyEventAt: true, meaningfulActivityAt: true,
            agentStateVersion: true, agentState: true, pendingPermissionRequestCount: true, pendingUserActionRequestCount: true,
            pendingRequestObservedAt: true, pendingCount: true, pendingBlockedCount: true,
            runtimeActivityState: true, runtimeActivityActiveCount: true,
        },
    });
    if (!source || source.archivedAt !== null || (source.encryptionMode !== "plain" && source.encryptionMode !== "e2ee")) return null;
    // The Runner reports the observation it is hydrating, but those sequence
    // numbers are never read authority. Bound the lower bound by the exact
    // transaction-loaded edge frontier so a stale or malicious caller cannot
    // replay already-delivered history, and reject an upper bound beyond the
    // source frontier this same transaction can currently observe. A cursor
    // above the frontier is a continuation inside the same pending range: a
    // wake scans past a full nonhuman page for protected human ingress (09D
    // §6.3), which delivery and ACK never skip.
    if (
        input.request.afterTranscriptSeq < (custody ? sessionFollowInputFrontiers(custody.delivery).expected.transcriptSeq
            : rule ? rule.observation.delivered.transcriptSeq : edge!.deliveredTranscriptSeq)
        || input.request.observedTranscriptSeq > source.seq
        || custody && input.request.observedTranscriptSeq > sessionFollowInputFrontiers(custody.delivery).observed.transcriptSeq
        || rule && input.request.observedTranscriptSeq > rule.observation.observed.transcriptSeq
    ) return null;
    return { edge, source, custody };
}

export async function projectSessionFollowSourceForRunnerInTx(
    tx: Tx, input: SessionFollowSourceRunnerInput,
): Promise<SessionFollowSourceProjectionResponseV1 | null> {
    const admission = await admitSessionFollowSourceForRunnerInTx(tx, input);
    if (!admission) return null;
    const { source, custody } = admission;
    const pendingReviewRuns = await readSessionPendingReviewRunCountsInTx(tx, [source.id]);
    const sourceTurn = custody && 'sourceTurn' in custody.delivery.original ? custody.delivery.original.sourceTurn : null;
    const turn = sourceTurn ? await tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
        sessionId: source.id, turnId: sourceTurn.id,
    } }, select: { status: true, transcriptAnchorsJson: true, lastRuntimeIssueJson: true } }) : null;
    if (sourceTurn && turn?.status !== sourceTurn.status) return null;
    const finalAssistantMessageSeq = turn ? parseStoredSessionTurnTranscriptAnchors(turn.transcriptAnchorsJson)?.finalAssistantMessageSeq : null;
    const messageSelect = { seq: true, localId: true, content: true, messageRole: true, createdAt: true,
        inputAdmissionReceipt: true, authorAccountId: true } as const;
    const terminalMessage = sourceTurn && finalAssistantMessageSeq != null
        ? await tx.sessionMessage.findFirst({ where: {
            sessionId: source.id, seq: finalAssistantMessageSeq,
        }, select: { ...messageSelect, sidechainId: true } }) : null;
    if (terminalMessage) {
        const content = SessionStoredMessageContentSchema.safeParse(terminalMessage.content);
        if (!content.success || (source.encryptionMode === 'plain') !== (content.data.t === 'plain')) return null;
    }
    const fetched = sourceTurn ? terminalMessage && terminalMessage.sidechainId === null && terminalMessage.messageRole === 'agent'
        ? [terminalMessage] : [] : await tx.sessionMessage.findMany({
        where: {
            sessionId: source.id,
            seq: { gt: input.request.afterTranscriptSeq, lte: input.request.observedTranscriptSeq },
        },
        select: messageSelect,
        orderBy: { seq: 'asc' },
        take: input.request.limit + 1,
    });
    const hasMore = !sourceTurn && fetched.length > input.request.limit;
    const page = fetched.slice(0, input.request.limit);
    const accountActors = await projectSessionMessageAccountActors(tx, page);
    return SessionFollowSourceProjectionResponseV1Schema.parse({
        v: 1,
        source: {
            id: source.id,
            encryptionMode: source.encryptionMode,
            metadata: source.metadata,
            metadataLayoutVersion: source.metadataLayoutVersion,
            archivedAt: null,
            createdAt: source.createdAt.getTime(), updatedAt: source.updatedAt.getTime(),
            active: source.active, activeAt: source.lastActiveAt.getTime(),
            thinking: source.thinking, thinkingAt: source.thinkingAt?.getTime() ?? null,
            latestTurnStatus: source.latestTurnStatus,
            latestTurnId: source.latestTurnId,
            lastRuntimeIssue: parseStoredSessionRuntimeIssue(turn ? turn.lastRuntimeIssueJson : source.lastRuntimeIssue),
            latestTurnStatusObservedAt: source.latestTurnStatusObservedAt === null ? null : Number(source.latestTurnStatusObservedAt),
            latestReadyEventSeq: source.latestReadyEventSeq,
            latestReadyEventAt: source.latestReadyEventAt?.getTime() ?? null,
            meaningfulActivityAt: source.meaningfulActivityAt?.getTime() ?? null,
            agentStateVersion: source.agentStateVersion,
            agentState: source.agentState,
            pendingReviewRuns: pendingReviewRuns.get(source.id) ?? 0,
            pendingPermissionRequestCount: source.pendingPermissionRequestCount,
            pendingUserActionRequestCount: source.pendingUserActionRequestCount,
            pendingRequestObservedAt: source.pendingRequestObservedAt?.getTime() ?? null,
            pendingCount: source.pendingCount, pendingBlockedCount: source.pendingBlockedCount,
            runtimeActivityState: source.runtimeActivityState,
            runtimeActivityActiveCount: source.runtimeActivityActiveCount,
        },
        messages: page.map((message, index) => ({
            seq: message.seq,
            localId: message.localId,
            content: message.content,
            ...(() => {
                const role = SessionMessageRoleSchema.safeParse(message.messageRole);
                return role.success ? { messageRole: role.data } : {};
            })(),
            createdAt: message.createdAt.getTime(),
            accountActor: accountActors[index] ?? null,
        })),
        hasMore,
    });
}

export async function projectSessionFollowSourceForRunner(input: SessionFollowSourceRunnerInput): Promise<SessionFollowSourceProjectionResponseV1 | null> {
    return await readSnapshotWithCurrentAdmission<SessionFollowSourceProjectionResponseV1 | null>(
        tx => projectSessionFollowSourceForRunnerInTx(tx, input), async (tx, captured) => {
            if (!captured) return null;
            const current = await admitSessionFollowSourceForRunnerInTx(tx, input);
            return current && current.source.encryptionMode === captured.source.encryptionMode ? captured : null;
        });
}

export type SessionFollowSourceFailure =
    | "invalid_parameters"
    | "session_not_found"
    | "account_inactive"
    | "session_archived"
    | "session_follow_same_session"
    | "session_follow_source_forbidden"
    | "session_follow_source_unavailable";

export type SessionFollowSourceResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: SessionFollowSourceFailure }>;

export type SessionFollowSourceKeyPreparationAdmission = Readonly<{
    destinationRuntimeAccountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    machineId: string;
}>;

type SessionRow = Readonly<{
    id: string;
    accountId: string;
    archivedAt: Date | null;
    publisherGeneration: bigint;
    seq: number;
    latestReadyEventSeq: number | null;
    agentStateVersion: number;
    latestTurnId: string | null;
    latestTurnStatus: string | null;
    active: boolean;
    lastActiveAt: Date;
}>;

type EdgeRow = Readonly<{
    sourceSessionId: string;
    destinationSessionId: string;
    deliveredTranscriptSeq: number;
    deliveredReadyEventSeq: number;
    deliveredAgentStateVersion: number;
    deliveredTurnId: string | null;
    deliveredTurnStatus: string | null;
    policy: FollowPolicyV1;
    policyJson: string;
    relation: 'follower' | 'manager';
    attachedAt: Date;
}>;

/** Session-only adapters never reinterpret a Discussion FK as a Session id. */
function readSessionEdge<T extends { sourceKey: string; sourceSessionId: string | null; sourceDiscussionId: string | null;
    sourceExecutionRunSessionId: string | null; sourceExecutionRunMachineId?: string | null; sourceExecutionRunId: string | null; sourceWorkflowRunId: string | null;
    relation: string; policyJson: string }>(edge: T | null):
    (T & { sourceSessionId: string; relation: 'follower' | 'manager'; policy: FollowPolicyV1 }) | null {
    if (!edge || edge.sourceSessionId === null || (edge.relation !== 'follower' && edge.relation !== 'manager')) return null;
    const source = sourceForSessionFollowEdgeV1(edge);
    if (source?.kind !== 'session' || source.sessionId !== edge.sourceSessionId) return null;
    const policy = readStoredPolicy(edge.policyJson);
    return policy ? { ...edge, sourceSessionId: edge.sourceSessionId, relation: edge.relation, policy } : null;
}

function projectSource(edge: EdgeRow, source: SessionRow | null, dormant: boolean): SessionFollowSourceV1 {
    return {
        sourceSessionId: edge.sourceSessionId,
        destinationSessionId: edge.destinationSessionId,
        policy: edge.policy,
        deliveryState: dormant ? "paused_archived" : "eligible",
        hasPendingUpdates: source !== null && compareSessionFollowFrontierProgressV1(
            readStoredSessionFollowFrontier(edge),
            readCurrentSourceSessionFollowFrontier(source),
        ) === "ahead",
    };
}

async function loadSession(tx: Tx, sessionId: string): Promise<SessionRow | null> {
    return await tx.session.findUnique({ where: { id: sessionId }, select: SESSION_SELECT });
}

async function isActingAccountActive(tx: Tx, accountId: string): Promise<boolean> {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: { status: true } });
    return account?.status === AccountStatus.active;
}

async function canReadSession(tx: Tx, accountId: string, sessionId: string, authentication: SessionAccessAuthentication): Promise<boolean> {
    return (await resolveEffectiveSessionAccess(tx, { accountId, sessionId, authentication }))?.capabilities.readTranscript === true;
}

async function canSubmitDestinationInput(tx: Tx, accountId: string, sessionId: string, authentication: SessionAccessAuthentication): Promise<boolean> {
    return (await resolveEffectiveSessionAccess(tx, { accountId, sessionId, authentication }))?.capabilities.submitAgentInput === true;
}

/** Resolve the single content-free audience for every outgoing relation. */
export async function resolveSessionFollowSourceChangeRecipientsInTx(
    tx: Tx,
    input: Readonly<{ sourceSessionId: string }>,
): Promise<ReadonlyMap<string, readonly string[]>> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: { sourceSessionId: input.sourceSessionId },
        orderBy: { destinationSessionId: "asc" },
        select: { destinationSessionId: true },
    });
    const destinationSessionIds = [...new Set(edges.map((edge) => edge.destinationSessionId))];
    return resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
        sessionIds: destinationSessionIds,
    });
}

/** One source original's currently authorized ordinary routes; membership grants no input authority. */
export async function observeSessionFollowSourceRoutes(input: Readonly<{
    accountId: string;
    sourceSessionId: string;
    authentication: SessionAccessAuthentication;
    request: SessionFollowObserveSourceRoutesRequestV1;
}>): Promise<SessionFollowObserveSourceRoutesResponseV1> {
    return inReadSnapshot<SessionFollowObserveSourceRoutesResponseV1>(async tx => {
        const denied = { ok: false, v: 1, error: 'forbidden' } as const;
        if (input.authentication.sessionRuntimePrincipal || !await isActingAccountActive(tx, input.accountId)) return denied;
        const source = await tx.session.findUnique({ where: { id: input.sourceSessionId },
            select: { ...SESSION_SELECT, encryptionMode: true, responsibleAccountId: true } });
        const publisher = input.request.sourcePublisher;
        let recoveryDestinationId: string | undefined;
        if (!source || source.archivedAt !== null) return denied;
        if (publisher) {
            if (source.accountId !== input.accountId
                || source.publisherGeneration.toString() !== publisher.publisherGeneration
                || !await readExactCurrentPublisherAuthorityInTx(tx, {
                accountId: input.accountId, sessionId: source.id, machineId: publisher.machineId,
                // A committed original can wait behind source traversal while
                // this same publisher heartbeats. Validate its registration,
                // not the notification's superseded liveness timestamp.
                publisherGeneration: source.publisherGeneration,
            }, input.accountId, source.id)) return denied;
        } else if ('receiver' in input.request) {
            if (input.authentication.apiTokenGrant && isApiTokenGrantRestrictedV1(input.authentication.apiTokenGrant)
                || !await canReadSession(tx, input.accountId, source.id, input.authentication)) return denied;
            const original = await readSessionFollowOriginalOccurrenceFrontiersInTx(tx, {
                source, occurrence: input.request, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1,
            });
            if (!original) return denied;
            if (input.request.production === 'recovery') return { ok: false, v: 1, error: 'recovery_unverified' };
            if (source.accountId === input.accountId) return { ok: false, v: 1, error: 'other_evaluator' };
            return { ok: true, v: 1, sourceSessionId: source.id, routes: [], originalCreatedAt: original.originalCreatedAt,
                receiverEvaluation: { ownerAccountId: source.accountId, production: 'source' } };
        } else {
            // Receiver recovery uses its current Account authority, not a fabricated foreign publisher proof.
            const destinationSessionId = input.request.destinationSessionId;
            if (!destinationSessionId) return denied;
            const destination = await loadSession(tx, destinationSessionId);
            if (!destination || destination.accountId !== input.accountId || destination.archivedAt !== null
                || !(await mayInjectSessionContextInTx(tx, { configuringAccountId: input.accountId,
                    sourceSessionId: source.id, destinationSessionId: destination.id,
                    authentication: input.authentication })).ok) return denied;
            recoveryDestinationId = destination.id;
        }
        const original = await readSessionFollowOriginalOccurrenceFrontiersInTx(tx, {
            source, occurrence: input.request, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1,
        });
        if (!original) return denied;
        const edges = await tx.sessionFollowEdge.findMany({
            where: { sourceSessionId: source.id, relation: { in: ['follower', 'manager'] },
                ...(input.request.destinationSessionId ? { destinationSessionId: input.request.destinationSessionId } : {}) },
            select: EDGE_SELECT, orderBy: [{ destinationSessionId: 'asc' }, { relation: 'asc' }],
        });
        // All edges in this snapshot share one source and caller. The existing
        // set-oriented owner retains every destination's custody and audience
        // checks without re-reading the same source once per relation.
        const destinations = recoveryDestinationId ? new Set([recoveryDestinationId]) : await readSessionFollowRouteDestinationsInTx(tx, {
            accountId: input.accountId, authentication: input.authentication, sourceSessionId: source.id,
            destinationSessionIds: edges.map(edge => edge.destinationSessionId),
        });
        const routes: SessionFollowSessionPendingObservationV1[] = [];
        for (const row of edges) {
            const edge = readSessionEdge(row);
            if (!edge) continue;
            if (!destinations.has(edge.destinationSessionId)) continue;
            // Routes are demand for the Pending owner's final decision. A muted
            // original must reach that owner to settle as suppressed, not replay
            // when the receiver later removes its mute.
            const delivered = readStoredSessionFollowFrontier(edge);
            const observed = { ...delivered, ...(input.request.sourceTurn ? { turn: input.request.sourceTurn } : input.request.sourceMessage
                ? { transcriptSeq: original.observed.transcriptSeq }
                : { agentStateVersion: original.observed.agentStateVersion }) };
            if (compareSessionFollowFrontierProgressV1(delivered, observed) !== 'ahead') continue;
            routes.push({ sourceSessionId: source.id, destinationSessionId: edge.destinationSessionId,
                relation: edge.relation, ...(edge.relation === 'manager' ? { attachedAt: edge.attachedAt.getTime() } : {}),
                policy: edge.policy, delivered, observed });
        }
        const access = await resolveEffectiveSessionAccess(tx, { accountId: input.accountId, sessionId: source.id,
            authentication: input.authentication });
        if (!access?.capabilities.readTranscript) return denied;
        const follow = await resolveSessionFollowFactsInTx(tx, { accountId: input.accountId, sessionId: source.id });
        const request = input.request.sourceRequests?.requests[0];
        const handler = request?.currentHandler;
        let representedQuestionHandlerSessionId: string | undefined;
        if (input.request.sourceRequests?.requests.length === 1 && handler?.kind === 'session'
            && (!input.request.destinationSessionId || input.request.destinationSessionId === handler.sessionId)) {
            const original = { sourceSessionId: source.id, sourceRequests: input.request.sourceRequests };
            // Current source/route admission above stays exact. Existing input
            // custody, unlike its old carrier version, survives bookkeeping.
            const custody = await readAdmittedSessionFollowInputInTx(tx, {
                accountId: input.accountId, destinationSessionId: handler.sessionId, sourceSessionId: source.id,
                localInputId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: handler.sessionId, original }),
                authority: { kind: 'account', authentication: input.authentication },
            });
            if (custody && deriveSessionFollowOriginalOccurrenceKeyV1(custody.delivery.original)
                === deriveSessionFollowOriginalOccurrenceKeyV1(original)) representedQuestionHandlerSessionId = handler.sessionId;
        }
        return { ok: true, v: 1, sourceSessionId: source.id, routes, originalCreatedAt: original.originalCreatedAt,
            ...(representedQuestionHandlerSessionId ? { representedQuestionHandlerSessionId } : {}),
            currentAccountFacts: { defaultRelationships: projectSessionFollowDefaultRelationshipsV1({
                responsibleForMe: source.responsibleAccountId === input.accountId, relationshipKinds: access.relationshipKinds,
            }), personalFollowSuppressed: follow.follows === false && follow.notificationLevel === 'none',
            hasPersistentFollow: follow.notificationLevel !== null } };
    });
}

/** Durable destination invalidation and socket hints share the commit boundary. */
export async function invalidateSessionFollowDestinationsForSourceChangeInTx(
    tx: Tx,
    input: Readonly<{ sourceSessionId: string; recipientsBySession?: ReadonlyMap<string, readonly string[]> }>,
): Promise<void> {
    const recipients = input.recipientsBySession ?? await resolveSessionFollowSourceChangeRecipientsInTx(tx, input);
    await invalidateSessionFollowDestinationsInTx(tx, recipients.keys(), recipients);
}

/** Run source changes invalidate configured receivers; their daemon reads the original owner. */
export async function invalidateRunFollowDestinationsInTx(tx: Tx, source: RunFollowOriginalV1['source']): Promise<void> {
    const edges = await tx.sessionFollowEdge.findMany({ where: { sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower' },
        select: { destinationSessionId: true } });
    await invalidateSessionFollowDestinationsInTx(tx, edges.map(edge => edge.destinationSessionId));
}

/** Invalidates surviving destinations before the database cascades source-edge deletion. */
export async function invalidateSessionFollowDestinationsForSessionDeleteInTx(
    tx: Tx,
    input: Readonly<{ sessionId: string }>,
): Promise<void> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: { sourceSessionId: input.sessionId },
        select: { destinationSessionId: true },
    });
    await invalidateSessionFollowDestinationsInTx(
        tx,
        edges.map(({ destinationSessionId }) => destinationSessionId),
    );
}

/**
 * Lists the destination's authored sources, filtered to the sources this
 * Account may currently read. An unreadable source is omitted rather than
 * disclosed, and the projection is content-free: display titles live in
 * end-to-end encrypted Session metadata that the Home cannot read.
 */
export async function listSessionFollowSources(input: Readonly<{
    app?: Pick<Fastify, 'forwardRpcForUser'>;
    accountId: string;
    destinationSessionId: string;
    authentication: SessionAccessAuthentication;
}> & FollowListRequestV1): Promise<SessionFollowSourceResult<Readonly<{ sources: readonly FollowSourceRelationV1[]; continuation?: string }>>> {
    let selection: FollowListRequestV1, scope: string, after: string | undefined;
    try {
        selection = parseFollowListRequestV1({ cursor: input.cursor, limit: input.limit, source: input.source, sourceKinds: input.sourceKinds });
        scope = JSON.stringify([input.accountId, 'following', input.destinationSessionId, ...(selection.source ? [selection.source] : []),
            ...(selection.sourceKinds ? [{ sourceKinds: selection.sourceKinds }] : [])]);
        selection = { ...selection, cursor: openSessionFollowListCursor(scope, selection.cursor) };
        after = readFollowListCursorV1(scope, selection.cursor);
    } catch { return { ok: false, error: 'invalid_parameters' }; }
    const source = selection.source;
    if (source?.kind === 'rule') return { ok: false, error: 'invalid_parameters' };
    const sourceWhere = !source ? {} : source.kind === 'session'
        ? { OR: [{ sourceSessionId: source.sessionId }, { sourceExecutionRunSessionId: source.sessionId }] }
        : { sourceKey: sourceKeyForSessionFollowSourceV1(source) };
    const kindsWhere = selection.sourceKinds === undefined ? {} : { OR: selection.sourceKinds.map(kind => kind === 'session'
        ? { sourceSessionId: { not: null } } : { sourceKey: { startsWith: `${kind}:` } }) };
    const runEdges = new Map<string, SessionFollowProjectionEdge>();
    let runFrontiers = new Map<string, ExecutionRunFollowFrontierWitness>();
    return await readSnapshotWithCurrentAdmission<SessionFollowSourceResult<Readonly<{ sources: readonly FollowSourceRelationV1[]; continuation?: string }>>>({ capture: async (tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        const edges = await tx.sessionFollowEdge.findMany({
            where: { destinationSessionId: input.destinationSessionId, relation: 'follower',
                AND: [sourceWhere, kindsWhere, ...(after === undefined ? [] : [{ sourceKey: { gt: after } }])] },
            select: EDGE_SELECT,
            orderBy: { sourceKey: "asc" },
            ...(selection.limit === undefined ? {} : { take: selection.limit + 1 }),
        });
        const page = pageFollowListV1({ scope, rows: edges, key: row => row.sourceKey, cursor: selection.cursor, limit: selection.limit });
        const visible: FollowSourceRelationV1[] = [];
        for (const row of page.rows) {
            const edge = readSessionEdge(row);
            if (edge) {
                if (!await canReadSession(tx, input.accountId, edge.sourceSessionId, input.authentication)) continue;
                const source = await loadSession(tx, edge.sourceSessionId);
                const dormant = destination.archivedAt !== null || source === null || source.archivedAt !== null;
                visible.push(projectSource(edge, source, dormant));
            } else {
                const source = sourceForSessionFollowEdgeV1(row);
                if (!source || source.kind === 'session' || !await canReadOtherFollowSourceInTx(tx, {
                    accountId: input.accountId, source, authentication: input.authentication })) continue;
                const projected = await projectOtherFollowSourceInTx(tx, row, destination.archivedAt !== null);
                if (projected) {
                    visible.push(projected);
                    if (source.kind === 'execution_run') runEdges.set(row.sourceKey, row);
                }
            }
        }
        return { ok: true, value: { sources: visible, ...(page.continuation ? { continuation: page.continuation } : {}) } };
    }, materialize: async captured => {
        if (captured.ok) runFrontiers = await readExecutionRunFollowProjectionFrontiers({ ...input, sources: captured.value.sources });
        return captured;
    } }, async (tx, captured) => {
        if (!captured.ok) return captured;
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        if (!await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) return { ok: false, error: "session_not_found" };
        const visible: FollowSourceRelationV1[] = [];
        for (const source of captured.value.sources) {
            const permitted = 'sourceSessionId' in source
                ? await canReadSession(tx, input.accountId, source.sourceSessionId, input.authentication)
                : await canReadOtherFollowSourceInTx(tx, { accountId: input.accountId, source: source.source as OtherFollowSource,
                    authentication: input.authentication });
            if (!permitted) continue;
            const edge = 'source' in source && source.source.kind === 'execution_run'
                ? runEdges.get(sourceKeyForSessionFollowSourceV1(source.source)) : undefined;
            const projected = edge ? await projectOtherFollowSourceInTx(tx, edge, source.deliveryState === 'paused_archived',
                runFrontiers.get(edge.sourceKey)) : source;
            if (projected) visible.push(projected);
        }
        return { ok: true, value: { sources: visible, ...(captured.value.continuation
            ? { continuation: sealSessionFollowListCursor(scope, captured.value.continuation) } : {}) } };
    });
}

/** Reverse inspection is source-authorized; private people remain an anonymous census. */
export async function listSessionFollowers(input: Readonly<{
    accountId: string; sourceSessionId: string; authentication: SessionAccessAuthentication;
    cursor?: string; limit?: number;
}>): Promise<SessionFollowSourceResult<SessionFollowActionOutputV1['follow.list']>> {
    const admitSource = async (tx: Tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return 'account_inactive' as const;
        return await canReadSession(tx, input.accountId, input.sourceSessionId, input.authentication) ? null : 'session_not_found' as const;
    };
    return readSnapshotWithCurrentAdmission<SessionFollowSourceResult<SessionFollowActionOutputV1['follow.list']>>(async tx => {
        const error = await admitSource(tx);
        if (error) return { ok: false, error };
        const source = await loadSession(tx, input.sourceSessionId);
        if (!source) return { ok: false, error: 'session_not_found' };
        const rows = await tx.sessionFollowEdge.findMany({ where: { sourceSessionId: input.sourceSessionId,
            relation: { in: ['follower', 'manager'] } }, select: EDGE_SELECT,
            orderBy: [{ destinationSessionId: 'asc' }, { relation: 'asc' }] });
        const sources: SessionFollowSourceV1[] = [];
        for (const row of rows) {
            const edge = readSessionEdge(row);
            if (!edge || !await canReadSession(tx, input.accountId, edge.destinationSessionId, input.authentication)) continue;
            const destination = await loadSession(tx, edge.destinationSessionId);
            if (destination) sources.push({ ...projectSource(edge, source, source.archivedAt !== null || destination.archivedAt !== null), relation: edge.relation });
        }
        return { ok: true, value: { sources, ...await readSessionPersonalFollowerCensusInTx(tx,
            { accountId: input.accountId, sessionId: input.sourceSessionId }), rules: [], coverage: 'complete' } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        const error = await admitSource(tx);
        if (error) return { ok: false, error };
        const sources: SessionFollowSourceV1[] = [];
        for (const row of captured.value.sources) if ('sourceSessionId' in row
            && await canReadSession(tx, input.accountId, row.destinationSessionId, input.authentication)) sources.push(row);
        const census = await readSessionPersonalFollowerCensusInTx(tx, { accountId: input.accountId, sessionId: input.sourceSessionId });
        try {
            const page = pageFollowListV1({ scope: JSON.stringify([input.accountId, 'followers', input.sourceSessionId]),
                rows: sources, key: row => JSON.stringify([row.destinationSessionId, row.relation]),
                cursor: input.cursor, limit: input.limit });
            return { ok: true, value: { ...captured.value, sources: page.rows,
                coverage: page.continuation ? 'partial' : 'complete',
                ...(page.continuation ? { continuation: page.continuation } : {}),
                ...census } };
        } catch { return { ok: false, error: 'invalid_parameters' }; }
    });
}

/** Reverse inspection for one exact non-Session source, with anonymous personal census. */
export async function listOtherSessionFollowers(input: Readonly<{
    app?: Pick<Fastify, 'forwardRpcForUser'>;
    accountId: string; source: OtherFollowSource; authentication: SessionAccessAuthentication;
    cursor?: string; limit?: number;
}>): Promise<SessionFollowSourceResult<SessionFollowActionOutputV1['follow.list']>> {
    const admit = async (tx: Tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return 'account_inactive' as const;
        return await canReadOtherFollowSourceInTx(tx, input) ? null : 'session_not_found' as const;
    };
    const runEdges = new Map<string, SessionFollowProjectionEdge>();
    let runFrontiers = new Map<string, ExecutionRunFollowFrontierWitness>();
    return readSnapshotWithCurrentAdmission<SessionFollowSourceResult<SessionFollowActionOutputV1['follow.list']>>({ capture: async tx => {
        const error = await admit(tx);
        if (error) return { ok: false as const, error };
        const sourceKey = sourceKeyForSessionFollowSourceV1(input.source);
        const rows = await tx.sessionFollowEdge.findMany({ where: { sourceKey, relation: 'follower' },
            select: EDGE_SELECT, orderBy: { destinationSessionId: 'asc' } });
        const sources: FollowSourceRelationV1[] = [];
        for (const row of rows) {
            if (JSON.stringify(sourceForSessionFollowEdgeV1(row)) !== JSON.stringify(input.source))
                throw new Error('Follow Run source digest collision');
            if (!await canReadSession(tx, input.accountId, row.destinationSessionId, input.authentication)) continue;
            const destination = await loadSession(tx, row.destinationSessionId);
            if (!destination) continue;
            const projected = await projectOtherFollowSourceInTx(tx, row, destination.archivedAt !== null);
            if (projected) {
                sources.push(projected);
                if (input.source.kind === 'execution_run') runEdges.set(row.destinationSessionId, row);
            }
        }
        return { ok: true as const, value: { sources, rules: [], coverage: 'complete' as const,
            ...await readOtherPersonalFollowerCensusInTx(tx, { accountId: input.accountId, source: input.source }) } };
    }, materialize: async captured => {
        if (captured.ok) runFrontiers = await readExecutionRunFollowProjectionFrontiers({ ...input, sources: captured.value.sources });
        return captured;
    } }, async (tx, captured) => {
        if (!captured.ok) return captured;
        const error = await admit(tx);
        if (error) return { ok: false as const, error };
        const sources: FollowSourceRelationV1[] = [];
        for (const row of captured.value.sources) if (await canReadSession(tx, input.accountId,
            row.destinationSessionId, input.authentication)) {
            const edge = runEdges.get(row.destinationSessionId);
            const projected = edge ? await projectOtherFollowSourceInTx(tx, edge, row.deliveryState === 'paused_archived',
                runFrontiers.get(edge.sourceKey)) : row;
            if (projected) sources.push(projected);
        }
        try {
            const page = pageFollowListV1({ scope: JSON.stringify([input.accountId, 'followers',
                    sourceKeyForSessionFollowSourceV1(input.source)]), rows: sources,
                key: row => JSON.stringify([row.destinationSessionId, row.relation ?? 'follower']),
                cursor: input.cursor, limit: input.limit });
            return { ok: true as const, value: { sources: page.rows, rules: [], coverage: 'complete' as const,
                ...await readOtherPersonalFollowerCensusInTx(tx, { accountId: input.accountId, source: input.source }),
                ...(page.continuation ? { continuation: page.continuation } : {}) } };
        } catch { return { ok: false as const, error: 'invalid_parameters' as const }; }
    });
}

/**
 * Creates or confirms one source relation for a destination Session.
 *
 * Creation seeds every delivered component from the source's current frontier
 * inside the same transaction, so enabling Follow never emits historical
 * context. Key readiness and daemon reachability are deliberately not
 * preconditions: a valid authorized edge is persisted and waits.
 */
export async function setSessionFollowSource(input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    policy: FollowPolicyV1;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean; source: SessionFollowSourceV1 }>>> {
    const parsedPolicy = FollowPolicyV1Schema.safeParse(input.policy);
    if (!parsedPolicy.success) return { ok: false, error: 'invalid_parameters' };
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => {
        await acquireSessionAccountCursorLocksInTx(tx, [input.sourceSessionId, input.destinationSessionId], [input.accountId]);
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };

        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        const source = await loadSession(tx, input.sourceSessionId);
        if (!source || !await canReadSession(tx, input.accountId, input.sourceSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        if (!await canSubmitDestinationInput(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        if (destination.archivedAt !== null || source.archivedAt !== null) {
            return { ok: false, error: "session_archived" };
        }

        const decision = await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId,
            sourceSessionId: input.sourceSessionId,
            destinationSessionId: input.destinationSessionId,
            authentication: input.authentication,
        });
        if (!decision.ok) return { ok: false, error: "session_follow_source_forbidden" };

        const existing = readSessionEdge(await tx.sessionFollowEdge.findUnique({
            where: {
                destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                    relation: 'follower',
                },
            },
            select: EDGE_SELECT,
        }));

        const policy = parsedPolicy.data;
        const policyJson = serializeFollowPolicyV1(policy);
        if (existing) {
            if (isFollowPolicyEqualV1(existing.policy, policy)) {
                return { ok: true, value: { changed: false, source: projectSource(existing, source, false) } };
            }
            const updated = readSessionEdge(await tx.sessionFollowEdge.update({
                where: { destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                    relation: 'follower',
                } },
                data: { policyJson },
                select: EDGE_SELECT,
            }));
            if (!updated) throw new Error('Session Follow update lost its Session source identity');
            await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
            return { ok: true, value: { changed: true, source: projectSource(updated, source, false) } };
        }

        // Keep the resource idempotent under two concurrent first writers. The
        // preceding read preserves the ordinary `changed: false` response for
        // retries, while the upsert closes the unique-key race without a
        // catch-after-failed-transaction path (which PostgreSQL cannot use).
        const created = readSessionEdge(await tx.sessionFollowEdge.upsert({
            where: {
                destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                    relation: 'follower',
                },
            },
            create: {
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: input.sourceSessionId }),
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                relation: 'follower',
                policyJson,
                ...writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(source)),
            },
            update: {},
            select: EDGE_SELECT,
        }));
        if (!created) throw new Error('Session Follow creation lost its Session source identity');
        await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
        return { ok: true, value: { changed: true, source: projectSource(created, source, false) } };
    });
}

/**
 * Removes one source relation. Removal is idempotent, requires only the
 * existing destination mutation authorization, and never grants source read;
 * following again later creates a fresh edge seeded to the then-current
 * frontier, so no historical content is disclosed by re-enabling.
 */
export async function removeSessionFollowSource(input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean }>>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => {
        await acquireSessionAccountCursorLocksInTx(tx, [input.sourceSessionId, input.destinationSessionId], [input.accountId]);
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        if (!await canSubmitDestinationInput(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        const removed = await tx.sessionFollowEdge.deleteMany({
            where: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                relation: 'follower',
            },
        });
        if (removed.count > 0) {
            await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
        }
        return { ok: true, value: { changed: removed.count > 0 } };
    });
}

/**
 * Content-free server admission for the encrypted exact-Machine source-key
 * carrier. The DEK never enters this service: it validates only the current
 * caller, current context relation, pairwise audience policy, ephemeral destination
 * Machine, and exact AccessKey binding used to select the receiver room.
 */
type SessionFollowSourceKeyPreparerInput = Readonly<{
    accountId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    authentication: SessionAccessAuthentication;
    localInputId?: string;
}>;

async function prepareSessionFollowSourceKeyPreparerInTx(
    tx: Tx,
    input: SessionFollowSourceKeyPreparerInput,
): Promise<SessionFollowSourceResult<Readonly<{ destinationRuntimeAccountId: string }>>> {
    if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
    const [source, destination, edge, admittedInput] = await Promise.all([
        loadSession(tx, input.sourceSessionId),
        loadSession(tx, input.destinationSessionId),
        input.localInputId !== undefined ? null : tx.sessionFollowEdge.findFirst({
            where: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                relation: { in: ['follower', 'manager'] },
            },
            select: EDGE_SELECT,
        }).then(readSessionEdge),
        input.localInputId === undefined ? null : readAdmittedSessionFollowInputInTx(tx, {
            accountId: input.accountId, sourceSessionId: input.sourceSessionId,
            destinationSessionId: input.destinationSessionId, localInputId: input.localInputId,
            authority: { kind: 'account', authentication: input.authentication },
        }),
    ]);
    const rule = !edge && !admittedInput && input.localInputId === undefined
        ? (await readStalledSessionFollowRulesInTx(tx, { accountId: input.accountId,
            destinationSessionId: input.destinationSessionId, sourceSessionId: input.sourceSessionId }))[0] : null;
    if (!source || !destination || (!edge && !admittedInput && !rule)
        || admittedInput && !admittedInput.nativeAccepted && admittedInput.effectiveDelivery === null) {
        return { ok: false, error: "session_not_found" };
    }
    if (source.archivedAt !== null || destination.archivedAt !== null) {
        return { ok: false, error: "session_archived" };
    }
    // The custody owner has already admitted this exact Account, pair and
    // original. A missing/stale input never falls back to a configured edge.
    if (admittedInput) return { ok: true, value: { destinationRuntimeAccountId: destination.accountId } };
    const decision = await mayInjectSessionContextInTx(tx, {
        configuringAccountId: input.accountId,
        sourceSessionId: input.sourceSessionId,
        destinationSessionId: input.destinationSessionId,
        authentication: input.authentication,
    });
    if (!decision.ok) {
        return { ok: false, error: "session_follow_source_forbidden" };
    }
    return { ok: true, value: { destinationRuntimeAccountId: decision.destinationRuntimeAccountId } };
}

/** Resolves the authorized destination room; exact Runner authority is still required at dispatch. */
/** Non-Session refs use this same edge owner; raw Run fields are checked beside digest keys. */
export async function setOtherSessionFollowSource(input: Readonly<{
    accountId: string; destinationSessionId: string; source: OtherFollowSource;
    policy: FollowPolicyV1; authentication: SessionAccessAuthentication;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean; source: FollowSourceRelationV1 }>>> {
    const parsed = FollowPolicyV1Schema.safeParse(input.policy);
    if (!parsed.success) return { ok: false, error: 'invalid_parameters' };
    return inTx(async tx => {
        const sessionIds = input.source.kind === 'execution_run' && 'sessionId' in input.source
            ? [input.source.sessionId, input.destinationSessionId] : [input.destinationSessionId];
        await acquireSessionAccountCursorLocksInTx(tx, sessionIds, [input.accountId]);
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: 'account_inactive' };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, destination.id, input.authentication))
            return { ok: false, error: 'session_not_found' };
        if (!await canReadOtherFollowSourceInTx(tx, input)) return { ok: false, error: 'session_not_found' };
        if (!await canSubmitDestinationInput(tx, input.accountId, destination.id, input.authentication)
            || !await mayInjectOtherFollowSourceInTx(tx, input))
            return { ok: false, error: 'session_follow_source_forbidden' };
        if (destination.archivedAt !== null) return { ok: false, error: 'session_archived' };
        if (input.source.kind === 'discussion') {
            const discussion = await tx.discussion.findUnique({ where: { id: input.source.discussionId },
                select: { archivedAt: true } });
            if (!discussion) return { ok: false, error: 'session_not_found' };
            if (discussion.archivedAt !== null) return { ok: false, error: 'session_archived' };
        }
        if (input.source.kind === 'execution_run' && 'sessionId' in input.source) {
            const parent = await loadSession(tx, input.source.sessionId);
            if (!parent) return { ok: false, error: 'session_not_found' };
            if (parent.archivedAt !== null) return { ok: false, error: 'session_archived' };
        }
        const sourceKey = sourceKeyForSessionFollowSourceV1(input.source);
        const key = { destinationSessionId: destination.id, sourceKey, relation: 'follower' };
        const existing = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: key }, select: EDGE_SELECT });
        if (existing && JSON.stringify(sourceForSessionFollowEdgeV1(existing)) !== JSON.stringify(input.source))
            throw new Error('Follow Run source digest collision');
        if (!existing && input.source.kind === 'execution_run') {
            const frontier = input.executionRunFrontier;
            if (!frontier || JSON.stringify(frontier.source) !== JSON.stringify(input.source)
                || !await isExecutionRunFollowFrontierWitnessCurrentInTx(tx, frontier))
                return { ok: false, error: 'session_follow_source_unavailable' };
        }
        const policyJson = serializeFollowPolicyV1(parsed.data);
        if (existing) {
            const projection = await projectOtherFollowSourceInTx(tx, existing, false, input.executionRunFrontier);
            if (!projection) return { ok: false, error: 'session_follow_source_unavailable' };
            if (isFollowPolicyEqualV1(projection.policy, parsed.data))
                return { ok: true, value: { changed: false, source: projection } };
            const updated = await tx.sessionFollowEdge.update({ where: { destinationSessionId_sourceKey_relation: key },
                data: { policyJson }, select: EDGE_SELECT });
            await invalidateSessionFollowDestinationsInTx(tx, [destination.id]);
            const source = await projectOtherFollowSourceInTx(tx, updated, false, input.executionRunFrontier);
            if (!source) throw new Error('Follow source update lost exact identity');
            return { ok: true, value: { changed: true, source } };
        }
        const raw = input.source.kind === 'discussion' ? { sourceDiscussionId: input.source.discussionId }
            : input.source.kind === 'workflow_run' ? { sourceWorkflowRunId: input.source.runId }
            : { ...('sessionId' in input.source ? { sourceExecutionRunSessionId: input.source.sessionId }
                : { sourceExecutionRunMachineId: input.source.machineId }), sourceExecutionRunId: input.source.runId };
        const baseline = input.source.kind === 'discussion'
            ? { deliveredTranscriptSeq: (await tx.discussion.findUniqueOrThrow({ where: { id: input.source.discussionId },
                select: { messageSeq: true } })).messageSeq }
            : input.source.kind === 'workflow_run'
                ? { deliveredWorkflowRunRevision: (await tx.automationRun.findUniqueOrThrow({ where: { id: input.source.runId },
                    select: { revision: true } })).revision }
                : { deliveredExecutionRunTerminalEventId: input.executionRunFrontier?.terminalEventId ?? null };
        const created = await tx.sessionFollowEdge.upsert({ where: { destinationSessionId_sourceKey_relation: key },
            create: { ...key, ...raw, ...baseline, policyJson }, update: {}, select: EDGE_SELECT });
        if (JSON.stringify(sourceForSessionFollowEdgeV1(created)) !== JSON.stringify(input.source))
            throw new Error('Follow Run source digest collision');
        await invalidateSessionFollowDestinationsInTx(tx, [destination.id]);
        const source = await projectOtherFollowSourceInTx(tx, created, false, input.executionRunFrontier);
        if (!source) throw new Error('Follow source create lost exact identity');
        return { ok: true, value: { changed: true, source } };
    });
}

export async function removeOtherSessionFollowSource(input: Readonly<{
    accountId: string; destinationSessionId: string; source: OtherFollowSource;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean }>>> {
    return inTx(async tx => {
        await acquireSessionAccountCursorLocksInTx(tx, [input.destinationSessionId], [input.accountId]);
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: 'account_inactive' };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, destination.id, input.authentication))
            return { ok: false, error: 'session_not_found' };
        if (!await canSubmitDestinationInput(tx, input.accountId, destination.id, input.authentication))
            return { ok: false, error: 'session_follow_source_forbidden' };
        const key = { destinationSessionId: destination.id, sourceKey: sourceKeyForSessionFollowSourceV1(input.source), relation: 'follower' };
        const existing = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: key }, select: EDGE_SELECT });
        if (existing && JSON.stringify(sourceForSessionFollowEdgeV1(existing)) !== JSON.stringify(input.source))
            throw new Error('Follow Run source digest collision');
        if (!existing) return { ok: true, value: { changed: false } };
        await tx.sessionFollowEdge.delete({ where: { destinationSessionId_sourceKey_relation: key } });
        await invalidateSessionFollowDestinationsInTx(tx, [destination.id]);
        return { ok: true, value: { changed: true } };
    });
}

export async function authorizeSessionFollowSourceKeyPreparer(
    input: SessionFollowSourceKeyPreparerInput,
): Promise<SessionFollowSourceResult<Readonly<{ destinationRuntimeAccountId: string }>>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inReadSnapshot(async (tx) => await prepareSessionFollowSourceKeyPreparerInTx(tx, input));
}

export async function authorizeSessionFollowSourceKeyPreparation(input: Readonly<{
    accountId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    principal: VerifiedEphemeralSessionRunnerPrincipal;
    authentication: SessionAccessAuthentication;
    localInputId?: string;
}>): Promise<SessionFollowSourceResult<SessionFollowSourceKeyPreparationAdmission>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inReadSnapshot(async (tx) => {
        const prepared = await prepareSessionFollowSourceKeyPreparerInTx(tx, input);
        if (
            !prepared.ok
            || input.accountId !== prepared.value.destinationRuntimeAccountId
            || input.principal.accountId !== prepared.value.destinationRuntimeAccountId
            || input.principal.sessionId !== input.destinationSessionId
            || !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
        ) return prepared.ok ? { ok: false, error: "session_follow_source_forbidden" } : prepared;

        const binding = await tx.accessKey.findUnique({
                where: { accountId_machineId_sessionId: {
                    accountId: prepared.value.destinationRuntimeAccountId,
                    machineId: input.principal.machineId,
                    sessionId: input.destinationSessionId,
                } },
                select: {
                    machine: { select: {
                        accountId: true,
                        dataEncryptionKey: true,
                        kind: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                        runnerContentKeyBinding: true,
                    } },
                },
            });
        if (
            !binding
            || binding.machine.accountId !== prepared.value.destinationRuntimeAccountId
            || binding.machine.dataEncryptionKey === null
            || isPlainMachineDataKeyMarker(binding.machine.dataEncryptionKey)
            || binding.machine.kind !== "ephemeral_session_runner"
            || binding.machine.revokedAt !== null
            || binding.machine.replacedByMachineId !== null
            || binding.machine.runnerContentKeyBinding === null
        ) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        return { ok: true, value: {
            destinationRuntimeAccountId: prepared.value.destinationRuntimeAccountId,
            destinationSessionId: input.destinationSessionId,
            sourceSessionId: input.sourceSessionId,
            machineId: input.principal.machineId,
        } };
    });
}

/**
 * One pending observation for a destination Session. It is content-free: the
 * daemon receives source identities and frontiers, then fetches and decrypts
 * source material under its own authority.
 */
export type PendingSessionFollowObservationV1 = SessionFollowPendingObservationV1;

export type SessionFollowObservationResultV1 = Readonly<{
    currentSourceSessionIds: readonly string[];
    observations: readonly PendingSessionFollowObservationV1[];
    wakeAdmission?: FollowWakeAdmissionDecision;
}>;

type FollowWakeAdmissionDecision = NonNullable<Extract<SessionFollowObservePendingResponseV1, { ok: true }>['wakeAdmission']>;

const unavailableWake = { status: 'held', code: 'session_input_target_unavailable' } as const;

/** Potential interrupt eligibility only; actual source event selection is the hydrated executor's job. */
function policyAllowsFollowWake(policy: FollowPolicyV1): boolean {
    return FOLLOW_EVENT_KINDS_V1.some(kind => kind === 'needs_you'
        ? (['decision', 'approval', 'blocked'] as const).some(type =>
            resolveFollowDeliveryV1({ policies: [policy], event: { kind, type } }).session.wake)
        : resolveFollowDeliveryV1({ policies: [policy], event: { kind } }).session.wake);
}

/** Read-only final pre-effect check over the exact normalized Follow batch. */
async function readFollowWakeAdmissionInTx(tx: Tx, input: Readonly<{
    destinationSessionId: string;
    destinationAccountId: string;
    publisherGeneration: bigint;
    pending: readonly SessionFollowSessionPendingObservationV1[];
    wakeAdmission: NonNullable<SessionFollowObservePendingRequestV1['wakeAdmission']>;
}>): Promise<FollowWakeAdmissionDecision> {
    let observations: ReturnType<typeof normalizeSessionFollowWakeObservationsV1>;
    try {
        observations = normalizeSessionFollowWakeObservationsV1(input.wakeAdmission.observations);
        if (deriveSessionFollowWakeEventLocalIdV1({
            destinationSessionId: input.destinationSessionId,
            publisherGeneration: input.publisherGeneration.toString(), observations,
        }) !== input.wakeAdmission.eventLocalId) return unavailableWake;
    } catch {
        return unavailableWake;
    }
    let commonRoot: AutonomousExchangeRoot | null = null;
    let needsReceiverRoot = false;
    for (const observation of observations) {
        const pending = input.pending.find(row => row.sourceSessionId === observation.sourceSessionId
            && row.relation === (observation.relation ?? 'follower'));
        if (!pending || pending.attachedAt !== observation.attachedAt
            || (pending.relation === 'rule' ? observation.relation !== 'rule'
                || pending.effectiveDelivery !== observation.effectiveDelivery
                || !isDeepStrictEqual(pending.presence, observation.presence)
                : observation.relation === 'rule' || !isFollowPolicyEqualV1(pending.policy, observation.policy))
            || !isSessionFollowFrontierEqualV1(pending.delivered, observation.expected)
            || !isSessionFollowConsumptionWithinCurrentV1({ expected: observation.expected,
                observed: pending.observed, consumed: observation.consumed, current: pending.observed })) {
            return unavailableWake;
        }
        const source = await tx.session.findUnique({ where: { id: observation.sourceSessionId },
            select: { accountId: true, latestTurnId: true } });
        if (!source) return unavailableWake;
        if (source.accountId !== input.destinationAccountId) {
            const localRoot = await readReceiverAutonomousExchangeRootInTx(tx, {
                accountId: input.destinationAccountId, sessionId: input.destinationSessionId,
            });
            if (!localRoot) {
                // The first protected incoming Pending input becomes the
                // receiver-local root at admission, not during observation.
                needsReceiverRoot = true;
                continue;
            }
            if (commonRoot && (commonRoot.sessionId !== localRoot.sessionId || commonRoot.localId !== localRoot.localId)) return unavailableWake;
            commonRoot = localRoot;
            continue;
        }
        const selected = { localId: true, acceptedTurnId: true, targetExecutionRunId: true,
            inputAdmissionReceipt: true,
            autonomousExchangeRootSessionId: true, autonomousExchangeRootLocalId: true } as const;
        const changedInputs = observation.consumed.transcriptSeq > observation.expected.transcriptSeq
            ? await tx.sessionMessage.findMany({ where: { sessionId: observation.sourceSessionId,
                seq: { gt: observation.expected.transcriptSeq, lte: observation.consumed.transcriptSeq },
                acceptedTurnId: { not: null } }, select: selected, orderBy: { seq: 'asc' } })
            : [];
        // Agent-state and ready-event changes may not append an accepted input;
        // the current source Turn then supplies its already-bound original row.
        const sourceInputs = changedInputs.length > 0 ? changedInputs : source.latestTurnId
            ? await tx.sessionMessage.findMany({ where: { sessionId: observation.sourceSessionId,
                acceptedTurnId: source.latestTurnId }, select: selected, orderBy: { seq: 'asc' } })
            : [];
        const resolved = await readAutonomousExchangeSourceRoot({ tx, sourceSessionId: observation.sourceSessionId,
            actorAccountId: input.destinationAccountId, sourceInputs });
        if (resolved.status !== 'found') return unavailableWake;
        if (commonRoot && (commonRoot.sessionId !== resolved.root.sessionId
            || commonRoot.localId !== resolved.root.localId)) return unavailableWake;
        commonRoot = resolved.root;
    }
    const choice = input.wakeAdmission.autonomousCheckIn;
    if (!commonRoot) return needsReceiverRoot && choice
        ? { status: 'allowed', originatingDiscussion: null } : unavailableWake;
    const original = await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
        sessionId: commonRoot.sessionId, localId: commonRoot.localId } },
        select: { inputAdmissionReceipt: true, autonomousExchangeState: true, session: { select: { accountId: true } } } });
    if (!original || original.session.accountId !== input.destinationAccountId
        || !isAutonomousExchangeRootReceiptForAccount(original.inputAdmissionReceipt, input.destinationAccountId, commonRoot.sessionId)) return unavailableWake;
    // Only the exact validated exchange root decides which Discussion's
    // preference the owner client reads, including later inherited Follow wakes.
    const receipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).parse(original.inputAdmissionReceipt);
    const originatingDiscussion = receipt.issuer === 'authenticatedMachine' && receipt.discussionAddressing
        ? { serverId: receipt.admittedTarget!.homeId, discussionId: receipt.discussionAddressing.discussionId } : null;
    if (!choice) return { ...unavailableWake, originatingDiscussion };
    const state = createStoredReadSchema(AutonomousExchangeStateV1Schema).safeParse(original.autonomousExchangeState);
    if (!state.success && original.autonomousExchangeState !== null) return unavailableWake;
    if (state.success && state.data.stopped) return { status: 'held', code: 'session_input_cancelled', originatingDiscussion };
    const current = state.success ? { ...state.data, afterTurns: choice.afterTurns }
        : createAutonomousExchangeStateV1(choice.afterTurns);
    return readAutonomousExchangeAdmissionV1(current) === 'check_in'
        ? { status: 'held', code: 'autonomous_check_in', originatingDiscussion }
        : { status: 'allowed', originatingDiscussion };
}

/**
 * Returns authoritative current admitted source membership alongside the
 * subset whose frontier has advanced. Both projections are produced by the
 * same Lane 04 runtime source-read assertion pass, so pending delivery is never
 * misused as lifecycle membership. Archived, removed, or denied edges are
 * absent from both projections.
 */
export async function observePendingSessionFollowForDestinationInTx(tx: Tx, input: Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    destinationSessionId: string;
    includeManager?: boolean;
    inputLocalIds?: readonly string[];
    wakeAdmission?: SessionFollowObservePendingRequestV1['wakeAdmission'];
}>): Promise<SessionFollowObservationResultV1> {
    if (
        input.principal.kind === "ephemeral_session_runner"
        && !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
    ) return { currentSourceSessionIds: [], observations: [] };
    const destinationRuntimeAccountId = input.principal.kind === "destination_runtime"
        ? input.principal.destinationRuntimeAccountId
        : input.principal.accountId;
    const authentication = await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal);
    const destination = await loadSession(tx, input.destinationSessionId);
    if (!destination || destination.archivedAt !== null) return { currentSourceSessionIds: [], observations: [] };
    // Only the verified destination runtime observes its own edges; custody is
    // re-derived from the transaction, never trusted from the request.
    if (destination.accountId !== destinationRuntimeAccountId) return { currentSourceSessionIds: [], observations: [] };
    if (!await isActingAccountActive(tx, destinationRuntimeAccountId)) return { currentSourceSessionIds: [], observations: [] };
    if (!await canSubmitDestinationInput(tx, destinationRuntimeAccountId, destination.id, authentication)) return { currentSourceSessionIds: [], observations: [] };
    const result = await observePendingSessionFollowEdgesInTx(tx, {
        destinationSessionId: destination.id,
        destinationRuntimeAccountId,
        includeManager: input.includeManager,
        admitSources: sourceSessionIds => assertSessionFollowSourceReadsInTx(tx, {
            principal: input.principal, sourceSessionIds, destinationSessionId: destination.id,
        }),
    });
    const admittedObservations: Extract<SessionFollowPendingObservationV1, { kind: 'admitted_input' | 'admitted_run_input' }>[] = [];
    for (const localInputId of new Set(input.inputLocalIds ?? [])) {
        const custody = await readAdmittedSessionFollowInputInTx(tx, { principal: input.principal,
            accountId: destinationRuntimeAccountId, destinationSessionId: destination.id, localInputId });
        if (!custody) continue;
        if ('source' in custody.delivery.original) {
            admittedObservations.push({ kind: 'admitted_run_input', localInputId,
                destinationSessionId: destination.id, delivery: custody.delivery,
                effectiveDelivery: custody.effectiveDelivery });
            continue;
        }
        const frontiers = sessionFollowInputFrontiers(custody.delivery);
        admittedObservations.push({ kind: 'admitted_input' as const, localInputId,
            sourceSessionId: custody.delivery.original.sourceSessionId, destinationSessionId: destination.id,
            delivered: frontiers.expected, observed: frontiers.observed, delivery: custody.delivery,
            effectiveDelivery: custody.effectiveDelivery });
    }
    const combined = { ...result, currentSourceSessionIds: [...new Set([...result.currentSourceSessionIds,
        ...admittedObservations.flatMap(row => 'sourceSessionId' in row ? [row.sourceSessionId] : [])])], observations: [...result.observations, ...admittedObservations] };
    if (!input.wakeAdmission) return combined;
    return { ...combined, wakeAdmission: await readFollowWakeAdmissionInTx(tx, {
        destinationSessionId: destination.id, destinationAccountId: destinationRuntimeAccountId,
        publisherGeneration: destination.publisherGeneration,
        pending: result.observations.filter((observation): observation is SessionFollowSessionPendingObservationV1 => 'sourceSessionId' in observation && !('kind' in observation)), wakeAdmission: input.wakeAdmission,
    }) };
}

/** Exact retained input placement admits observation only, never a runtime principal. */
export async function observePendingSessionFollowForInactiveDestinationInTx(tx: Tx, input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    machineId: string;
    installationId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowObserveInactiveResponseV1> {
    const denied = { ok: false, v: 1, error: 'forbidden' } as const;
    const destination = await loadSession(tx, input.destinationSessionId);
    if (!destination || destination.accountId !== input.accountId || destination.archivedAt !== null
        || !await isActingAccountActive(tx, input.accountId)
        || !await canSubmitDestinationInput(tx, input.accountId, destination.id, input.authentication)) return denied;
    const target = await readCurrentCommittedSessionInputMachineTargetInTx(tx, destination.id);
    if (!target || target.accountId !== input.accountId || target.machineId !== input.machineId
        || target.installationId !== input.installationId) return denied;
    const observation = await observePendingSessionFollowEdgesInTx(tx, {
        destinationSessionId: destination.id,
        destinationRuntimeAccountId: input.accountId,
        includeManager: true,
        admitSources: sourceSessionIds => mayInjectSessionContextForSourcesInTx(tx, {
            configuringAccountId: input.accountId, sourceSessionIds,
            destinationSessionId: destination.id, authentication: input.authentication,
        }),
    });
    return { ok: true, v: 1, sessionId: destination.id, target,
        currentSourceSessionIds: [...observation.currentSourceSessionIds], observations: [...observation.observations] };
}

/** Current target, source reads and pairwise audience policy share one coherent snapshot. */
export async function observePendingSessionFollowForInactiveDestination(
    input: Parameters<typeof observePendingSessionFollowForInactiveDestinationInTx>[1],
): Promise<SessionFollowObserveInactiveResponseV1> {
    return inReadSnapshot(tx => observePendingSessionFollowForInactiveDestinationInTx(tx, input));
}

async function observePendingSessionFollowEdgesInTx(tx: Tx, input: Readonly<{
    destinationSessionId: string;
    destinationRuntimeAccountId: string;
    includeManager?: boolean;
    admitSources: (sourceSessionIds: readonly string[]) => Promise<ReadonlyMap<string, Readonly<{ ok: boolean }>>>;
}>): Promise<SessionFollowObservationResultV1> {
    const readDeliveryMuted = createDeliveryMuteReaderInTx(tx, {
        accountId: input.destinationRuntimeAccountId,
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
    });
    const rows = await tx.sessionFollowEdge.findMany({
        where: { destinationSessionId: input.destinationSessionId,
            sourceSessionId: { not: null },
            relation: { in: input.includeManager ? ['follower', 'manager'] : ['follower'] } },
        select: EDGE_SELECT,
        orderBy: { sourceSessionId: "asc" },
    });

    const edges = rows.flatMap(row => { const edge = readSessionEdge(row); return edge ? [edge] : []; });
    const ruleSelections = await readStalledSessionFollowRulesInTx(tx, { accountId: input.destinationRuntimeAccountId,
        destinationSessionId: input.destinationSessionId, readMuted: readDeliveryMuted });
    const sources = new Map<string, NonNullable<Awaited<ReturnType<typeof loadSession>>>>();
    const sourceIds = [...new Set(edges.map(edge => edge.sourceSessionId))];
    for (const ids of portableQueryChunks({ values: sourceIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        for (const source of await tx.session.findMany({ where: { id: { in: [...ids] } }, select: SESSION_SELECT })) {
            if (source.archivedAt === null) sources.set(source.id, source);
        }
    }
    const admissions = await input.admitSources([...new Set([...sources.keys(),
        ...ruleSelections.map(entry => entry.observation.sourceSessionId)])]);

    const pending: PendingSessionFollowObservationV1[] = [];
    const currentSourceSessionIds: string[] = [];
    for (const edge of edges) {
        const source = sources.get(edge.sourceSessionId);
        if (!source || admissions.get(edge.sourceSessionId)?.ok !== true) continue;
        currentSourceSessionIds.push(edge.sourceSessionId);
        // Observation demands settlement of this original. Keep muted work
        // reachable by the same dispatcher; source hydration and Pending still
        // refuse effects, and Pending retains its suppressed outcome.
        const muted = await readDeliveryMuted({ senderSessionId: edge.sourceSessionId,
            source: { kind: 'session', sessionId: edge.sourceSessionId },
        });
        if (muted === null) continue;
        const delivered = readStoredSessionFollowFrontier(edge);
        const current = readCurrentSourceSessionFollowFrontier(source);
        // Muted originals still traverse to their suppressed Pending outcome.
        // Turn-only context has no Pending to settle and must not wake a host.
        const observed = muted && (current.turn?.status === 'stalled' || current.turn?.status === 'waiting')
            ? { ...current, turn: delivered.turn } : current;
        if (compareSessionFollowFrontierProgressV1(delivered, observed) !== "ahead") continue;
        pending.push({
            sourceSessionId: edge.sourceSessionId,
            destinationSessionId: edge.destinationSessionId,
            delivered,
            observed,
            policy: edge.policy,
            relation: edge.relation,
            ...(edge.relation === 'manager' ? { attachedAt: edge.attachedAt.getTime() } : {}),
        });
    }
    for (const { observation } of ruleSelections) {
        if (admissions.get(observation.sourceSessionId)?.ok !== true) continue;
        currentSourceSessionIds.push(observation.sourceSessionId);
        pending.push(observation);
    }
    return { currentSourceSessionIds: [...new Set(currentSourceSessionIds)], observations: [
        ...pending, ...await observeDiscussionFollowSourcesInTx(tx, input, readDeliveryMuted),
    ] };
}

/** Content-free refusal facts observed at the existing checks, never re-derived by HTTP. */
export type RunFollowOccurrenceUnavailableCode = 'frontier_unavailable' | 'frontier_not_current'
    | 'occurrence_absent' | 'original_mismatch' | 'workflow_state_unavailable' | DiscussionFollowOccurrenceUnavailableCode;

/** The exact retained Run original is shared by Session routing and Account settlement. */
export async function readRunFollowOccurrenceInTx(tx: Tx, input: Readonly<{
    source: RunFollowOriginalV1['source']; original?: RunFollowOriginalV1;
    outputRef?: ExecutionRunOutputRefV1;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
    onUnavailable?: (code: RunFollowOccurrenceUnavailableCode) => void;
}>): Promise<RunFollowOccurrenceV1 | null> {
    const { source } = input;
    const requested = input.original;
    const unavailable = (code: RunFollowOccurrenceUnavailableCode) => { input.onUnavailable?.(code); return null; };
    if (source.kind === 'execution_run') {
        const frontier = input.executionRunFrontier;
        if (!frontier || !isDeepStrictEqual(frontier.source, source)) return unavailable('frontier_unavailable');
        if (!await isExecutionRunFollowFrontierWitnessCurrentInTx(tx, frontier)) return unavailable('frontier_not_current');
        const outputRef = requested && 'output' in requested ? requested.output.outputRef : input.outputRef;
        const occurrence = resolveExecutionRunFollowOccurrenceV1({ ...frontier, ...source }, outputRef);
        if (!occurrence) {
            // Resolver null also covers incomplete evidence. Only a known
            // running/no-attention frontier or an explicitly pending output
            // proves a healthy empty range, never a missing original identity.
            const empty = outputRef ? frontier.outputs?.some(output => isDeepStrictEqual(output.outputRef, outputRef)
                && (output.state === 'pending' || output.state === 'writing'))
                : frontier.status === 'running' && frontier.attention === undefined;
            return unavailable(empty ? 'occurrence_absent' : 'frontier_unavailable');
        }
        return !requested || isDeepStrictEqual(requested, occurrence.original) ? occurrence : unavailable('original_mismatch');
    }
    const run = await tx.automationRun.findUnique({ where: { id: source.runId },
        select: { accountId: true, revision: true, state: true, workflowCustodyState: true } });
    if (!run || run.revision < 1 || run.workflowCustodyState === null) return unavailable('workflow_state_unavailable');
    if (requested && (!('revision' in requested) || run.revision !== requested.revision)) return unavailable('original_mismatch');
    const original = { source, revision: run.revision };
    const terminal = run.state === 'running' ? null
        : resolveWorkflowRunFollowEventV1({ state: run.state, attentionRequired: false });
    if (terminal) return { original, event: terminal };
    const attentionRequired = await tx.automationRun.findFirst({ where: { id: source.runId,
        AND: [workflowRunAttentionWhere(run.accountId)] }, select: { id: true } }) !== null;
    const event = resolveWorkflowRunFollowEventV1({ state: run.state, attentionRequired });
    return event ? { original, event } : unavailable('occurrence_absent');
}

/** The shared non-Session route read delegates facts to each existing source lifecycle. Null is a healthy empty range. */
export async function observeFollowSourceOccurrenceRoutes(input: Readonly<{
    accountId: string; request: SessionFollowSourceOccurrenceRoutesRequestV1;
    authentication: SessionAccessAuthentication; executionRunFrontier?: ExecutionRunFollowFrontierWitness;
    onUnavailable?: (code: RunFollowOccurrenceUnavailableCode) => void;
}>): Promise<SessionFollowSourceOccurrenceRoutesResponseV1 | null> {
    if ('source' in input.request && input.request.source.kind === 'discussion') {
        const request = input.request;
        const source = input.request.source;
        return await inReadSnapshot(async tx => {
            if (input.authentication.sessionRuntimePrincipal || !await isActingAccountActive(tx, input.accountId)
                || !await canReadFollowSourceInTx(tx, { ...input, source }))
                return { ok: false, v: 1, error: 'forbidden' };
            let readCode: DiscussionFollowOccurrenceUnavailableCode | undefined;
            const discussion = await observeAccountDiscussionFollowOccurrenceInTx(tx, { ...input,
                request: { v: 1, source, ...('messageId' in request ? { messageId: request.messageId } : {}) },
                onUnavailable: code => { readCode = code; input.onUnavailable?.(code); } });
            if (!discussion && readCode === 'occurrence_absent') return null;
            return discussion ? { ok: true, v: 1, discussion } : { ok: false, v: 1, error: 'source_unavailable' };
        });
    }
    return observeRunFollowOccurrenceRoutes({ ...input, request: SessionFollowRunOccurrenceRoutesRequestV1Schema.parse(input.request) });
}

/** Retained Run adapter under the shared non-Session route owner. */
export async function observeRunFollowOccurrenceRoutes(input: Readonly<{
    accountId: string; request: SessionFollowRunOccurrenceRoutesRequestV1;
    authentication: SessionAccessAuthentication;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
    onUnavailable?: (code: RunFollowOccurrenceUnavailableCode) => void;
}>): Promise<SessionFollowRunOccurrenceRoutesResponseV1 | null> {
    return await inReadSnapshot(async tx => {
        const requested = 'original' in input.request ? input.request.original : null;
        const source = requested?.source ?? ('source' in input.request ? input.request.source : input.request.original.source);
        const denied = { ok: false, v: 1, error: 'forbidden' } as const;
        const unavailable = { ok: false, v: 1, error: 'source_unavailable' } as const;
        if (input.authentication.sessionRuntimePrincipal || !await isActingAccountActive(tx, input.accountId)
            || !await canReadFollowSourceInTx(tx, { ...input, source })) return denied;
        let readCode: RunFollowOccurrenceUnavailableCode | undefined;
        const occurrence = await readRunFollowOccurrenceInTx(tx, { source, ...(requested ? { original: requested } : {}),
            ...('outputRef' in input.request ? { outputRef: input.request.outputRef } : {}),
            executionRunFrontier: input.executionRunFrontier,
            onUnavailable: code => { readCode = code; input.onUnavailable?.(code); } });
        // Only a current, authorized source-range read can be empty. An exact
        // original still requires positive evidence; absence cannot admit it.
        if (!occurrence) return !requested && readCode === 'occurrence_absent' ? null : unavailable;
        const { original, event } = occurrence;
        // Ready-output convenience is personal custody on notifyOnce. It has
        // no Session-edge cursor and must never become a repeating wake route.
        const edges = 'output' in original ? [] : await tx.sessionFollowEdge.findMany({ where: {
            sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower',
        }, select: EDGE_SELECT });
        const routes = [];
        for (const edge of edges) {
            if (!isDeepStrictEqual(sourceForSessionFollowEdgeV1(edge), source)) continue;
            if (!await hasPendingRunFollowOccurrenceInTx(tx, edge, original)) continue;
            const policy = readStoredPolicy(edge.policyJson);
            if (!policy || !resolveFollowDeliveryV1({ policies: [policy], event }).selected) continue;
            const destination = await loadSession(tx, edge.destinationSessionId);
            if (!destination || destination.archivedAt !== null || destination.accountId !== input.accountId
                || !await canSubmitDestinationInput(tx, input.accountId, destination.id, input.authentication)
                || !await mayInjectOtherFollowSourceInTx(tx, { ...input, source, destinationSessionId: destination.id })
                || await isDeliveryMutedInTx(tx, { accountId: input.accountId,
                    receiver: { kind: 'session', sessionId: destination.id }, candidate: { source,
                        ...(source.kind === 'execution_run' && 'sessionId' in source ? { senderSessionId: source.sessionId } : {}) } }) === null) continue;
            routes.push({ destinationSessionId: destination.id, relation: 'follower', attachedAt: edge.attachedAt.getTime(), policy,
                ...('revision' in original ? { expectedRevision: edge.deliveredWorkflowRunRevision ?? 0 }
                    : { expectedTerminalEventId: edge.deliveredExecutionRunTerminalEventId }) });
        }
        const personal = await readAccountRunFollowDeliveryInTx(tx, { ...input, ...occurrence });
        return SessionFollowRunOccurrenceRoutesResponseV1Schema.parse({ ok: true, v: 1, original, event, routes,
            ...(personal ? { personal: { policy: personal.policy, alreadyRepresented: personal.represented } } : {}) });
    });
}

export type SessionFollowAcknowledgeRejection =
    | "edge_not_found"
    | "session_archived"
    | "stale_publisher_generation"
    | "stale_expected_frontier"
    | "stale_terminal_turn"
    | "invalid_consumed_frontier"
    | "provider_acceptance_unverified"
    | "source_forbidden";

export type SessionFollowAcknowledgeResult =
    | Readonly<{ ok: true; delivered: SessionFollowFrontierV1 }>
    | Readonly<{ ok: false; rejection: SessionFollowAcknowledgeRejection }>;

/** Input admission retains current ordinary/manager reasons beside one public original. */
export async function admitSessionFollowRelationsForInputInTx(tx: Tx, input: Readonly<{
    accountId: string; destinationSessionId: string;
    delivery: NonNullable<SessionPendingEnqueueByMachineRequestV1['followDeliveryV1']>;
    relations: NonNullable<SessionPendingEnqueueByMachineRequestV1['followRelations']>;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
    /** Only an immutable server-built Pending/Message receipt supplies this fact. */
    admittedOriginal?: true;
    /** Pending validates all other fences before retaining a suppressed original. */
    settleSuppressedOriginal?: true;
} & ({ sourceMachineId: string; authentication?: never } | { sourceMachineId?: never; authentication: SessionAccessAuthentication })>): Promise<readonly SessionFollowInputRelation[] | null> {
    if (!('sourceSessionId' in input.delivery.original)) {
        return admitRunFollowRelationsForInputInTx(tx, input);
    }
    const pair = { destinationSessionId: input.destinationSessionId, sourceSessionId: input.delivery.original.sourceSessionId };
    const source = await tx.session.findUnique({ where: { id: pair.sourceSessionId },
        select: { id: true, accountId: true, archivedAt: true, seq: true, agentStateVersion: true, encryptionMode: true } });
    if ('sourceTurn' in input.delivery.original && (!('event' in input.delivery)
        || !isDeepStrictEqual(input.delivery.event, resolveSessionFollowTurnEventV1(input.delivery.original.sourceTurn)))) return null;
    if (!source || source.archivedAt !== null || !(await evaluateCurrentSessionContextPairInTx(tx, pair)).ok
        || !await readSessionFollowOriginalOccurrenceFrontiersInTx(tx, { source, occurrence: input.delivery.original,
            delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null } })) return null;
    if (input.authentication) {
        if (input.authentication.sessionRuntimePrincipal || !(await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId, authentication: input.authentication, ...pair,
        })).ok) return null;
    } else {
        const [sourceTarget, receiverTarget] = await Promise.all([
            source.accountId === input.accountId ? readCurrentCommittedSessionInputMachineTargetInTx(tx, source.id) : null,
            readCurrentCommittedSessionInputMachineTargetInTx(tx, pair.destinationSessionId),
        ]);
        if (![sourceTarget, receiverTarget].some(target => target?.accountId === input.accountId && target.machineId === input.sourceMachineId)) return null;
    }
    if (!input.settleSuppressedOriginal && await isDeliveryMutedInTx(tx, { accountId: input.accountId, receiver: { kind: 'session', sessionId: pair.destinationSessionId },
        candidate: { senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } } }) !== false) return null;
    const relations: SessionFollowInputRelation[] = [];
    for (const relation of input.relations) {
        const edge = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceSessionId_relation: {
            ...pair, relation: relation.relation,
        } } });
        if (!edge || relation.relation === 'manager' && edge.attachedAt.getTime() !== relation.attachedAt) return null;
        if (!resolveSessionFollowInputSelectedDelivery(input.delivery, [edge], [])) continue;
        relations.push(edge);
    }
    return relations;
}

/** Run originals use the same relation, disclosure and Pending acceptance owners, never a parent transcript cursor. */
async function admitRunFollowRelationsForInputInTx(tx: Tx, input: Readonly<{
    accountId: string; destinationSessionId: string; delivery: SessionFollowInputV1;
    relations: NonNullable<SessionPendingEnqueueByMachineRequestV1['followRelations']>;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
    admittedOriginal?: true;
    settleSuppressedOriginal?: true;
    sourceMachineId?: string; authentication?: SessionAccessAuthentication;
}>): Promise<readonly SessionFollowInputRelation[] | null> {
    const original = input.delivery.original;
    if (!isRunFollowOriginalV1(original) || !('event' in input.delivery)) return null;
    if ('output' in original) return null;
    const source = original.source;
    const authentication = input.authentication ?? backgroundDeliveryAuthentication();
    const machineAdmission = source.kind === 'execution_run' && 'machineId' in source
        ? await readExecutionRunFollowMachineAdmissionInTx(tx, { ...input, machineId: source.machineId, authentication }) : null;
    const sourceReadable = source.kind === 'execution_run' && 'machineId' in source ? machineAdmission !== null
        : await canReadFollowSourceInTx(tx, { ...input, source, authentication });
    if (authentication.sessionRuntimePrincipal || !sourceReadable
        || !await mayInjectOtherFollowSourceInTx(tx, { ...input, source, authentication })) return null;
    const destination = await tx.session.findUnique({ where: { id: input.destinationSessionId },
        select: { accountId: true, archivedAt: true } });
    if (!destination || destination.accountId !== input.accountId || destination.archivedAt !== null) return null;
    if (input.sourceMachineId) {
        const receiver = await readCurrentCommittedSessionInputMachineTargetInTx(tx, input.destinationSessionId);
        const producer = source.kind === 'execution_run' && 'sessionId' in source
            ? await readCurrentCommittedSessionInputMachineTargetInTx(tx, source.sessionId)
            : machineAdmission ? { accountId: machineAdmission.custodianAccountId, machineId: machineAdmission.machineId } : undefined;
        if (![receiver, producer].some(target => target?.accountId === input.accountId
            && target.machineId === input.sourceMachineId)) return null;
    }
    if (!input.settleSuppressedOriginal && await isDeliveryMutedInTx(tx, { accountId: input.accountId,
        receiver: { kind: 'session', sessionId: input.destinationSessionId }, candidate: {
            source, ...(source.kind === 'execution_run' && 'sessionId' in source ? { senderSessionId: source.sessionId } : {}),
        } }) !== false) return null;
    const acceptedKey = deriveSessionFollowOriginalOccurrenceKeyV1(original);
    const accepted = acceptedKey ? await tx.sessionMessage.findFirst({ where: { sessionId: input.destinationSessionId,
        acceptedFollowOriginalKey: acceptedKey }, select: { localId: true, seq: true } }) : null;
    const nativeAccepted = accepted?.localId ? await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
        destinationSessionId: input.destinationSessionId, localInputId: accepted.localId,
        userMessageSeq: accepted.seq, requireProviderAccepted: true,
    }) : false;
    if (!nativeAccepted && !input.admittedOriginal) {
        const occurrence = await readRunFollowOccurrenceInTx(tx, { source, original,
            executionRunFrontier: input.executionRunFrontier });
        if (!occurrence || !isDeepStrictEqual(occurrence.event, input.delivery.event)) return null;
    }
    const relations: SessionFollowInputRelation[] = [];
    for (const reason of input.relations) {
        if (!('source' in reason) || !isDeepStrictEqual(reason.source, source)) return null;
        const edge = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
            destinationSessionId: input.destinationSessionId, sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower',
        } } });
        if (!edge || edge.attachedAt.getTime() !== reason.attachedAt
            || !isDeepStrictEqual(sourceForSessionFollowEdgeV1(edge), source)) {
            if (input.admittedOriginal) continue;
            return null;
        }
        const policy = readStoredPolicy(edge.policyJson);
        if (!policy || !resolveFollowDeliveryV1({ policies: [policy], event: input.delivery.event }).selected) {
            if (input.admittedOriginal) continue;
            return null;
        }
        if (!input.admittedOriginal
            && resolveSessionFollowInputSelectedDelivery(input.delivery, [edge], []) !== input.delivery.delivery) return null;
        if (!nativeAccepted && ('expectedRevision' in reason
            ? edge.deliveredWorkflowRunRevision !== reason.expectedRevision
            : edge.deliveredExecutionRunTerminalEventId !== reason.expectedTerminalEventId)) return null;
        relations.push(edge);
    }
    return relations.length || input.admittedOriginal ? relations : null;
}

/** Exact Pending→Message custody settles all admitted reasons without publishing private witnesses. */
export async function acknowledgeAdmittedSessionFollowInputInTx(tx: Tx, input: Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    request: Extract<SessionFollowAcknowledgeRequestV1, { localInputId: string }>;
}>): Promise<SessionFollowAcknowledgeResult> {
    const request = input.request;
    const accountId = input.principal.kind === 'destination_runtime'
        ? input.principal.destinationRuntimeAccountId : input.principal.accountId;
    const readCurrentAdmission = async () => {
        const destination = await loadSession(tx, request.destinationSessionId);
        if (!destination || destination.accountId !== accountId || destination.archivedAt !== null
            || !await isActingAccountActive(tx, accountId)
            || !await canSubmitDestinationInput(tx, accountId, destination.id,
                await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal))) return { ok: false as const, rejection: 'source_forbidden' as const };
        if (destination.publisherGeneration.toString() !== request.expectedPublisherGeneration) return { ok: false as const, rejection: 'stale_publisher_generation' as const };
        const custody = await readAdmittedSessionFollowInputInTx(tx, { principal: input.principal, accountId,
            destinationSessionId: destination.id, ...('sourceSessionId' in request ? { sourceSessionId: request.sourceSessionId } : {}), localInputId: request.localInputId });
        if (!custody) return { ok: false as const, rejection: 'source_forbidden' as const };
        const represented = sessionFollowInputFrontiers(custody.delivery);
        if ('original' in request ? !isDeepStrictEqual(request.original, custody.delivery.original)
            : !isSessionFollowFrontierEqualV1(request.expected, represented.expected)
            || !isSessionFollowFrontierEqualV1(request.observed, represented.observed)
            || !isSessionFollowFrontierEqualV1(request.consumed, represented.observed)) return { ok: false as const, rejection: 'invalid_consumed_frontier' as const };
        if (request.acceptance.localInputId !== request.localInputId
            || !await hasCanonicalFollowProviderInputAcceptanceInTx(tx, { destinationSessionId: destination.id,
                localInputId: request.localInputId, userMessageSeq: request.acceptance.userMessageSeq,
                requireProviderAccepted: true })) return { ok: false as const, rejection: 'provider_acceptance_unverified' as const };
        return { ok: true as const, destination, custody, represented };
    };
    let admission = await readCurrentAdmission();
    if (!admission.ok) return admission;
    if (admission.custody.admissions.length > 0 || 'sourceSessionId' in admission.custody.delivery.original
        && admission.custody.relations.length > 0) {
        // Accepted progress publishes the destination Session. Admit its complete
        // audience and resource before KV/edge writes or terminal Account locks.
        await acquireSessionAccountCursorLocksInTx(tx, [admission.destination.id], [accountId]);
        admission = await readCurrentAdmission();
        if (!admission.ok) return admission;
    }
    const { custody, represented } = admission;
    const relationProgressAdvanced = 'sourceSessionId' in custody.delivery.original && custody.relations.some(edge =>
        edge.deliveredTranscriptSeq < represented.observed.transcriptSeq
        || edge.deliveredAgentStateVersion < represented.observed.agentStateVersion
        || 'sourceTurn' in custody.delivery.original && !isSessionFollowTurnEqualV1(readStoredSessionFollowFrontier(edge).turn, custody.delivery.original.sourceTurn));
    if (!await settleSessionFollowInputReasonsInTx(tx, { progresses: custody.admissions.map(row => row.progress),
        relations: custody.relations, observed: represented.observed, delivery: custody.delivery })) return { ok: false, rejection: 'stale_expected_frontier' };
    // Rule progress already publishes through its KV owner. Manager/explicit
    // progress must wake that same receiver recovery after an unconfirmed
    // middle admission, even if no new source notification will arrive.
    if (relationProgressAdvanced) await invalidateSessionFollowDestinationsInTx(tx, [admission.destination.id]);
    return { ok: true, delivered: represented.observed };
}

/**
 * Advances one edge's delivered frontier after the canonical provider-input
 * outcome reported acceptance.
 *
 * This is consumption progress, not exactly-once delivery proof. The write is a
 * compare-and-set over the complete expected stored tuple and the
 * destination's exact publisher generation, so a reordered or
 * duplicated acknowledgment can never regress or overwrite newer progress. The
 * three numeric components must be monotone from the expected tuple and no
 * greater than either the exact observed tuple or the current canonical source
 * values. An original prefix may retain the already-delivered turn while its
 * terminal outcome remains pending. Turns are identities, so the observed
 * turn must still equal the current source turn before any progress commits.
 */
export async function acknowledgeSessionFollowFrontierInTx(tx: Tx, input: Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    destinationSessionId: string;
    sourceSessionId: string;
    relation?: 'follower' | 'manager' | 'rule';
    attachedAt?: number;
    expectedPublisherGeneration: bigint;
    policy?: FollowPolicyV1;
    effectiveDelivery?: SessionFollowSelectedDeliveryV1;
    presence?: SessionFollowStalledOccurrenceV1;
    expected: SessionFollowFrontierV1;
    observed: SessionFollowFrontierV1;
    consumed: SessionFollowFrontierV1;
    acceptance: SessionFollowAcknowledgeRequestV1['acceptance'];
}>): Promise<SessionFollowAcknowledgeResult> {
    if (
        input.principal.kind === "ephemeral_session_runner"
        && !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
    ) return { ok: false, rejection: "source_forbidden" };
    const destinationRuntimeAccountId = input.principal.kind === "destination_runtime"
        ? input.principal.destinationRuntimeAccountId
        : input.principal.accountId;
    const authentication = await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal);
    const acceptance = input.acceptance;
    if (!acceptance) {
        return { ok: false, rejection: "provider_acceptance_unverified" };
    }
    switch (acceptance.kind) {
        case "context_only_wake":
            if (typeof acceptance.eventLocalId !== "string" || acceptance.eventLocalId.trim().length === 0) {
                return { ok: false, rejection: "provider_acceptance_unverified" };
            }
            break;
        case "admitted_input":
            if (
                typeof acceptance.localInputId !== "string"
                || acceptance.localInputId.trim().length === 0
                || !(acceptance.userMessageSeq === null
                    || Number.isSafeInteger(acceptance.userMessageSeq) && acceptance.userMessageSeq >= 0)
            ) {
                return { ok: false, rejection: "provider_acceptance_unverified" };
            }
            break;
        default:
            return { ok: false, rejection: "provider_acceptance_unverified" };
    }
    const rule = input.relation === 'rule' ? (await readStalledSessionFollowRulesInTx(tx, {
        accountId: destinationRuntimeAccountId, destinationSessionId: input.destinationSessionId,
        sourceSessionId: input.sourceSessionId,
    }))[0] : null;
    const edge = input.relation === 'rule' ? null : readSessionEdge(await tx.sessionFollowEdge.findUnique({
        where: {
            destinationSessionId_sourceSessionId_relation: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                relation: input.relation ?? 'follower',
            },
        },
        select: EDGE_SELECT,
    }));
    if (!edge && !rule) return { ok: false, rejection: "edge_not_found" };
    const policy = FollowPolicyV1Schema.safeParse(input.policy);
    if (edge ? !policy.success || !isFollowPolicyEqualV1(edge.policy, policy.data)
        : rule!.observation.effectiveDelivery !== input.effectiveDelivery || !isDeepStrictEqual(rule!.observation.presence, input.presence)) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    if (edge?.relation === 'manager' && edge.attachedAt.getTime() !== input.attachedAt) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    const stored = edge ? readStoredSessionFollowFrontier(edge) : rule!.observation.delivered;
    if (!isSessionFollowFrontierEqualV1(stored, input.expected)) {
        return { ok: false, rejection: "stale_expected_frontier" };
    }

    const destination = await loadSession(tx, input.destinationSessionId);
    const source = await loadSession(tx, input.sourceSessionId);
    if (!destination || !source) return { ok: false, rejection: "edge_not_found" };
    if (destination.accountId !== destinationRuntimeAccountId
        || !await isActingAccountActive(tx, destinationRuntimeAccountId)
        || !await canSubmitDestinationInput(
            tx,
            destinationRuntimeAccountId,
            destination.id,
            authentication,
        )
        || !(await assertSessionFollowSourceReadInTx(tx, {
            principal: input.principal,
            sourceSessionId: input.sourceSessionId,
            edge: { sourceSessionId: input.sourceSessionId, destinationSessionId: input.destinationSessionId },
        })).ok) return { ok: false, rejection: "source_forbidden" };
    if (destination.archivedAt !== null || source.archivedAt !== null) {
        return { ok: false, rejection: "session_archived" };
    }
    if (destination.publisherGeneration !== input.expectedPublisherGeneration) {
        return { ok: false, rejection: "stale_publisher_generation" };
    }

    let hasCanonicalAcceptance: boolean;
    if (acceptance.kind === "context_only_wake") {
        let expectedEventLocalId: string;
        try {
            expectedEventLocalId = deriveSessionFollowWakeEventLocalIdV1({
                destinationSessionId: destination.id,
                publisherGeneration: destination.publisherGeneration.toString(),
                observations: acceptance.observations,
            });
        } catch {
            return { ok: false, rejection: "provider_acceptance_unverified" };
        }
        const acceptedObservation = acceptance.observations.find(
            (observation) => observation.sourceSessionId === input.sourceSessionId
                && (observation.relation ?? 'follower') === (input.relation ?? 'follower'),
        );
        if (
            expectedEventLocalId !== acceptance.eventLocalId
            || !acceptedObservation
            || acceptedObservation.attachedAt !== input.attachedAt
            || (input.relation === 'rule' ? acceptedObservation.relation !== 'rule'
                || acceptedObservation.effectiveDelivery !== input.effectiveDelivery
                || !isDeepStrictEqual(acceptedObservation.presence, input.presence)
                : acceptedObservation.relation === 'rule' || !policy.success
                    || !isFollowPolicyEqualV1(acceptedObservation.policy, policy.data))
            || !isSessionFollowFrontierEqualV1(acceptedObservation.expected, input.expected)
            || !isSessionFollowFrontierEqualV1(acceptedObservation.consumed, input.consumed)
        ) {
            return { ok: false, rejection: "provider_acceptance_unverified" };
        }
        if (rule ? rule.observation.effectiveDelivery !== 'wake' : !policyAllowsFollowWake(edge!.policy)) {
            // A stronger route for this exact source may cover a quiet route.
            // Its ACK may have committed first: current attachment/policy and
            // the accepted represented prefix remain the proof, not its old cursor.
            let covered = false;
            for (const represented of acceptance.observations) {
                if (represented.sourceSessionId !== input.sourceSessionId) continue;
                if (represented.relation === 'rule') {
                    const stronger = (await readStalledSessionFollowRulesInTx(tx, { accountId: destinationRuntimeAccountId,
                        destinationSessionId: destination.id, sourceSessionId: input.sourceSessionId, includeRepresented: true }))[0];
                    if (stronger?.observation.effectiveDelivery === 'wake' && represented.effectiveDelivery === 'wake'
                        && isDeepStrictEqual(stronger.observation.presence, represented.presence)
                        && represented.consumed.transcriptSeq >= input.consumed.transcriptSeq
                        && represented.consumed.readyEventSeq >= input.consumed.readyEventSeq
                        && represented.consumed.agentStateVersion >= input.consumed.agentStateVersion
                        && isSessionFollowTurnEqualV1(represented.consumed.turn, input.consumed.turn)) {
                        covered = true;
                        break;
                    }
                    continue;
                }
                if (!policyAllowsFollowWake(represented.policy)) continue;
                const stronger = readSessionEdge(await tx.sessionFollowEdge.findUnique({
                    where: { destinationSessionId_sourceSessionId_relation: {
                        destinationSessionId: destination.id, sourceSessionId: input.sourceSessionId, relation: represented.relation,
                    } }, select: EDGE_SELECT,
                }));
                const current = readCurrentSourceSessionFollowFrontier(source);
                if (!stronger || !isFollowPolicyEqualV1(stronger.policy, represented.policy)
                    || (stronger.relation === 'manager' ? stronger.attachedAt.getTime() : undefined) !== represented.attachedAt
                    || represented.consumed.transcriptSeq < input.consumed.transcriptSeq
                    || represented.consumed.readyEventSeq < input.consumed.readyEventSeq
                    || represented.consumed.agentStateVersion < input.consumed.agentStateVersion
                    || !isSessionFollowConsumptionWithinCurrentV1({ expected: represented.expected,
                        observed: current, consumed: represented.consumed, current })) continue;
                covered = true;
                break;
            }
            if (!covered) {
                return { ok: false, rejection: "provider_acceptance_unverified" };
            }
        }
        hasCanonicalAcceptance = await hasCanonicalFollowWakeEventAcceptanceInTx(tx, {
            destinationSessionId: input.destinationSessionId,
            eventLocalId: acceptance.eventLocalId,
        });
    } else {
        hasCanonicalAcceptance = await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
            destinationSessionId: input.destinationSessionId,
            localInputId: acceptance.localInputId,
            userMessageSeq: acceptance.userMessageSeq,
        });
    }
    if (!hasCanonicalAcceptance) {
        return { ok: false, rejection: "provider_acceptance_unverified" };
    }

    const current = readCurrentSourceSessionFollowFrontier(source);
    if (!isSessionFollowConsumptionWithinCurrentV1({
        expected: input.expected,
        observed: input.observed,
        consumed: input.consumed,
        current,
    })) {
        return { ok: false, rejection: "invalid_consumed_frontier" };
    }
    if (!isSessionFollowTurnEqualV1(current.turn, input.observed.turn)) {
        return { ok: false, rejection: "stale_terminal_turn" };
    }

    if (rule) {
        if (!input.presence || !isSessionFollowStalledOccurrenceCurrentV1(input.presence, {
            ...source, activeAt: source.lastActiveAt.getTime(),
        })) return { ok: false, rejection: 'stale_terminal_turn' };
        await acknowledgeStalledSessionFollowRulesInTx(tx, rule.progress, input.consumed);
        return { ok: true, delivered: input.consumed };
    }

    const frontierWhere = writeSessionFollowFrontierColumns(input.expected);
    const written = await tx.sessionFollowEdge.updateMany({
        where: { destinationSessionId: input.destinationSessionId, sourceSessionId: input.sourceSessionId,
            relation: edge!.relation, policyJson: edge!.policyJson,
            ...(edge!.relation === 'manager' ? { attachedAt: edge!.attachedAt } : {}), ...frontierWhere },
        data: writeSessionFollowFrontierColumns(input.consumed),
    });
    if (written.count === 0) return { ok: false, rejection: "stale_expected_frontier" };
    return { ok: true, delivered: input.consumed };
}

/**
 * Reseed adapter consumed by the canonical Session archive/restore owner.
 *
 * Archiving either endpoint keeps the edge and makes it derived-dormant, so
 * this performs no write. When a Session becomes unarchived and its partner is
 * also unarchived, every delivered component is reseeded to the source's
 * then-current frontier in the same transaction, so updates accumulated while
 * archived are intentionally skipped rather than replayed.
 */
export async function reseedRestoredSessionFollowEdgesInTx(tx: Tx, input: Readonly<{
    sessionId: string;
    archived: boolean;
}>): Promise<number> {
    if (input.archived) return 0;
    const edges = await tx.sessionFollowEdge.findMany({
        where: {
            OR: [{ sourceSessionId: input.sessionId }, { destinationSessionId: input.sessionId }],
            relation: 'follower',
            sourceSessionId: { not: null },
        },
        select: { sourceSessionId: true, destinationSessionId: true },
    });

    let reseeded = 0;
    for (const edge of edges) {
        if (edge.sourceSessionId === null) continue;
        const source = await loadSession(tx, edge.sourceSessionId);
        const destination = await loadSession(tx, edge.destinationSessionId);
        if (!source || !destination) continue;
        if (source.archivedAt !== null || destination.archivedAt !== null) continue;
        await tx.sessionFollowEdge.update({
            where: {
                destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: edge.destinationSessionId,
                    sourceSessionId: edge.sourceSessionId,
                    relation: 'follower',
                },
            },
            data: writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(source)),
        });
        reseeded += 1;
    }
    return reseeded;
}

/**
 * Re-evaluates each Follow edge touching a Session whose effective audience or
 * access just changed. The complete current pair decision catches source-access
 * loss by any destination audience member as well as destination broadening;
 * it preserves an edge when the final post-mutation pair remains safe.
 * Restoring access does not
 * recreate the edge: the user follows again explicitly, seeded to current, so
 * content accumulated while unauthorized is never silently disclosed.
 */
export async function removeUnsafeSessionFollowEdgesForAccessChangeInTx(tx: Tx, input: Readonly<{
    sessionId: string;
}>): Promise<number> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: {
            relation: 'follower',
            sourceSessionId: { not: null },
            OR: [
                { sourceSessionId: input.sessionId },
                { destinationSessionId: input.sessionId },
            ],
        },
        select: { sourceSessionId: true, destinationSessionId: true },
    });

    let removed = 0;
    const invalidatedDestinationSessionIds = new Set<string>();
    for (const edge of edges) {
        if (edge.sourceSessionId === null) continue;
        if ((await evaluateCurrentSessionContextPairInTx(tx, { ...edge, sourceSessionId: edge.sourceSessionId })).ok) continue;
        const deleted = await tx.sessionFollowEdge.deleteMany({
            where: {
                destinationSessionId: edge.destinationSessionId,
                sourceSessionId: edge.sourceSessionId,
                relation: 'follower',
            },
        });
        removed += deleted.count;
        if (deleted.count > 0) invalidatedDestinationSessionIds.add(edge.destinationSessionId);
    }
    await invalidateSessionFollowDestinationsInTx(tx, invalidatedDestinationSessionIds);
    return removed;
}
