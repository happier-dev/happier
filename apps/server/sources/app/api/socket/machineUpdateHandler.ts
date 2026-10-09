import { machineAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics/index";
import { activityCache } from "@/app/presence/sessionCache";
import { buildMachineActivityEphemeral, buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/logging/log";
import { db } from "@/storage/db";
import { Socket } from "socket.io";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { recordMachineAlive } from "@/app/presence/presenceRecorder";
import {
    EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1,
    ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1,
    ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1,
    EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1,
    EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1,
    ExternalSessionTranscriptInvalidationV1Schema,
    ExternalSessionSourceUnavailableOccurrenceV1Schema,
    MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
    MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
    SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2,
    SessionPendingExecutionRunEnqueueByMachineRequestV2Schema,
    SESSION_SERVER_START_INGRESS_EVENT_V1,
    MachineSessionTerminalCaptureRequestV1Schema,
    MachineSessionTerminalFinalizeRequestV1Schema,
    MachineUpdateMetadataRequestSchema,
    MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
    SessionPendingEnqueueByMachineRequestV1Schema,
    isPlainMachineDataKeyMarker,
    machineStoredContentMatchesAccountMode,
    machineUpdateMatchesStoredMode,
    decodePlainMachineStoredContent,
    isMachinePublishedContentSafeV1,
    type ExternalSessionOperationSocketBatchLimitResolutionV1,
    type MachineUpdateMetadataResponse,
    type MachineSessionTerminalCaptureResponseV1,
    type MachineSessionTerminalFinalizeResponseV1,
    type SessionServerStartIngressResponseV1,
} from "@happier-dev/protocol";
import { projectActionOperationSnapshotPush } from './actionOperationSnapshotPush';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { enqueuePendingMessageByAuthenticatedMachine } from "@/app/session/pending/pendingMessageService";
import { executeExternalSessionHistoricalImportCommand } from "@/app/session/externalSessionHistoricalImportCommand";
import type { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { publishSessionPublisherClose } from "@/app/presence/publishSessionPublisherClose";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import { scheduleSessionActivityRemoteAlerts } from "@/app/activity/remoteAlerts/submitSessionActivityRemoteAlerts";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "@/app/session/access/sessionRecipients";
import { scheduleSessionPersonalEvent } from "@/app/session/personal/publishPersonalEvent";
import {
    classifyMachineAvailabilityState,
    readMachineAvailabilityState,
} from "@/app/machines/machineStateGuards";
import {
    buildAccountStoredContentSocketUpgradeError,
    readAccountStoredContentCompatibilityForSocket,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { hasCurrentSocketCredential } from "./socketCredentialCurrentness";
import { readVerifiedMachineSocketInstallationIdFromSocketData } from "./machineSocketInstallationProof";
import {
    TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1,
    TeamCredentialExternalProviderOperationRetireV1Schema,
} from "@happier-dev/protocol/teams";
import { retireExternalBrokerOperationInTx } from "@/app/teams/credentials/externalBrokerOperation";
import { verifyExternalActionMachineRpcExecution } from "@/app/auth/externalActionExecutionAuthorization";
import * as privacyKit from "privacy-kit";
import { serializeMachineKeyBasis } from "@/app/machines/machineSerialization";
import { readMachineDevcontainerChildInTx } from '@/app/machines/managed/managedRows';
import { MachineUpdateStateRequestSchema, type MachineUpdateStateResponse } from "@happier-dev/protocol/machines/metadataUpdate";
import {
    resolveMachineAdmissionInTx,
    resolveMachineAccessInTx,
    resolveCurrentMachineRecipientAccountIdsInTx,
} from "@/app/machines/machineAccess";

function readMarkedMachineSocketUpgradeRequired(
    socket: Socket,
    dataEncryptionKey: Uint8Array | null | undefined,
) {
    if (!isPlainMachineDataKeyMarker(dataEncryptionKey)) {
        return null;
    }
    const compatibility =
        readAccountStoredContentCompatibilityForSocket(socket);
    return compatibility.supportsCurrentProtocol
        ? null
        : buildAccountStoredContentSocketUpgradeError(compatibility).data;
}

function readSocketMachineIdentity(socket: Socket): {
    clientType: unknown;
    machineId: string | null;
} {
    const data = socket.data as { clientType?: unknown; machineId?: unknown } | undefined;
    return {
        clientType: data?.clientType,
        machineId: typeof data?.machineId === 'string' && data.machineId
            ? data.machineId
            : null,
    };
}

function readAuthenticatedMachineId(socket: Socket): string | null {
    const { clientType, machineId } = readSocketMachineIdentity(socket);
    return clientType === 'machine-scoped' ? machineId : null;
}

function hasCurrentMachineSocketInstallation(socket: Socket, installationId: string | null): boolean {
    if (!readAuthenticatedMachineId(socket)) return true;
    if (installationId === null) return false;
    return readVerifiedMachineSocketInstallationIdFromSocketData(socket.data) === installationId;
}

function encodedMachineEnvelope(dataEncryptionKey: Uint8Array<ArrayBuffer> | null): string | null {
    return dataEncryptionKey === null ? null : privacyKit.encodeBase64(dataEncryptionKey);
}

function isSafePlainMachinePublication(metadata: string, daemonState: string | null): boolean {
    try {
        return isMachinePublishedContentSafeV1({
            metadata: decodePlainMachineStoredContent(metadata),
            daemonState: daemonState === null ? null : decodePlainMachineStoredContent(daemonState),
        });
    } catch {
        return false;
    }
}

function resolveMachineScopedPayloadMachineId(socket: Socket, payloadMachineId: unknown): string | null {
    const authenticatedMachineId = readAuthenticatedMachineId(socket);
    if (!authenticatedMachineId) return null;
    if (typeof payloadMachineId === 'string' && payloadMachineId && payloadMachineId !== authenticatedMachineId) {
        return null;
    }
    return authenticatedMachineId;
}

function resolveMachineMetadataTarget(
    socket: Socket,
    payloadMachineId: string | undefined,
): string | null {
    const { clientType } = readSocketMachineIdentity(socket);
    if (clientType === 'machine-scoped') {
        return resolveMachineScopedPayloadMachineId(socket, payloadMachineId);
    }
    if (clientType === 'user-scoped' || clientType === undefined) {
        return payloadMachineId ?? null;
    }
    return null;
}

async function isMachineAvailableForSocket(accountId: string, machineId: string): Promise<boolean> {
    return await readMachineAvailabilityState({ accountId, machineId }) === "available";
}

export function machineUpdateHandler(
    userId: string,
    socket: Socket,
    options: Readonly<{
        operationSocketBatchLimits: ExternalSessionOperationSocketBatchLimitResolutionV1;
        sessionPublisherPresence?: Pick<
            ReturnType<typeof createSessionPublisherPresence>,
            "captureMachineSessionTerminal" | "finalizeMachineSessionTerminal"
        >;
        sessionServerStartIngress?: (params: Readonly<{
            accountId: string;
            sourceMachineId: string;
            request: unknown;
            signal?: AbortSignal;
        }>) => Promise<SessionServerStartIngressResponseV1>;
    }>,
) {
    socket.on(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, async (
        request: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const parsed = TeamCredentialExternalProviderOperationRetireV1Schema.safeParse(request);
        if (!parsed.success) { callback?.({ ok: false, reasonCode: "invalid_request" }); return; }
        const machineId = readAuthenticatedMachineId(socket);
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        try {
            if (!machineId || !installationId || !await hasCurrentSocketCredential(userId, socket)) {
                callback?.({ ok: false, reasonCode: "resource_forbidden" });
                return;
            }
            const result = await inTx(async tx => {
                const machine = await tx.machine.findFirst({
                    where: { id: machineId, accountId: userId, installationId }, select: { id: true },
                });
                if (!machine) return { ok: false as const, reasonCode: "resource_forbidden" as const };
                return await retireExternalBrokerOperationInTx(tx, {
                    authenticatedAccountId: userId, authenticatedMachineId: machine.id,
                    externalApiKeyId: parsed.data.externalApiKeyId, operationId: parsed.data.operationId,
                });
            });
            callback?.(result);
        } catch {
            // No acknowledgement on an indeterminate storage failure: custody
            // keeps its retirement pending and can retry through its owner.
        }
    });
    socket.on(SESSION_SERVER_START_INGRESS_EVENT_V1, async (
        request: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const sourceMachineId = readAuthenticatedMachineId(socket);
        if (
            !sourceMachineId
            || !(await isMachineAvailableForSocket(userId, sourceMachineId))
        ) {
            if (sourceMachineId) activityCache.invalidateMachine(sourceMachineId);
            callback?.({
                v: 1,
                kind: "result",
                result: { type: "error", code: "permission_denied", retryable: false },
            });
            return;
        }
        if (!options.sessionServerStartIngress) {
            callback?.({
                v: 1,
                kind: "result",
                result: { type: "error", code: "target_unavailable", retryable: true },
            });
            return;
        }
        try {
            callback?.(await options.sessionServerStartIngress({
                accountId: userId,
                sourceMachineId,
                request,
            }));
        } catch {
            // The server may already have dispatched a cross-machine start. A
            // response loss must preserve the one canonical creation-key rejoin.
            callback?.({
                v: 1,
                kind: "result",
                result: { type: "pending", retryWithSameCreationKey: true, outcome: "unknown" },
            });
        }
    });

    for (const version of [1, 2] as const) {
        const event = version === 2 ? SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 : SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1;
        socket.on(event, async (
            request: unknown,
            callback?: (response: unknown) => void,
        ) => {
            const parsed = (version === 2 ? SessionPendingExecutionRunEnqueueByMachineRequestV2Schema : SessionPendingEnqueueByMachineRequestV1Schema).safeParse(request);
            const sourceMachineId = readAuthenticatedMachineId(socket);
            if (!parsed.success) {
                callback?.({
                    v: version,
                    result: { status: "rejected", code: "session_input_invalid" },
                });
                return;
            }
            if (
                !sourceMachineId
                || !(await isMachineAvailableForSocket(userId, sourceMachineId))
            ) {
                if (sourceMachineId) activityCache.invalidateMachine(sourceMachineId);
                callback?.({
                    v: version,
                    result: { status: "rejected", code: "session_input_unauthorized" },
                });
                return;
            }

            try {
                const { externalAction, ...unsignedRequest } = parsed.data;
                const verifiedInvocation = externalAction
                    ? await verifyExternalActionMachineRpcExecution(externalAction, {
                        event, method: event, requestId: externalAction.authorization.binding.requestId,
                        params: unsignedRequest,
                    }) : null;
                if (externalAction && (!verifiedInvocation
                    || verifiedInvocation.principal.accountId !== userId
                    || verifiedInvocation.binding.machineId !== sourceMachineId
                    || parsed.data.targetMachineId !== sourceMachineId
                    || verifiedInvocation.effectActionId !== "session.message.send"
                    || verifiedInvocation.target.kind !== "session"
                    || verifiedInvocation.target.sessionId !== parsed.data.sessionId
                    || readVerifiedMachineSocketInstallationIdFromSocketData(socket.data) !== externalAction.installationId)) {
                    callback?.({ v: version, result: { status: "rejected", code: "session_input_unauthorized" } });
                    return;
                }
                const result = await enqueuePendingMessageByAuthenticatedMachine({
                    accountId: userId,
                    sourceMachineId,
                    targetMachineId: parsed.data.targetMachineId,
                    ...(parsed.data.v === 2 ? { targetExecutionRunId: parsed.data.recipient.runId } : {}),
                    sessionId: parsed.data.sessionId,
                    localId: parsed.data.localId,
                    content: parsed.data.content,
                    requestedAction: parsed.data.requestedAction,
                    ...(verifiedInvocation && 'grant' in verifiedInvocation.binding ? { callerInputConstraints: {
                        models: verifiedInvocation.binding.grant.models,
                        permissionModes: verifiedInvocation.binding.grant.permissionModes,
                    } } : {}),
                    ...(parsed.data.requestEqualityEvidenceV1
                        ? { requestEqualityEvidenceV1: parsed.data.requestEqualityEvidenceV1 }
                        : {}),
                });
                callback?.({ v: version, result });
            } catch {
                log({
                    module: "websocket",
                    level: "error",
                    event,
                    errorCode: "internal_error",
                }, "Machine Session Pending enqueue failed.");
                callback?.({
                    v: version,
                    result: {
                        status: "outcomeUnknown",
                        localId: parsed.data.localId,
                        code: "session_input_admission_acknowledgement_lost",
                    },
                });
            }
        });
    }

    socket.on(MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, async (
        request: unknown,
        callback?: (response: MachineSessionTerminalCaptureResponseV1) => void,
    ) => {
        const parsed = MachineSessionTerminalCaptureRequestV1Schema.safeParse(request);
        const machineId = readAuthenticatedMachineId(socket);
        if (!parsed.success) {
            callback?.({ v: 1, status: "rejected", reason: "invalid_request" });
            return;
        }
        if (!machineId || !(await isMachineAvailableForSocket(userId, machineId))) {
            if (machineId) activityCache.invalidateMachine(machineId);
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "wrong_machine_socket",
            });
            return;
        }
        if (!options.sessionPublisherPresence) {
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "unsupported",
            });
            return;
        }
        try {
            const result = await options.sessionPublisherPresence.captureMachineSessionTerminal({
                binding: {
                    accountId: userId,
                    machineId,
                    sessionId: parsed.data.sessionId,
                },
            });
            callback?.(result.status === "captured"
                ? {
                    v: 1,
                    status: "captured",
                    sessionId: parsed.data.sessionId,
                    authority: result.target.authority.kind === "generation"
                        ? {
                            kind: "generation",
                            publisherGeneration: result.target.authority.publisherGeneration.toString(),
                        }
                        : {
                            kind: "legacy-heartbeat",
                            committedFenceMs: result.target.authority.committedFence.getTime(),
                        },
                }
                : result.status === "rejected"
                    ? {
                        v: 1,
                        status: "rejected",
                        sessionId: parsed.data.sessionId,
                        // The domain's missing machine binding is an authorization
                        // denial at this existing wire boundary.
                        reason: result.reason === "machine_control_unavailable"
                            ? "unauthorized"
                            : result.reason,
                    }
                    : {
                        v: 1,
                        status: "already_inactive",
                        sessionId: parsed.data.sessionId,
                    });
        } catch {
            log({
                module: "websocket",
                level: "error",
                event: MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
                errorCode: "internal_error",
            }, "Machine Session terminal capture failed.");
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "internal_error",
            });
        }
    });

    socket.on(MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1, async (
        request: unknown,
        callback?: (response: MachineSessionTerminalFinalizeResponseV1) => void,
    ) => {
        const parsed = MachineSessionTerminalFinalizeRequestV1Schema.safeParse(request);
        const machineId = readAuthenticatedMachineId(socket);
        if (!parsed.success) {
            callback?.({ v: 1, status: "rejected", reason: "invalid_request" });
            return;
        }
        if (!machineId) {
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "wrong_machine_socket",
            });
            return;
        }
        if (!options.sessionPublisherPresence) {
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "unsupported",
            });
            return;
        }
        try {
            const result = await options.sessionPublisherPresence.finalizeMachineSessionTerminal({
                target: {
                    binding: {
                        accountId: userId,
                        machineId,
                        sessionId: parsed.data.sessionId,
                    },
                    authority: parsed.data.authority.kind === "generation"
                        ? {
                            kind: "generation",
                            publisherGeneration: BigInt(parsed.data.authority.publisherGeneration),
                        }
                        : {
                            kind: "legacy-heartbeat",
                            committedFence: new Date(parsed.data.authority.committedFenceMs),
                        },
                },
            });
            if (result.status === "closed") {
                await publishSessionPublisherClose({
                    sessionId: parsed.data.sessionId,
                    publisherAccountId: userId,
                    closed: result,
                });
            }
            callback?.(result.status === "rejected"
                ? {
                    v: 1,
                    status: "rejected",
                    sessionId: parsed.data.sessionId,
                    reason: result.reason,
                }
                : {
                    v: 1,
                    status: result.status === "closed_replay"
                        ? "already_inactive"
                        : result.status,
                    sessionId: parsed.data.sessionId,
                });
        } catch {
            log({
                module: "websocket",
                level: "error",
                event: MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
                errorCode: "internal_error",
            }, "Machine Session terminal finalize failed.");
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "internal_error",
            });
        }
    });

    const handleActionOperationSnapshotPush = async (raw: unknown) => {
        try {
            if (!await hasCurrentSocketCredential(userId, socket)) return;
            const account = await db.account.findUnique({ where: { id: userId }, select: { encryptionMode: true } });
            if (!account) return;
            const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
            if (mode.status !== 'ready') return;
            const payload = projectActionOperationSnapshotPush(raw, readAuthenticatedMachineId(socket), {
                accountId: userId, encryptionMode: mode.mode,
            });
            if (!payload || !await hasCurrentSocketCredential(userId, socket)) return;
            eventRouter.emitEphemeral({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });
        } catch {
            // Unavailable Account admission cannot disclose an operation observation.
        }
    };
    socket.on(ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1, handleActionOperationSnapshotPush);
    socket.on(ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, handleActionOperationSnapshotPush);

    socket.on(EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1, async (
        command: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const machineId = readAuthenticatedMachineId(socket);
        if (!machineId) {
            callback?.({
                v: 1,
                kind: "error",
                errorCode: "wrong_machine_socket",
                message: "Historical import requires an authenticated machine socket.",
            });
            return;
        }
        try {
            if (!(await isMachineAvailableForSocket(userId, machineId))) {
                activityCache.invalidateMachine(machineId);
                callback?.({
                    v: 1,
                    kind: "error",
                    errorCode: "wrong_machine_socket",
                    message: "Historical import requires a current machine socket.",
                });
                return;
            }
            if (!options.operationSocketBatchLimits.ok) {
                callback?.({
                    v: 1,
                    kind: "error",
                    errorCode: options.operationSocketBatchLimits.errorCode,
                    message: "Historical import exceeds the live socket capacity.",
                });
                return;
            }
            callback?.(await executeExternalSessionHistoricalImportCommand({
                actorUserId: userId,
                transportMachineId: machineId,
                command,
                limits: options.operationSocketBatchLimits.limits,
            }));
        } catch {
            log(
                {
                    module: "websocket",
                    level: "error",
                    event: EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1,
                    errorCode: "internal_error",
                },
                "External Session historical import command failed.",
            );
            callback?.({
                v: 1,
                kind: "error",
                errorCode: "internal_error",
                message: "Historical import command failed.",
            });
        }
    });

    socket.on('machine-alive', async (data: {
        machineId?: string;
        time: number;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'machine-alive' });
            machineAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number') {
                return;
            }
            const machineId = resolveMachineScopedPayloadMachineId(socket, data.machineId);
            if (!machineId) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            if (!(await hasCurrentSocketCredential(userId, socket))) {
                return;
            }

            // Check machine validity using cache
            const isValid = await activityCache.isMachineValid(machineId, userId);
            if (!isValid) {
                return;
            }
            const recipientAccountIds = await inTx(async tx => {
                const machine = await tx.machine.findUnique({
                    where: { id: machineId },
                    select: { accountId: true, installationId: true, revokedAt: true, replacedByMachineId: true },
                });
                if (!machine) return null;
                if (machine.installationId === null) {
                    // Released uninstalled custodian daemons have no installation
                    // proof. This adapter retains only their owned heartbeat;
                    // installed publishers always consume C41 admission below.
                    if (machine.accountId !== userId || classifyMachineAvailabilityState(machine) !== 'available') return null;
                } else {
                    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: userId, machineId });
                    if (admission.kind !== 'admitted' || admission.custodianAccountId !== userId
                        || !hasCurrentMachineSocketInstallation(socket, admission.installationId)) return null;
                }
                return await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId);
            });
            if (!recipientAccountIds) {
                activityCache.invalidateMachine(machineId);
                return;
            }

            // Queue database update (will only update if time difference is significant)
            await recordMachineAlive({ accountId: userId, machineId, timestamp: t });

            const machineActivity = buildMachineActivityEphemeral(machineId, true, t);
            for (const accountId of recipientAccountIds) {
                eventRouter.emitEphemeral({
                    userId: accountId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' },
                });
            }
        } catch {
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: 'machine-alive',
                    errorCode: 'internal_error',
                },
                'Machine alive handling failed.',
            );
        }
    });

    socket.on(EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1, async (data: unknown) => {
        try {
            websocketEventsCounter.inc({ event_type: EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1 });

            const clientType = typeof (socket.data as any)?.clientType === 'string'
                ? (socket.data as any).clientType
                : '';
            const machineId = typeof (socket.data as any)?.machineId === 'string'
                ? (socket.data as any).machineId
                : '';
            if (clientType !== 'machine-scoped' || !machineId) {
                return;
            }

            const parsed = ExternalSessionTranscriptInvalidationV1Schema.safeParse(data);
            if (!parsed.success || parsed.data.binding.machineId !== machineId) {
                return;
            }
            if (!(await isMachineAvailableForSocket(userId, machineId))) {
                activityCache.invalidateMachine(machineId);
                return;
            }

            eventRouter.emitEphemeral({
                userId,
                payload: parsed.data,
                recipientFilter: {
                    type: 'all-interested-in-session',
                    sessionId: parsed.data.binding.sessionId,
                },
            });
        } catch {
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1,
                    errorCode: 'internal_error',
                },
                'External Session transcript invalidation handling failed.',
            );
        }
    });

    socket.on(EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1, async (data: unknown) => {
        try {
            websocketEventsCounter.inc({ event_type: EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1 });
            const clientType = typeof (socket.data as Record<string, unknown> | undefined)?.clientType === "string"
                ? (socket.data as Record<string, unknown>).clientType
                : "";
            const machineId = typeof (socket.data as Record<string, unknown> | undefined)?.machineId === "string"
                ? (socket.data as Record<string, unknown>).machineId as string
                : "";
            const parsed = ExternalSessionSourceUnavailableOccurrenceV1Schema.safeParse(data);
            if (clientType !== "machine-scoped" || !machineId || !parsed.success || parsed.data.machineId !== machineId) return;
            if (!(await isMachineAvailableForSocket(userId, machineId))) {
                activityCache.invalidateMachine(machineId);
                return;
            }
            const admitted = await inTx(async (tx) => {
                if (!(await hasCurrentSessionScopedMachineAccessInTx({
                    tx, accountId: userId, machineId, sessionId: parsed.data.sessionId,
                }))) return false;
                // Synchronize the committed content-free fact, not a background
                // notification decision. The router qualifies each live socket's
                // credential; Activity then applies its current Follow and policy.
                const recipients = await resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: parsed.data.sessionId });
                for (const recipientAccountId of recipients) {
                    scheduleSessionPersonalEvent(tx, recipientAccountId, {
                        type: 'session-personal-event',
                        sessionId: parsed.data.sessionId,
                        event: 'source_unavailable',
                        eventId: JSON.stringify([parsed.data.machineId, parsed.data.observedAtMs]),
                    });
                }
                return true;
            });
            if (!admitted) return;
            // The daemon emits only after its canonical status metadata write
            // commits. Recipient access, Follow and policy are rechecked by the
            // Activity owner at submission time.
            scheduleSessionActivityRemoteAlerts({
                sessionId: parsed.data.sessionId,
                event: "source_unavailable",
            });
        } catch {
            log({ module: "websocket", level: "error", event: EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1, errorCode: "internal_error" },
                "External Session source-unavailable occurrence handling failed.");
        }
    });

    // The authenticated daemon replaces its full content-free operation capability
    // projection here. This is deliberately separate from encrypted daemonState and
    // has no merge behavior: omission withdraws an older leaf.
    socket.on(MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, async (
        request: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const parsed = MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.safeParse(request);
        const machineId = parsed.success
            ? resolveMachineScopedPayloadMachineId(socket, parsed.data.machineId)
            : null;
        if (!parsed.success || !machineId) {
            callback?.({ v: 1, result: 'error', code: 'invalid_request' });
            return;
        }

        try {
            // Credential verification uses the Auth owner's database reader.
            // Complete it before opening a write transaction so it cannot wait
            // on a connection held by that same transaction.
            if (!await hasCurrentSocketCredential(userId, socket)) {
                callback?.({ v: 1, result: 'error', code: 'machine_unavailable' });
                socket.disconnect(true);
                return;
            }
            await inTx(async (tx) => {
                const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: userId, machineId });
                if (admission.kind !== 'admitted'
                    || admission.custodianAccountId !== userId
                    || !hasCurrentMachineSocketInstallation(socket, admission.installationId)) {
                    afterTx(tx, () => callback?.({ v: 1, result: 'error', code: 'machine_unavailable' }));
                    return null;
                }
                const machine = await tx.machine.findFirst({
                    where: { accountId: admission.custodianAccountId, id: machineId, installationId: admission.installationId },
                    select: {
                        operationProtocolCapabilitiesRevision: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                    },
                });
                if (!machine || classifyMachineAvailabilityState(machine) !== 'available') {
                    afterTx(tx, () => callback?.({
                        v: 1,
                        result: 'error',
                        code: 'machine_unavailable',
                    }));
                    return null;
                }
                const expectedRevision = machine.operationProtocolCapabilitiesRevision;
                const nextRevision = (expectedRevision ?? 0) + 1;
                const { count } = await tx.machine.updateMany({
                    where: {
                        accountId: userId,
                        id: machineId,
                        installationId: admission.installationId,
                        revokedAt: null,
                        replacedByMachineId: null,
                        operationProtocolCapabilitiesRevision: expectedRevision,
                    },
                    data: {
                        operationProtocolCapabilities: parsed.data.capabilities,
                        operationProtocolCapabilitiesRevision: nextRevision,
                    },
                });
                if (count !== 1) {
                    const fresh = await tx.machine.findFirst({
                        where: { accountId: userId, id: machineId },
                        select: { revokedAt: true, replacedByMachineId: true, installationId: true },
                    });
                    afterTx(tx, () => callback?.({
                        v: 1,
                        result: 'error',
                        code: classifyMachineAvailabilityState(fresh) === 'available'
                            && fresh?.installationId === admission.installationId
                            ? 'internal_error'
                            : 'machine_unavailable',
                    }));
                    return null;
                }

                for (const accountId of await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId)) {
                    await markAccountChanged(tx, { accountId, kind: 'machine', entityId: machineId });
                }
                afterTx(tx, () => callback?.({
                    v: 1,
                    result: 'success',
                    revision: nextRevision,
                }));
                return null;
            });
        } catch {
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
                    errorCode: 'internal_error',
                },
                'Machine operation protocol capability update failed.',
            );
            callback?.({ v: 1, result: 'error', code: 'internal_error' });
        }
    });

    // Machine metadata update with optimistic concurrency control
    socket.on('machine-update-metadata', async (
        data: unknown,
        callback: (response: MachineUpdateMetadataResponse) => void,
    ) => {
        try {
            const parsed = MachineUpdateMetadataRequestSchema.safeParse(data);
            const machineId = parsed.success
                ? resolveMachineMetadataTarget(socket, parsed.data.machineId)
                : null;

            // Validate input
            if (!parsed.success || !machineId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }
            const { metadata, expectedVersion, expectedDataEncryptionKey } = parsed.data;

            if (!await hasCurrentSocketCredential(userId, socket)) {
                callback?.({ result: 'error', message: 'Forbidden' });
                socket.disconnect(true);
                return;
            }
            await inTx(async (tx) => {
                // Metadata is an offline content edit, not installation execution admission.
                // The canonical access owner keeps a legacy owner's nullable installation valid.
                const admission = await resolveMachineAccessInTx(tx, { actorAccountId: userId, machineId });
                if (!admission || admission.role !== 'manage' || admission.accessState !== 'ready') {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Forbidden' }));
                    return null;
                }
                const machine = await tx.machine.findFirst({
                    where: { accountId: admission.custodianAccountId, id: machineId, installationId: admission.installationId },
                    select: {
                        metadataVersion: true,
                        daemonStateVersion: true,
                        metadata: true,
                        daemonState: true,
                        dataEncryptionKey: true,
                        installationId: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                    },
                });
                if (!machine) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                    return null;
                }
                const machineState = classifyMachineAvailabilityState(machine);
                if (machineState === "revoked") {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                    return null;
                }
                if (machineState === "replaced") {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
                    return null;
                }
                if (!hasCurrentMachineSocketInstallation(socket, machine.installationId)) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine installation changed' }));
                    return null;
                }
                if (encodedMachineEnvelope(machine.dataEncryptionKey) !== expectedDataEncryptionKey) {
                    afterTx(tx, () => callback?.({ result: 'key-mismatch' }));
                    return null;
                }
                const upgradeRequired =
                    readMarkedMachineSocketUpgradeRequired(
                        socket,
                        machine.dataEncryptionKey,
                    );
                if (upgradeRequired) {
                    afterTx(tx, () => callback?.(upgradeRequired));
                    return null;
                }
                if (!machineStoredContentMatchesAccountMode({
                    mode: admission.encryptionMode,
                    dataEncryptionKey: machine.dataEncryptionKey,
                    metadata,
                }) || (admission.encryptionMode === 'plain' && !isSafePlainMachinePublication(metadata, machine.daemonState))) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Invalid parameters' }));
                    return null;
                }

                if (machine.metadataVersion !== expectedVersion) {
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: machine.metadataVersion, metadata: machine.metadata }));
                    return null;
                }

                const { count } = await tx.machine.updateMany({
                    where: {
                        accountId: admission.custodianAccountId, id: machineId, metadataVersion: expectedVersion,
                        dataEncryptionKey: machine.dataEncryptionKey, installationId: machine.installationId,
                        revokedAt: null, replacedByMachineId: null,
                    },
                    data: { metadata, metadataVersion: expectedVersion + 1 },
                });

                if (count === 0) {
                    const fresh = await tx.machine.findFirst({
                        where: { accountId: admission.custodianAccountId, id: machineId },
                        select: { metadataVersion: true, metadata: true, dataEncryptionKey: true, installationId: true, revokedAt: true, replacedByMachineId: true },
                    });
                    const freshState = classifyMachineAvailabilityState(fresh);
                    if (freshState === "revoked") {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                        return null;
                    }
                    if (freshState === "replaced") {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
                        return null;
                    }
                    if (!fresh) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                        return null;
                    }
                    if (fresh.installationId !== admission.installationId
                        || !hasCurrentMachineSocketInstallation(socket, fresh.installationId)) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine installation changed' }));
                        return null;
                    }
                    if (encodedMachineEnvelope(fresh.dataEncryptionKey) !== expectedDataEncryptionKey) {
                        afterTx(tx, () => callback?.({ result: 'key-mismatch' }));
                        return null;
                    }
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: fresh.metadataVersion, metadata: fresh.metadata }));
                    return null;
                }

                const metadataUpdate = { value: metadata, version: expectedVersion + 1 };
                const child = await readMachineDevcontainerChildInTx(tx, machineId);
                for (const accountId of await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId)) {
                    const access = await resolveMachineAccessInTx(tx, { actorAccountId: accountId, machineId });
                    const devcontainerChild = access?.accessState === 'ready' ? child : null;
                    const cursor = await markAccountChanged(tx, { accountId, kind: 'machine', entityId: machineId });
                    afterTx(tx, () => {
                        const updatePayload = buildUpdateMachineUpdate(machineId, cursor, randomKeyNaked(12), metadataUpdate, undefined, {
                            keyBasis: serializeMachineKeyBasis({ ...machine, metadataVersion: expectedVersion + 1 }),
                            devcontainerChild,
                        });
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload: updatePayload,
                            recipientFilter: { type: 'machine-scoped-only', machineId },
                        });
                    });
                }
                afterTx(tx, () => callback?.({ result: 'success', version: expectedVersion + 1, metadata }));
                return null;
            });
        } catch {
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: 'machine-update-metadata',
                    errorCode: 'internal_error',
                },
                'Machine metadata update failed.',
            );
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Machine daemon state update with optimistic concurrency control
    socket.on('machine-update-state', async (data: unknown, callback: (response: MachineUpdateStateResponse) => void) => {
        try {
            const parsed = MachineUpdateStateRequestSchema.safeParse(data);
            const machineId = parsed.success ? resolveMachineScopedPayloadMachineId(socket, parsed.data.machineId) : null;

            // Validate input
            if (!parsed.success || !machineId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }
            const { daemonState, expectedVersion, expectedDataEncryptionKey } = parsed.data;

            if (!await hasCurrentSocketCredential(userId, socket)) {
                callback?.({ result: 'error', message: 'Forbidden' });
                socket.disconnect(true);
                return;
            }
            await inTx(async (tx) => {
                const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: userId, machineId });
                if (admission.kind !== 'admitted'
                    || admission.custodianAccountId !== userId
                    || !hasCurrentMachineSocketInstallation(socket, admission.installationId)) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Forbidden' }));
                    return null;
                }
                const machine = await tx.machine.findFirst({
                    where: { accountId: admission.custodianAccountId, id: machineId, installationId: admission.installationId },
                    select: {
                        daemonStateVersion: true,
                        metadataVersion: true,
                        daemonState: true,
                        metadata: true,
                        dataEncryptionKey: true,
                        installationId: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                    },
                });
                if (!machine) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                    return null;
                }
                const machineState = classifyMachineAvailabilityState(machine);
                if (machineState === "revoked") {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                    return null;
                }
                if (machineState === "replaced") {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
                    return null;
                }
                if (!hasCurrentMachineSocketInstallation(socket, machine.installationId)) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine installation changed' }));
                    return null;
                }
                if (encodedMachineEnvelope(machine.dataEncryptionKey) !== expectedDataEncryptionKey) {
                    afterTx(tx, () => callback?.({ result: 'key-mismatch' }));
                    return null;
                }
                const upgradeRequired =
                    readMarkedMachineSocketUpgradeRequired(
                        socket,
                        machine.dataEncryptionKey,
                    );
                if (upgradeRequired) {
                    afterTx(tx, () => callback?.(upgradeRequired));
                    return null;
                }
                if (!machineUpdateMatchesStoredMode({ dataEncryptionKey: machine.dataEncryptionKey, daemonState })
                    || !machineStoredContentMatchesAccountMode({
                    mode: admission.encryptionMode,
                    metadata: machine.metadata,
                    daemonState,
                    dataEncryptionKey: machine.dataEncryptionKey,
                    storedRead: true,
                }) || (admission.encryptionMode === 'plain' && !isSafePlainMachinePublication(machine.metadata, daemonState))) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Invalid parameters' }));
                    return null;
                }

                if (machine.daemonStateVersion !== expectedVersion) {
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: machine.daemonStateVersion, daemonState: machine.daemonState }));
                    return null;
                }

                const activeAt = Date.now();
                const { count } = await tx.machine.updateMany({
                    where: {
                        accountId: userId, id: machineId, daemonStateVersion: expectedVersion,
                        dataEncryptionKey: machine.dataEncryptionKey, installationId: machine.installationId,
                        revokedAt: null, replacedByMachineId: null,
                    },
                    data: {
                        daemonState,
                        daemonStateVersion: expectedVersion + 1,
                        active: true,
                        lastActiveAt: new Date(activeAt),
                    },
                });

                if (count === 0) {
                    const fresh = await tx.machine.findFirst({
                        where: { accountId: userId, id: machineId },
                        select: { daemonStateVersion: true, daemonState: true, dataEncryptionKey: true, installationId: true, revokedAt: true, replacedByMachineId: true },
                    });
                    const freshState = classifyMachineAvailabilityState(fresh);
                    if (freshState === "revoked") {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                        return null;
                    }
                    if (freshState === "replaced") {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
                        return null;
                    }
                    if (!fresh) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                        return null;
                    }
                    if (!hasCurrentMachineSocketInstallation(socket, fresh.installationId)) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine installation changed' }));
                        return null;
                    }
                    if (encodedMachineEnvelope(fresh.dataEncryptionKey) !== expectedDataEncryptionKey) {
                        afterTx(tx, () => callback?.({ result: 'key-mismatch' }));
                        return null;
                    }
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: fresh.daemonStateVersion, daemonState: fresh.daemonState }));
                    return null;
                }

                const daemonStateUpdate = { value: daemonState, version: expectedVersion + 1 };
                const child = await readMachineDevcontainerChildInTx(tx, machineId);
                for (const accountId of await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId)) {
                    const access = await resolveMachineAccessInTx(tx, { actorAccountId: accountId, machineId });
                    const devcontainerChild = access?.accessState === 'ready' ? child : null;
                    const cursor = await markAccountChanged(tx, { accountId, kind: 'machine', entityId: machineId });
                    afterTx(tx, () => {
                        const updatePayload = buildUpdateMachineUpdate(
                            machineId, cursor, randomKeyNaked(12), undefined, daemonStateUpdate,
                            { active: true, activeAt, keyBasis: serializeMachineKeyBasis({ ...machine, daemonStateVersion: expectedVersion + 1 }), devcontainerChild },
                        );
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload: updatePayload,
                            recipientFilter: { type: 'machine-scoped-only', machineId },
                        });
                    });
                }
                afterTx(tx, () => callback?.({ result: 'success', version: expectedVersion + 1, daemonState }));
                return null;
            });
        } catch {
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: 'machine-update-state',
                    errorCode: 'internal_error',
                },
                'Machine state update failed.',
            );
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });
}
