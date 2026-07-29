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
    EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1,
    ExternalSessionTranscriptInvalidationV1Schema,
    MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
    MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
    MachineSessionTerminalCaptureRequestV1Schema,
    MachineSessionTerminalFinalizeRequestV1Schema,
    type ExternalSessionOperationSocketBatchLimitResolutionV1,
} from "@happier-dev/protocol";
import { executeExternalSessionHistoricalImportCommand } from "@/app/session/externalSessionHistoricalImportCommand";
import type { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { publishSessionPublisherClose } from "@/app/presence/publishSessionPublisherClose";

function readAuthenticatedMachineId(socket: Socket): string | null {
    const clientType = typeof (socket.data as any)?.clientType === 'string'
        ? (socket.data as any).clientType
        : '';
    const machineId = typeof (socket.data as any)?.machineId === 'string'
        ? (socket.data as any).machineId
        : '';
    return clientType === 'machine-scoped' && machineId ? machineId : null;
}

function resolveMachineScopedPayloadMachineId(socket: Socket, payloadMachineId: unknown): string | null {
    const authenticatedMachineId = readAuthenticatedMachineId(socket);
    if (!authenticatedMachineId) return null;
    if (typeof payloadMachineId === 'string' && payloadMachineId && payloadMachineId !== authenticatedMachineId) {
        return null;
    }
    return authenticatedMachineId;
}

async function isMachineAvailableForSocket(accountId: string, machineId: string): Promise<boolean> {
    const machine = await db.machine.findFirst({
        where: { accountId, id: machineId },
        select: { revokedAt: true, replacedByMachineId: true },
    });
    return Boolean(machine && !machine.revokedAt && !machine.replacedByMachineId);
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
    }>,
) {
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
                    committedFenceMs: result.target.committedFence.getTime(),
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
                    committedFence: new Date(parsed.data.committedFenceMs),
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

    // Machine metadata update with optimistic concurrency control
    socket.on('machine-update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { metadata, expectedVersion } = data;
            const machineId = resolveMachineScopedPayloadMachineId(socket, data?.machineId);

            // Validate input
            if (!machineId || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            await inTx(async (tx) => {
                const machine = await tx.machine.findFirst({
                    where: { accountId: userId, id: machineId },
                    select: { metadataVersion: true, metadata: true, revokedAt: true, replacedByMachineId: true },
                });
                if (!machine) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                    return null;
                }
                if (machine.revokedAt) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                    return null;
                }
                if (machine.replacedByMachineId) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
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
                    if (fresh?.revokedAt) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                        return null;
                    }
                    if (fresh?.replacedByMachineId) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
                        return null;
                    }
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: fresh?.metadataVersion ?? expectedVersion, metadata: fresh?.metadata }));
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
                    select: { daemonStateVersion: true, daemonState: true, revokedAt: true, replacedByMachineId: true },
                });
                if (!machine) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                    return null;
                }
                if (machine.revokedAt) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                    return null;
                }
                if (machine.replacedByMachineId) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
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
                    if (fresh?.revokedAt) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                        return null;
                    }
                    if (fresh?.replacedByMachineId) {
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
