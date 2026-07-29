import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    registerExternalSessionStatusDemandTransport,
    replaceExternalSessionStatusDemandViewport,
    resetExternalSessionStatusDemandCoordinatorForTests,
} from './externalSessionStatusDemandCoordinator';
import { EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 } from '@happier-dev/protocol';

describe('externalSessionStatusDemandCoordinator', () => {
    afterEach(() => {
        resetExternalSessionStatusDemandCoordinatorForTests();
    });

    it('unions viewport snapshots per existing server connection and emits one bounded replace', () => {
        const emitOne = vi.fn();
        const emitTwo = vi.fn();
        registerExternalSessionStatusDemandTransport('server-1', emitOne);
        registerExternalSessionStatusDemandTransport('server-2', emitTwo);

        replaceExternalSessionStatusDemandViewport('viewport-1', [
            {
                serverId: 'server-1',
                sessionId: 'session-1',
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
                demand: 'loaded',
            },
            {
                serverId: 'server-1',
                sessionId: 'session-1',
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
                demand: 'open',
            },
            {
                serverId: 'server-2',
                sessionId: 'session-2',
                machineId: 'machine-2',
                linkGeneration: 'generation-2',
                demand: 'visible',
            },
        ]);

        expect(emitOne).toHaveBeenCalledTimes(1);
        expect(emitOne.mock.calls[0]?.[1]).toMatchObject({
            entries: [{
                sessionId: 'session-1',
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
                demand: 'open',
            }],
        });
        expect(emitTwo).toHaveBeenCalledTimes(1);
    });

    it('keeps bounded viewports capped while retaining open and visible priorities', () => {
        const emit = vi.fn();
        registerExternalSessionStatusDemandTransport('server-1', emit);
        replaceExternalSessionStatusDemandViewport('viewport-1', [
            ...Array.from({ length: EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 }, (_, index) => ({
                serverId: 'server-1',
                sessionId: `loaded-${index}`,
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
                demand: 'loaded' as const,
            })),
        ]);
        replaceExternalSessionStatusDemandViewport('viewport-2', [
            ...Array.from({ length: 20 }, (_, index) => ({
                serverId: 'server-1',
                sessionId: `visible-${index}`,
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
                demand: 'visible' as const,
            })),
        ]);
        replaceExternalSessionStatusDemandViewport('viewport-3', [{
            serverId: 'server-1',
            sessionId: 'visible-0',
            machineId: 'machine-1',
            linkGeneration: 'generation-1',
            demand: 'open',
        }]);

        const payload = emit.mock.calls.at(-1)?.[1] as {
            entries: Array<{ demand: string; sessionId: string }>;
        };
        expect(payload.entries).toHaveLength(256);
        expect(payload.entries.filter((entry) => entry.sessionId.startsWith('visible-'))).toHaveLength(20);
        expect(payload.entries.find((entry) => entry.sessionId === 'visible-0')?.demand).toBe('open');
    });

    it('rejects an over-bound viewport before retaining or reconciling it', () => {
        const emit = vi.fn();
        registerExternalSessionStatusDemandTransport('server-1', emit);
        const entries = Array.from(
            { length: EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 + 1 },
            (_, index) => ({
                serverId: 'server-1',
                sessionId: `session-${index}`,
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
                demand: 'loaded' as const,
            }),
        );

        expect(() => replaceExternalSessionStatusDemandViewport('viewport-1', entries)).toThrow();
        expect(emit).not.toHaveBeenCalled();
    });

    it('resends a nonempty demand batch only when each machine transitions to active', () => {
        const emit = vi.fn();
        const transport = registerExternalSessionStatusDemandTransport('server-1', emit);
        replaceExternalSessionStatusDemandViewport('viewport-1', [{
            serverId: 'server-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            linkGeneration: 'generation-1',
            demand: 'visible',
        }]);

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0]?.[1]).toMatchObject({ revision: 1 });

        transport.observeEphemeral({
            type: 'activity',
            id: 'session-1',
            active: true,
            activeAt: 1,
        });
        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: 'true',
            activeAt: 1,
        });
        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 2,
        });
        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 3,
        });
        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit.mock.calls[1]?.[1]).toMatchObject({ revision: 2 });

        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: false,
            activeAt: 4,
        });
        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 5,
        });
        expect(emit).toHaveBeenCalledTimes(3);
        expect(emit.mock.calls[2]?.[1]).toMatchObject({ revision: 3 });

        replaceExternalSessionStatusDemandViewport('viewport-1', []);
        expect(emit).toHaveBeenCalledTimes(4);
        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: false,
            activeAt: 6,
        });
        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 7,
        });
        expect(emit).toHaveBeenCalledTimes(4);

        transport.dispose();
        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: false,
            activeAt: 8,
        });
        transport.observeEphemeral({
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 9,
        });
        expect(emit).toHaveBeenCalledTimes(4);
    });
});
