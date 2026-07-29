import {
    EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
    ExternalSessionStatusDemandReplaceV1Schema,
    isExternalSessionStatusDemandRevisionNewerV1,
    type ExternalSessionStatusDemandDaemonMessageV1,
    type ExternalSessionStatusDemandReplaceV1,
} from '@happier-dev/protocol';

import { getSocketRooms } from '../socketRooms';

type DemandSocket = Readonly<{
    id: string;
    data: Readonly<{ clientType?: string }>;
    on(event: string, listener: (payload?: unknown) => void): unknown;
}>;

type DemandIo = Readonly<{
    to(room: string): Readonly<{
        emit(
            event: typeof EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
            payload: ExternalSessionStatusDemandDaemonMessageV1,
        ): unknown;
    }>;
}>;

function machineRoom(userId: string, machineId: string): string {
    const room = getSocketRooms({
        userId,
        clientType: 'machine-scoped',
        machineId,
    }).find((candidate) => candidate.startsWith('machine:'));
    if (!room) throw new Error('Machine-scoped socket room unavailable');
    return room;
}

/**
 * Relays one UI connection's bounded replace-set to machine-scoped daemon rooms.
 * Socket.IO supplies the unforgeable connection id and disconnect lifecycle.
 */
export function externalSessionStatusDemandHandler(
    userId: string,
    socket: DemandSocket,
    deps: Readonly<{ io: DemandIo }>,
): void {
    if (socket.data.clientType !== 'user-scoped') return;

    let currentRevision: number | null = null;
    let currentMachineIds = new Set<string>();

    socket.on(EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1, (payload) => {
        const parsed = ExternalSessionStatusDemandReplaceV1Schema.safeParse(payload);
        if (!parsed.success) return;
        const message: ExternalSessionStatusDemandReplaceV1 = parsed.data;
        if (!isExternalSessionStatusDemandRevisionNewerV1(currentRevision, message.revision)) {
            return;
        }

        const entriesByMachineId = new Map<
            string,
            ExternalSessionStatusDemandReplaceV1['entries']
        >();
        for (const entry of message.entries) {
            const entries = entriesByMachineId.get(entry.machineId) ?? [];
            entries.push(entry);
            entriesByMachineId.set(entry.machineId, entries);
        }

        const nextMachineIds = new Set(entriesByMachineId.keys());
        const affectedMachineIds = [...new Set([
            ...currentMachineIds,
            ...nextMachineIds,
        ])].sort();
        for (const machineId of affectedMachineIds) {
            deps.io.to(machineRoom(userId, machineId)).emit(
                EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
                {
                    v: 1,
                    type: 'replace',
                    clientConnectionId: socket.id,
                    revision: message.revision,
                    entries: (entriesByMachineId.get(machineId) ?? []).map((entry) => ({
                        sessionId: entry.sessionId,
                        linkGeneration: entry.linkGeneration,
                        demand: entry.demand,
                    })),
                },
            );
        }
        currentRevision = message.revision;
        currentMachineIds = nextMachineIds;
    });

    socket.on('disconnect', () => {
        for (const machineId of [...currentMachineIds].sort()) {
            deps.io.to(machineRoom(userId, machineId)).emit(
                EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
                {
                    v: 1,
                    type: 'disconnect',
                    clientConnectionId: socket.id,
                },
            );
        }
        currentMachineIds.clear();
    });
}
