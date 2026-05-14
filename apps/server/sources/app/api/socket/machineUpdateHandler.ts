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
import { ExternalSessionTranscriptDeltaEphemeralSchema } from "@happier-dev/protocol";

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

export function machineUpdateHandler(userId: string, socket: Socket) {
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

            const parsed = ExternalSessionTranscriptDeltaEphemeralSchema.safeParse(data);
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
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in machine-update-state: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });
}
