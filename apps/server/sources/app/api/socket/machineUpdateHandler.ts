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
    ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1,
    EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1,
    ExternalSessionTranscriptInvalidationV1Schema,
    MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
    MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
    SESSION_SERVER_START_INGRESS_EVENT_V1,
    MachineSessionTerminalCaptureRequestV1Schema,
    MachineSessionTerminalFinalizeRequestV1Schema,
    MachineUpdateMetadataRequestSchema,
    MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
    SessionPendingEnqueueByMachineRequestV1Schema,
    isPlainMachineDataKeyMarker,
    machineUpdateMatchesStoredMode,
    type ExternalSessionOperationSocketBatchLimitResolutionV1,
    type MachineUpdateMetadataResponse,
    type SessionServerStartIngressResponseV1,
} from "@happier-dev/protocol";
import { projectActionOperationSnapshotPush } from './actionOperationSnapshotPush';
import { enqueuePendingMessageByAuthenticatedMachine } from "@/app/session/pending/pendingMessageService";
import { executeExternalSessionHistoricalImportCommand } from "@/app/session/externalSessionHistoricalImportCommand";
import type { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { publishSessionPublisherClose } from "@/app/presence/publishSessionPublisherClose";
import {
    classifyMachineAvailabilityState,
    readMachineAvailabilityState,
} from "@/app/machines/machineStateGuards";
import {
    buildAccountStoredContentSocketUpgradeError,
    readAccountStoredContentCompatibilityForSocket,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";

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

    socket.on(SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, async (
        request: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const parsed = SessionPendingEnqueueByMachineRequestV1Schema.safeParse(request);
        const sourceMachineId = readAuthenticatedMachineId(socket);
        if (!parsed.success) {
            callback?.({
                v: 1,
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
                v: 1,
                result: { status: "rejected", code: "session_input_unauthorized" },
            });
            return;
        }

        try {
            const result = await enqueuePendingMessageByAuthenticatedMachine({
                accountId: userId,
                sourceMachineId,
                targetMachineId: parsed.data.targetMachineId,
                sessionId: parsed.data.sessionId,
                localId: parsed.data.localId,
                content: parsed.data.content,
                requestedAction: parsed.data.requestedAction,
                ...(parsed.data.requestEqualityEvidenceV1
                    ? { requestEqualityEvidenceV1: parsed.data.requestEqualityEvidenceV1 }
                    : {}),
            });
            callback?.({ v: 1, result });
        } catch {
            log({
                module: "websocket",
                level: "error",
                event: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
                errorCode: "internal_error",
            }, "Machine Session Pending enqueue failed.");
            callback?.({
                v: 1,
                result: {
                    status: "outcomeUnknown",
                    localId: parsed.data.localId,
                    code: "session_input_admission_acknowledgement_lost",
                },
            });
        }
    });

    socket.on(MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, async (
        request: unknown,
        callback?: (response: unknown) => void,
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
                        reason: result.reason,
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
        callback?: (response: unknown) => void,
    ) => {
        const parsed = MachineSessionTerminalFinalizeRequestV1Schema.safeParse(request);
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

    socket.on(ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1, (raw: unknown) => {
        const payload = projectActionOperationSnapshotPush(raw, readAuthenticatedMachineId(socket));
        if (!payload) return;
        eventRouter.emitEphemeral({
            userId,
            payload,
            recipientFilter: { type: 'user-scoped-only' },
        });
    });

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

            // Check machine validity using cache
            const isValid = await activityCache.isMachineValid(machineId, userId);
            if (!isValid) {
                return;
            }
            if (!(await isMachineAvailableForSocket(userId, machineId))) {
                activityCache.invalidateMachine(machineId);
                return;
            }

            // Queue database update (will only update if time difference is significant)
            await recordMachineAlive({ accountId: userId, machineId, timestamp: t });

            const machineActivity = buildMachineActivityEphemeral(machineId, true, t);
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
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
            await inTx(async (tx) => {
                const machine = await tx.machine.findFirst({
                    where: { accountId: userId, id: machineId },
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
                        select: { revokedAt: true, replacedByMachineId: true },
                    });
                    afterTx(tx, () => callback?.({
                        v: 1,
                        result: 'error',
                        code: classifyMachineAvailabilityState(fresh) === 'available'
                            ? 'internal_error'
                            : 'machine_unavailable',
                    }));
                    return null;
                }

                await markAccountChanged(tx, {
                    accountId: userId,
                    kind: 'machine',
                    entityId: machineId,
                });
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
            const { metadata, expectedVersion } = parsed.data;

            await inTx(async (tx) => {
                const machine = await tx.machine.findFirst({
                    where: { accountId: userId, id: machineId },
                    select: {
                        metadataVersion: true,
                        metadata: true,
                        dataEncryptionKey: true,
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
                const upgradeRequired =
                    readMarkedMachineSocketUpgradeRequired(
                        socket,
                        machine.dataEncryptionKey,
                    );
                if (upgradeRequired) {
                    afterTx(tx, () => callback?.(upgradeRequired));
                    return null;
                }
                if (!machineUpdateMatchesStoredMode({
                    dataEncryptionKey: machine.dataEncryptionKey,
                    metadata,
                })) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Invalid parameters' }));
                    return null;
                }

                if (machine.metadataVersion !== expectedVersion) {
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: machine.metadataVersion, metadata: machine.metadata }));
                    return null;
                }

                const { count } = await tx.machine.updateMany({
                    where: { accountId: userId, id: machineId, metadataVersion: expectedVersion, revokedAt: null, replacedByMachineId: null },
                    data: { metadata, metadataVersion: expectedVersion + 1 },
                });

                if (count === 0) {
                    const fresh = await tx.machine.findFirst({
                        where: { accountId: userId, id: machineId },
                        select: { metadataVersion: true, metadata: true, revokedAt: true, replacedByMachineId: true },
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
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: fresh.metadataVersion, metadata: fresh.metadata }));
                    return null;
                }

                const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: machineId });
                const metadataUpdate = { value: metadata, version: expectedVersion + 1 };
                afterTx(tx, () => {
                    const updatePayload = buildUpdateMachineUpdate(machineId, cursor, randomKeyNaked(12), metadataUpdate);
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'machine-scoped-only', machineId }
                    });
                    callback?.({ result: 'success', version: expectedVersion + 1, metadata });
                });
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
    socket.on('machine-update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { daemonState, expectedVersion } = data;
            const machineId = resolveMachineScopedPayloadMachineId(socket, data?.machineId);

            // Validate input
            if (!machineId || typeof daemonState !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            await inTx(async (tx) => {
                const machine = await tx.machine.findFirst({
                    where: { accountId: userId, id: machineId },
                    select: {
                        daemonStateVersion: true,
                        daemonState: true,
                        dataEncryptionKey: true,
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
                const upgradeRequired =
                    readMarkedMachineSocketUpgradeRequired(
                        socket,
                        machine.dataEncryptionKey,
                    );
                if (upgradeRequired) {
                    afterTx(tx, () => callback?.(upgradeRequired));
                    return null;
                }
                if (!machineUpdateMatchesStoredMode({
                    dataEncryptionKey: machine.dataEncryptionKey,
                    daemonState,
                })) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Invalid parameters' }));
                    return null;
                }

                if (machine.daemonStateVersion !== expectedVersion) {
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: machine.daemonStateVersion, daemonState: machine.daemonState }));
                    return null;
                }

                const activeAt = Date.now();
                const { count } = await tx.machine.updateMany({
                    where: { accountId: userId, id: machineId, daemonStateVersion: expectedVersion, revokedAt: null, replacedByMachineId: null },
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
                        select: { daemonStateVersion: true, daemonState: true, revokedAt: true, replacedByMachineId: true },
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
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: fresh?.daemonStateVersion ?? expectedVersion, daemonState: fresh?.daemonState }));
                    return null;
                }

                const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: machineId });
                const daemonStateUpdate = { value: daemonState, version: expectedVersion + 1 };
                afterTx(tx, () => {
                    const updatePayload = buildUpdateMachineUpdate(
                        machineId,
                        cursor,
                        randomKeyNaked(12),
                        undefined,
                        daemonStateUpdate,
                        {
                            active: true,
                            activeAt,
                        },
                    );
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'machine-scoped-only', machineId }
                    });
                    callback?.({ result: 'success', version: expectedVersion + 1, daemonState });
                });
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
