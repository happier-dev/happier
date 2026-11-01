import { readExternalActionManagedControlAdmission } from '@/app/auth/externalActionManagedAdmission';
import { randomUUID } from "node:crypto";

import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, parseExternalActionDaemonDispatchResult, type ExternalActionActionIdV1, type ExternalActionDaemonDispatchRequest, type ParsedExternalActionDaemonDispatchResult, type ExternalActionDaemonPlacementV1, type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionExecutionAuthorizationV1, type ExternalActionRequestEnvelope, type ExternalActionServerPrincipalV1, prepareExternalActionResponseEnvelopeV1, isExternalActionRequestVersionAllowedForAccountModeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { supportsMachineOperationProtocolCapabilityV1, supportsMachineSessionInputAdmissionProtocolVersion } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { ManagedAcquireInputV1Schema, ManagedAdmissionComputeInputV1Schema, resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { projectExternalActionPendingResetStartEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server } from "socket.io";

import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { auth, ApiTokenOperationError, type ExternalActionGrantEvaluationContext, type ExternalActionExecutionAuthorizationMintInput } from "@/app/auth/auth";
import { admitManagedAcquire, ExternalActionAdmissionUnexpectedError } from '@/app/machines/managed/managedAcquire';
import { ManagedMachineError, sameManagedInput } from '@/app/machines/managed/managedRows';
import { verifyCurrentExternalActionPrincipal, verifyCurrentExternalActionPrincipalInTx,
    hasCurrentExternalActionSessionSource, isExternalActionAuthorizationBoundToEnvelope,
    projectExternalActionBoundPrincipal, isOriginalAccountHandoffAction,
    readCurrentExternalActionHandoffBindingInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { readMachineScopedSocketIdentity } from "@/app/machines/machineDaemonPresence";
import { readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import {
    readSessionPublisherAuthorityProjection,
    type createSessionPublisherPresence,
    type CurrentSessionPublisherAuthority,
} from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { resolveMachineAdmission } from "@/app/machines/machineAccess";
import { getAccountSessionSocketRoom } from "@/app/api/socketRooms";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { prepareManagedFiniteActionWake } from '@/app/machines/managed/managedWake';
import { log } from '@/utils/logging/log';
import { timeWebLatencyPhase } from '@/utils/webLatencyTrace';
import { readDatabaseErrorCode } from '@/app/api/utils/enableErrorHandlers';

import { forwardRpcCall, type RpcForwardResult } from "./rpc/forwardRpcCall";
import { readVerifiedMachineSocketInstallationIdFromSocketData } from "./machineSocketInstallationProof";
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./rpc/_types";
import { readSocketRoomSnapshot } from './socketRoomDiscovery';

/**
 * Reserved to the server's external Action bridge. The corresponding daemon
 * handler is intentionally not callable or registerable by ordinary sockets.
 */
export { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 };

/**
 * Internal relay data after public ingress has validated only the bounded
 * Action-id path segment. The daemon remains the canonical owner of Action
 * semantics; this boundary only proves that a response belongs to the
 * requested relay.
 */
export type ExternalActionPlacementErrorCode =
    | "credential_scope_denied"
    | "target_required"
    | "target_not_local"
    | "target_unavailable"
    | "database_transaction_conflict_exhausted"
    | "database_transaction_timeout"
    | "database_connection_unavailable"
    | "encrypted_action_unsupported"
    | "session_input_target_update_required";

export type ExternalActionDaemonDispatchResult =
    | ParsedExternalActionDaemonDispatchResult
    | Readonly<{ kind: "submitted_unknown" }>
    | Readonly<{ kind: "placement_error"; code: ExternalActionPlacementErrorCode; managedAdmission?: Readonly<{ managedId: string }> }>;

export type ExternalActionDaemonDispatcher = (
    request: Readonly<{
        actionId: ExternalActionActionIdV1;
        envelope: ExternalActionRequestEnvelope;
        principal: ExternalActionServerPrincipalV1;
        managedContinuation?: ExternalActionExecutionAuthorizationBindingV1['managedContinuation'];
        sessionActionSource?: ExternalActionExecutionAuthorizationBindingV1['sessionActionSource'];
        /** The authenticated front door's exact already-admitted root. */
        executionAuthorization?: ExternalActionExecutionAuthorizationV1;
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<ExternalActionDaemonDispatchResult>;

export type ExternalActionForwardRpcCall = typeof forwardRpcCall;

type MachineResolution =
    | "available"
    | "not_owned"
    | "unavailable"
    | "external_action_update_required"
    | "session_input_update_required";

type ResolveMachine = (params: Readonly<{
    accountId: string;
    machineId: string;
    actionId?: ExternalActionActionIdV1;
    handoffAdmission?: ExternalActionRequestEnvelope['handoffAdmission'] | ExternalActionExecutionAuthorizationBindingV1['handoffAdmission'];
    expectedCustodianAccountId?: string;
    expectedInstallationId?: string;
    requiredExternalActionExecutionAuthorization?: true;
    requiredSessionInputAdmissionProtocolVersion?: 2;
    requireOnline?: boolean;
}>) => Promise<MachineResolution>;

type ResolveSessionMachine = (params: Readonly<{
    accountId: string;
    sessionId: string;
}>) => Promise<string | null>;

type MintExecutionAuthorization = (
    binding: ExternalActionExecutionAuthorizationMintInput,
    context?: ExternalActionGrantEvaluationContext,
) => Promise<ExternalActionExecutionAuthorizationV1>;

type SessionPublisherPresenceForExternalAction = Pick<
    ReturnType<typeof createSessionPublisherPresence>,
    "resolveProjectedCurrentPublisher"
>;

type SocketDataCarrier = Readonly<{ data?: unknown }>;

type DispatchPhase =
    | 'session_publishers'
    | 'publisher_currentness'
    | 'principal_currentness'
    | 'target_currentness'
    | 'pending_reset_admission'
    | 'session_machine_resolution'
    | 'managed_finite_wake'
    | 'machine_resolution'
    | 'execution_authorization'
    | 'daemon_cancel'
    | 'daemon_forward';

type PlacementRefusalBranch =
    | 'target_required'
    | 'aborted'
    | 'session_machine_unresolved'
    | 'execution_authorization_invalid'
    | 'managed_machine_not_authorized'
    | 'managed_controller_mismatch'
    | 'principal_not_current'
    | 'managed_credential_scope_denied'
    | 'managed_acquire_unavailable'
    | 'finite_wake_unavailable'
    | 'managed_machine_unavailable_after_admission'
    | 'machine_not_owned'
    | 'machine_unavailable'
    | 'machine_external_action_update_required'
    | 'machine_session_input_update_required'
    | 'credential_scope_denied'
    | 'session_source_stale'
    | 'daemon_forward_not_ok'
    | 'daemon_response_unparsable'
    | 'phase_exception';

interface DispatchPhaseFailure {
    readonly kind: 'failed';
    readonly phase: DispatchPhase;
    readonly errorClass: 'TypeError' | 'RangeError' | 'SyntaxError' | 'Error' | 'UnknownError';
    readonly message: 'Unexpected phase failure (details redacted)';
    readonly credentialScopeDenied: boolean;
    readonly databaseErrorCode: ReturnType<typeof readDatabaseErrorCode>;
}

type DispatchPhaseResult<T> = Readonly<{ kind: 'ready'; value: T }> | DispatchPhaseFailure;

function emitDispatchPhaseWitness(
    failure: Pick<DispatchPhaseFailure, 'phase' | 'errorClass' | 'message'> | Readonly<{
        phase: 'daemon_envelope_admission' | 'placement_refusal';
        errorClass: 'DaemonAdmissionError' | 'PlacementRefusal';
        message: 'invalid_encrypted_envelope' | 'External Action placement refused';
    }>,
    machineId?: string,
    context: Readonly<{ requestId?: string; refusalBranch: PlacementRefusalBranch | 'daemon_envelope_rejected'; availability?: MachineResolution }> = {
        refusalBranch: 'phase_exception',
    },
): void {
    try {
        log({ module: 'external-action-dispatch', level: 'warn', phase: failure.phase,
            errorClass: failure.errorClass, message: failure.message,
            refusalBranch: context.refusalBranch,
            ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
            ...(context.availability === undefined ? {} : { availability: context.availability }),
            ...(machineId === undefined ? {} : { machineId }) }, '[external-action-phase]');
    } catch {
        // Diagnostics cannot replace the existing fail-closed public outcome.
    }
}

function recordDispatchPhaseFailure(
    phase: DispatchPhase,
    error: unknown,
    _machineId?: string,
    _requestId?: string,
): DispatchPhaseFailure {
    // Error names, messages, causes and Zod issues can contain Action content,
    // credentials or Account identifiers. Classify builtins without reading them.
    let errorClass: DispatchPhaseFailure['errorClass'] = 'UnknownError';
    let credentialScopeDenied = false;
    let databaseErrorCode: DispatchPhaseFailure['databaseErrorCode'] = null;
    try {
        errorClass = error instanceof TypeError ? 'TypeError'
            : error instanceof RangeError ? 'RangeError'
                : error instanceof SyntaxError ? 'SyntaxError'
                    : error instanceof Error ? 'Error' : 'UnknownError';
        credentialScopeDenied = error instanceof ApiTokenOperationError && error.code === 'credential_scope_denied';
        databaseErrorCode = readDatabaseErrorCode(error);
    } catch {
        // A thrown Proxy or accessor is untrusted too; retain only the phase.
    }
    const failure: DispatchPhaseFailure = {
        kind: 'failed', phase, errorClass,
        message: 'Unexpected phase failure (details redacted)',
        credentialScopeDenied,
        databaseErrorCode,
    };
    return failure;
}

async function runDispatchPhase<T>(
    phase: DispatchPhase,
    machineId: string | undefined,
    operation: () => T | Promise<T>,
    requestId?: string,
): Promise<DispatchPhaseResult<T>> {
    try {
        return { kind: 'ready', value: await timeWebLatencyPhase(`dispatch.${phase}`, operation) };
    } catch (error) {
        return recordDispatchPhaseFailure(phase, error, machineId, requestId);
    }
}

function projectDispatchPhaseFailureCode(failure: DispatchPhaseFailure): ExternalActionPlacementErrorCode {
    return failure.databaseErrorCode ?? 'target_unavailable';
}

function createPlacementError(input: Readonly<{
    code: ExternalActionPlacementErrorCode;
    refusalBranch: PlacementRefusalBranch;
    requestId: string | undefined;
    machineId?: string;
    availability?: MachineResolution;
    phaseFailure?: DispatchPhaseFailure;
    managedAdmission?: Readonly<{ managedId: string }>;
}>): Extract<ExternalActionDaemonDispatchResult, { kind: 'placement_error' }> {
    emitDispatchPhaseWitness(input.phaseFailure ?? {
        phase: 'placement_refusal',
        errorClass: 'PlacementRefusal',
        message: 'External Action placement refused',
    }, input.machineId, {
        refusalBranch: input.refusalBranch,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        ...(input.availability === undefined ? {} : { availability: input.availability }),
    });
    return {
        kind: 'placement_error',
        code: input.code,
        ...(input.managedAdmission === undefined ? {} : { managedAdmission: input.managedAdmission }),
    };
}

function parseDaemonResponse(
    raw: unknown,
    expected: Readonly<{ v: 1 | 2; actionId: ExternalActionActionIdV1; requestId?: string }>,
): ParsedExternalActionDaemonDispatchResult | null {
    const result = parseExternalActionDaemonDispatchResult(raw);
    if (!result) return null;
    if (result.kind === "invalid_request") {
        // A protected pre-open failure is untrusted transport evidence, but it
        // still must belong to this exact opaque request before the relay may
        // return its bounded code. V1 also accepts the retained uncorrelated
        // shape; current daemon refusals echo the original request id.
        return expected.v === 2
            ? result.requestId === expected.requestId ? result : null
            : result.requestId === undefined || result.requestId === expected.requestId ? result : null;
    }
    const response = result.prepared.response;
    if (response.v !== expected.v || response.actionId !== expected.actionId) return null;

    if (expected.requestId === undefined) {
        if (response.requestId !== undefined) return null;
    } else if (response.requestId !== expected.requestId) {
        return null;
    }

    return result;
}

async function resolveMachineFromServer(params: Readonly<{
    accountId: string;
    machineId: string;
    actionId?: ExternalActionActionIdV1;
    handoffAdmission?: ExternalActionRequestEnvelope['handoffAdmission'] | ExternalActionExecutionAuthorizationBindingV1['handoffAdmission'];
    expectedCustodianAccountId?: string;
    expectedInstallationId?: string;
    requiredExternalActionExecutionAuthorization?: true;
    requiredSessionInputAdmissionProtocolVersion?: 2;
    requireOnline?: boolean;
}>): Promise<MachineResolution> {
    const machine = await db.machine.findUnique({
        where: { id: params.machineId },
        select: {
            accountId: true,
            kind: true,
            installationId: true,
            revokedAt: true,
            replacedByMachineId: true,
            operationProtocolCapabilities: true,
            operationProtocolCapabilitiesRevision: true,
        },
    });
    if (!machine) return "not_owned";
    if (machine.kind === 'ephemeral_session_runner') {
        // Restricted Runners retain their incumbent credential/session owner;
        // they never acquire persistent shared-Machine grants.
        if (machine.accountId !== params.accountId) return 'not_owned';
    } else {
        // A handoff's Session/key owner qualifies both exact installations. The
        // unsigned private RPC policy remains custodian-only.
        const handoff = params.handoffAdmission && params.actionId
            && (isOriginalAccountHandoffAction(params.actionId) || params.actionId === 'session.spawn_new')
            ? await readCurrentExternalActionHandoffBindingInTx(db, { accountId: params.accountId,
                handoffAdmission: params.handoffAdmission, requireSourceOnline: true }) : null;
        if (params.handoffAdmission && (!handoff
            || ![handoff.sourceMachineId, handoff.targetMachineId].includes(params.machineId)
            || machine.installationId !== (params.machineId === handoff.sourceMachineId
                ? handoff.sourceInstallationId : handoff.targetInstallationId))) return 'not_owned';
        const admission = await resolveMachineAdmission({ actorAccountId: params.accountId,
            machineId: params.machineId, ...(handoff ? { requiredRole: 'use' as const } : { actionId: params.actionId }),
            requireOnline: params.requireOnline ?? true });
        if (admission.kind !== 'admitted') return admission.code === 'machine_unavailable' ? 'unavailable' : 'not_owned';
        if (admission.custodianAccountId !== machine.accountId || admission.installationId !== machine.installationId) return 'unavailable';
    }
    if ((params.expectedCustodianAccountId !== undefined && machine.accountId !== params.expectedCustodianAccountId)
        || (params.expectedInstallationId !== undefined && machine.installationId !== params.expectedInstallationId)) return 'unavailable';
    if (classifyMachineAvailabilityState(machine) !== "available") return "unavailable";
    const hasCurrentExternalActionAuthorization = typeof machine.operationProtocolCapabilitiesRevision === "number"
        && machine.operationProtocolCapabilitiesRevision >= 1
        && supportsMachineOperationProtocolCapabilityV1(
            machine.operationProtocolCapabilities,
            "externalActionExecutionAuthorization",
        );
    if (
        params.requiredExternalActionExecutionAuthorization === true
        && !hasCurrentExternalActionAuthorization
    ) return "external_action_update_required";
    if (params.requiredSessionInputAdmissionProtocolVersion === undefined) return "available";
    return supportsMachineSessionInputAdmissionProtocolVersion(
        machine.operationProtocolCapabilities,
        params.requiredSessionInputAdmissionProtocolVersion,
    ) ? "available" : "session_input_update_required";
}

function requiresSessionInputAdmissionV2(request: Readonly<{
    actionId: ExternalActionActionIdV1;
    envelope: ExternalActionRequestEnvelope;
}>): boolean {
    if (request.actionId !== "session.message.send") return false;
    // V2 deliberately encrypts the complete Action input, so the Home cannot
    // distinguish a main send from a Run-targeted send without violating that
    // privacy boundary. The protected transport therefore requires the daemon
    // generation that truthfully publishes targeted input admission. Released
    // plaintext V1 retains main-send compatibility and requires v2 only when
    // its visible input carries a recipient.
    if (request.envelope.v === 2) return true;
    const inputSchema = getActionSpec("session.message.send").surfaceBindings?.api?.inputSchema;
    const parsed = inputSchema?.safeParse(request.envelope.input);
    return parsed?.success === true
        && typeof parsed.data === "object"
        && parsed.data !== null
        && "recipient" in parsed.data
        && parsed.data.recipient !== undefined;
}

export async function resolveCurrentSessionPublisherFromServer(params: Readonly<{
    io: Server;
    presence?: SessionPublisherPresenceForExternalAction;
    accountId: string;
    sessionId: string;
}>): Promise<CurrentSessionPublisherAuthority | null> {
    if (!params.presence) return null;
    const presence = params.presence;
    const resolveAuthority = async (sockets: readonly SocketDataCarrier[]) => {
        const authorities = new Map<string, CurrentSessionPublisherAuthority>();
        for (const socket of sockets) {
            const projection = readSessionPublisherAuthorityProjection(socket.data);
            if (!projection) continue;
            const authority = await runDispatchPhase('publisher_currentness', undefined, () => (
                presence.resolveProjectedCurrentPublisher({
                    expectedAccountId: params.accountId,
                    expectedSessionId: params.sessionId,
                    projection,
                })
            ));
            if (authority.kind === 'ready' && authority.value) {
                authorities.set(authority.value.machineId, authority.value);
            }
        }
        return authorities.size === 1 ? [...authorities.values()][0]! : null;
    };
    const snapshot = await runDispatchPhase('session_publishers', undefined, async () => {
        // The per-account Session room is the exact set of this Account's
        // sockets scoped to this Session, and it is what every Session-scoped
        // client joins — including a restricted Runner, which is deliberately
        // kept out of the Account-wide `user:` room. Resolving a Session
        // target from that Account-wide room therefore missed exactly the
        // publisher a Session target names.
        return await readSocketRoomSnapshot({
            io: params.io,
            room: getAccountSessionSocketRoom(params.accountId, params.sessionId),
            // A room member alone cannot select placement. The canonical owner
            // first proves its globally unique committed publisher generation,
            // current fence and Machine access before accepting that carrier.
            acceptPartial: async sockets => (await resolveAuthority(sockets)) !== null,
        });
    });
    if (snapshot.kind === 'failed') return null;
    // Discovery is an asynchronous transport boundary. Revalidate its positive
    // evidence after settlement; replacement or revocation cannot survive it.
    return await resolveAuthority(snapshot.value.sockets);
}

/** The existing placement reader projects the same current publisher owner. */
export async function resolveCurrentSessionMachineFromServer(params: Readonly<{
    io: Server;
    presence?: SessionPublisherPresenceForExternalAction;
    accountId: string;
    sessionId: string;
}>): Promise<string | null> {
    return (await resolveCurrentSessionPublisherFromServer(params))?.machineId ?? null;
}

function isExactMachineDaemonTarget(
    target: Pick<RpcAckResponseEmitter, "data">,
    machineId: string,
    installationId: string,
): boolean {
    const identity = readMachineScopedSocketIdentity(target.data);
    return identity?.machineId === machineId
        && readVerifiedMachineSocketInstallationIdFromSocketData(target.data) === installationId;
}

function createExactMachineDaemonGuard(params: Readonly<{
    accountId: string;
    machineId: string;
    installationId: string;
    actionId: ExternalActionActionIdV1;
    custodianAccountId: string;
    handoffAdmission?: ExternalActionExecutionAuthorizationBindingV1['handoffAdmission'];
    sessionId?: string;
    requiredExternalActionExecutionAuthorization?: true;
    requiredSessionInputAdmissionProtocolVersion?: 2;
    resolveMachine: ResolveMachine;
    resolveSessionMachine: ResolveSessionMachine;
    isOriginCurrent?: () => Promise<boolean>;
}>): Readonly<{
    targetGuard: RpcForwardTargetGuard;
    readPhaseFailure: () => DispatchPhaseFailure | null;
}> {
    let phaseFailure: DispatchPhaseFailure | null = null;
    const current = async (): Promise<boolean> => {
        const result = await runDispatchPhase('target_currentness', params.machineId, async () => {
            if (params.isOriginCurrent && !await params.isOriginCurrent()) return false;
            if (await params.resolveMachine({
                accountId: params.accountId,
                machineId: params.machineId,
                actionId: params.actionId,
                ...(params.handoffAdmission ? { handoffAdmission: params.handoffAdmission } : {}),
                expectedCustodianAccountId: params.custodianAccountId,
                expectedInstallationId: params.installationId,
                ...(params.requiredExternalActionExecutionAuthorization === true
                    ? { requiredExternalActionExecutionAuthorization: true as const }
                    : {}),
                ...(params.requiredSessionInputAdmissionProtocolVersion === undefined
                    ? {}
                    : { requiredSessionInputAdmissionProtocolVersion: params.requiredSessionInputAdmissionProtocolVersion }),
            }) !== "available") {
                return false;
            }
            if (params.sessionId === undefined) return true;
            return await params.resolveSessionMachine({
                accountId: params.accountId,
                sessionId: params.sessionId,
            }) === params.machineId;
        });
        if (result.kind === 'failed') {
            phaseFailure = result;
            return false;
        }
        phaseFailure = null;
        return result.value;
    };
    const exact = (target: Pick<RpcAckResponseEmitter, "data">): boolean => (
        isExactMachineDaemonTarget(target, params.machineId, params.installationId)
    );

    return {
        readPhaseFailure: () => phaseFailure,
        targetGuard: {
            filterTargets: async (targets) => {
                if (!await current()) return [];
                return targets.filter(exact);
            },
            runOperation: async ({ target, operation, readLatestTarget }) => {
                if (!exact(target) || !await current()) return { status: "unavailable" };
                const latestTarget = await readLatestTarget();
                if (!latestTarget || !exact(latestTarget) || !await current()) {
                    return { status: "unavailable" };
                }
                const value = await operation();
                return { status: "current", value };
            },
        },
    };
}

/**
 * The sole server-side relay for an external Action request. The server owns
 * credential provenance and exact daemon placement. For raw V1 targeted
 * Session input, it consumes the ActionSpec-owned recipient projection; for
 * opaque V2 Session input, it conservatively consumes the outer Action id.
 * Both enforce the exact Machine's published admission version before relay.
 * The target daemon remains the owner of all Action semantics and policy.
 */
export function createExternalActionDaemonDispatcher(params: Readonly<{
    io: Server;
    forwardRpc?: ExternalActionForwardRpcCall;
    resolveMachine?: ResolveMachine;
    resolveSessionMachine?: ResolveSessionMachine;
    sessionPublisherPresence?: SessionPublisherPresenceForExternalAction;
    mintExecutionAuthorization?: MintExecutionAuthorization;
    getServerIdentityId?: () => Promise<string>;
}>): ExternalActionDaemonDispatcher {
    const forwardRpc = params.forwardRpc ?? forwardRpcCall;
    const resolveMachine = params.resolveMachine ?? resolveMachineFromServer;
    const resolveSessionMachine = params.resolveSessionMachine ?? (async ({ accountId, sessionId }) => (
        await resolveCurrentSessionMachineFromServer({
            io: params.io,
            presence: params.sessionPublisherPresence,
            accountId,
            sessionId,
        })
    ));
    // Input is admitted to Pending, whose committed target survives a planned
    // publisher replacement. A live socket is authority for runtime effects,
    // not a prerequisite for the Session's existing input custody.
    const resolveSessionInputMachine: ResolveSessionMachine = params.resolveSessionMachine ?? (async ({ accountId, sessionId }) => {
        const target = await readCurrentCommittedSessionInputMachineTargetInTx(db, sessionId);
        return target?.accountId === accountId ? target.machineId : null;
    });
    const mintExecutionAuthorization = params.mintExecutionAuthorization
        ?? ((binding, context) => auth.mintExternalActionExecutionAuthorization(binding, context));
    const getServerIdentityId = params.getServerIdentityId ?? getOrCreateServerIdentityId;

    return async (request, options = {}): Promise<ExternalActionDaemonDispatchResult> => {
        const resolveTargetSessionMachine = request.actionId === 'session.message.send'
            ? resolveSessionInputMachine : resolveSessionMachine;
        const target = request.envelope.target;
        if (!target) {
            return createPlacementError({ code: 'target_required', refusalBranch: 'target_required',
                requestId: request.envelope.requestId });
        }
        if (options.signal?.aborted) {
            return createPlacementError({ code: 'target_unavailable', refusalBranch: 'aborted',
                requestId: request.envelope.requestId,
                ...(target.kind === 'machine' ? { machineId: target.machineId } : {}) });
        }
        const pendingReset = await runDispatchPhase('pending_reset_admission',
            target.kind === 'machine' ? target.machineId : undefined, () => (
                projectExternalActionPendingResetStartEnvelopeAdmissionV1({
                    actionId: request.actionId, envelope: request.envelope, target })
            ), request.envelope.requestId);
        if (pendingReset.kind === 'failed') {
            emitDispatchPhaseWitness(pendingReset,
                target.kind === 'machine' ? target.machineId : undefined, {
                    refusalBranch: 'phase_exception',
                    ...(request.envelope.requestId === undefined ? {} : { requestId: request.envelope.requestId }),
                });
            return { kind: 'invalid_request', errorCode: 'invalid_envelope',
                ...(request.envelope.requestId ? { requestId: request.envelope.requestId } : {}) };
        }
        const pendingResetStartAdmission = pendingReset.value;
        if (pendingResetStartAdmission) {
            const account = await db.account.findUnique({ where: { id: request.principal.accountId }, select: { encryptionMode: true } });
            const mode = account ? resolveEffectiveAccountEncryptionModeFromAccountRow(account) : null;
            if (mode?.status !== 'ready' || !isExternalActionRequestVersionAllowedForAccountModeV1({
                accountEncryptionMode: mode.mode, envelopeVersion: request.envelope.v })) {
                return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope',
                    ...(request.envelope.requestId ? { requestId: request.envelope.requestId } : {}) };
            }
        }

        let machineId: string;
        let sessionId: string | undefined;
        if (target.kind === "machine") {
            machineId = target.machineId;
        } else {
            sessionId = target.sessionId;
            const resolved = await runDispatchPhase('session_machine_resolution', undefined, () => (
                resolveTargetSessionMachine({
                    accountId: request.principal.accountId,
                    sessionId: target.sessionId,
                })
            ), request.envelope.requestId);
            if (resolved.kind === 'failed') {
                return createPlacementError({ code: projectDispatchPhaseFailureCode(resolved), refusalBranch: 'phase_exception',
                    requestId: request.envelope.requestId, phaseFailure: resolved });
            }
            if (!resolved.value) {
                return createPlacementError({ code: 'target_unavailable', refusalBranch: 'session_machine_unresolved',
                    requestId: request.envelope.requestId });
            }
            machineId = resolved.value;
        }

        let executionAuthorization = request.executionAuthorization;
        if (executionAuthorization) {
            const root = await auth.verifyExternalActionExecutionAuthorization(executionAuthorization.token);
            const current = root ? await verifyCurrentExternalActionPrincipalInTx(db, root) : null;
            const principal = root && current
                ? projectExternalActionBoundPrincipal(root, current, request.principal.authority) : null;
            if (!root || !principal || root.serverIdentityId !== await getServerIdentityId()
                || !sameManagedInput(root, executionAuthorization.binding)
                || !sameManagedInput(principal, request.principal)
                || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId: request.actionId, machineId,
                    envelope: request.envelope })) return createPlacementError({ code: 'credential_scope_denied',
                    refusalBranch: 'execution_authorization_invalid', requestId: request.envelope.requestId, machineId });
        }
        let managedAdmission: Awaited<ReturnType<typeof admitManagedAcquire>> | undefined;
        const mint = async (): Promise<ExternalActionExecutionAuthorizationV1> => {
            const handoffAdmission = request.envelope.handoffAdmission && isOriginalAccountHandoffAction(request.actionId)
                ? await readCurrentExternalActionHandoffBindingInTx(db, { accountId: request.principal.accountId,
                    handoffAdmission: request.envelope.handoffAdmission, requireSourceOnline: true }) : null;
            if (request.envelope.handoffAdmission && !handoffAdmission) throw new Error('handoff_admission_unavailable');
            const managedAdmission = readExternalActionManagedControlAdmission(request.actionId, request.envelope);
            const routing = {
                serverIdentityId: await getServerIdentityId(), machineId,
                actionId: request.actionId, requestId: request.envelope.requestId ?? randomUUID(),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target,
                ...(request.envelope.idempotencyKey === undefined ? {} : { idempotencyKey: request.envelope.idempotencyKey }),
                ...(pendingResetStartAdmission ? { pendingResetStartAdmission } : {}),
                ...(managedAdmission ? { managedAdmission } : {}),
                ...(handoffAdmission ? { handoffAdmission } : {}),
                ...(request.managedContinuation ? { managedContinuation: request.managedContinuation } : {}),
                ...(request.sessionActionSource ? { sessionActionSource: request.sessionActionSource } : {}),
            };
            const context = { input: request.envelope.v === 1 ? request.envelope.input : request.envelope.sessionSpawnAdmission ?? managedAdmission?.input,
                ...(request.sessionActionSource ? { resolveCurrentSessionMachine: resolveSessionMachine } : {}) };
            const principal = request.principal;
            if ('authentication' in principal) {
                const { authority: _authority, authentication, ...provenance } = principal;
                return authentication.kind === 'account'
                    ? mintExecutionAuthorization({ ...routing, ...provenance, authentication }, context)
                    : mintExecutionAuthorization({ ...routing, ...provenance, authentication }, context);
            }
            const { authority: _authority, ...provenance } = principal;
            return mintExecutionAuthorization({ ...routing, ...provenance }, context);
        };
        if (request.actionId === 'machines.managed.acquire') {
            if (target.kind !== 'machine' || !request.envelope.requestId) {
                return { kind: 'invalid_request', errorCode: 'invalid_envelope',
                    ...(request.envelope.requestId ? { requestId: request.envelope.requestId } : {}) };
            }
            const actor = await db.account.findUnique({ where: { id: request.principal.accountId }, select: { encryptionMode: true } });
            const mode = actor ? resolveEffectiveAccountEncryptionModeFromAccountRow(actor) : null;
            if (mode?.status !== 'ready' || !isExternalActionRequestVersionAllowedForAccountModeV1({ accountEncryptionMode: mode.mode,
                envelopeVersion: request.envelope.v })) {
                return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.envelope.requestId };
            }
            const actual = request.envelope.v === 1 ? ManagedAcquireInputV1Schema.safeParse(request.envelope.input) : null;
            const projected = actual?.success ? (() => {
                const { agentStart, ...compute } = actual.data;
                return { actionId: 'machines.managed.acquire' as const,
                    input: ManagedAdmissionComputeInputV1Schema.parse(compute), continuationPresent: agentStart !== undefined };
            })() : request.envelope.managedAdmission;
            if (!projected || projected.actionId !== request.actionId
                || (actual !== null && !actual.success)
                || (request.envelope.managedAdmission !== undefined
                    && !sameManagedInput(request.envelope.managedAdmission, projected))) {
                return { kind: 'invalid_request', errorCode: 'invalid_envelope', requestId: request.envelope.requestId };
            }
            const review = resolveManagedAcquireReviewV1(projected.input);
            const admission = await resolveMachineAdmission({ actorAccountId: request.principal.accountId,
                machineId, actionId: request.actionId, requiredRole: 'manage' });
            if (admission.kind !== 'admitted') return createPlacementError({ code: 'credential_scope_denied',
                refusalBranch: 'managed_machine_not_authorized', requestId: request.envelope.requestId, machineId });
            if (review.controller.machineId !== machineId || review.controller.installationId !== admission.installationId) {
                return createPlacementError({ code: 'target_unavailable', refusalBranch: 'managed_controller_mismatch',
                    requestId: request.envelope.requestId, machineId });
            }
            let admissionStarted = false;
            try {
                executionAuthorization ??= await mint();
                const principal = request.executionAuthorization
                    ? await verifyCurrentExternalActionPrincipalInTx(db, executionAuthorization.binding)
                    : await verifyCurrentExternalActionPrincipal(executionAuthorization.binding);
                if (!principal) return createPlacementError({ code: 'target_unavailable', refusalBranch: 'principal_not_current',
                    requestId: request.envelope.requestId, machineId });
                admissionStarted = true;
                managedAdmission = await admitManagedAcquire({ custodianAccountId: executionAuthorization.binding.custodianAccountId,
                    requesterAccountId: request.principal.accountId,
                    authentication: { authenticationAuthority: principal.authority,
                        authenticationEvidence: principal.authenticationEvidence },
                    requestEnvelopeDigest: executionAuthorization.binding.requestEnvelopeDigest,
                    input: { input: projected.input, continuationPresent: projected.continuationPresent, requestId: request.envelope.requestId } });
            } catch (error) {
                const cause = error instanceof ExternalActionAdmissionUnexpectedError ? error.cause : error;
                if (cause instanceof ApiTokenOperationError) return createPlacementError({
                    code: cause.code === 'credential_scope_denied' ? 'credential_scope_denied' : 'target_unavailable',
                    refusalBranch: cause.code === 'credential_scope_denied'
                        ? 'managed_credential_scope_denied' : 'managed_acquire_unavailable',
                    requestId: request.envelope.requestId, machineId,
                });
                if (error instanceof ManagedMachineError) {
                    if (request.envelope.v === 1) return { kind: 'response', prepared: prepareExternalActionResponseEnvelopeV1({
                        v: 1, actionId: request.actionId, requestId: request.envelope.requestId,
                        execution: { ok: false, errorCode: error.code, error: error.code } }) };
                    return createPlacementError({
                        code: error.code === 'permission_denied' ? 'credential_scope_denied' : 'target_unavailable',
                        refusalBranch: error.code === 'permission_denied'
                            ? 'managed_credential_scope_denied' : 'managed_acquire_unavailable',
                        requestId: request.envelope.requestId, machineId,
                    });
                }
                let admissionCommitted: boolean | null = error instanceof ExternalActionAdmissionUnexpectedError
                    ? error.admissionCommitted : admissionStarted ? null : false;
                try {
                    const retained = await db.managedMachine.findUnique({ where: {
                        homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.envelope.requestId },
                    }, select: { id: true } });
                    if (retained) admissionCommitted = true;
                } catch { admissionCommitted = null; /* Prior admission may also be unavailable. */ }
                throw new ExternalActionAdmissionUnexpectedError(cause, admissionCommitted);
            }
        }
        const requiredSessionInputAdmissionProtocolVersion = requiresSessionInputAdmissionV2(request)
            ? 2 as const
            : undefined;
        let finiteWake: Awaited<ReturnType<typeof prepareManagedFiniteActionWake>> | undefined;
        const finiteSignal = options.signal ?? new AbortController().signal;
        if (target.kind === 'machine' && Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, request.actionId)) {
            const wake = await runDispatchPhase('managed_finite_wake', machineId, async () => {
                executionAuthorization ??= await mint();
                const originalAuthorization = executionAuthorization;
                return await prepareManagedFiniteActionWake({ io: params.io, actionOrigin: originalAuthorization,
                    signal: finiteSignal, forwardRpc,
                    isOriginalSourceCurrent: () => hasCurrentExternalActionSessionSource(originalAuthorization.binding, resolveSessionMachine) });
            }, request.envelope.requestId);
            if (wake.kind === 'failed') return createPlacementError({ code: projectDispatchPhaseFailureCode(wake),
                refusalBranch: 'phase_exception', requestId: request.envelope.requestId, machineId, phaseFailure: wake });
            finiteWake = wake.value;
            if (finiteWake.kind === 'submitted-unknown') return { kind: 'submitted_unknown' };
            if (finiteWake.kind === 'unavailable') return createPlacementError({ code: 'target_unavailable',
                refusalBranch: 'finite_wake_unavailable', requestId: request.envelope.requestId, machineId });
        }
        const machine = await runDispatchPhase('machine_resolution', machineId, () => (
            resolveMachine({
                accountId: request.principal.accountId,
                machineId,
                actionId: request.actionId,
                ...((executionAuthorization?.binding.handoffAdmission ?? request.envelope.handoffAdmission)
                    ? { handoffAdmission: executionAuthorization?.binding.handoffAdmission ?? request.envelope.handoffAdmission } : {}),
                requiredExternalActionExecutionAuthorization: true,
                ...(finiteWake?.kind === 'ready' ? { requireOnline: false } : {}),
                ...(requiredSessionInputAdmissionProtocolVersion === undefined
                    ? {}
                    : { requiredSessionInputAdmissionProtocolVersion }),
            })
        ), request.envelope.requestId);
        if (machine.kind === 'failed') {
            return createPlacementError({ code: projectDispatchPhaseFailureCode(machine), refusalBranch: 'phase_exception',
                requestId: request.envelope.requestId, machineId, phaseFailure: machine });
        }
        const availability = machine.value;
        if (availability !== "available") {
            if (managedAdmission && availability === 'unavailable') {
                return request.envelope.v === 1
                    ? { kind: 'response', prepared: prepareExternalActionResponseEnvelopeV1({ v: 1,
                        actionId: request.actionId, requestId: request.envelope.requestId,
                        execution: { ok: true, result: { managedId: managedAdmission.machine.id } } }) }
                    : createPlacementError({ code: 'target_unavailable',
                        refusalBranch: 'managed_machine_unavailable_after_admission', requestId: request.envelope.requestId,
                        machineId, availability, managedAdmission: { managedId: managedAdmission.machine.id } });
            }
            if (availability === "external_action_update_required") {
                return createPlacementError({ code: 'encrypted_action_unsupported',
                    refusalBranch: 'machine_external_action_update_required', requestId: request.envelope.requestId,
                    machineId, availability });
            }
            if (availability === "session_input_update_required") {
                return createPlacementError({ code: 'session_input_target_update_required',
                    refusalBranch: 'machine_session_input_update_required', requestId: request.envelope.requestId,
                    machineId, availability });
            }
            return createPlacementError({
                code: target.kind === 'machine' && availability === 'not_owned' ? 'target_not_local' : 'target_unavailable',
                refusalBranch: availability === 'not_owned' ? 'machine_not_owned' : 'machine_unavailable',
                requestId: request.envelope.requestId, machineId, availability,
            });
        }
        if (options.signal?.aborted) {
            return createPlacementError({ code: 'target_unavailable', refusalBranch: 'aborted',
                requestId: request.envelope.requestId, machineId });
        }

        const authorization = await runDispatchPhase('execution_authorization', machineId, async () => (
            executionAuthorization ?? await mint()
        ), request.envelope.requestId);
        if (authorization.kind === 'failed') {
            if (authorization.credentialScopeDenied) {
                return createPlacementError({ code: 'credential_scope_denied', refusalBranch: 'credential_scope_denied',
                    requestId: request.envelope.requestId, machineId, phaseFailure: authorization });
            }
            return createPlacementError({ code: projectDispatchPhaseFailureCode(authorization), refusalBranch: 'phase_exception',
                requestId: request.envelope.requestId, machineId, phaseFailure: authorization });
        }
        const currentAuthorization = authorization.value;

        // No provider/login HTTP await follows these original-source checks.
        if (request.executionAuthorization || currentAuthorization.binding.sessionActionOrigin) {
            const sourceCurrent = await runDispatchPhase('target_currentness', machineId, () => (
                hasCurrentExternalActionSessionSource(currentAuthorization.binding, resolveSessionMachine)
            ), request.envelope.requestId);
            if (sourceCurrent.kind === 'failed') return createPlacementError({
                code: projectDispatchPhaseFailureCode(sourceCurrent), refusalBranch: 'phase_exception',
                requestId: request.envelope.requestId, machineId, phaseFailure: sourceCurrent,
            });
            if (!sourceCurrent.value) return createPlacementError({ code: 'target_unavailable',
                refusalBranch: 'session_source_stale', requestId: request.envelope.requestId, machineId });

            const principalCurrent = await runDispatchPhase('principal_currentness', machineId, () => (
                verifyCurrentExternalActionPrincipalInTx(db, currentAuthorization.binding)
            ), request.envelope.requestId);
            if (principalCurrent.kind === 'failed') return createPlacementError({
                code: projectDispatchPhaseFailureCode(principalCurrent), refusalBranch: 'phase_exception',
                requestId: request.envelope.requestId, machineId, phaseFailure: principalCurrent,
            });
            if (!principalCurrent.value) return createPlacementError({ code: 'target_unavailable',
                refusalBranch: 'principal_not_current', requestId: request.envelope.requestId, machineId });
        }

        const placement: ExternalActionDaemonPlacementV1 = {
            machineId,
            target: { kind: "machine", machineId },
        };
        const exactDaemonTarget = createExactMachineDaemonGuard({
            accountId: request.principal.accountId,
            machineId,
            actionId: request.actionId,
            custodianAccountId: currentAuthorization.binding.custodianAccountId,
            installationId: currentAuthorization.binding.installationId,
            ...(currentAuthorization.binding.handoffAdmission ? { handoffAdmission: currentAuthorization.binding.handoffAdmission } : {}),
            requiredExternalActionExecutionAuthorization: true,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(requiredSessionInputAdmissionProtocolVersion === undefined
                ? {}
                : { requiredSessionInputAdmissionProtocolVersion }),
            resolveMachine,
            resolveSessionMachine: resolveTargetSessionMachine,
            ...(finiteWake && (finiteWake.kind === 'ready' || finiteWake.kind === 'not-needed')
                ? { isOriginCurrent: finiteWake.isCurrent } : {}),
        });
        const requestId = options.signal ? randomUUID() : null;
        let targetSocketId: string | null = null;
        const cancellation = requestId && options.signal
            ? {
                targetRequestId: requestId,
                signal: options.signal,
                onTargetSelected: (targetSocket: RpcAckResponseEmitter) => {
                    targetSocketId = targetSocket.id;
                },
            }
            : null;
        const cancelTarget = (): void => {
            if (!targetSocketId || !requestId) return;
            try {
                params.io.to(targetSocketId).emit(SOCKET_RPC_EVENTS.CANCEL, { requestId });
            } catch (error) {
                const failure = recordDispatchPhaseFailure('daemon_cancel', error, machineId,
                    request.envelope.requestId);
                emitDispatchPhaseWitness(failure, machineId, {
                    refusalBranch: 'phase_exception',
                    ...(request.envelope.requestId === undefined ? {} : { requestId: request.envelope.requestId }),
                });
                // Cancellation is best effort at the transport boundary.
            }
        };
        options.signal?.addEventListener("abort", cancelTarget, { once: true });

        let forwarded: DispatchPhaseResult<RpcForwardResult>;
        let submittedUnknown = false;
        try {
            forwarded = await runDispatchPhase('daemon_forward', machineId, () => forwardRpc({
                io: params.io,
                targetUserId: currentAuthorization.binding.custodianAccountId,
                method: `${machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
                timeoutMs: null,
                callParams: {
                    actionId: request.actionId,
                    envelope: request.envelope,
                    principal: request.principal,
                    placement,
                    executionAuthorization: currentAuthorization,
                } satisfies ExternalActionDaemonDispatchRequest,
                authorization: ACTION_API_SERVER_ORIGIN,
                targetGuard: exactDaemonTarget.targetGuard,
                onSubmittedUnknown: () => {
                    submittedUnknown = true;
                },
                ...(finiteWake?.kind === 'ready' ? { callerLifetime: { signal: finiteSignal, isCurrent: finiteWake.isCurrent } } : {}),
                ...(cancellation ? { cancellation } : {}),
            }), request.envelope.requestId);
        } finally {
            options.signal?.removeEventListener("abort", cancelTarget);
        }
        if (forwarded.kind === 'failed' || !forwarded.value.ok) {
            const guardFailure = exactDaemonTarget.readPhaseFailure();
            return submittedUnknown
                ? { kind: "submitted_unknown" }
                : createPlacementError({
                    code: forwarded.kind === 'failed' ? projectDispatchPhaseFailureCode(forwarded)
                        : guardFailure ? projectDispatchPhaseFailureCode(guardFailure) : 'target_unavailable',
                    refusalBranch: forwarded.kind === 'failed' || guardFailure ? 'phase_exception'
                        : options.signal?.aborted ? 'aborted' : 'daemon_forward_not_ok',
                    requestId: request.envelope.requestId, machineId,
                    ...(forwarded.kind === 'failed'
                        ? { phaseFailure: forwarded }
                        : guardFailure ? { phaseFailure: guardFailure } : {}),
                });
        }

        const result = parseDaemonResponse(forwarded.value.result, {
            v: request.envelope.v,
            actionId: request.actionId,
            ...(request.envelope.requestId === undefined ? {} : { requestId: request.envelope.requestId }),
        });
        if (result?.kind === 'invalid_request' && result.errorCode === 'invalid_encrypted_envelope') {
            emitDispatchPhaseWitness({ phase: 'daemon_envelope_admission',
                errorClass: 'DaemonAdmissionError', message: 'invalid_encrypted_envelope' }, machineId, {
                refusalBranch: 'daemon_envelope_rejected',
                ...(request.envelope.requestId === undefined ? {} : { requestId: request.envelope.requestId }),
            });
        }
        return result
            ? result
            : request.envelope.v === 2
                ? { kind: "submitted_unknown" }
                : createPlacementError({ code: 'target_unavailable', refusalBranch: 'daemon_response_unparsable',
                    requestId: request.envelope.requestId, machineId });
    };
}
