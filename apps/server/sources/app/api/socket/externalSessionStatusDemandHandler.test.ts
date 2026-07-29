import { describe, expect, it, vi } from 'vitest';
import {
    EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
    type ExternalSessionStatusDemandDaemonMessageV1,
} from '@happier-dev/protocol';

import { externalSessionStatusDemandHandler } from './externalSessionStatusDemandHandler';

function createHarness(clientType: 'user-scoped' | 'machine-scoped' = 'user-scoped') {
    const listeners = new Map<string, (payload?: unknown) => void>();
    const emitted: Array<{
        room: string;
        event: string;
        payload: ExternalSessionStatusDemandDaemonMessageV1;
    }> = [];
    const socket = {
        id: 'socket-1',
        data: { clientType },
        on: vi.fn((event: string, listener: (payload?: unknown) => void) => {
            listeners.set(event, listener);
        }),
    };
    const io = {
        to: vi.fn((room: string) => ({
            emit: (event: string, payload: ExternalSessionStatusDemandDaemonMessageV1) => {
                emitted.push({ room, event, payload });
            },
        })),
    };

    externalSessionStatusDemandHandler('user-1', socket, { io });
    return { listeners, emitted, socket, io };
}

describe('externalSessionStatusDemandHandler', () => {
    it('partitions one authenticated user replace-set into one batched message per machine', () => {
        const harness = createHarness();
        harness.listeners.get(EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1)?.({
            v: 1,
            type: 'replace',
            revision: 4,
            entries: [
                {
                    sessionId: 'session-1',
                    machineId: 'machine-1',
                    linkGeneration: 'generation-1',
                    demand: 'visible',
                },
                {
                    sessionId: 'session-2',
                    machineId: 'machine-1',
                    linkGeneration: 'generation-2',
                    demand: 'loaded',
                },
                {
                    sessionId: 'session-3',
                    machineId: 'machine-2',
                    linkGeneration: 'generation-3',
                    demand: 'open',
                },
            ],
        });

        expect(harness.emitted).toEqual([
            {
                room: 'machine:machine-1:user-1',
                event: EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
                payload: {
                    v: 1,
                    type: 'replace',
                    clientConnectionId: 'socket-1',
                    revision: 4,
                    entries: [
                        {
                            sessionId: 'session-1',
                            linkGeneration: 'generation-1',
                            demand: 'visible',
                        },
                        {
                            sessionId: 'session-2',
                            linkGeneration: 'generation-2',
                            demand: 'loaded',
                        },
                    ],
                },
            },
            {
                room: 'machine:machine-2:user-1',
                event: EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
                payload: {
                    v: 1,
                    type: 'replace',
                    clientConnectionId: 'socket-1',
                    revision: 4,
                    entries: [{
                        sessionId: 'session-3',
                        linkGeneration: 'generation-3',
                        demand: 'open',
                    }],
                },
            },
        ]);
    });

    it('relays disconnect cleanup to every machine touched by the latest valid set', () => {
        const harness = createHarness();
        const listener = harness.listeners.get(EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1);
        listener?.({
            v: 1,
            type: 'replace',
            revision: 1,
            entries: [
                {
                    sessionId: 'session-1',
                    machineId: 'machine-1',
                    linkGeneration: 'generation-1',
                    demand: 'visible',
                },
                {
                    sessionId: 'session-2',
                    machineId: 'machine-2',
                    linkGeneration: 'generation-1',
                    demand: 'visible',
                },
            ],
        });
        harness.listeners.get('disconnect')?.();

        expect(harness.emitted.slice(2)).toEqual([
            {
                room: 'machine:machine-1:user-1',
                event: EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
                payload: {
                    v: 1,
                    type: 'disconnect',
                    clientConnectionId: 'socket-1',
                },
            },
            {
                room: 'machine:machine-2:user-1',
                event: EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
                payload: {
                    v: 1,
                    type: 'disconnect',
                    clientConnectionId: 'socket-1',
                },
            },
        ]);
    });

    it('sends an empty same-revision replace when a client scroll removes its final link on a machine', () => {
        const harness = createHarness();
        const listener = harness.listeners.get(EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1);
        listener?.({
            v: 1,
            type: 'replace',
            revision: 1,
            entries: [{
                sessionId: 'session-1',
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
                demand: 'visible',
            }],
        });
        listener?.({
            v: 1,
            type: 'replace',
            revision: 2,
            entries: [],
        });

        expect(harness.emitted[1]).toEqual({
            room: 'machine:machine-1:user-1',
            event: EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
            payload: {
                v: 1,
                type: 'replace',
                clientConnectionId: 'socket-1',
                revision: 2,
                entries: [],
            },
        });
    });

    it('does not register on machine-scoped sockets and drops malformed or over-bound payloads', () => {
        const machineHarness = createHarness('machine-scoped');
        expect(machineHarness.socket.on).not.toHaveBeenCalled();

        const userHarness = createHarness();
        userHarness.listeners.get(EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1)?.({
            v: 1,
            type: 'replace',
            revision: 1,
            entries: Array.from({ length: 257 }, (_, index) => ({
                sessionId: `session-${index}`,
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
                demand: 'visible',
            })),
        });
        expect(userHarness.emitted).toEqual([]);
    });
});
