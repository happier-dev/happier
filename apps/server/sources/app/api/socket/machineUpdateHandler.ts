import { machineAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildMachineActivityEphemeral, buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { Socket } from "socket.io";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { recordMachineAlive } from "@/app/presence/presenceRecorder";

export function machineUpdateHandler(userId: string, socket: Socket) {
    socket.on('machine-alive', async (data: {
        machineId: string;
        time: number;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'machine-alive' });
            machineAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.machineId) {
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
            const isValid = await activityCache.isMachineValid(data.machineId, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            await recordMachineAlive({ accountId: userId, machineId: data.machineId, timestamp: t });

            const machineActivity = buildMachineActivityEphemeral(data.machineId, true, t);
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in machine-alive: ${error}`);
        }
    });

    // Machine metadata update with optimistic concurrency control
    socket.on('machine-update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { machineId, metadata, expectedVersion } = data;

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
                    select: { metadataVersion: true, metadata: true },
                });
                if (!machine) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                    return null;
                }

                if (machine.metadataVersion !== expectedVersion) {
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: machine.metadataVersion, metadata: machine.metadata }));
                    return null;
                }

                const { count } = await tx.machine.updateMany({
                    where: { accountId: userId, id: machineId, metadataVersion: expectedVersion },
                    data: { metadata, metadataVersion: expectedVersion + 1 },
                });

                if (count === 0) {
                    const fresh = await tx.machine.findFirst({
                        where: { accountId: userId, id: machineId },
                        select: { metadataVersion: true, metadata: true },
                    });
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
            const { machineId, daemonState, expectedVersion } = data;

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
                    select: { daemonStateVersion: true, daemonState: true },
                });
                if (!machine) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                    return null;
                }

                if (machine.daemonStateVersion !== expectedVersion) {
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: machine.daemonStateVersion, daemonState: machine.daemonState }));
                    return null;
                }

                const { count } = await tx.machine.updateMany({
                    where: { accountId: userId, id: machineId, daemonStateVersion: expectedVersion },
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
                        select: { daemonStateVersion: true, daemonState: true },
                    });
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
