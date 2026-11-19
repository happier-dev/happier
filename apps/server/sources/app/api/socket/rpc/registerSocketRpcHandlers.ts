import { decodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import { cancelRpcTarget } from './cancelRpcTarget';
import { SocketRpcContinuationFrameV1Schema } from '@happier-dev/protocol/socketRpc';
import { projectRpcFailureDiagnostic } from './rpcFailureDiagnostic';
import { createProtectedRawSessionTargetGuard } from './protectedRawSessionTargetGuard';
import { forwardManagedInstallationResponse } from './forwardManagedInstallationResponse';
import { createLiveApprovalOriginTargetGuard, isOrdinaryLiveApprovalOriginSocket, isPresentUserLiveApprovalOriginCaller } from './liveApprovalOrigin';
import { isLiveCliApprovalOriginMethod } from '@happier-dev/protocol/approvals/approvalRequestV1';

import type { Server, Socket } from "socket.io";

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { ActionFailureCauseV1Schema, projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ScmWorkEvidenceAuthorizationSelectorSchema, type ScmWorkEvidenceAdmission } from '@happier-dev/protocol/scm';
import { readStructuredMessageActionRoutingV1 } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { StructuredMessageActionRoutingV1Schema, type StructuredMessageActionRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { readDeploymentArchiveRpcEffectV1 } from '@happier-dev/protocol';
import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import { isWorkspaceSyncRelationshipWriteActionId } from '@happier-dev/protocol/actions/actionIds';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS, parseSocketRpcAuthorizationContext, isSocketRpcSessionAuthorizationNamespace, resolveSocketRpcSessionAuthorization, type SocketRpcAuthorizationContext, type SocketRpcCurrentSessionPresentationOriginAuthorizationContext, type SessionPermissionDecisionAuthenticationV1 } from '@happier-dev/protocol/socketRpc';
import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '@happier-dev/protocol/auth/authToken';
import { AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/automations/event';
import { CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD, CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD } from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ExternalActionMachineRpcExecutionV1Schema, isExternalActionManagedWakeRootV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SESSION_SERVER_START_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/sessions/creation/sessionServerStartV1';
import { SessionFollowSourceKeyPrepareAuthorizationV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { resolveEphemeralRunnerMachineRpcAuthority, type EphemeralRunnerMachineRpcAuthority } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { isUiBrowserAutomationDispatchMethod } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import { isCurrentUiContextClientRpcMethod, isSessionUiActionClientRpcMethod, isVoiceRunActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { type MachineAccessRefusalCode, type SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityReadRequestV1Schema, ManagedAdmissionDrainConfirmRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { resolveManagedGuestActivityAdmissionInTx, publishManagedGuestActivityAvailable } from '@/app/machines/managed/managedGuestActivity';
import { inReadSnapshot } from '@/storage/inTx';
import { readDatabaseErrorCode } from '@/storage/transactionErrors';
import { VerifiedEphemeralSessionRunnerPrincipalSchema } from "@happier-dev/protocol/ephemeralRunner/principal";
import { canCredentialDecideV1 } from "@happier-dev/protocol/actions/decisionAuthority";
import { computeExternalActionSocketRpcRequestDigestV1, isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { StrictJsonValueSchema, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { prepareManagedFiniteActionWake } from '@/app/machines/managed/managedWake';
import { auth } from "@/app/auth/auth";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { hasCurrentSocketCredential, readCurrentSocketCredential } from "../socketCredentialCurrentness";
import { transferRelayLifecycle } from "../transferRelayLifecycle";
import {
    SOCKET_RPC_EVENTS,
    SocketRpcCancellationPayloadSchema,
    SocketRpcRequestIdSchema,
    SocketRpcTimeoutMsSchema,
    SocketRpcAnsweringClientV1Schema,
    ANSWERING_CLIENT_RPC_PREFIX_V1,
    SessionTransferRoutingV1Schema,
    SessionTransferRpcMethodV1Schema,
    WorkspaceSyncSourceRoutingV1Schema,
    WorkspaceSyncTargetRoutingV1Schema,
    WorkspaceSyncSourceWriterTargetRoutingV1Schema,
    WorkspaceSyncSourceExecutionV1Schema,
    WorkspaceSyncSeedRoutingV1Schema,
    isWorkspaceSyncSourceWriterCleanupPhaseV1,
    readWorkspaceSyncTargetMethodV1,
    isSessionActionRpcMethodV1,
    readOriginalActionEnvelopeMachineRpcKindV1,
    type SessionActionRpcOriginV1,
    type WorkspaceSyncSourceRoutingV1,
    type WorkspaceSyncTargetRoutingV1,
} from "@happier-dev/protocol/socketRpc";

import { observeRpcCall, recordRpcCallFailure, recordRpcRegistration, recordRpcUnregistration } from "@/app/monitoring/metrics/index";
import { classifyMachineAvailabilityState, readMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { mintWorkspaceSyncSeedCarrier } from '@/app/machines/peer/mediation/mintWorkspaceSyncSeedCarrier';
import { resolveSessionAccessForOperation, type SessionAccessOperationDecision } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromSocket } from "@/app/session/access/sessionAccessAuthentication";
import { isCurrentSessionInputMachineTargetInTx, readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { db } from "@/storage/db";
import { readMachineAdmissionFactsInTx, resolveMachineAdmission, resolveMachineAdmissionFromFactsInTx } from "@/app/machines/machineAccess";
import { isMachineOperationSupportedForRequester, isRetainedMachineOperationRequest, type MachineOperationRequesterContext } from '@/app/machines/machineOperationSupport';
import { readMachineDevcontainerWorkspaceSyncRouteInTx } from "@/app/machines/managed/managedRows";
import { recoverMachineAccessLossCustody } from '@/app/machines/machineAccessCustody';
import { log, warn } from "@/utils/logging/log";
import type {
    CaptureExplicitMachineStopResult,
    createSessionPublisherPresence,
} from "@/app/presence/sessionPublisherPresence";
import { readSessionPublisherAuthorityProjection } from "@/app/presence/sessionPublisherPresence";
import { readAdmittedExternalActionHandoffMachineInTx } from '@/app/auth/externalActionHandoffAdmission';
import { publishSessionPublisherClose } from "@/app/presence/publishSessionPublisherClose";
import {
    authorizeSessionFollowSourceKeyPreparation,
    authorizeSessionFollowSourceKeyPreparer,
} from "@/app/session/follow/sessionFollowEdgeService";
import { verifyExternalActionMachineRpcExecution, hasCurrentExternalActionSessionSource,
    readCurrentWorkspaceSyncHandoffWriterTarget, verifyWorkspaceSyncProjectSourceAuthorization,
    resolveReceivingMachineRpcAdmission } from "@/app/auth/externalActionExecutionAuthorization";
import {
    readMaterializedRunnerMachineRoutingBinding,
    verifyCurrentMaterializedRunnerPrincipal,
} from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";

import { canCallSessionScopedRpcMethod, canRegisterSessionScopedRpcMethod, hasCurrentSessionActionRpcSourceBinding,
    hasCurrentSessionScopedMachineAccessInTx, readSessionScopedSocketBinding } from "../sessionScopedBinding";
import {
    canEphemeralRunnerMachineRegisterRpcMethod,
    type RestrictedSocketAdmission,
} from "../restrictedSocketAdmission";
import { readVerifiedMachineSocketInstallationIdFromSocketData } from "../machineSocketInstallationProof";
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, resolveCurrentSessionMachineFromServer } from "../externalActionDispatcher";
import { forwardRpcCall } from "./forwardRpcCall";
import type { RpcForwardTargetGuard } from "./_types";
import { buildMachineRpcAvailabilityRoom, buildRpcMethodRoom } from "./rpcMethodRoom";
import { RPC_REGISTERED_METHODS_SOCKET_DATA_KEY, readSocketRegisteredRpcMethods } from './rpcRegisteredMethods';
import { getMachineSocketRoom } from "../../socketRooms";
import { isWorkflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { DESKTOP_UI_ACTION_CLIENT_RPC_METHOD, isMountedWorkReadClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { readSocketRoomSnapshot } from '../socketRoomDiscovery';
import { readRegisteredRpcTargetPresence } from './rpcTargetDiscovery';
import { resolveSessionBrowserRpcCapabilityV1, type SocketRpcSessionBrowserAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { resolveSessionBrowserAdmission } from './sessionBrowserAdmission';
import { admitSessionRpc } from './admitSessionRpc';

const MAX_RPC_METHOD_NAME_LENGTH = 512;
const MACHINE_VISIBLE_CLIENT_RPC_METHODS = new Set<string>([
    RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME,
    RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE,
    RPC_METHODS.UI_ACTION_EXECUTE,
    DESKTOP_UI_ACTION_CLIENT_RPC_METHOD,
]);

function isMachineVisibleClientRpcMethod(method: string): boolean {
    return MACHINE_VISIBLE_CLIENT_RPC_METHODS.has(method)
        || isUiBrowserAutomationDispatchMethod(method)
        || isWorkflowDraftClientRpcMethod(method)
        || isMountedWorkReadClientRpcMethod(method)
        || isSessionUiActionClientRpcMethod(method)
        || isVoiceRunActionClientRpcMethod(method)
        || isCurrentUiContextClientRpcMethod(method);
}

type SessionPublisherPresenceForRpc = Pick<
    ReturnType<typeof createSessionPublisherPresence>,
    | "captureExplicitMachineStop"
    | "finalizeExplicitMachineStop"
    | "resolveProjectedCurrentPublisher"
    | "isCurrentPublisherProjection"
    | "runAsProjectedCurrentPublisher"
>;

type SocketDataCarrier = Readonly<{ data?: unknown }>;

type MachineScopedRpcMethod = Readonly<{
    machineId: string;
    rpcMethod: string;
}>;

type ActiveSocketRpcCancellation = {
    controller: AbortController;
    /** Cooperative work cancellation must not retire a still-connected caller's result. */
    ackController?: AbortController;
    targetRequestId: string;
    targetSocketId: string | null;
    cancelled: boolean;
};

function readOptionalSocketRpcRequestId(data: unknown): string | null | undefined {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const requestId = (data as { requestId?: unknown }).requestId;
    if (requestId === undefined) return undefined;
    const parsed = SocketRpcRequestIdSchema.safeParse(requestId);
    return parsed.success ? parsed.data : null;
}

function cancelActiveSocketRpcCall(params: Readonly<{
    io: Server;
    active: ActiveSocketRpcCancellation;
    retireAck?: boolean;
}>): void {
    // A disconnect still retires custody after an earlier cooperative cancel.
    if (params.retireAck) params.active.ackController?.abort();
    if (params.active.cancelled) return;
    params.active.cancelled = true;
    params.active.controller.abort();
    if (!params.active.targetSocketId) return;
    cancelRpcTarget({ io: params.io, targetSocketId: params.active.targetSocketId, targetRequestId: params.active.targetRequestId });
}

function normalizeRpcMethodName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex > 0 && (isWorkflowDraftClientRpcMethod(trimmed.slice(separatorIndex + 1))
        || isMountedWorkReadClientRpcMethod(trimmed.slice(separatorIndex + 1))
        || isSessionUiActionClientRpcMethod(trimmed.slice(separatorIndex + 1))
        || isVoiceRunActionClientRpcMethod(trimmed.slice(separatorIndex + 1))
        || isUiBrowserAutomationDispatchMethod(trimmed.slice(separatorIndex + 1)))) {
        // Mounted addresses have no schema length ceiling. Their
        // encoded suffix is content carried by this known method family and
        // remains under the existing Socket.IO packet boundary. Retain the
        // ordinary method-name budget for the Machine and fixed method prefix.
        const familyPrefix = isWorkflowDraftClientRpcMethod(trimmed.slice(separatorIndex + 1))
            ? `${RPC_METHODS.UI_ACTION_EXECUTE}.workflow.`
            : isVoiceRunActionClientRpcMethod(trimmed.slice(separatorIndex + 1))
                ? `${RPC_METHODS.UI_ACTION_EXECUTE}.voice.`
            : isSessionUiActionClientRpcMethod(trimmed.slice(separatorIndex + 1))
                ? `${RPC_METHODS.UI_ACTION_EXECUTE}.session.`
            : isUiBrowserAutomationDispatchMethod(trimmed.slice(separatorIndex + 1))
                ? `${RPC_METHODS.UI_BROWSER_AUTOMATION_DISPATCH}.` : `${RPC_METHODS.UI_ACTION_EXECUTE}.work.`;
        return separatorIndex + 1 + familyPrefix.length <= MAX_RPC_METHOD_NAME_LENGTH
            ? trimmed : null;
    }
    if (trimmed.length > MAX_RPC_METHOD_NAME_LENGTH) return null;
    return trimmed;
}

function parseMachineScopedRpcMethod(method: string): MachineScopedRpcMethod | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === method.length - 1) return null;
    const machineId = method.slice(0, separatorIndex).trim();
    const rpcMethod = method.slice(separatorIndex + 1).trim();
    if (!machineId || !isMachineVisibleClientRpcMethod(rpcMethod)) return null;
    return { machineId, rpcMethod };
}

function readExplicitMachineStopRequest(method: string, value: unknown): Readonly<{
    machineId: string;
    sessionId: string;
}> | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0 || method.slice(separatorIndex + 1) !== RPC_METHODS.STOP_SESSION) return null;
    const machineId = method.slice(0, separatorIndex).trim();
    if (!machineId || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const sessionId = (value as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string") return null;
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId || trimmedSessionId.length > MAX_RPC_METHOD_NAME_LENGTH) return null;
    return { machineId, sessionId: trimmedSessionId };
}

function readSessionModelTransitionSessionId(method: string): string | null {
    const suffix = `:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
    if (!method.endsWith(suffix)) return null;
    const sessionId = method.slice(0, -suffix.length).trim();
    return sessionId.length > 0 ? sessionId : null;
}

function createCurrentSessionPublisherTargetGuard(params: Readonly<{
    method: string;
    sessionId?: string;
    machineId?: string;
    targetUserId: string;
    presence?: SessionPublisherPresenceForRpc;
}>): RpcForwardTargetGuard | null {
    const sessionId = params.sessionId ?? readSessionModelTransitionSessionId(params.method);
    if (!sessionId) return null;

    return {
        filterTargets: async (targets) => {
            if (!params.presence) return [];
            const currentTargets: typeof targets = [];
            for (const target of targets) {
                const projection = readSessionPublisherAuthorityProjection(target.data);
                if (!projection || params.machineId && projection.machineId !== params.machineId) continue;
                if (await params.presence.isCurrentPublisherProjection({
                    expectedAccountId: params.targetUserId,
                    expectedSessionId: sessionId,
                    projection,
                })) {
                    currentTargets.push(target);
                }
            }
            return currentTargets.length === 1 ? currentTargets : [];
        },
        runOperation: async ({ target, operation }) => {
            if (!params.presence) return { status: "unavailable" };
            const initialProjection = readSessionPublisherAuthorityProjection(target.data);
            if (!initialProjection || params.machineId && initialProjection.machineId !== params.machineId) return { status: "unavailable" };
            return await params.presence.runAsProjectedCurrentPublisher({
                expectedAccountId: params.targetUserId,
                expectedSessionId: sessionId,
                initialProjection,
                operation: async () => await operation(),
            });
        },
    };
}

function composeRpcForwardTargetGuards(
    guards: readonly (RpcForwardTargetGuard | null)[],
): RpcForwardTargetGuard | null {
    const activeGuards = guards.filter((guard): guard is RpcForwardTargetGuard => guard !== null);
    if (activeGuards.length === 0) return null;
    return {
        filterTargets: async (targets) => {
            let filteredTargets = targets;
            for (const guard of activeGuards) {
                filteredTargets = await guard.filterTargets(filteredTargets);
            }
            return filteredTargets;
        },
        runOperation: async ({ target, operation, readLatestTarget }) => {
            const runGuard = async (index: number): ReturnType<RpcForwardTargetGuard["runOperation"]> => {
                const guard = activeGuards[index];
                if (!guard) return { status: "current", value: await operation() };
                return await guard.runOperation({
                    target,
                    readLatestTarget,
                    operation: async () => {
                        const nested = await runGuard(index + 1);
                        if (nested.status !== "current") {
                            throw new RpcForwardGuardUnavailableError(
                                nested.status === "refused" ? nested.response : undefined,
                            );
                        }
                        return nested.value;
                    },
                });
            };
            try {
                return await runGuard(0);
            } catch (error) {
                if (error instanceof RpcForwardGuardUnavailableError) {
                    return error.refusal
                        ? { status: "refused", response: error.refusal }
                        : { status: "unavailable" };
                }
                throw error;
            }
        },
    };
}

/** Unwinds the nested guard chain, carrying a typed refusal when one guard stated it. */
class RpcForwardGuardUnavailableError extends Error {
    constructor(readonly refusal?: Readonly<{ ok: false; error: string; errorCode: string }>) {
        super("RPC forward guard refused the operation");
        this.name = "RpcForwardGuardUnavailableError";
    }
}

function readSocketData(socket: SocketDataCarrier): Record<string, unknown> {
    return socket.data && typeof socket.data === "object" && !Array.isArray(socket.data)
        ? socket.data as Record<string, unknown>
        : {};
}

function ensureMutableSocketData(socket: Socket): Record<string, unknown> {
    const mutableSocket = socket as Socket & { data: Record<string, unknown> };
    if (!mutableSocket.data || typeof mutableSocket.data !== "object" || Array.isArray(mutableSocket.data)) {
        mutableSocket.data = {};
    }
    return mutableSocket.data;
}

function readSocketClientType(socket: SocketDataCarrier): string | null {
    const clientType = readSocketData(socket).clientType;
    return typeof clientType === "string" ? clientType : null;
}

function readMachineScopedSocketMachineId(socket: SocketDataCarrier): string | null {
    if (readSocketClientType(socket) !== "machine-scoped") return null;
    const machineId = readSocketData(socket).machineId;
    if (typeof machineId !== "string") return null;
    const trimmed = machineId.trim();
    return trimmed ? trimmed : null;
}

/** The credentialed daemon attests original Session facts only while it hosts that Session. */
async function hasCurrentSessionActionRpcSource(params: Readonly<{
    accountId: string;
    socket: Socket;
    io: Server;
    presence?: SessionPublisherPresenceForRpc;
    sourceSessionId: string;
    targetSessionId: string;
}>): Promise<boolean> {
    const data = readSocketData(params.socket);
    const machineId = readMachineScopedSocketMachineId(params.socket);
    const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(data);
    if (!machineId || !installationId || params.socket.connected !== true
        || (data.authTokenKind !== "account" && data.authTokenKind !== "terminal") || data.ephemeralRunnerAdmission != null
        || data.apiTokenPrincipal != null) return false;
    const currentSource = await hasCurrentSessionActionRpcSourceBinding({ accountId: params.accountId, machineId, installationId,
        sourceSessionId: params.sourceSessionId, targetSessionId: params.targetSessionId,
        resolveCurrentSessionMachine: input => resolveCurrentSessionMachineFromServer({ io: params.io, presence: params.presence, ...input }),
    });
    return currentSource;
}

/**
 * The Account of a Session Action's source Session when it differs from the
 * Machine socket's Account. Only the source binding admits it as the actor.
 */
async function readHostedMemberSessionActionAccountId(userId: string, sourceSessionId: string): Promise<string | null> {
    const source = await db.session.findUnique({ where: { id: sourceSessionId }, select: { accountId: true } });
    return source && source.accountId !== userId ? source.accountId : null;
}

function readMachineIdPrefix(method: string): string | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0) return null;
    const prefix = method.slice(0, separatorIndex).trim();
    return prefix || null;
}

function readSessionFollowSourceKeyPreparationMachineId(method: string): string | null {
    const suffix = `:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`;
    if (!method.endsWith(suffix)) return null;
    const machineId = method.slice(0, -suffix.length).trim();
    return machineId || null;
}

const RESERVED_SERVER_ORIGIN_DAEMON_RPC_METHODS = new Set<string>([
    SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
    RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS,
    RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION,
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    MANAGED_FINITE_WAKE_RPC_METHOD,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
]);

function readReservedServerOriginTargetMachineId(method: string): string | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0 || !RESERVED_SERVER_ORIGIN_DAEMON_RPC_METHODS.has(method.slice(separatorIndex + 1))) {
        return null;
    }
    const machineId = method.slice(0, separatorIndex).trim();
    return machineId || null;
}

function isReservedServerOriginRpcMethod(method: string): boolean {
    return [...RESERVED_SERVER_ORIGIN_DAEMON_RPC_METHODS].some((reservedMethod) => (
        method === reservedMethod || method.endsWith(`:${reservedMethod}`)
    ));
}

function isSessionServerStartReservedRpcMethod(method: string): boolean {
    return method === SESSION_SERVER_START_DAEMON_RPC_METHOD_V1
        || method.endsWith(`:${SESSION_SERVER_START_DAEMON_RPC_METHOD_V1}`);
}

function isExternalActionReservedRpcMethod(method: string): boolean {
    return method === EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1
        || method.endsWith(`:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`)
        || method === MANAGED_FINITE_WAKE_RPC_METHOD || method.endsWith(`:${MANAGED_FINITE_WAKE_RPC_METHOD}`);
}

function isMachineOwnedSessionSpawnRpcMethod(method: string): boolean {
    return method === RPC_METHODS.SESSION_SPAWN_NEW
        || method.endsWith(`:${RPC_METHODS.SESSION_SPAWN_NEW}`);
}

async function canRegisterReservedServerOriginRpcMethod(params: Readonly<{
    accountId: string;
    socket: SocketDataCarrier;
    method: string;
}>): Promise<boolean> {
    const targetMachineId = readReservedServerOriginTargetMachineId(params.method);
    if (
        targetMachineId === null
        || readMachineScopedSocketMachineId(params.socket) !== targetMachineId
    ) {
        return false;
    }
    if (params.method.endsWith(`:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`)) {
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket));
        if (!installationId) return false;
        const machine = await db.machine.findFirst({
            where: { accountId: params.accountId, id: targetMachineId },
            select: { installationId: true },
        });
        return machine !== null && machine.installationId === installationId;
    }
    return !(
        isSessionServerStartReservedRpcMethod(params.method)
        || isExternalActionReservedRpcMethod(params.method)
        || params.method.endsWith(`:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`)
    )
        || readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket)) !== null;
}

function canRegisterMachineScopedRpcMethod(params: Readonly<{
    socketMachineId: string;
    method: string;
}>): boolean {
    const methodMachineId = readMachineIdPrefix(params.method);
    return methodMachineId === null || methodMachineId === params.socketMachineId;
}

function createExactMachineRpcTargetGuard(
    request: Readonly<{ machineId: string }>,
): RpcForwardTargetGuard {
    const matchesRequestMachine = (target: SocketDataCarrier): boolean => (
        readMachineScopedSocketMachineId(target) === request.machineId
    );
    return {
        filterTargets: async (targets) => targets.filter(matchesRequestMachine),
        runOperation: async ({ target, operation, readLatestTarget }) => {
            if (!matchesRequestMachine(target)) return { status: "unavailable" };
            const latestTarget = await readLatestTarget();
            if (!latestTarget || !matchesRequestMachine(latestTarget)) {
                return { status: "unavailable" };
            }
            return { status: "current", value: await operation() };
        },
    };
}

function createCurrentMachineAdmissionTargetGuard(
    admission: Pick<SocketRpcMachineAdmissionContextV1, 'machineId' | 'installationId'>,
    sourceSocket?: Pick<Socket, 'data' | 'connected'>,
): RpcForwardTargetGuard {
    // Reverse client RPCs continue the admitted daemon's authority. Their
    // recipient is an App, so installation custody belongs to the source.
    const matches = (target: SocketDataCarrier) => {
        const machineSocket = sourceSocket ?? target;
        return (!sourceSocket || sourceSocket.connected === true)
            && readMachineScopedSocketMachineId(machineSocket) === admission.machineId
            && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(machineSocket)) === admission.installationId;
    };
    return {
        filterTargets: async (targets) => targets.filter(matches),
        runOperation: async ({ target, readLatestTarget, operation }) => {
            const latest = await readLatestTarget();
            if (!matches(target) || !latest || !matches(latest)) return { status: 'unavailable' };
            return { status: 'current', value: await operation() };
        },
    };
}

/** The child retains admission; its retained bind delegates only the physical workspace operation. */
async function resolveWorkspaceSyncChildAdmission(params: Readonly<{
    accountId: string; socket: Socket; io: Server; presence?: SessionPublisherPresenceForRpc;
    routing: WorkspaceSyncSourceRoutingV1 | WorkspaceSyncTargetRoutingV1; parentMachineId: string;
    operationRpcMethod: string;
    admittedHandoff?: import('@happier-dev/protocol/actions/externalActionApi').ExternalActionExecutionAuthorizationBindingV1;
}>) {
    const routing = params.routing;
    const isSource = 'sourceMachineId' in routing;
    const childMachineId = isSource ? routing.sourceMachineId : routing.targetMachineId;
    const childRootPath = isSource ? routing.sourceRootPath : routing.targetRootPath;
    const sourceContext = isSource ? routing.sourceContext : routing.targetContext;
    const data = readSocketData(params.socket);
    const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(data);
    if (readMachineScopedSocketMachineId(params.socket) !== childMachineId
        || !installationId || params.socket.connected !== true || data.authTokenKind !== 'account'
        || data.ephemeralRunnerAdmission != null || data.apiTokenPrincipal != null
        || !await hasCurrentSocketCredential(params.accountId, params.socket)) return null;
    const claimed = sourceContext?.machineAdmission;
    if (claimed && (claimed.machineId !== childMachineId || claimed.installationId !== installationId
        || claimed.custodianAccountId !== params.accountId)) return null;
    const releaseOnly = routing.phase === 'commit' || routing.phase === 'abort' || routing.phase === 'release';
    const requester: MachineOperationRequesterContext = { callerAuthority: sourceContext?.callerAuthority
        ?? readSessionAccessAuthenticationFromSocket(params.socket).authority,
        ...(sourceContext?.sessionActionOrigin ? { sessionActionOrigin: sourceContext.sessionActionOrigin } : {}) };
    const admission = params.admittedHandoff
        ? await readAdmittedExternalActionHandoffMachineInTx(db, params.admittedHandoff, childMachineId, claimed)
        : await resolveMachineAdmission({ actorAccountId: releaseOnly ? params.accountId : claimed?.actorAccountId ?? params.accountId,
        machineId: childMachineId, requiredRole: 'use', operationRpcMethod: params.operationRpcMethod, requireOnline: true, ...requester });
    if (!admission || admission.kind !== 'admitted' || admission.installationId !== installationId) return null;
    if (claimed && (claimed.custodianAccountId !== admission.custodianAccountId
        || claimed.encryptionMode !== admission.encryptionMode
        || !releaseOnly && claimed.role === 'manage' && admission.role !== 'manage')) return null;
    // Session ownership proves hosting correlation only. The original admitted actor
    // remains the source context's actor, including shared Sessions and child Machines.
    const sourceSessions = new Set(isSource && !releaseOnly && !params.admittedHandoff ? [routing.sourceSessionId,
        sourceContext?.sessionActionOrigin?.caller.sessionId].filter((id): id is string => Boolean(id)) : []);
    for (const sessionId of sourceSessions) {
        const session = await db.session.findUnique({ where: { id: sessionId }, select: { accountId: true } });
        if (!session || !await hasCurrentSessionActionRpcSource({ accountId: session.accountId,
            socket: params.socket, io: params.io, presence: params.presence,
            sourceSessionId: sessionId, targetSessionId: sessionId,
        })) return null;
    }
    const route = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, {
        accountServerId: routing.accountServerId, childMachineId, childRootPath,
        operation: { actorAccountId: admission.actorAccountId, rpcMethod: params.operationRpcMethod, ...requester },
        parentMachineId: params.parentMachineId, releaseOnly,
    });
    // Enrollment owns child admission; the retained bind independently owns
    // physical controller custody, which may belong to a different Account.
    if (!route) return null;
    const { kind: _kind, ...context } = admission;
    return { context: claimed ?? context, route };
}

function readMachineRuntimeRunnerPrincipal(target: SocketDataCarrier) {
    const data = readSocketData(target);
    const admission = data.ephemeralRunnerAdmission;
    if (!admission || typeof admission !== "object" || Array.isArray(admission)) return null;
    if ((admission as { kind?: unknown }).kind !== "machine-runtime") return null;
    const parsed = VerifiedEphemeralSessionRunnerPrincipalSchema.safeParse(
        (admission as { principal?: unknown }).principal,
    );
    return parsed.success ? parsed.data : null;
}

/**
 * The two non-Session Runner authorities have their own admission owners and
 * are never reachable from this client-originated socket RPC path: Follow
 * source-key preparation is authorized by its own guard, and the closed public
 * Action dispatch is server-origin only.
 */
type ClientReachableEphemeralRunnerMachineRpcAuthority = Exclude<
    EphemeralRunnerMachineRpcAuthority,
    "followSourceKeyPreparation" | "externalActionDispatch"
>;

function readEphemeralRunnerMachineRpcRequest(method: string): Readonly<{
    machineId: string;
    authority: ClientReachableEphemeralRunnerMachineRpcAuthority;
}> | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === method.length - 1) return null;
    const machineId = method.slice(0, separatorIndex).trim();
    const authority = resolveEphemeralRunnerMachineRpcAuthority(method.slice(separatorIndex + 1));
    if (
        !machineId
        || authority === null
        || authority === "followSourceKeyPreparation"
        || authority === "externalActionDispatch"
    ) return null;
    return { machineId, authority };
}

function createEphemeralRunnerMachineRpcTargetGuard(params: Readonly<{
    accountId: string;
    targetAccountId: string;
    machineId: string;
    authority: ClientReachableEphemeralRunnerMachineRpcAuthority;
    authentication: ReturnType<typeof readSessionAccessAuthenticationFromSocket>;
    /** The composed raw Session guard owns this receiver's binding and Machine role. */
    protectedSessionTarget: boolean;
}>): RpcForwardTargetGuard {
    // Candidate selection is a local match. The receiver's authority (a persistent Machine of the
    // target Account, or a Runner principal with a current Session capability) is checked fresh
    // once, on the latest target immediately before the operation.
    const matchesTarget = (target: SocketDataCarrier): boolean => {
        if (params.protectedSessionTarget && readSocketClientType(target) === 'session-scoped') return true;
        if (readMachineScopedSocketMachineId(target) !== params.machineId) return false;
        if (readSocketData(target).ephemeralRunnerAdmission === undefined) return true;
        const principal = readMachineRuntimeRunnerPrincipal(target);
        return principal !== null && principal.accountId === params.targetAccountId && principal.machineId === params.machineId;
    };
    const authorizeTarget = async (target: SocketDataCarrier): Promise<boolean> => {
        if (!matchesTarget(target)) return false;
        if (params.protectedSessionTarget && readSocketClientType(target) === 'session-scoped') return true;
        if (readSocketData(target).ephemeralRunnerAdmission === undefined) {
            const machine = await db.machine.findFirst({
                where: { accountId: params.targetAccountId, id: params.machineId },
                select: { kind: true },
            });
            return machine !== null && machine.kind !== "ephemeral_session_runner";
        }
        const principal = readMachineRuntimeRunnerPrincipal(target);
        if (!principal || !await verifyCurrentMaterializedRunnerPrincipal(principal)) return false;
        const decision = await resolveSessionAccessForOperation(db, {
            accountId: params.accountId,
            sessionId: principal.sessionId,
            authentication: params.authentication,
            capability: params.authority,
        });
        return decision.status === "allowed" && decision.access.capabilities[params.authority];
    };
    return {
        filterTargets: async (targets) => targets.filter(matchesTarget),
        runOperation: async ({ operation, readLatestTarget }) => {
            const latest = await readLatestTarget();
            if (!latest || !await authorizeTarget(latest)) return { status: "unavailable" };
            return { status: "current", value: await operation() };
        },
    };
}

function createSessionFollowSourceKeyPreparationTargetGuard(params: Readonly<{
    accountId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    localInputId?: string;
    machineId: string;
    authentication: ReturnType<typeof readSessionAccessAuthenticationFromSocket>;
}>): RpcForwardTargetGuard {
    const matchesTarget = (target: SocketDataCarrier): boolean => {
        const principal = readMachineRuntimeRunnerPrincipal(target);
        return principal?.machineId === params.machineId;
    };
    const authorizeTarget = async (target: SocketDataCarrier): Promise<boolean> => {
        const principal = readMachineRuntimeRunnerPrincipal(target);
        if (!principal || principal.machineId !== params.machineId) return false;
        const admission = await authorizeSessionFollowSourceKeyPreparation({
            accountId: params.accountId,
            sourceSessionId: params.sourceSessionId,
            destinationSessionId: params.destinationSessionId,
            ...(params.localInputId !== undefined ? { localInputId: params.localInputId } : {}),
            principal,
            authentication: params.authentication,
        });
        return admission.ok && admission.value.machineId === params.machineId;
    };
    return {
        filterTargets: async (targets) => targets.filter(matchesTarget),
        runOperation: async ({ operation, readLatestTarget }) => {
            const latest = await readLatestTarget();
            if (!latest || !await authorizeTarget(latest)) return { status: "unavailable" };
            return { status: "current", value: await operation() };
        },
    };
}

function writeSocketRegisteredRpcMethods(socket: Socket, methods: ReadonlySet<string>): void {
    ensureMutableSocketData(socket)[RPC_REGISTERED_METHODS_SOCKET_DATA_KEY] = [...methods];
}

function buildForbiddenRpcResponse(reason?: MachineAccessRefusalCode, phase?: string): Readonly<{
    ok: false; error: string; errorCode: string; failureCause?: ActionFailureCauseV1; effectAttempted?: false;
}> {
    return {
        ok: false,
        error: RPC_ERROR_MESSAGES.FORBIDDEN,
        errorCode: RPC_ERROR_CODES.FORBIDDEN,
        ...(reason || phase ? { failureCause: { phase: phase ?? 'rpc.admission.machine', errorClass: 'Error' as const,
            errorCode: reason ?? RPC_ERROR_CODES.FORBIDDEN, httpStatus: 403 } } : {}),
        ...(phase ? { effectAttempted: false as const } : {}),
    };
}

/**
 * The one RPC refusal envelope for a Session access decision.
 *
 * `resolveSessionAccessForOperation` deliberately separates a recoverable Team
 * authentication requirement from an outright refusal, and every HTTP Session
 * route already preserves that distinction (`team_authentication_required` /
 * `team_authentication_unavailable`). Socket RPC answers from the same decision,
 * so it uses this one mapping instead of collapsing the recoverable answers into
 * `RPC_FORBIDDEN` or `RPC_METHOD_NOT_AVAILABLE`.
 */
function buildSessionAccessRpcRefusal(
    status: Exclude<SessionAccessOperationDecision["status"], "allowed">,
): Readonly<{ ok: false; error: string; errorCode: string }> {
    if (status === "authentication_required") {
        return {
            ok: false,
            error: RPC_ERROR_MESSAGES.TEAM_AUTHENTICATION_REQUIRED,
            errorCode: RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED,
        };
    }
    if (status === "authentication_unavailable") {
        return {
            ok: false,
            error: RPC_ERROR_MESSAGES.TEAM_AUTHENTICATION_UNAVAILABLE,
            errorCode: RPC_ERROR_CODES.TEAM_AUTHENTICATION_UNAVAILABLE,
        };
    }
    return buildForbiddenRpcResponse();
}

async function isMachineScopedRpcMethodAvailable(params: Readonly<{
    userId: string;
    method: string;
}>): Promise<boolean> {
    const parsed = parseMachineScopedRpcMethod(params.method);
    if (!parsed) return false;
    return await readMachineAvailabilityState({
        accountId: params.userId,
        machineId: parsed.machineId,
    }) === "available";
}

function emitMachineScopedRpcAvailability(params: Readonly<{
    userId: string;
    io: Server;
    method: string;
    event: typeof SOCKET_RPC_EVENTS.REGISTERED | typeof SOCKET_RPC_EVENTS.UNREGISTERED;
}>): void {
    const parsed = parseMachineScopedRpcMethod(params.method);
    if (!parsed) return;
    params.io.to(getMachineSocketRoom(params.userId, parsed.machineId)).emit(params.event, { method: params.method });
}

async function emitMachineScopedRpcUnregisteredWhenUnavailable(params: Readonly<{
    userId: string;
    io: Server;
    method: string;
}>): Promise<void> {
    if (!parseMachineScopedRpcMethod(params.method)) return;
    if (await readRegisteredRpcTargetPresence(params) !== "absent") return;
    emitMachineScopedRpcAvailability({
        ...params,
        event: SOCKET_RPC_EVENTS.UNREGISTERED,
    });
}

async function hydrateMachineScopedRpcAvailabilityForSocket(params: Readonly<{
    userId: string;
    socket: Socket;
    io: Server;
}>): Promise<void> {
    const machineId = readMachineScopedSocketMachineId(params.socket);
    if (!machineId) return;
    const state = await readMachineAvailabilityState({
        accountId: params.userId,
        machineId,
    });
    if (state !== "available") return;

    const snapshot = await readSocketRoomSnapshot({ io: params.io,
        room: buildMachineRpcAvailabilityRoom({ userId: params.userId, machineId }) });
    const methods = new Set<string>();
    // Reconnect hints advertise positive registrations, never complete absence.
    for (const socket of snapshot.sockets) {
        for (const method of readSocketRegisteredRpcMethods(socket) ?? []) {
            const parsed = parseMachineScopedRpcMethod(method);
            if (parsed?.machineId === machineId) {
                methods.add(method);
            }
        }
    }
    for (const method of methods) {
        params.socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
    }
}

export function registerSocketRpcHandlers(params: Readonly<{
    userId: string;
    socket: Socket;
    io: Server;
    sessionPublisherPresence?: SessionPublisherPresenceForRpc;
    ephemeralRunnerAdmission?: RestrictedSocketAdmission | null;
}>): void {
    const ownedMethods = new Set<string>();
    // Caller request ids are meaningful only within this authenticated socket.
    // The relay maps them to server-minted target ids, so a caller cannot name
    // or cancel another caller's in-flight work at a shared target.
    const activeCancellations = new Map<string, ActiveSocketRpcCancellation>();
    const activePresentationBindings = new Map<string, Readonly<{
        ownerAccountId: string;
        clientId: string;
    }>>();
    let disconnected = false;

    const retireMachineAvailabilityIfUnused = async (machineId: string): Promise<void> => {
        const stillOwnsAvailability = () => {
            for (const method of ownedMethods) {
                if (parseMachineScopedRpcMethod(method)?.machineId === machineId) return true;
            }
            return false;
        };
        if (stillOwnsAvailability()) return;
        const room = buildMachineRpcAvailabilityRoom({ userId: params.userId, machineId });
        await params.socket.leave(room);
        // A registration can finish while an older adapter leave is pending.
        if (!disconnected && stillOwnsAvailability()) await params.socket.join(room);
    };

    const retirePresentationBinding = async (
        sessionId: string,
        binding: Readonly<{ ownerAccountId: string; clientId: string }>,
    ): Promise<void> => {
        await forwardRpcCall({
            io: params.io,
            targetUserId: binding.ownerAccountId,
            method: `${sessionId}:${CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD}`,
            callParams: { clientId: binding.clientId },
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN,
                sessionId,
                accountId: params.userId,
                connectionId: params.socket.id,
            },
            callerSocketId: params.socket.id,
            callerSocket: params.socket,
        }).catch((error: unknown) => {
            log(
                { module: "websocket-rpc", level: "warn", sessionId },
                `Presentation disconnect retirement failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    };

    params.socket.on(SOCKET_RPC_EVENTS.CANCEL, (data: unknown) => {
        if (params.ephemeralRunnerAdmission?.kind === "api-token-session-viewer") return;
        const parsed = SocketRpcCancellationPayloadSchema.safeParse(data);
        if (!parsed.success) return;
        const active = activeCancellations.get(parsed.data.requestId);
        if (!active) return;
        cancelActiveSocketRpcCall({ io: params.io, active });
    });

    params.socket.on(SOCKET_RPC_EVENTS.CONTINUATION, (value: unknown) => {
        if (params.ephemeralRunnerAdmission?.kind === 'api-token-session-viewer') return;
        const parsed = SocketRpcContinuationFrameV1Schema.safeParse(value);
        if (!parsed.success) return;
        const frame = parsed.data;
        const active = frame.returnTo ? undefined : activeCancellations.get(frame.requestId);
        const destination = frame.returnTo ?? (active?.targetSocketId
            ? { socketId: active.targetSocketId, requestId: active.targetRequestId } : null);
        if (!destination) return;
        // Socket rooms route across cluster nodes. Return addresses carry no authority:
        // the endpoint admits only its live call, relay-selected peer and captured codec.
        params.io.to(destination.socketId).emit(SOCKET_RPC_EVENTS.CONTINUATION, {
            requestId: destination.requestId, senderSocketId: params.socket.id, params: frame.params,
            callId: frame.callId, ...(frame.reply ? { reply: true } : {}),
            ...(frame.notification ? { notification: true } : {}),
        });
    });

    params.socket.on(SOCKET_RPC_EVENTS.REGISTER, async (data: unknown) => {
        const method = normalizeRpcMethodName((data as { method?: unknown } | undefined)?.method);
        const reject = (error: string, retryable: boolean) => params.socket.emit(SOCKET_RPC_EVENTS.ERROR, {
            type: "register", error, ...(method ? { method } : {}), retryable,
        });
        try {
            if (!params.socket.connected) return;
            if (params.ephemeralRunnerAdmission?.kind === "api-token-session-viewer") {
                reject("Forbidden", false);
                return;
            }
            if (!method) {
                reject("Invalid method name", false);
                return;
            }
            if (isLiveCliApprovalOriginMethod(method) && (params.ephemeralRunnerAdmission != null
                || !isOrdinaryLiveApprovalOriginSocket(params.socket)
                || !await hasCurrentSocketCredential(params.userId, params.socket))) {
                reject("Forbidden", false);
                return;
            }

            if (
                params.ephemeralRunnerAdmission?.kind === "machine-runtime"
                && !canEphemeralRunnerMachineRegisterRpcMethod({
                    admission: params.ephemeralRunnerAdmission,
                    method,
                })
            ) {
                reject("Forbidden", false);
                return;
            }
            if (params.ephemeralRunnerAdmission?.kind === "machine-runtime"
                && !await verifyCurrentMaterializedRunnerPrincipal(params.ephemeralRunnerAdmission.principal)) {
                reject("Forbidden", true);
                return;
            }
            const isMachineTransferRegistration = readSocketClientType(params.socket) === "machine-scoped"
                && SessionTransferRpcMethodV1Schema.safeParse(method.slice(method.indexOf(':') + 1)).success;
            const sessionAuthorization = isMachineTransferRegistration ? null : resolveSocketRpcSessionAuthorization(method);
            const isSessionAuthorizationNamespace = isSocketRpcSessionAuthorizationNamespace(method);
            const isMachineOwnedSessionSpawnRegistration = (
                readSocketClientType(params.socket) === "machine-scoped"
                && isMachineOwnedSessionSpawnRpcMethod(method)
            );
            if (
                isSessionAuthorizationNamespace
                && !sessionAuthorization
                && !isMachineOwnedSessionSpawnRegistration
            ) {
                reject(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, false);
                return;
            }
            if (
                sessionAuthorization?.routeToSessionOwnerDaemon === true
                && readSocketClientType(params.socket) !== "session-scoped"
                && !isMachineOwnedSessionSpawnRegistration
                && !(sessionAuthorization.machineScope === true
                    && readSocketClientType(params.socket) === "machine-scoped"
                    && readMachineScopedSocketMachineId(params.socket) === readMachineIdPrefix(method))
            ) {
                reject("Forbidden", false);
                return;
            }
            if (
                isReservedServerOriginRpcMethod(method)
                && !await canRegisterReservedServerOriginRpcMethod({ accountId: params.userId, socket: params.socket, method })
            ) {
                reject("Forbidden", true);
                return;
            }
            if (!await canRegisterSessionScopedRpcMethod({ socket: params.socket, accountId: params.userId, method })) {
                reject("Forbidden", true);
                return;
            }
            const machineScopedSocketMachineId = readMachineScopedSocketMachineId(params.socket);
            if (readSocketClientType(params.socket) === "machine-scoped") {
                const machineId = machineScopedSocketMachineId ?? "";
                if (!machineId || !canRegisterMachineScopedRpcMethod({
                    socketMachineId: machineId,
                    method,
                })) {
                    reject("Forbidden", false);
                    return;
                }
            }

            const alreadyRegistered = ownedMethods.has(method);
            const availability = parseMachineScopedRpcMethod(method);
            const managedGuestActivity = machineScopedSocketMachineId !== null
                && (method === `${machineScopedSocketMachineId}:${MANAGED_ACTIVITY_READ_RPC_METHOD}`
                    || method === `${machineScopedSocketMachineId}:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`);
            // The method room is the registration authority across Home nodes.
            // An unchanged owner needs no census; a new owner publishes only
            // when the previous room was proven empty, never on an unknown census.
            const previousPresence = (availability && machineScopedSocketMachineId === null || managedGuestActivity) && !alreadyRegistered
                ? await readRegisteredRpcTargetPresence({ userId: params.userId, io: params.io, method })
                : "present";
            await params.socket.join(buildRpcMethodRoom({ userId: params.userId, method }));
            const becameAvailable = previousPresence === "absent" && !ownedMethods.has(method);
            ownedMethods.add(method);
            writeSocketRegisteredRpcMethods(params.socket, ownedMethods);
            if (availability && machineScopedSocketMachineId === null && !params.ephemeralRunnerAdmission) {
                await params.socket.join(buildMachineRpcAvailabilityRoom({ userId: params.userId, machineId: availability.machineId }));
                if (!ownedMethods.has(method)) {
                    await retireMachineAvailabilityIfUnused(availability.machineId);
                    return;
                }
            }
            recordRpcRegistration(method);
            params.socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
            if (managedGuestActivity && becameAvailable && machineScopedSocketMachineId) {
                const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket));
                if (installationId) await publishManagedGuestActivityAvailable({ accountId: params.userId,
                    machineId: machineScopedSocketMachineId, installationId });
            }
            if (method === `${machineScopedSocketMachineId}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`) {
                const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket));
                if (machineScopedSocketMachineId && installationId) {
                    await recoverMachineAccessLossCustody({ machineId: machineScopedSocketMachineId,
                        expectedCustodianAccountId: params.userId, expectedInstallationId: installationId }).catch((error: unknown) => {
                        log({ module: 'machine-access', level: 'warn', machineId: machineScopedSocketMachineId, error },
                            'Reconnect requester work cleanup remains incomplete');
                    });
                }
            }
            if (machineScopedSocketMachineId === null && becameAvailable) {
                // Registration advertises an Account/Machine-scoped address, not
                // execution authority. Reverse calls recheck the exact Machine's
                // availability at admission; no DB read is needed per UI method.
                emitMachineScopedRpcAvailability({
                    userId: params.userId,
                    io: params.io,
                    method,
                    event: SOCKET_RPC_EVENTS.REGISTERED,
                });
            }
        } catch (error) {
            log({ module: "websocket-rpc", level: "error" }, `Error in rpc-register: ${error}`);
            reject("Internal error", true);
        }
    });

    params.socket.on(SOCKET_RPC_EVENTS.UNREGISTER, async (data: unknown) => {
        try {
            if (params.ephemeralRunnerAdmission?.kind === "api-token-session-viewer") {
                params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "unregister", error: "Forbidden" });
                return;
            }
            const method = normalizeRpcMethodName((data as { method?: unknown } | undefined)?.method);
            if (!method) {
                params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "unregister", error: "Invalid method name" });
                return;
            }
            if (ownedMethods.has(method)) {
                ownedMethods.delete(method);
                writeSocketRegisteredRpcMethods(params.socket, ownedMethods);
                const room = buildRpcMethodRoom({ userId: params.userId, method });
                await params.socket.leave(room);
                if (!disconnected && ownedMethods.has(method)) {
                    // Socket.IO awaits register/unregister listeners independently. A replacement
                    // registration can therefore finish before this older leave does; restore that
                    // current owner instead of letting the stale leave retire its room membership.
                    await params.socket.join(room);
                    writeSocketRegisteredRpcMethods(params.socket, ownedMethods);
                } else {
                    const availability = parseMachineScopedRpcMethod(method);
                    if (availability) await retireMachineAvailabilityIfUnused(availability.machineId);
                    recordRpcUnregistration(method);
                    await emitMachineScopedRpcUnregisteredWhenUnavailable({
                        userId: params.userId,
                        io: params.io,
                        method,
                    });
                }
            }

            params.socket.emit(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
        } catch (error) {
            log({ module: "websocket-rpc", level: "error" }, `Error in rpc-unregister: ${error}`);
            params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "unregister", error: "Internal error" });
        }
    });

    params.socket.on(SOCKET_RPC_EVENTS.CALL, async (data: unknown, acknowledge?: (response: unknown) => void) => {
        const startedAt = Date.now();
        const parsedRequestId = readOptionalSocketRpcRequestId(data);
        // Diagnostics cannot opt a caller into cancellation. Keep requestId's
        // existing admission/cleanup path, and ignore malformed trace metadata.
        const parsedTraceId = parsedRequestId === undefined && data && typeof data === 'object' && !Array.isArray(data)
            ? SocketRpcRequestIdSchema.safeParse((data as { traceId?: unknown }).traceId) : null;
        const diagnosticOnly = parsedTraceId?.success === true;
        const incomingTraceId = typeof parsedRequestId === 'string' ? parsedRequestId
            : parsedTraceId?.success ? parsedTraceId.data : undefined;
        // Opaque caller ids can contain private text. Match the daemon's
        // diagnostic privacy boundary without changing the actual request key.
        const callerTraceId = incomingTraceId === undefined ? undefined
            : /^(?:rpc_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incomingTraceId)
                ? incomingTraceId : `sha256:${createHash('sha256').update(incomingTraceId).digest('hex')}`;
        let targetTraceId: string | undefined;
        let method: string | null = null;
        let callerRequestId: string | undefined;
        let cancellation: ActiveSocketRpcCancellation | undefined;
        let machineAdmission: SocketRpcMachineAdmissionContextV1 | undefined;
        let receivingMachineAdmission: SocketRpcMachineAdmissionContextV1 | undefined;
        let sessionBrowserAuthorization: SocketRpcSessionBrowserAuthorizationContext | undefined;
        let forwardStartedAt: number | undefined;
        let forwardCompletedAt: number | undefined;
        const completionDiagnostic: { failure: ReturnType<typeof projectRpcFailureDiagnostic> } = { failure: null };
        const callback = (response: unknown) => {
            const receivedMethod: unknown = method ?? (data && typeof data === 'object' ? Reflect.get(data, 'method') : null);
            completionDiagnostic.failure = projectRpcFailureDiagnostic(typeof receivedMethod === 'string' ? receivedMethod : null, response,
                forwardStartedAt === undefined ? 'rpc.admission' : 'rpc.relay',
                forwardStartedAt === undefined ? false : null);
            acknowledge?.(response);
        };
        const logDeploymentChildRefusal = (phase: 'execution_shape' | 'original_action_shape'
            | 'external_action_execution' | 'original_action_envelope' | 'machine_admission') => {
            if (method?.slice(method.indexOf(':') + 1) === RPC_METHODS.DAEMON_DEPLOYMENT_CHILD) {
                warn({ module: 'websocket-rpc', phase, rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD,
                    ...(callerTraceId ? { requestId: callerTraceId } : {}) });
            }
        };
        try {
            if (callerTraceId) log({ module: 'websocket-rpc', event: 'rpc-call-received',
                requestId: callerTraceId, callerSocketId: params.socket.id,
            }, 'RPC call received');
            // Runner socket compositions are restricted RPC receivers. A future
            // Runner-originated call needs its own explicit source authority;
            // target-side Machine classification cannot grant caller authority.
            if (params.ephemeralRunnerAdmission && params.ephemeralRunnerAdmission.kind !== "api-token-session-viewer") {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            let viewer: Extract<RestrictedSocketAdmission, { kind: "api-token-session-viewer" }> | null = null;
            if (params.ephemeralRunnerAdmission?.kind === "api-token-session-viewer") {
                if (!await hasCurrentSocketCredential(params.userId, params.socket)) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                const current = params.socket.data.ephemeralRunnerAdmission as RestrictedSocketAdmission | undefined;
                if (current?.kind !== "api-token-session-viewer" || current.sessionId !== params.ephemeralRunnerAdmission.sessionId) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                viewer = current;
            }
            if (parsedRequestId === null) {
                callback?.({
                    ok: false,
                    error: "Invalid RPC request correlation",
                });
                return;
            }
            callerRequestId = parsedRequestId;
            const waitForResultOnCancel = (data as { waitForResultOnCancel?: unknown } | undefined)?.waitForResultOnCancel;
            if (waitForResultOnCancel !== undefined && typeof waitForResultOnCancel !== 'boolean') {
                callback?.({ ok: false, error: 'Invalid RPC cancellation result policy' });
                return;
            }
            if (callerRequestId) {
                if (activeCancellations.has(callerRequestId)) {
                    callback?.({
                        ok: false,
                        error: "RPC request correlation is already active",
                    });
                    return;
                }
                cancellation = {
                    controller: new AbortController(),
                    ...(waitForResultOnCancel === true ? { ackController: new AbortController() } : {}),
                    targetRequestId: `rpc_${randomUUID()}`,
                    targetSocketId: null,
                    cancelled: false,
                };
                activeCancellations.set(callerRequestId, cancellation);
            }
            method = normalizeRpcMethodName((data as { method?: unknown } | undefined)?.method);
            const callParams = (data as { params?: unknown } | undefined)?.params;
            const separator = method?.indexOf(':') ?? -1;
            const usesAnsweringClientRouting = separator > 0
                && method!.slice(separator + 1).startsWith(ANSWERING_CLIENT_RPC_PREFIX_V1);
            const rawAnsweringClient = (data as { answeringClient?: unknown } | undefined)?.answeringClient;
            const parsedAnsweringClient = usesAnsweringClientRouting ? SocketRpcAnsweringClientV1Schema.safeParse(rawAnsweringClient) : null;
            if (usesAnsweringClientRouting && !parsedAnsweringClient?.success || !usesAnsweringClientRouting && rawAnsweringClient !== undefined) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const answeringClient = parsedAnsweringClient?.success ? parsedAnsweringClient.data : undefined;
            if (usesAnsweringClientRouting) {
                method = normalizeRpcMethodName(`${method!.slice(0, separator + 1)}${method!.slice(separator + 1 + ANSWERING_CLIENT_RPC_PREFIX_V1.length)}`);
            }
            if (data && typeof data === 'object' && 'machineAdmission' in data) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const parsedTimeout = SocketRpcTimeoutMsSchema.safeParse((data as { timeoutMs?: unknown } | undefined)?.timeoutMs);
            if (!parsedTimeout.success) {
                callback?.({ ok: false, error: "Invalid RPC deadline" });
                return;
            }
            const timeoutMs = parsedTimeout.data;
            if (method?.endsWith(`:${RPC_METHODS.CAPABILITIES_INVOKE}`)) {
                const installationResponse = await forwardManagedInstallationResponse({ io: params.io, socket: params.socket,
                    actorAccountId: params.userId, method, params: callParams, timeoutMs,
                    inboundAuthorization: (data as { authorization?: unknown } | undefined)?.authorization,
                    ...(cancellation ? { cancellation: { targetRequestId: cancellation.targetRequestId,
                        signal: cancellation.controller.signal,
                        ...(cancellation.ackController ? { ackSignal: cancellation.ackController.signal } : {}),
                        onTargetSelected: target => { cancellation!.targetSocketId = target.id; } } } : {}),
                });
                if (installationResponse) { callback?.(installationResponse); return; }
            }
            let authorization: SocketRpcAuthorizationContext | undefined;
            let sessionWriteTargetUserId: string | null = null;
            let requesterApprovalMachine: Readonly<{
                machineId: string;
                sessionId: string;
                accountId: string;
                routingProof: Readonly<{ kind: 'committed'; target: SessionInputMachineTargetV1 }> | Readonly<{ kind: 'publisher' }>;
            }> | null = null;
            let sessionActionOrigin: SessionActionRpcOriginV1 | undefined;
            let sessionActionSourceGuard: RpcForwardTargetGuard | null = null;

            if (!method) {
                callback?.({
                    ok: false,
                    error: "Invalid parameters: method is required",
                });
                return;
            }
            const rawTransferRouting = (data as { transferRouting?: unknown } | undefined)?.transferRouting;
            const liveApprovalOrigin = isLiveCliApprovalOriginMethod(method);
            if (liveApprovalOrigin && (params.ephemeralRunnerAdmission != null
                || !isPresentUserLiveApprovalOriginCaller(params.socket)
                || (data as { authorization?: unknown }).authorization !== undefined
                || (data as { externalActionExecution?: unknown }).externalActionExecution !== undefined
                || (data as { sessionActionOrigin?: unknown }).sessionActionOrigin !== undefined)) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const reverseAutomationSeparator = method.indexOf(':');
            const reverseMethod = method.slice(reverseAutomationSeparator + 1);
            const reverseClientContinuation = reverseAutomationSeparator > 0
                && isMachineVisibleClientRpcMethod(reverseMethod);
            const appClientContinuation = answeringClient !== undefined
                && (reverseMethod === RPC_METHODS.UI_ACTION_EXECUTE || reverseMethod === DESKTOP_UI_ACTION_CLIENT_RPC_METHOD)
                && params.ephemeralRunnerAdmission == null
                && isPresentUserLiveApprovalOriginCaller(params.socket)
                && await hasCurrentSocketCredential(params.userId, params.socket);
            if (answeringClient && !reverseClientContinuation) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            if (reverseClientContinuation && (!appClientContinuation
                    && readMachineScopedSocketMachineId(params.socket) !== method.slice(0, reverseAutomationSeparator)
                    || !await isMachineScopedRpcMethodAvailable({ userId: params.userId, method }))) {
                // Daemons and present-user Apps continue their admitted Action
                // through a registered App in the same Account.
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const parsedTransferRouting = rawTransferRouting === undefined ? null : SessionTransferRoutingV1Schema.safeParse(rawTransferRouting);
            if (parsedTransferRouting && (!parsedTransferRouting.success
                || method !== `${parsedTransferRouting.data.sessionId}:${parsedTransferRouting.data.method}`
                || (viewer && parsedTransferRouting.data.sessionId !== viewer.sessionId))) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const transferRouting = parsedTransferRouting?.success ? parsedTransferRouting.data : undefined;
            const sourcePhaseMethod = method.slice(method.indexOf(':') + 1) === RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE;
            const projectSourceMethod = method.slice(method.indexOf(':') + 1) === RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN
                || method.slice(method.indexOf(':') + 1) === RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN;
            const rawSourceRouting = (data as { workspaceSyncSourceRouting?: unknown } | undefined)?.workspaceSyncSourceRouting;
            const parsedSourceRouting = rawSourceRouting === undefined ? null : WorkspaceSyncSourceRoutingV1Schema.safeParse(rawSourceRouting);
            if ((sourcePhaseMethod && (!readMachineIdPrefix(method) || !parsedSourceRouting?.success))
                || (rawSourceRouting !== undefined && (!(sourcePhaseMethod || projectSourceMethod) || !parsedSourceRouting?.success || transferRouting || viewer))) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const workspaceSyncSourceRouting = parsedSourceRouting?.success ? parsedSourceRouting.data : undefined;
            const isProjectSource = Boolean(projectSourceMethod && workspaceSyncSourceRouting?.originalActionEnvelope);
            if (projectSourceMethod && workspaceSyncSourceRouting && !isProjectSource
                || workspaceSyncSourceRouting?.originalActionEnvelope && !isProjectSource) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const rawTargetRouting = (data as { workspaceSyncTargetRouting?: unknown } | undefined)?.workspaceSyncTargetRouting;
            const parsedTargetRouting = rawTargetRouting === undefined ? null : WorkspaceSyncTargetRoutingV1Schema.safeParse(rawTargetRouting);
            if (rawTargetRouting !== undefined && (!parsedTargetRouting?.success || isWorkspaceSyncSourceWriterCleanupPhaseV1(parsedTargetRouting.data.phase) && parsedTargetRouting.data.phase !== 'release' || workspaceSyncSourceRouting
                || !readMachineIdPrefix(method) || method.slice(method.indexOf(':') + 1) !== readWorkspaceSyncTargetMethodV1(parsedTargetRouting.data.phase)
                || transferRouting || viewer)) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const workspaceSyncTargetRouting = parsedTargetRouting?.success ? parsedTargetRouting.data : undefined;
            const rawWriterRouting = (data as { workspaceSyncSourceWriterTargetRouting?: unknown } | undefined)?.workspaceSyncSourceWriterTargetRouting;
            const parsedWriterRouting = rawWriterRouting === undefined ? null : WorkspaceSyncSourceWriterTargetRoutingV1Schema.safeParse(rawWriterRouting);
            const rawSeedRouting = (data as { workspaceSyncSeedRouting?: unknown } | undefined)?.workspaceSyncSeedRouting;
            const parsedSeedRouting = rawSeedRouting === undefined ? null : WorkspaceSyncSeedRoutingV1Schema.safeParse(rawSeedRouting);
            if (rawSeedRouting !== undefined && (!parsedSeedRouting?.success || transferRouting || viewer || workspaceSyncSourceRouting
                || workspaceSyncTargetRouting || rawWriterRouting !== undefined || !readMachineIdPrefix(method)
                || method.slice(method.indexOf(':') + 1) !== RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const workspaceSyncSeedRouting = parsedSeedRouting?.success ? parsedSeedRouting.data : undefined;
            // Initial D ingress produces this packet. Only exact Project B or
            // seed preparation may carry it onward; Home rechecks D's signature.
            const rawSourceExecution = (data as { workspaceSyncSourceExecution?: unknown } | undefined)?.workspaceSyncSourceExecution;
            const parsedSourceExecution = rawSourceExecution === undefined ? null : WorkspaceSyncSourceExecutionV1Schema.safeParse(rawSourceExecution);
            if (rawSourceExecution !== undefined && (!parsedSourceExecution?.success || !workspaceSyncSeedRouting && (!parsedWriterRouting?.success
                    || !parsedWriterRouting.data.source.originalActionEnvelope || isWorkspaceSyncSourceWriterCleanupPhaseV1(parsedWriterRouting.data.target.phase)))) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            if (rawWriterRouting !== undefined && (!parsedWriterRouting?.success || workspaceSyncSourceRouting
                || workspaceSyncTargetRouting && isWorkspaceSyncSourceWriterCleanupPhaseV1(parsedWriterRouting.data.target.phase)
                || transferRouting || viewer || !readMachineIdPrefix(method)
                || method.slice(method.indexOf(':') + 1) !== readWorkspaceSyncTargetMethodV1(parsedWriterRouting.data.target.phase))) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const workspaceSyncSourceWriterTargetRouting = parsedWriterRouting?.success ? parsedWriterRouting.data : undefined;
            const retainedProjectSourceExecution = parsedSourceExecution?.success ? parsedSourceExecution.data : undefined;
            const workspaceSyncRouting = workspaceSyncSourceRouting ?? workspaceSyncTargetRouting;
            const workspaceSyncContext = workspaceSyncSourceRouting?.sourceContext ?? workspaceSyncTargetRouting?.targetContext
                ?? (workspaceSyncSourceWriterTargetRouting && !isWorkspaceSyncSourceWriterCleanupPhaseV1(workspaceSyncSourceWriterTargetRouting.target.phase)
                    ? workspaceSyncSourceWriterTargetRouting.source.sourceContext : undefined)
                ?? workspaceSyncSeedRouting?.sourceWriterTarget.source.sourceContext;

            const rawExternalActionExecution = (data as { externalActionExecution?: unknown } | undefined)
                ?.externalActionExecution;
            const externalActionExecution = rawExternalActionExecution === undefined
                ? null
                : ExternalActionMachineRpcExecutionV1Schema.safeParse(rawExternalActionExecution);
            if (externalActionExecution && !externalActionExecution.success) {
                logDeploymentChildRefusal('execution_shape');
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const rawOriginalActionEnvelope = (data as { originalActionEnvelope?: unknown } | undefined)?.originalActionEnvelope;
            const parsedOriginalActionEnvelope = rawOriginalActionEnvelope === undefined ? null : ExternalActionRequestEnvelopeSchema.safeParse(rawOriginalActionEnvelope);
            const originalActionMethod = method.slice(method.indexOf(':') + 1);
            const operationCancellation = originalActionMethod === ACTION_OPERATION_RPC_METHODS_V1.cancel
                && externalActionExecution?.success
                && externalActionExecution.data.authorization.binding.actionId === 'action.operations.cancel'
                && externalActionExecution.data.effectActionId === 'action.operations.cancel'
                && externalActionExecution.data.target.kind === 'machine'
                && externalActionExecution.data.target.machineId === externalActionExecution.data.authorization.binding.machineId
                && method === `${externalActionExecution.data.authorization.binding.machineId}:${ACTION_OPERATION_RPC_METHODS_V1.cancel}`;
            const deploymentChild = originalActionMethod === RPC_METHODS.DAEMON_DEPLOYMENT_CHILD
                && externalActionExecution?.success
                && (externalActionExecution.data.authorization.binding.deploymentChildRoot === true)
                && externalActionExecution.data.deploymentChildRouting !== undefined;
            const deploymentArchiveChild = externalActionExecution?.success
                && externalActionExecution.data.deploymentChildExecution !== undefined
                && readDeploymentArchiveRpcEffectV1(originalActionMethod) !== null;
            const originalActionEnvelopeKind = parsedOriginalActionEnvelope?.success
                ? readOriginalActionEnvelopeMachineRpcKindV1({ method: originalActionMethod,
                    machineId: method.slice(0, method.indexOf(':')),
                    execution: externalActionExecution?.success ? externalActionExecution.data : undefined,
                    envelope: parsedOriginalActionEnvelope.data, params: callParams }) : null;
            if (rawOriginalActionEnvelope !== undefined && (!parsedOriginalActionEnvelope?.success
                || originalActionEnvelopeKind === null
                || transferRouting || workspaceSyncRouting || workspaceSyncSourceWriterTargetRouting || workspaceSyncSeedRouting || viewer)) {
                logDeploymentChildRefusal('original_action_shape');
                callback?.(buildForbiddenRpcResponse(undefined, 'rpc.admission.original_action'));
                return;
            }
            const originalActionEnvelope = parsedOriginalActionEnvelope?.success ? parsedOriginalActionEnvelope.data : undefined;
            if (viewer && rawExternalActionExecution !== undefined) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const verifiedExternalAction = externalActionExecution?.success
                ? await verifyExternalActionMachineRpcExecution(externalActionExecution.data, {
                    method,
                    resolveCurrentSessionMachine: input => resolveCurrentSessionMachineFromServer({ io: params.io, presence: params.sessionPublisherPresence, ...input }),
                    ...(callerRequestId === undefined ? {} : { requestId: callerRequestId }),
                    ...(callParams === undefined ? {} : { params: callParams }),
                    ...(isProjectSource && workspaceSyncSourceRouting ? { workspaceSyncSourceRouting } : {}),
                    ...(workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting } : {}),
                    ...(workspaceSyncSourceWriterTargetRouting && workspaceSyncTargetRouting ? { workspaceSyncTargetRouting } : {}),
                    ...(retainedProjectSourceExecution ? { workspaceSyncSourceExecution: retainedProjectSourceExecution } : {}),
                    ...(workspaceSyncSeedRouting ? { workspaceSyncSeedRouting } : {}),
                    ...(originalActionEnvelope ? { originalActionEnvelope } : {}),
                })
                : null;
            const verifiedPairedTargetSender = Boolean(verifiedExternalAction && workspaceSyncSourceWriterTargetRouting && workspaceSyncTargetRouting
                && workspaceSyncTargetRouting.targetContext.machineAdmission.custodianAccountId === params.userId
                && readMachineScopedSocketMachineId(params.socket) === workspaceSyncTargetRouting.targetMachineId
                && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket))
                    === workspaceSyncTargetRouting.targetContext.machineAdmission.installationId);
            const verifiedProjectSourceWriterSender = Boolean(verifiedExternalAction?.binding.actionId === 'projects.open'
                && workspaceSyncSourceWriterTargetRouting && retainedProjectSourceExecution && !workspaceSyncTargetRouting
                && params.userId === workspaceSyncSourceWriterTargetRouting.source.sourceContext.machineAdmission.custodianAccountId
                && readMachineScopedSocketMachineId(params.socket) === workspaceSyncSourceWriterTargetRouting.sourceWriter.machineId
                && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket)) === workspaceSyncSourceWriterTargetRouting.sourceWriter.installationId);
            const seedAdmission = verifiedExternalAction?.workspaceSyncSeedAdmission;
            const seedTarget = seedAdmission?.physicalTarget;
            const seedSocketData = seedTarget ? readSocketData(params.socket) : null;
            const verifiedSeedSender = Boolean(seedTarget && seedSocketData && params.userId === seedTarget.custodianAccountId
                && readMachineScopedSocketMachineId(params.socket) === seedTarget.machineId
                && readVerifiedMachineSocketInstallationIdFromSocketData(seedSocketData) === seedTarget.installationId
                && params.socket.connected === true && (seedSocketData.authTokenKind === 'account' || seedSocketData.authTokenKind === 'terminal')
                && seedSocketData.ephemeralRunnerAdmission == null && seedSocketData.apiTokenPrincipal == null
                && await hasCurrentSocketCredential(params.userId, params.socket));
            const archiveSigner = verifiedExternalAction?.deploymentChildSigner;
            const archiveSocketData = archiveSigner ? readSocketData(params.socket) : null;
            // The installed receiver dials over its custodian's user-scoped RPC socket (callExactMachineRpc).
            // Its installation signature on the child packet, verified above, proves the signer, as for a
            // requester-transported deployment child; a different Machine's own socket is still refused.
            const verifiedArchiveSender = Boolean(archiveSigner && params.userId === archiveSigner.custodianAccountId
                && (readSocketClientType(params.socket) === 'user-scoped'
                    || readMachineScopedSocketMachineId(params.socket) === archiveSigner.machineId
                        && readVerifiedMachineSocketInstallationIdFromSocketData(archiveSocketData) === archiveSigner.installationId)
                && params.socket.connected === true && (archiveSocketData?.authTokenKind === 'account' || archiveSocketData?.authTokenKind === 'terminal')
                && archiveSocketData.ephemeralRunnerAdmission == null && archiveSocketData.apiTokenPrincipal == null
                && await hasCurrentSocketCredential(params.userId, params.socket));
            if (
                externalActionExecution?.success
                && (!verifiedExternalAction || deploymentArchiveChild && !verifiedArchiveSender || (verifiedExternalAction.principal.accountId !== params.userId
                    && !verifiedPairedTargetSender && !verifiedProjectSourceWriterSender && !verifiedSeedSender && !verifiedArchiveSender && !(verifiedExternalAction.binding.custodianAccountId === params.userId
                        && (verifiedExternalAction.managedGuestActivity
                            || readMachineScopedSocketMachineId(params.socket) === verifiedExternalAction.binding.machineId
                                && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket)) === verifiedExternalAction.binding.installationId
                            || workspaceSyncSourceWriterTargetRouting
                                && readMachineScopedSocketMachineId(params.socket) === workspaceSyncSourceWriterTargetRouting.sourceWriter.machineId
                                && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket)) === workspaceSyncSourceWriterTargetRouting.sourceWriter.installationId))))
            ) {
                logDeploymentChildRefusal('external_action_execution');
                callback?.(buildForbiddenRpcResponse(undefined, 'rpc.admission.execution'));
                return;
            }
            if (originalActionEnvelope) {
                const binding = verifiedExternalAction?.binding;
                const moveChild = originalActionEnvelopeKind === 'child';
                const socketData = readSocketData(params.socket);
                const plainParams = originalActionEnvelope.v === 1 && typeof callParams !== 'string'
                    ? StrictJsonValueSchema.safeParse(callParams) : null;
                const rootMethod = binding?.actionId === 'projects.open' ? RPC_METHODS.PROJECTS_OPEN
                    : operationCancellation ? ACTION_OPERATION_RPC_METHODS_V1.cancel
                    : binding && Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, binding.actionId)
                        ? PROJECT_FINITE_ACTION_RPC_METHODS_V1[binding.actionId as keyof typeof PROJECT_FINITE_ACTION_RPC_METHODS_V1] : null;
                // Exact-Machine CLI calls use the requester's Account transport;
                // the verified child packet above carries the controller's signature.
                const deploymentAccountSender = deploymentChild
                    && readSocketClientType(params.socket) === 'user-scoped'
                    && params.userId === binding?.accountId;
                const cancellationAccountSender = operationCancellation
                    && readSocketClientType(params.socket) === 'user-scoped'
                    && params.userId === binding?.accountId;
                if (!binding || !moveChild && (!rootMethod || verifiedExternalAction?.effectActionId !== binding.actionId
                    || method !== `${binding.machineId}:${rootMethod}`)
                    || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId, machineId: binding.machineId, envelope: originalActionEnvelope })
                    || !moveChild && !operationCancellation && originalActionEnvelope.v === 1 && plainParams
                        && (!plainParams.success || !sameStrictJsonValue(originalActionEnvelope.input, plainParams.data))
                    || params.socket.connected !== true || (socketData.authTokenKind !== 'account'
                        && !(moveChild && socketData.authTokenKind === 'terminal'))
                    || socketData.ephemeralRunnerAdmission != null || socketData.apiTokenPrincipal != null
                    || !await hasCurrentSocketCredential(params.userId, params.socket)
                    || (operationCancellation ? !cancellationAccountSender
                        : deploymentChild ? !deploymentAccountSender && (params.userId !== binding.custodianAccountId
                            || readMachineScopedSocketMachineId(params.socket) !== binding.machineId
                            || readVerifiedMachineSocketInstallationIdFromSocketData(socketData) !== binding.installationId)
                        : deploymentArchiveChild ? !verifiedArchiveSender
                        : moveChild ? params.userId !== binding.accountId
                        : params.userId !== binding.custodianAccountId || readMachineScopedSocketMachineId(params.socket) !== binding.machineId
                            || readVerifiedMachineSocketInstallationIdFromSocketData(socketData) !== binding.installationId)) {
                    logDeploymentChildRefusal('original_action_envelope');
                    callback?.(buildForbiddenRpcResponse(undefined, 'rpc.admission.original_action'));
                    return;
                }
            }
            const projectSourceExecution = isProjectSource && verifiedExternalAction && externalActionExecution?.success
                ? WorkspaceSyncSourceExecutionV1Schema.safeParse({ method, requestId: callerRequestId,
                    ...(callParams === undefined ? {} : { params: callParams }), externalActionExecution: externalActionExecution.data }) : null;
            if (isProjectSource && !projectSourceExecution?.success) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            const deploymentReferenceServices = verifiedExternalAction?.deploymentReferenceServiceList;
            const moveChildExecution = (deploymentArchiveChild || deploymentReferenceServices || originalActionEnvelope && originalActionEnvelopeKind === 'child')
                && externalActionExecution?.success ? WorkspaceSyncSourceExecutionV1Schema.parse({ method,
                    requestId: callerRequestId, ...(callParams === undefined ? {} : { params: callParams }),
                    externalActionExecution: externalActionExecution.data, ...(originalActionEnvelope ? { originalActionEnvelope } : {}) }) : null;
            if (verifiedExternalAction?.binding.sessionActionOrigin) {
                // Original Session facts come only from the verified Home carrier,
                // never from caller-authored socket fields.
                sessionActionOrigin = verifiedExternalAction.binding.sessionActionOrigin;
            }
            // A Machine socket also hosts Can-use members' Sessions. Its Session
            // Action RPC acts as the source Session's Account, admitted once by
            // the source binding below; the host's own evidence never travels.
            const sessionActionAuthorization = !archiveSigner && !verifiedExternalAction && !workspaceSyncSourceRouting
                ? parseSocketRpcAuthorizationContext((data as { authorization?: unknown } | undefined)?.authorization) : null;
            const hostedMemberAccountId = sessionActionAuthorization?.kind === 'session.action'
                ? await readHostedMemberSessionActionAccountId(params.userId, sessionActionAuthorization.origin.caller.sessionId) : null;
            const actorAccountId = archiveSigner?.custodianAccountId ?? verifiedExternalAction?.principal.accountId
                ?? hostedMemberAccountId ?? params.userId;
            const archiveAuthentication = archiveSigner ? readSessionAccessAuthenticationFromSocket(params.socket) : undefined;
            const requestAuthentication = hostedMemberAccountId
                ? { ...readSessionAccessAuthenticationFromSocket(params.socket), authenticationEvidence: undefined }
                : verifiedExternalAction
                ? {
                    ...archiveAuthentication,
                    env: process.env,
                    authority: archiveAuthentication ? narrowCredentialAuthority(archiveAuthentication.authority, verifiedExternalAction.effectiveAuthority)
                        : verifiedExternalAction.effectiveAuthority,
                    authenticationEvidence: archiveAuthentication ? archiveAuthentication.authenticationEvidence : verifiedExternalAction.principal.authenticationEvidence,
                    ...('grant' in verifiedExternalAction.binding ? { callerInputConstraints: {
                        models: verifiedExternalAction.binding.grant.models,
                        permissionModes: verifiedExternalAction.binding.grant.permissionModes,
                    } } : {}),
                }
                : readSessionAccessAuthenticationFromSocket(params.socket);

            const inboundAuthorization = (data as { authorization?: unknown } | undefined)?.authorization;
            if (inboundAuthorization && typeof inboundAuthorization === 'object'
                && 'kind' in inboundAuthorization && inboundAuthorization.kind === 'session.browser') {
                callback?.(buildForbiddenRpcResponse()); return;
            }
            const browserCapability = resolveSessionBrowserRpcCapabilityV1(method.slice(method.indexOf(':') + 1));
            const browserSelector = browserCapability ? parseSocketRpcAuthorizationContext(inboundAuthorization) : null;
            if (browserCapability && browserSelector
                && (browserSelector.kind === 'session.read' || browserSelector.kind === 'session.write')) {
                if (requestAuthentication.authority !== 'present_user' || viewer || verifiedExternalAction) {
                    callback?.(buildForbiddenRpcResponse()); return;
                }
                const admission = await resolveSessionBrowserAdmission({ actorAccountId,
                    sessionId: browserSelector.sessionId, capability: browserCapability,
                    authentication: requestAuthentication, io: params.io, presence: params.sessionPublisherPresence });
                if (admission.status !== 'allowed') {
                    callback?.(buildSessionAccessRpcRefusal(admission.status)); return;
                }
                const prefix = method.slice(0, method.indexOf(':'));
                if (prefix !== admission.authorization.sessionId) {
                    callback?.(buildForbiddenRpcResponse()); return;
                }
                sessionBrowserAuthorization = admission.authorization;
                authorization = admission.authorization;
                sessionWriteTargetUserId = admission.authorization.custodianAccountId;
                method = `${admission.authorization.machineId}:${method.slice(method.indexOf(':') + 1)}`;
            }
            const isTransferMethod = SessionTransferRpcMethodV1Schema.safeParse(method.slice(method.indexOf(':') + 1)).success;
            // The same transfer methods also serve the incumbent Machine carrier.
            // Only the routing header selects the Session-owned encrypted carrier.
            const methodSessionAuthorization = isTransferMethod && !transferRouting ? null : resolveSocketRpcSessionAuthorization(method);
            const rawSessionAuthorization = (data as { authorization?: unknown } | undefined)?.authorization;
            const scopedMachineId = methodSessionAuthorization?.machineScope === true
                && readSocketClientType(params.socket) !== 'session-scoped' ? readMachineIdPrefix(method) : null;
            // A declared dual-scope method selects Machine scope only from an exact
            // persisted identity. Session scope never falls back after refusal.
            const detachedMachine = scopedMachineId
                ? await readMachineAdmissionFactsInTx(db, { actorAccountId, machineId: scopedMachineId }) : null;
            // Checkout deletion remains Session-owned on the Machine carrier.
            // A selector admits that Session before the daemon can run teardown;
            // an opaque detached Run request retains its Run-store authority.
            const machineSessionDelete = detachedMachine
                && methodSessionAuthorization?.method === SESSION_RPC_METHODS.SESSION_DELETE
                && rawSessionAuthorization !== undefined;
            if (detachedMachine) {
                if (detachedMachine.kind === 'ephemeral_session_runner'
                    || rawSessionAuthorization !== undefined && !machineSessionDelete) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
            }
            if (rawSessionAuthorization && typeof rawSessionAuthorization === "object"
                && "kind" in rawSessionAuthorization && rawSessionAuthorization.kind === "session.action") {
                const parsed = parseSocketRpcAuthorizationContext(rawSessionAuthorization);
                if (parsed?.kind !== "session.action"
                    || (workspaceSyncSourceRouting
                        ? parsed.sessionId !== workspaceSyncSourceRouting.sourceSessionId
                        : !methodSessionAuthorization?.routeToSessionOwnerDaemon || !isSessionActionRpcMethodV1(method)
                            || parsed.sessionId !== method.slice(0, method.lastIndexOf(":")))
                    || viewer || rawExternalActionExecution !== undefined || transferRouting
                    // A hosted member's Session acts only on itself.
                    || hostedMemberAccountId && parsed.sessionId !== parsed.origin.caller.sessionId) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                const source = {
                    accountId: hostedMemberAccountId ?? params.userId, socket: params.socket, io: params.io, presence: params.sessionPublisherPresence,
                    sourceSessionId: parsed.origin.caller.sessionId, targetSessionId: parsed.sessionId,
                };
                const releasingSource = workspaceSyncSourceRouting?.phase === 'commit' || workspaceSyncSourceRouting?.phase === 'abort';
                if (!releasingSource && !await hasCurrentSessionActionRpcSource(source)) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                sessionActionOrigin = parsed.origin;
                sessionActionSourceGuard = releasingSource ? null : {
                    filterTargets: async (targets) => targets,
                    runOperation: async ({ operation }) => await hasCurrentSessionActionRpcSource(source)
                        ? { status: "current", value: await operation() }
                        : { status: "refused", response: buildForbiddenRpcResponse() },
                };
            }
            const isPermissionDecisionMethod = methodSessionAuthorization?.serverMintedContext === "session.permission.respond";
            // The question owner validates the narrow manager exception. An
            // explicit token input grant is re-admitted below by its own owner.
            const delegatesQuestionAnswer = methodSessionAuthorization?.method === RPC_METHODS.SESSION_USER_ACTION_ANSWER
                && (sessionActionOrigin !== undefined || viewer !== null);
            const isRequesterApprovalDecision = methodSessionAuthorization?.method === RPC_METHODS.APPROVAL_REQUEST_DECIDE;
            let requesterDecisionAuthentication: SessionPermissionDecisionAuthenticationV1 | undefined;
            if (isRequesterApprovalDecision && !detachedMachine) {
                const verified = await readCurrentSocketCredential(actorAccountId, params.socket);
                if (!verified || verified.userId !== actorAccountId || verified.authority !== 'present_user'
                    || verified.tokenEpoch === undefined) { callback?.(buildForbiddenRpcResponse()); return; }
                requesterDecisionAuthentication = { tokenEpoch: verified.tokenEpoch,
                    ...(verified.authenticationEvidence?.length ? { evidence: AuthTokenAuthenticationEvidenceSnapshotV1Schema.parse({
                        v: 1, evidence: verified.authenticationEvidence,
                    }) } : {}) };
            }
            const sessionRequestAuthentication = requesterDecisionAuthentication ? { ...requestAuthentication,
                tokenEpoch: requesterDecisionAuthentication.tokenEpoch,
                authenticationEvidence: requesterDecisionAuthentication.evidence?.evidence,
            } : requestAuthentication;
            if (viewer && isTransferMethod && !transferRouting) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            if (viewer && (!methodSessionAuthorization?.actionId
                || !methodSessionAuthorization.routeToSessionOwnerDaemon
                || method.slice(0, method.lastIndexOf(':')) !== viewer.sessionId)) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            // A signed root admitted for this exact decision was decided once by
            // resolveCredentialActionAdmissionV1 at verification; only unsigned
            // credentials and viewers are decided here.
            const admittedDecisionEffect = verifiedExternalAction !== null
                && verifiedExternalAction.effectActionId === methodSessionAuthorization?.actionId;
            if ((isRequesterApprovalDecision && requestAuthentication.authority !== 'present_user')
                || ((isPermissionDecisionMethod && !delegatesQuestionAnswer && !admittedDecisionEffect
                    || method.endsWith(`:${RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND}`))
                && !canCredentialDecideV1({
                    authority: requestAuthentication.authority,
                    grant: verifiedExternalAction && 'grant' in verifiedExternalAction.principal
                        ? verifiedExternalAction.principal.grant : viewer?.principal.grant ?? null,
                }))) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            // The machine-owned session spawn method lives in the closed `session.`
            // namespace but is a Machine operation, not a Session write: the exact
            // daemon may register it (see REGISTER above), so Account callers must
            // reach it through ordinary machine-scoped forwarding.
            if (
                isSocketRpcSessionAuthorizationNamespace(method)
                && !methodSessionAuthorization
                && !isMachineOwnedSessionSpawnRpcMethod(method)
            ) {
                callback?.({
                    ok: false,
                    error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                    errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                });
                return;
            }

            if (isReservedServerOriginRpcMethod(method)) {
                recordRpcCallFailure(method, "forbidden");
                observeRpcCall({
                    method,
                    durationMs: Date.now() - startedAt,
                    result: "error",
                });
                callback?.(buildForbiddenRpcResponse());
                return;
            }

            if (!viewer && !await canCallSessionScopedRpcMethod({ socket: params.socket, accountId: actorAccountId, method })) {
                recordRpcCallFailure(method, "forbidden");
                observeRpcCall({
                    method,
                    durationMs: Date.now() - startedAt,
                    result: "error",
                });
                callback?.({
                    ok: false,
                    error: "Forbidden",
                });
                return;
            }

            const sourceKeyPreparationMachineId = readSessionFollowSourceKeyPreparationMachineId(method);
            let sourceKeyPreparationTargetGuard: RpcForwardTargetGuard | null = null;
            if (sourceKeyPreparationMachineId) {
                const parsedAuthorization = SessionFollowSourceKeyPrepareAuthorizationV1Schema.safeParse(
                    (data as { authorization?: unknown } | undefined)?.authorization,
                );
                if (!parsedAuthorization.success) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                const admission = await authorizeSessionFollowSourceKeyPreparer({
                    accountId: actorAccountId,
                    sourceSessionId: parsedAuthorization.data.sourceSessionId,
                    destinationSessionId: parsedAuthorization.data.destinationSessionId,
                    ...(parsedAuthorization.data.localInputId !== undefined ? { localInputId: parsedAuthorization.data.localInputId } : {}),
                    authentication: requestAuthentication,
                });
                if (!admission.ok) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                authorization = parsedAuthorization.data;
                sessionWriteTargetUserId = admission.value.destinationRuntimeAccountId;
                sourceKeyPreparationTargetGuard = createSessionFollowSourceKeyPreparationTargetGuard({
                    accountId: actorAccountId,
                    machineId: sourceKeyPreparationMachineId,
                    sourceSessionId: parsedAuthorization.data.sourceSessionId,
                    destinationSessionId: parsedAuthorization.data.destinationSessionId,
                    ...(parsedAuthorization.data.localInputId !== undefined ? { localInputId: parsedAuthorization.data.localInputId } : {}),
                    authentication: requestAuthentication,
                });
            } else if (
                method === RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE
                || method.endsWith(`:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`)
            ) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }

            const sessionAuthorization = machineSessionDelete && methodSessionAuthorization
                ? { ...methodSessionAuthorization, routeToSessionOwnerDaemon: false }
                : detachedMachine ? null : methodSessionAuthorization;
            const isScmWorkEvidenceBatch = method === RPC_METHODS.SCM_WORK_EVIDENCE_READ
                || method.slice(method.indexOf(':') + 1) === RPC_METHODS.SCM_WORK_EVIDENCE_READ;
            if (isScmWorkEvidenceBatch) {
                const selector = ScmWorkEvidenceAuthorizationSelectorSchema.safeParse(rawSessionAuthorization);
                if (!readMachineIdPrefix(method) || !selector.success || !sessionAuthorization) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                const admissions: ScmWorkEvidenceAdmission['admissions'] = [];
                for (const sessionId of new Set(selector.data.sessionIds)) {
                    const decision = await admitSessionRpc({ actorAccountId, credentialAccountId: params.userId,
                        sessionId, rule: sessionAuthorization, authentication: sessionRequestAuthentication,
                        tokenAuthentication: requestAuthentication, viewerPrincipal: viewer?.principal,
                        io: params.io, presence: params.sessionPublisherPresence });
                    admissions.push(decision.status === 'allowed'
                        ? { kind: 'session.write', sessionId }
                        : { kind: 'refused', sessionId, errorCode: buildSessionAccessRpcRefusal(decision.status).errorCode });
                }
                authorization = { kind: 'scm.workEvidence.admitted', admissions };
            } else if (sessionAuthorization
                && (sessionAuthorization.optionalSessionScope !== true || rawSessionAuthorization !== undefined)) {
                const separatorIndex = method.lastIndexOf(":");
                const rawAuthorization = (data as { authorization?: unknown } | undefined)?.authorization;
                const suppliedAuthorization = parseSocketRpcAuthorizationContext(
                    rawAuthorization,
                );
                const sessionId = sessionAuthorization.routeToSessionOwnerDaemon
                    ? (separatorIndex > 0 ? method.slice(0, separatorIndex) : null)
                    : sessionAuthorization.serverMintedContext === "session.read"
                        ? suppliedAuthorization?.kind === "session.read" ? suppliedAuthorization.sessionId : null
                        : suppliedAuthorization?.kind === "session.write" ? suppliedAuthorization.sessionId : null;
                if (
                    !sessionId
                    || (
                        sessionAuthorization.routeToSessionOwnerDaemon
                        && !isPermissionDecisionMethod
                        && rawAuthorization !== undefined
                        && (
                            (suppliedAuthorization?.kind !== "session.write"
                                && !(suppliedAuthorization?.kind === "session.action" && sessionActionOrigin))
                            || suppliedAuthorization.sessionId !== sessionId
                        )
                    )
                ) {
                    recordRpcCallFailure(method, "forbidden");
                    observeRpcCall({
                        method,
                        durationMs: Date.now() - startedAt,
                        result: "error",
                    });
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                const decision = await admitSessionRpc({
                    actorAccountId, credentialAccountId: params.userId,
                    sessionId, rule: sessionAuthorization, authentication: sessionRequestAuthentication,
                    tokenAuthentication: requestAuthentication, viewerPrincipal: viewer?.principal,
                    io: params.io, presence: params.sessionPublisherPresence,
                });
                if (decision.status !== 'allowed') {
                    recordRpcCallFailure(method, "forbidden");
                    observeRpcCall({
                        method,
                        durationMs: Date.now() - startedAt,
                        result: "error",
                    });
                    callback?.(buildSessionAccessRpcRefusal(decision.status));
                    return;
                }
                if (sessionAuthorization.routeToSessionOwnerDaemon) {
                    const session = await db.session.findUnique({
                        where: { id: sessionId },
                        select: { accountId: true },
                    });
                    if (!session) {
                        callback?.(buildForbiddenRpcResponse());
                        return;
                    }
                    // A fresh attached Run resolves provider custody as the Session Account.
                    // Session input grants allow collaboration, but do not delegate that custody.
                    if (sessionAuthorization.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
                        && actorAccountId !== session.accountId) {
                        callback?.(buildForbiddenRpcResponse(undefined, 'rpc.admission.session'));
                        return;
                    }
                    sessionWriteTargetUserId = session.accountId;
                    if (sessionAuthorization.startsAgentWork) {
                        // Retaining a publisher lets its admitted turn finish; a new provider
                        // operation is a new admission under the Session owner's Machine grant.
                        const target = await readCurrentCommittedSessionInputMachineTargetInTx(db, sessionId, { admittedWork: true });
                        if (target?.accountId !== session.accountId || !await hasCurrentSessionScopedMachineAccessInTx({ tx: db,
                            accountId: session.accountId, machineId: target.machineId, sessionId })) {
                            callback?.(buildForbiddenRpcResponse());
                            return;
                        }
                    }
                    if (isRequesterApprovalDecision) {
                        // Requester confirmation spends already-created approval custody. Its exact
                        // Session placement survives a stopped runner, just like queued Session input;
                        // a live publisher remains the compatibility fallback for predecessor rows.
                        const committed = await readCurrentCommittedSessionInputMachineTargetInTx(db, sessionId);
                        const publisherMachineId = committed?.accountId === session.accountId ? null
                            : await resolveCurrentSessionMachineFromServer({ io: params.io,
                                presence: params.sessionPublisherPresence, accountId: session.accountId, sessionId });
                        const machineId = committed?.accountId === session.accountId
                            ? committed.machineId : publisherMachineId;
                        if (!machineId) { callback?.(buildForbiddenRpcResponse()); return; }
                        requesterApprovalMachine = { machineId, sessionId, accountId: session.accountId,
                            routingProof: committed?.accountId === session.accountId
                                ? { kind: 'committed', target: committed }
                                : { kind: 'publisher' } };
                    }
                }
                authorization = sessionAuthorization.serverMintedContext === "session.read"
                    ? { kind: "session.read", sessionId }
                    : sessionAuthorization.serverMintedContext === "session.presentation.origin"
                    ? {
                        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN,
                        sessionId,
                        accountId: actorAccountId,
                        connectionId: params.socket.id,
                    } satisfies SocketRpcCurrentSessionPresentationOriginAuthorizationContext
                    : isPermissionDecisionMethod
                    ? {
                        kind: "session.permission.respond",
                        sessionId,
                        actor: {
                            kind: "accountUser",
                            accountId: actorAccountId,
                            relationship: decision.status === "allowed" && decision.access.level === "owner"
                                ? "owner"
                                : "sharedApprover",
                        },
                        ...(requesterDecisionAuthentication ? { authentication: requesterDecisionAuthentication } : {}),
                    }
                    : { kind: "session.write", sessionId,
                        // Native input admission needs an owner proof. Only the
                        // canonical owner-classified operation can mint it here.
                        ...(sessionAuthorization.method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START
                            && sessionAuthorization.authority === "sessionOwner"
                            ? { authority: "sessionOwner" as const } : {}),
                    };
            }
            const ephemeralRunnerMachineRequest = transferRouting ? null : readEphemeralRunnerMachineRpcRequest(method);
            if (ephemeralRunnerMachineRequest && sessionWriteTargetUserId === null) {
                const runnerBinding = await readMaterializedRunnerMachineRoutingBinding(
                    ephemeralRunnerMachineRequest.machineId,
                );
                if (runnerBinding) {
                    sessionWriteTargetUserId = runnerBinding.accountId;
                    authorization = {
                        kind: "session.write",
                        sessionId: runnerBinding.sessionId,
                    };
                }
            }
            let machineAdmissionGuard: RpcForwardTargetGuard | null = null;
            if (sessionBrowserAuthorization) machineAdmissionGuard = createCurrentMachineAdmissionTargetGuard(sessionBrowserAuthorization);
            // This prefix carries the existing registration and encryption key;
            // an App-to-App call does not execute work on that Machine.
            const machinePrefix = appClientContinuation ? null : readMachineIdPrefix(method);
            let structuredMessageRouting: StructuredMessageActionRoutingV1 | undefined;
            const machineRpcMethod = machinePrefix ? method.slice(method.indexOf(':') + 1) : null;
            if (machinePrefix && (machineRpcMethod === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
                || machineRpcMethod === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)) {
                const supplied = (data as { structuredMessageRouting?: unknown }).structuredMessageRouting;
                const parsed = supplied === undefined ? null : StructuredMessageActionRoutingV1Schema.safeParse(supplied);
                if (parsed && !parsed.success) { callback?.(buildForbiddenRpcResponse()); return; }
                const projected = typeof callParams === 'string' ? null
                    : readStructuredMessageActionRoutingV1(machineRpcMethod, callParams);
                // The encrypted body remains opaque. Its receiver binds these admitted
                // selectors to the opened invocation before any handler can run.
                structuredMessageRouting = (typeof callParams === 'string'
                    ? parsed?.success ? parsed.data : null : projected) ?? undefined;
                // Raw Machine Actions enter through action.invoke's Manage policy.
                // Ordinary Resource watches have no structured Action selectors.
                if (machineRpcMethod === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE && !structuredMessageRouting
                    || structuredMessageRouting && structuredMessageRouting.machineId !== machinePrefix) {
                    callback?.(buildForbiddenRpcResponse()); return;
                }
                for (const sessionId of structuredMessageRouting?.sessionIds ?? []) {
                    if ((await resolveSessionAccessForOperation(db, {
                        accountId: actorAccountId, sessionId,
                        authentication: requestAuthentication, capability: 'submitAgentInput',
                    })).status !== 'allowed') {
                        callback?.(buildForbiddenRpcResponse()); return;
                    }
                }
            }
            const signedHandoff = verifiedExternalAction?.binding.handoffAdmission;
            const isHandoffCurrent = machinePrefix && signedHandoff && verifiedExternalAction
                && verifiedExternalAction.binding.machineId === machinePrefix
                && resolveMachineRpcExternalActionEffectV1(method.slice(machinePrefix.length + 1), verifiedExternalAction.binding)
                    === verifiedExternalAction.effectActionId
                ? async () => Boolean(await readAdmittedExternalActionHandoffMachineInTx(db, verifiedExternalAction.binding)) : undefined;
            if (isHandoffCurrent && !await isHandoffCurrent()) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            let finiteWake: Awaited<ReturnType<typeof prepareManagedFiniteActionWake>> | undefined;
            if (machinePrefix && verifiedExternalAction && externalActionExecution?.success
                && isExternalActionManagedWakeRootV1(verifiedExternalAction.binding)) {
                // Only the already verified original Action can prepare its stopped guest.
                // Account CALL credentials alone never mint finite wake authority.
                if (!cancellation) { callback?.(buildForbiddenRpcResponse()); return; }
                const originalAuthorization = externalActionExecution.data.authorization;
                finiteWake = await prepareManagedFiniteActionWake({ io: params.io, signal: cancellation.controller.signal,
                    actionOrigin: originalAuthorization,
                    isOriginalSourceCurrent: () => hasCurrentExternalActionSessionSource(originalAuthorization.binding,
                        input => resolveCurrentSessionMachineFromServer({ io: params.io, presence: params.sessionPublisherPresence, ...input })) });
                if (finiteWake.kind === 'submitted-unknown') {
                    callback?.({ ok: false, error: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
                    return;
                }
                if (finiteWake.kind === 'unavailable') {
                    callback?.({ ...buildForbiddenRpcResponse(), ...(finiteWake.reason === undefined ? {} : {
                        failureCause: { phase: 'machines.managed.wake', errorClass: 'Error', errorCode: 'target_unavailable',
                            nativeErrorReason: finiteWake.reason, httpStatus: null },
                    }) });
                    return;
                }
            }
            let mintSeedCarrier: (() => ReturnType<typeof mintWorkspaceSyncSeedCarrier>) | undefined;
            if (workspaceSyncSeedRouting) {
                if (!seedAdmission || !verifiedSeedSender) { callback?.(buildForbiddenRpcResponse()); return; }
                const admitted = seedAdmission;
                machineAdmission = admitted.sourceMachineAdmission;
                receivingMachineAdmission = admitted.receivingMachineAdmission;
                if (admitted.carrierPublicKey) mintSeedCarrier = () => mintWorkspaceSyncSeedCarrier(admitted);
                sessionWriteTargetUserId = admitted.writer.custodianAccountId;
                const matches = (target: SocketDataCarrier) => readMachineScopedSocketMachineId(target) === admitted.writer.machineId
                    && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(target)) === admitted.writer.installationId;
                machineAdmissionGuard = { filterTargets: async targets => targets.filter(matches),
                    runOperation: async ({ target, readLatestTarget, operation }) => {
                        const latest = await readLatestTarget();
                        if (!latest || !matches(target) || !matches(latest)) {
                            return { status: 'refused', response: buildForbiddenRpcResponse() };
                        }
                        return { status: 'current', value: await operation() };
                    } };
            } else if (isProjectSource && workspaceSyncSourceRouting && projectSourceExecution?.success && machinePrefix) {
                const routing = workspaceSyncSourceRouting;
                const packet = projectSourceExecution.data;
                const readCurrent = async () => {
                    const socketData = readSocketData(params.socket);
                    const root = packet.externalActionExecution.authorization.binding;
                    // Pairing gives installed daemons terminal credentials. That
                    // credential proves transport custody; the signed root and
                    // SOURCE verifier below authorize this exact Project effect.
                    if (params.socket.connected !== true || (socketData.authTokenKind !== 'account' && socketData.authTokenKind !== 'terminal')
                        || socketData.ephemeralRunnerAdmission != null || socketData.apiTokenPrincipal != null
                        || params.userId !== root.custodianAccountId || !await hasCurrentSocketCredential(params.userId, params.socket)
                        || readMachineScopedSocketMachineId(params.socket) !== root.machineId
                        || readVerifiedMachineSocketInstallationIdFromSocketData(socketData) !== root.installationId) return null;
                    return verifyWorkspaceSyncProjectSourceAuthorization(packet.externalActionExecution.authorization, routing, packet,
                        input => resolveCurrentSessionMachineFromServer({ io: params.io, presence: params.sessionPublisherPresence, ...input }));
                };
                const admitted = await readCurrent();
                if (!admitted || !routing.sourceContext) { callback?.(buildForbiddenRpcResponse()); return; }
                machineAdmission = routing.sourceContext.machineAdmission;
                receivingMachineAdmission = await resolveReceivingMachineRpcAdmission({
                    actorAccountId: admitted.verified.binding.accountId, rpcMethod: method.slice(method.indexOf(':') + 1),
                    receiver: { machineId: admitted.route.parentMachineId, installationId: admitted.route.parentInstallationId },
                    admitted: admitted.receivingMachineAdmission });
                sessionWriteTargetUserId = admitted.route.custodianAccountId;
                const matches = (target: SocketDataCarrier) => readMachineScopedSocketMachineId(target) === admitted.route.parentMachineId
                    && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(target)) === admitted.route.parentInstallationId;
                machineAdmissionGuard = { filterTargets: async targets => targets.filter(matches),
                    runOperation: async ({ target, readLatestTarget, operation }) => {
                        const latest = await readLatestTarget();
                        if (!latest || !matches(target) || !matches(latest)) {
                            return { status: 'refused', response: buildForbiddenRpcResponse() };
                        }
                        return { status: 'current', value: await operation() };
                    } };
            } else if (workspaceSyncSourceWriterTargetRouting && machinePrefix) {
                const routing = workspaceSyncSourceWriterTargetRouting;
                const cleanup = isWorkspaceSyncSourceWriterCleanupPhaseV1(routing.target.phase);
                const readCurrent = async () => {
                    const socketData = readSocketData(params.socket);
                    const sender = workspaceSyncTargetRouting?.targetContext.machineAdmission ?? routing.sourceWriter;
                    if (routing.source.accountServerId !== await getOrCreateServerIdentityId()
                        || params.socket.connected !== true
                        || (socketData.authTokenKind !== 'account' && socketData.authTokenKind !== 'terminal')
                        || socketData.ephemeralRunnerAdmission != null || socketData.apiTokenPrincipal != null
                        || !await hasCurrentSocketCredential(params.userId, params.socket)
                        || readMachineScopedSocketMachineId(params.socket) !== sender.machineId
                        || readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket)) !== sender.installationId) return null;
                    const writer = await resolveMachineAdmission({ actorAccountId: params.userId,
                        machineId: sender.machineId, requiredRole: 'manage' });
                    if (writer.kind !== 'admitted' || writer.custodianAccountId !== params.userId
                        || writer.actorAccountId !== params.userId || writer.installationId !== sender.installationId) return null;
                    if (cleanup) {
                        if (sessionActionOrigin || (externalActionExecution
                            ? !externalActionExecution.success || !verifiedExternalAction
                            : routing.target.phase === 'remove')) return null;
                        const receiver = await db.machine.findUnique({ where: { id: machinePrefix } }).then(decodeMachineStoredContent);
                        if (!receiver?.installationId || classifyMachineAvailabilityState(receiver) !== 'available') return null;
                        const { kind: _kind, ...context } = writer;
                        return { context, receiverId: receiver.id, receiverInstallationId: receiver.installationId, accountId: receiver.accountId };
                    }
                    if (!externalActionExecution?.success || !verifiedExternalAction) return null;
                    const current = await readCurrentWorkspaceSyncHandoffWriterTarget(externalActionExecution.data.authorization, routing,
                        input => resolveCurrentSessionMachineFromServer({ io: params.io, presence: params.sessionPublisherPresence, ...input }),
                        workspaceSyncTargetRouting ? { routing: workspaceSyncTargetRouting, machineId: machinePrefix } : undefined,
                        retainedProjectSourceExecution);
                    if (!current) return null;
                    if (workspaceSyncTargetRouting) {
                        if (current.target.machineId !== writer.machineId || current.target.installationId !== writer.installationId
                            || !current.targetRoute || machinePrefix !== current.targetRoute.parentMachineId) return null;
                        const { kind: _kind, ...context } = current.target;
                        return { context, receiverId: current.targetRoute.parentMachineId,
                            receiverInstallationId: current.targetRoute.parentInstallationId, accountId: current.targetRoute.custodianAccountId };
                    }
                    if (current.writer.machineId !== writer.machineId || current.writer.installationId !== writer.installationId
                        || machinePrefix !== current.target.machineId) return null;
                    const { kind: _kind, ...context } = current.target;
                    return { context, receiverId: context.machineId, receiverInstallationId: context.installationId,
                        accountId: context.custodianAccountId };
                };
                const admitted = await readCurrent();
                if (!admitted) { callback?.(buildForbiddenRpcResponse()); return; }
                machineAdmission = admitted.context;
                sessionWriteTargetUserId = admitted.accountId;
                const matches = (target: SocketDataCarrier) => readMachineScopedSocketMachineId(target) === admitted.receiverId
                    && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(target)) === admitted.receiverInstallationId;
                machineAdmissionGuard = { filterTargets: async targets => targets.filter(matches),
                    runOperation: async ({ target, readLatestTarget, operation }) => {
                        const latest = await readLatestTarget();
                        if (!latest || !matches(target) || !matches(latest)) {
                            return { status: 'refused', response: buildForbiddenRpcResponse() };
                        }
                        return { status: 'current', value: await operation() };
                    } };
            } else if (workspaceSyncRouting && machinePrefix) {
                if (verifiedExternalAction) {
                    const binding = verifiedExternalAction.binding;
                    const claimed = workspaceSyncContext?.machineAdmission;
                    const childMachineId = workspaceSyncSourceRouting?.sourceMachineId
                        ?? workspaceSyncTargetRouting?.targetMachineId;
                    // Installed child custody proves routing, not new requester
                    // authority. A supplied Home root is the single origin owner,
                    // including the absence of Session authority on a PAT root.
                    if (!workspaceSyncContext || !claimed
                        || childMachineId !== binding.machineId
                        || workspaceSyncRouting.accountServerId !== binding.serverIdentityId
                        || claimed.machineId !== binding.machineId || claimed.installationId !== binding.installationId
                        || claimed.actorAccountId !== binding.accountId || claimed.custodianAccountId !== binding.custodianAccountId
                        || workspaceSyncContext.callerAuthority !== verifiedExternalAction.effectiveAuthority
                        || !isDeepStrictEqual(workspaceSyncContext.sessionActionOrigin, binding.sessionActionOrigin)
                        || ('grant' in binding && !isDeepStrictEqual(workspaceSyncContext.callerInputConstraints, {
                            models: binding.grant.models, permissionModes: binding.grant.permissionModes,
                        }))
                        || workspaceSyncSourceRouting && binding.handoffAdmission
                            && workspaceSyncSourceRouting.sourceSessionId !== binding.handoffAdmission.sessionId) {
                        callback?.(buildForbiddenRpcResponse());
                        return;
                    }
                }
                const source = { accountId: params.userId, socket: params.socket, io: params.io,
                    presence: params.sessionPublisherPresence, routing: workspaceSyncRouting, parentMachineId: machinePrefix,
                    ...(verifiedExternalAction?.binding.handoffAdmission ? { admittedHandoff: verifiedExternalAction.binding } : {}),
                    operationRpcMethod: method.slice(method.indexOf(':') + 1) };
                const admitted = await resolveWorkspaceSyncChildAdmission(source);
                if (!admitted) {
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                machineAdmission = admitted.context;
                sessionWriteTargetUserId = admitted.route.custodianAccountId;
                const claimedOrigin = workspaceSyncContext?.sessionActionOrigin;
                if (claimedOrigin) {
                    if (sessionActionOrigin && !isDeepStrictEqual(sessionActionOrigin, claimedOrigin)) {
                        callback?.(buildForbiddenRpcResponse());
                        return;
                    }
                    sessionActionOrigin = claimedOrigin;
                }
                const matches = (target: SocketDataCarrier) => readMachineScopedSocketMachineId(target) === admitted.route.parentMachineId
                    && readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(target)) === admitted.route.parentInstallationId;
                machineAdmissionGuard = {
                    filterTargets: async targets => targets.filter(matches),
                    runOperation: async ({ target, readLatestTarget, operation }) => {
                        const latest = await readLatestTarget();
                        if (!matches(target) || !latest || !matches(latest)) {
                            return { status: 'refused', response: buildForbiddenRpcResponse() };
                        }
                        return { status: 'current', value: await operation() };
                    },
                };
            } else if ((deploymentChild || deploymentArchiveChild && verifiedArchiveSender)
                && verifiedExternalAction?.deploymentChildCodecAdmission && machinePrefix) {
                const codecAdmission = verifiedExternalAction.deploymentChildCodecAdmission;
                if (codecAdmission.machineId !== machinePrefix) { callback?.(buildForbiddenRpcResponse()); return; }
                machineAdmission = { ...codecAdmission, actorAccountId, role: 'use' };
                machineAdmissionGuard = createCurrentMachineAdmissionTargetGuard(codecAdmission);
            } else if (verifiedExternalAction?.sessionAgentReadinessAdmission && machinePrefix) {
                const { kind: _kind, ...admitted } = verifiedExternalAction.sessionAgentReadinessAdmission;
                if (admitted.machineId !== machinePrefix) { callback?.(buildForbiddenRpcResponse()); return; }
                machineAdmission = admitted;
                machineAdmissionGuard = createCurrentMachineAdmissionTargetGuard(admitted);
            } else if (machinePrefix && sessionWriteTargetUserId === null && !sourceKeyPreparationTargetGuard) {
                const machine = detachedMachine ?? await readMachineAdmissionFactsInTx(db, { actorAccountId, machineId: machinePrefix });
                const rpcMethod = method.slice(method.indexOf(':') + 1);
                const requester: MachineOperationRequesterContext = { callerAuthority: requestAuthentication.authority,
                    sessionActionOrigin, ...(verifiedExternalAction ? { executionBinding: verifiedExternalAction.binding } : {}) };
                if (machine && !machine.installationId && machine.accountId === actorAccountId
                    && !isMachineOperationSupportedForRequester({ actorAccountId, rpcMethod, ...requester,
                        machine: { ...machine,
                            operationProtocolCapabilities: 'operationProtocolCapabilities' in machine ? machine.operationProtocolCapabilities : undefined,
                            operationProtocolCapabilitiesRevision: 'operationProtocolCapabilitiesRevision' in machine ? machine.operationProtocolCapabilitiesRevision : undefined } })) {
                    callback?.(buildForbiddenRpcResponse()); return;
                }
                if (detachedMachine || (machine && machine.kind !== 'ephemeral_session_runner'
                    // Retained owned rows without an installation keep the predecessor carrier.
                    // Foreign routing never uses this legacy seam.
                    && (machine.installationId || machine.accountId !== actorAccountId))) {
                    // Reviewed composite effects use their already verified root;
                    // raw method policy must not reinterpret that proof as a new grant.
                    const requiredRole = isHandoffCurrent || moveChildExecution && !deploymentArchiveChild ? 'use' as const : undefined;
                    // Client-supplied plugin bindings are raw Machine Action claims.
                    // Reuse the Action ingress policy in this same admission decision.
                    const actionPolicy = structuredMessageRouting?.invocationKind === 'mountedPluginSurface'
                        || structuredMessageRouting?.invocationKind === 'clientPluginAction' ? 'action.invoke' : undefined;
                    // Passive status and retained operation controls do not wake a Machine.
                    // Authority is admitted independently of persisted presence; the
                    // existing forwarder still requires the live exact installation.
                    const requireOnline = rpcMethod !== 'projects.worker.status'
                        && !isRetainedMachineOperationRequest({ rpcMethod });
                    const managedTarget = rpcMethod === MANAGED_ACTIVITY_READ_RPC_METHOD ? ManagedActivityReadRequestV1Schema.safeParse(callParams)
                        : rpcMethod === MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD ? ManagedAdmissionDrainConfirmRequestV1Schema.safeParse(callParams) : null;
                    const readScopedAdmission = isHandoffCurrent && verifiedExternalAction
                        ? () => readAdmittedExternalActionHandoffMachineInTx(db, verifiedExternalAction.binding)
                        : managedTarget?.success ? () => inReadSnapshot(tx => resolveManagedGuestActivityAdmissionInTx(tx, {
                        actorAccountId, machineId: machinePrefix, rpcMethod, target: managedTarget.data, requireOnline,
                    })) : undefined;
                    const scopedAdmission = await readScopedAdmission?.();
                    const admitted = isHandoffCurrent ? scopedAdmission : scopedAdmission ?? await resolveMachineAdmissionFromFactsInTx(db, machine, { actorAccountId,
                        machineId: machinePrefix,
                        operationRpcMethod: rpcMethod, ...requester,
                        ...(requiredRole ? { requiredRole } : actionPolicy ? { actionId: actionPolicy } : { rpcMethod }),
                        requireOnline: finiteWake?.kind === 'ready' ? false : requireOnline });
                    if (!admitted || admitted.kind !== 'admitted') {
                        logDeploymentChildRefusal('machine_admission');
                        callback?.(buildForbiddenRpcResponse(admitted?.kind === 'denied' ? admitted.code : undefined));
                        return;
                    }
                    const { kind: _kind, ...context } = admitted;
                    machineAdmission = context;
                    machineAdmissionGuard = createCurrentMachineAdmissionTargetGuard(context,
                        reverseClientContinuation ? params.socket : undefined);
                }
            }
            if (deploymentReferenceServices && (machineAdmission?.machineId !== deploymentReferenceServices.machineId
                || machineAdmission.installationId !== deploymentReferenceServices.installationId)) {
                callback?.(buildForbiddenRpcResponse());
                return;
            }
            if (machineAdmission && structuredMessageRouting) machineAdmission = { ...machineAdmission, structuredMessageRouting };
            const targetUserId = sessionWriteTargetUserId ?? machineAdmission?.custodianAccountId ?? actorAccountId;
            const admittedMethod = method;
            const callerInputActionId = methodSessionAuthorization?.method === SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND
                || methodSessionAuthorization?.method === RPC_METHODS.SESSION_USER_ACTION_ANSWER
                ? methodSessionAuthorization.actionId : undefined;
            const callerInputViewer = viewer && callerInputActionId ? viewer : null;

            const explicitMachineStopRequest = readExplicitMachineStopRequest(method, authorization);
            if (method.endsWith(`:${RPC_METHODS.STOP_SESSION}`) && !explicitMachineStopRequest) {
                callback?.({
                    ok: false,
                    error: "Invalid parameters: sessionId is required",
                });
                return;
            }

            let explicitMachineStopCapture: CaptureExplicitMachineStopResult | null = null;
            if (explicitMachineStopRequest) {
                const presence = params.sessionPublisherPresence;
                if (!presence) {
                    callback?.({
                        ok: false,
                        error: "Server explicit stop lifecycle owner unavailable",
                    });
                    return;
                }
                explicitMachineStopCapture = await presence.captureExplicitMachineStop({
                    binding: {
                        // Stop admission above proves the actor is the Session
                        // owner; targetUserId is only the Machine custodian route.
                        accountId: actorAccountId,
                        machineId: explicitMachineStopRequest.machineId,
                        sessionId: explicitMachineStopRequest.sessionId,
                    },
                });
                if (explicitMachineStopCapture.status === "rejected") {
                    callback?.(explicitMachineStopCapture.reason === "machine_control_unavailable"
                        ? {
                            ok: false,
                            error: RPC_ERROR_MESSAGES.SESSION_MACHINE_CONTROL_UNAVAILABLE,
                            errorCode: RPC_ERROR_CODES.SESSION_MACHINE_CONTROL_UNAVAILABLE,
                        }
                        : {
                            ok: false,
                            error: "Session stop target unavailable",
                        });
                    return;
                }
            }

            const protectedRawSession = createProtectedRawSessionTargetGuard({ method, actorAccountId, targetUserId,
                callerSocket: params.socket, callerAuthority: requestAuthentication.authority,
                knownSessionSource: sessionActionOrigin !== undefined,
                ...(transferRouting ? { transferRouting } : {}),
                ...(viewer && transferRouting ? { sessionTransferViewer: viewer } : {}) });
            const isTransitionRoot = verifiedExternalAction?.binding.actionId === 'session.agent.transition';
            const transitionSessionTarget = isTransitionRoot && methodSessionAuthorization?.routeToSessionOwnerDaemon
                && verifiedExternalAction.target.kind === 'session' ? verifiedExternalAction.target : null;
            const signedSessionTarget = verifiedExternalAction?.sessionRpcTarget
                ?? (transitionSessionTarget ? { sessionId: transitionSessionTarget.sessionId,
                    machineId: verifiedExternalAction!.binding.machineId } : null);
            const decisionMachine = requesterApprovalMachine;
            const targetSpecificGuard = explicitMachineStopRequest
                ? createExactMachineRpcTargetGuard(explicitMachineStopRequest)
                : requesterApprovalMachine
                    ? createExactMachineRpcTargetGuard(requesterApprovalMachine)
                : sourceKeyPreparationTargetGuard
                    ? sourceKeyPreparationTargetGuard
                    : ephemeralRunnerMachineRequest
                        ? createEphemeralRunnerMachineRpcTargetGuard({
                            accountId: actorAccountId,
                            targetAccountId: targetUserId,
                            machineId: ephemeralRunnerMachineRequest.machineId,
                            authority: ephemeralRunnerMachineRequest.authority,
                            authentication: requestAuthentication,
                            protectedSessionTarget: protectedRawSession !== null,
                        })
                        : createCurrentSessionPublisherTargetGuard({
                            method,
                            targetUserId,
                            presence: params.sessionPublisherPresence,
                            ...(callerInputViewer ? { sessionId: callerInputViewer.sessionId } : {}),
                            ...(signedSessionTarget ?? {}),
                        });
            const finiteWakeCurrent = finiteWake && (finiteWake.kind === 'ready' || finiteWake.kind === 'not-needed')
                ? finiteWake.isCurrent : undefined;
            const targetGuard = composeRpcForwardTargetGuards([
                targetSpecificGuard,
                protectedRawSession?.targetGuard ?? null,
                sessionActionSourceGuard,
                machineAdmissionGuard,
                ...(decisionMachine ? [{
                    filterTargets: async targets => targets,
                    runOperation: async ({ operation }) => (decisionMachine.routingProof.kind === 'committed'
                        ? await isCurrentSessionInputMachineTargetInTx(db, decisionMachine.routingProof.target)
                        : await resolveCurrentSessionMachineFromServer({ io: params.io,
                            presence: params.sessionPublisherPresence, accountId: decisionMachine.accountId,
                            sessionId: decisionMachine.sessionId }) === decisionMachine.machineId)
                        ? { status: 'current' as const, value: await operation() }
                        : { status: 'refused' as const, response: buildForbiddenRpcResponse() },
                } satisfies RpcForwardTargetGuard] : []),
                ...(reverseAutomationSeparator > 0 && isWorkflowDraftClientRpcMethod(method.slice(reverseAutomationSeparator + 1)) ? [{
                    // A mounted draft must have one answering client. Exclude
                    // the caller exactly as the canonical target selector does.
                    filterTargets: async targets => {
                        const candidates = targets.filter(target => target.id !== params.socket.id);
                        return candidates.length === 1 ? candidates : [];
                    },
                    runOperation: async ({ operation }) => ({ status: 'current' as const, value: await operation() }),
                } satisfies RpcForwardTargetGuard] : []),
                ...(finiteWakeCurrent ? [{
                    filterTargets: async targets => await finiteWakeCurrent() ? targets : [],
                    runOperation: async ({ operation }) => await finiteWakeCurrent()
                        ? { status: 'current' as const, value: await operation() }
                        : { status: 'refused' as const, response: buildForbiddenRpcResponse() },
                } satisfies RpcForwardTargetGuard] : []),
                liveApprovalOrigin ? createLiveApprovalOriginTargetGuard({ userId: params.userId, socket: params.socket }) : null,
            ]);
            const verifiedCallerGrant = verifiedExternalAction && 'grant' in verifiedExternalAction.binding
                ? verifiedExternalAction.binding.grant : viewer?.principal.grant;
            forwardStartedAt = Date.now();
            targetTraceId = diagnosticOnly ? `rpc_${randomUUID()}` : cancellation?.targetRequestId;
            if (callerTraceId) log({ module: 'websocket-rpc', event: 'rpc-call-admitted',
                requestId: callerTraceId, targetRequestId: targetTraceId,
                callerSocketId: params.socket.id, method,
                durationMs: forwardStartedAt - startedAt,
            }, 'RPC call admitted to target lookup');
            const forwarded = await forwardRpcCall({
                io: params.io,
                targetUserId,
                method,
                ...(diagnosticOnly && targetTraceId ? { traceId: targetTraceId } : {}),
                callParams,
                ...((data as { continuation?: unknown })?.continuation === true && callerRequestId
                    ? { continuationReturn: { socketId: params.socket.id, requestId: callerRequestId } } : {}),
                ...(sessionAuthorization?.routeToSessionOwnerDaemon && !requesterApprovalMachine ? {
                    isTargetUnavailable: async () => !await resolveCurrentSessionMachineFromServer({
                        io: params.io, presence: params.sessionPublisherPresence, accountId: targetUserId,
                        sessionId: admittedMethod.slice(0, admittedMethod.lastIndexOf(':')),
                    }),
                } : {}),
                ...(requesterApprovalMachine ? {
                    sessionDecisionTargetMethod: `${requesterApprovalMachine.machineId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
                } : {}),
                timeoutMs,
                ...(finiteWake?.kind === 'ready' && cancellation
                    ? { callerLifetime: { signal: cancellation.controller.signal, isCurrent: finiteWake.isCurrent } } : {}),
                authorization,
                ...(machineAdmission ? { machineAdmission } : {}),
                ...(receivingMachineAdmission ? { receivingMachineAdmission } : {}),
                ...(protectedRawSession ? { createMachineAdmission: protectedRawSession.createMachineAdmission } : {}),
                ...(transferRouting ? { transferRouting } : {}),
                ...(workspaceSyncSourceRouting ? { workspaceSyncSourceRouting } : {}),
                ...(workspaceSyncTargetRouting ? { workspaceSyncTargetRouting } : {}),
                ...(workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting } : {}),
                ...(projectSourceExecution?.success ? { workspaceSyncSourceExecution: projectSourceExecution.data } : {}),
                ...(retainedProjectSourceExecution ? { workspaceSyncSourceExecution: retainedProjectSourceExecution } : {}),
                ...(moveChildExecution ? { workspaceSyncSourceExecution: moveChildExecution } : {}),
                ...(workspaceSyncSeedRouting ? { workspaceSyncSeedRouting: {
                    v: workspaceSyncSeedRouting.v, sourceWriterTarget: workspaceSyncSeedRouting.sourceWriterTarget,
                    target: workspaceSyncSeedRouting.target,
                } } : {}),
                ...(originalActionEnvelope ? { originalActionEnvelope } : {}),
                ...(workspaceSyncContext ? {
                    callerAuthority: sessionActionOrigin ? 'account_automation' as const : workspaceSyncContext.callerAuthority,
                } : verifiedExternalAction
                    ? { callerAuthority: requestAuthentication.authority } : {}),
                ...(liveApprovalOrigin ? { callerAuthority: 'present_user' as const } : {}),
                ...(appClientContinuation ? { callerAuthority: requestAuthentication.authority, allowCallerTarget: true } : {}),
                ...(sessionBrowserAuthorization ? { callerAuthority: requestAuthentication.authority } : {}),
                ...(explicitMachineStopRequest
                    ? { transportResponseEnvelopeVersion: 1 as const }
                    : {}),
                callerSocketId: params.socket.id,
                ...(liveApprovalOrigin ? { answeringClient: { requireSingle: true } } : answeringClient ? { answeringClient } : {}),
                callerSocket: params.socket,
                ...(sessionActionOrigin ? { sessionActionOrigin } : {}),
                ...(verifiedExternalAction && externalActionExecution?.success && !deploymentReferenceServices
                    ? { createCallerInputAuthorization: async () => externalActionExecution.data.authorization }
                    : {}),
                ...(callerInputViewer && callerInputActionId ? { createCallerInputAuthorization: async ({ target, requestId }) => {
                    const projection = readSessionPublisherAuthorityProjection(target.data);
                    if (!projection || projection.accountId !== targetUserId || projection.sessionId !== callerInputViewer.sessionId) {
                        throw new Error('Current Session publisher identity is unavailable');
                    }
                    const sessionTarget = { kind: 'session' as const, sessionId: callerInputViewer.sessionId };
                    const principal = callerInputViewer.principal;
                    return await auth.mintExternalActionExecutionAuthorization({
                        serverIdentityId: await getOrCreateServerIdentityId(),
                        accountId: principal.accountId, principalId: principal.principalId,
                        credentialId: principal.credentialId, grant: principal.grant,
                        machineId: projection.machineId, actionId: callerInputActionId, requestId,
                        requestEnvelopeDigest: computeExternalActionSocketRpcRequestDigestV1({
                            method: admittedMethod, params: callParams, requestId, target: sessionTarget,
                        }),
                        target: sessionTarget,
                    });
                } } : {}),
                ...(workspaceSyncContext?.callerInputConstraints
                    ? { callerInputConstraints: workspaceSyncContext.callerInputConstraints }
                    : verifiedCallerGrant
                    ? { callerInputConstraints: {
                        models: verifiedCallerGrant.models,
                        permissionModes: verifiedCallerGrant.permissionModes,
                    } }
                    : {}),
                ...(targetGuard ? { targetGuard } : {}),
                ...(cancellation
                    ? {
                        cancellation: {
                            targetRequestId: cancellation.targetRequestId,
                            signal: cancellation.controller.signal,
                            ...(cancellation.ackController ? { ackSignal: cancellation.ackController.signal } : {}),
                            onTargetSelected: (target) => {
                                cancellation!.targetSocketId = target.id;
                                if ((data as { continuation?: unknown })?.continuation === true) params.socket.emit(SOCKET_RPC_EVENTS.CONTINUATION,
                                    { requestId: callerRequestId, selectedSocketId: target.id });
                            },
                        },
                    }
                    : {}),
            });
            forwardCompletedAt = Date.now();
            const unscopedMethod = method.slice(method.lastIndexOf(":") + 1);
            const presentationClientId = callParams && typeof callParams === "object" && !Array.isArray(callParams)
                ? (callParams as { clientId?: unknown }).clientId
                : null;
            if (
                forwarded.ok
                && unscopedMethod === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD
                && typeof presentationClientId === "string"
                && forwarded.result
                && typeof forwarded.result === "object"
                && (forwarded.result as { status?: unknown }).status === "bound"
                && authorization?.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN
            ) {
                const binding = {
                    ownerAccountId: targetUserId,
                    clientId: presentationClientId,
                };
                if (disconnected) {
                    await retirePresentationBinding(authorization.sessionId, binding);
                } else {
                    activePresentationBindings.set(authorization.sessionId, binding);
                }
            } else if (
                forwarded.ok
                && unscopedMethod === CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD
                && typeof presentationClientId === "string"
                && authorization?.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN
                && activePresentationBindings.get(authorization.sessionId)?.clientId === presentationClientId
            ) {
                activePresentationBindings.delete(authorization.sessionId);
            }
            if (
                explicitMachineStopRequest
                && explicitMachineStopCapture?.status === "captured"
                && forwarded.ok
            ) {
                const didProveStopped = (
                    forwarded.transportAcknowledgement?.kind === "session.stop"
                    && forwarded.transportAcknowledgement.status === "stopped"
                );
                if (didProveStopped) {
                    const presence = params.sessionPublisherPresence;
                    if (!presence) {
                        callback?.({
                            ok: false,
                            error: "Server explicit stop lifecycle owner unavailable",
                        });
                        return;
                    }
                    const closed = await presence.finalizeExplicitMachineStop({
                        target: explicitMachineStopCapture.target,
                    });
                    if (closed.status === "closed") {
                        await publishSessionPublisherClose({
                            sessionId: explicitMachineStopRequest.sessionId,
                            publisherAccountId: explicitMachineStopCapture.target.binding.accountId,
                            closed,
                        });
                    } else if (closed.status !== "already_inactive") {
                        callback?.({
                            ok: false,
                            error: closed.status === "superseded"
                                ? "Session resumed while stop was in progress"
                                : "Session stop could not be finalized safely",
                        });
                        return;
                    }
                }
            }
            const workspaceSyncSeedCarrier = forwarded.ok ? await mintSeedCarrier?.() : undefined;
            callback?.(forwarded.ok && ("transportAcknowledgement" in forwarded || workspaceSyncSeedCarrier)
                ? { ok: true, result: forwarded.result, ...(workspaceSyncSeedCarrier ? { workspaceSyncSeedCarrier } : {}) }
                : forwarded);
        } catch (error) {
            if (method) {
                recordRpcCallFailure(method, "internal_error");
                observeRpcCall({
                    method,
                    durationMs: Date.now() - startedAt,
                    result: "error",
                });
            }
            const forwardedCause = ActionFailureCauseV1Schema.safeParse(
                error && typeof error === 'object' && 'failureCause' in error ? error.failureCause : undefined,
            );
            // The relay can certify that a failed admission never dispatched.
            const databaseErrorCode = forwardStartedAt === undefined && !forwardedCause.success
                ? readDatabaseErrorCode(error) : null;
            if (databaseErrorCode) {
                callback?.({
                    ok: false, error: databaseErrorCode, errorCode: databaseErrorCode, effectAttempted: false,
                    failureCause: { ...projectActionFailureCauseV1(error, 'rpc.admission'), errorCode: databaseErrorCode, httpStatus: 503 },
                });
                return;
            }
            callback?.({
                ok: false,
                error: redactBugReportSensitiveText(error instanceof Error ? error.message : "Internal error"),
                failureCause: forwardedCause.success ? forwardedCause.data : projectActionFailureCauseV1(error, 'rpc.relay'),
            });
        } finally {
            if (callerTraceId || completionDiagnostic.failure) {
                const machineCall = method && (machineAdmission || parseMachineScopedRpcMethod(method));
                log({ module: "websocket-rpc", event: machineCall ? "machine-rpc-relay-completed" : "rpc-call-completed",
                    method, ...completionDiagnostic.failure, requestId: callerTraceId ?? randomUUID(), targetRequestId: targetTraceId ?? cancellation?.targetRequestId,
                    callerSocketId: params.socket.id, callerConnected: params.socket.connected === true,
                    targetSocketId: cancellation?.targetSocketId,
                    durationMs: Date.now() - startedAt,
                    admissionMs: (forwardStartedAt ?? Date.now()) - startedAt,
                    relayMs: forwardStartedAt === undefined ? null : (forwardCompletedAt ?? Date.now()) - forwardStartedAt,
                }, machineCall ? "Machine RPC relay completed" : "RPC call completed");
            }
            if (
                callerRequestId
                && cancellation
                && activeCancellations.get(callerRequestId) === cancellation
            ) {
                activeCancellations.delete(callerRequestId);
            }
        }
    });

    params.socket.on("disconnect", async () => {
        disconnected = true;
        transferRelayLifecycle.disconnectSocket(params.socket.id);
        for (const active of activeCancellations.values()) {
            cancelActiveSocketRpcCall({ io: params.io, active, retireAck: true });
        }
        activeCancellations.clear();
        const presentationBindings = [...activePresentationBindings.entries()];
        activePresentationBindings.clear();
        for (const [sessionId, binding] of presentationBindings) {
            await retirePresentationBinding(sessionId, binding);
        }
        const methods = [...ownedMethods];
        ownedMethods.clear();
        writeSocketRegisteredRpcMethods(params.socket, ownedMethods);
        for (const method of methods) {
            recordRpcUnregistration(method);
            await Promise.resolve(params.socket.leave(buildRpcMethodRoom({ userId: params.userId, method }))).catch((error: unknown) => {
                log({ module: "websocket-rpc", level: "error" }, `Error leaving rpc room on disconnect: ${error}`);
            });
            const availability = parseMachineScopedRpcMethod(method);
            if (availability) {
                await Promise.resolve(params.socket.leave(buildMachineRpcAvailabilityRoom({
                    userId: params.userId, machineId: availability.machineId,
                }))).catch((error: unknown) => {
                    log({ module: "websocket-rpc", level: "error" }, `Error leaving rpc availability room on disconnect: ${error}`);
                });
            }
            await emitMachineScopedRpcUnregisteredWhenUnavailable({
                userId: params.userId,
                io: params.io,
                method,
            });
        }
    });

    void hydrateMachineScopedRpcAvailabilityForSocket(params).catch((error) => {
        log({ module: "websocket-rpc", level: "error" }, `Error hydrating rpc handler availability: ${error}`);
    });
}
