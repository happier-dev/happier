import { machineAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
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
    ActionOperationRevisionEphemeralV1Schema,
    DirectSessionTranscriptDeltaEphemeralSchema,
    MachineUpdateMetadataRequestSchema,
    type MachineUpdateMetadataResponse,
} from "@happier-dev/protocol";
import { validateCurrentMachineSocket } from "@/app/machines/validateCurrentMachineSocket";
import { readHappierSocketData } from "./socketData";

function readAuthenticatedMachineId(socket: Socket): string | null {
    const clientType = typeof (socket.data as any)?.clientType === 'string'
        ? (socket.data as any).clientType
        : '';
    const machineId = typeof (socket.data as any)?.machineId === 'string'
        ? (socket.data as any).machineId
        : '';
    if (clientType !== 'machine-scoped' || !machineId) {
        return null;
    }
    return machineId;
}

function payloadMachineIdMatches(socketMachineId: string, payloadMachineId: unknown): boolean {
    return typeof payloadMachineId !== 'string' || !payloadMachineId || payloadMachineId === socketMachineId;
}

function resolveMachineMetadataTarget(
    socket: Socket,
    payloadMachineId: string | undefined,
): { ok: true; machineId: string } | { ok: false; message: string } {
    const { clientType, machineId: socketMachineId } = readHappierSocketData(socket);

    if (clientType === 'machine-scoped') {
        if (!socketMachineId) {
            return { ok: false, message: 'Machine-scoped socket required' };
        }
        if (!payloadMachineIdMatches(socketMachineId, payloadMachineId)) {
            return { ok: false, message: 'Machine id mismatch' };
        }
        return { ok: true, machineId: socketMachineId };
    }

    if (clientType === 'user-scoped' || clientType === undefined) {
        if (!payloadMachineId) {
            return { ok: false, message: 'Machine id required' };
        }
        return { ok: true, machineId: payloadMachineId };
    }

    return { ok: false, message: 'User- or machine-scoped socket required' };
}

export function machineUpdateHandler(userId: string, socket: Socket) {
    socket.on('machine-alive', async (data: {
        machineId?: string;
        time: number;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'machine-alive' });
            machineAliveEventsCounter.inc();

            const machineId = readAuthenticatedMachineId(socket);
            if (!machineId) {
                return;
            }

            // Basic validation
            if (!data || typeof data.time !== 'number') {
                return;
            }
            if (!payloadMachineIdMatches(machineId, data.machineId)) {
                log(
                    {
                        module: 'websocket',
                        level: 'warn',
                        socketMachineId: machineId,
                        payloadMachineId: data.machineId,
                    },
                    'Ignoring machine-alive for mismatched machine id',
                );
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

            const currentMachine = await validateCurrentMachineSocket({ accountId: userId, machineId });
            if (!currentMachine.ok) {
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
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in machine-alive: ${error}`);
        }
    });

    socket.on('direct-session-transcript-delta', async (data: unknown) => {
        try {
            websocketEventsCounter.inc({ event_type: 'direct-session-transcript-delta' });

            const clientType = typeof (socket.data as any)?.clientType === 'string'
                ? (socket.data as any).clientType
                : '';
            const machineId = typeof (socket.data as any)?.machineId === 'string'
                ? (socket.data as any).machineId
                : '';
            if (clientType !== 'machine-scoped' || !machineId) {
                return;
            }

            const parsed = DirectSessionTranscriptDeltaEphemeralSchema.safeParse(data);
            if (!parsed.success) {
                return;
            }

            eventRouter.emitEphemeral({
                userId,
                payload: parsed.data,
                recipientFilter: { type: 'all-interested-in-session', sessionId: parsed.data.sessionId },
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in direct-session-transcript-delta handler: ${error}`);
        }
    });

    socket.on('action-operation-updated', async (data: unknown) => {
        try {
            websocketEventsCounter.inc({ event_type: 'action-operation-updated' });
            const machineId = readAuthenticatedMachineId(socket);
            if (!machineId) return;
            const parsed = ActionOperationRevisionEphemeralV1Schema.safeParse(data);
            if (!parsed.success || parsed.data.machineId !== machineId) return;

            eventRouter.emitEphemeral({
                userId,
                payload: parsed.data,
                recipientFilter: { type: 'user-scoped-only' },
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in action-operation-updated handler: ${error}`);
        }
    });

    // Machine metadata update with optimistic concurrency control
    socket.on('machine-update-metadata', async (data: unknown, callback: (response: MachineUpdateMetadataResponse) => void) => {
        try {
            const parsed = MachineUpdateMetadataRequestSchema.safeParse(data);
            if (!parsed.success) {
                callback?.({ result: 'error', message: 'Invalid parameters' });
                return;
            }

            const { machineId: payloadMachineId, metadata, expectedVersion } = parsed.data;
            const target = resolveMachineMetadataTarget(socket, payloadMachineId);
            if (!target.ok) {
                log(
                    {
                        module: 'websocket',
                        level: 'warn',
                        socketMachineId: readHappierSocketData(socket).machineId,
                        payloadMachineId,
                    },
                    'Rejecting machine metadata update for socket scope',
                );
                callback?.({ result: 'error', message: target.message });
                return;
            }
            const machineId = target.machineId;

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
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in machine-update-metadata: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Machine daemon state update with optimistic concurrency control
    socket.on('machine-update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const authenticatedMachineId = readAuthenticatedMachineId(socket);
            if (!authenticatedMachineId) {
                callback?.({ result: 'error', message: 'Machine-scoped socket required' });
                return;
            }

            const { machineId: payloadMachineId, daemonState, expectedVersion } = data;
            if (!payloadMachineIdMatches(authenticatedMachineId, payloadMachineId)) {
                log(
                    {
                        module: 'websocket',
                        level: 'warn',
                        socketMachineId: authenticatedMachineId,
                        payloadMachineId,
                    },
                    'Rejecting machine daemon state update for mismatched machine id',
                );
                callback?.({ result: 'error', message: 'Machine id mismatch' });
                return;
            }
            const machineId = authenticatedMachineId;

            // Validate input
            if (typeof daemonState !== 'string' || typeof expectedVersion !== 'number') {
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

                const { count } = await tx.machine.updateMany({
                    where: { accountId: userId, id: machineId, daemonStateVersion: expectedVersion, revokedAt: null, replacedByMachineId: null },
                    data: {
                        daemonState,
                        daemonStateVersion: expectedVersion + 1,
                        active: true,
                        lastActiveAt: new Date(),
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
                    const updatePayload = buildUpdateMachineUpdate(machineId, cursor, randomKeyNaked(12), undefined, daemonStateUpdate);
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'machine-scoped-only', machineId }
                    });
                    callback?.({ result: 'success', version: expectedVersion + 1, daemonState });
                });
                return null;
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in machine-update-state: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });
}
