import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
    SimulatorPreviewActionResultV1,
    SimulatorPreviewSnapshotV1,
} from '@happier-dev/protocol';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

function createRegistrar(): { handlers: Map<string, (payload: unknown) => Promise<unknown>>; registrar: RpcHandlerRegistrar } {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method, handler) {
                handlers.set(method, handler as (payload: unknown) => Promise<unknown>);
            },
        },
    };
}

describe('daemon simulator preview rpc handlers', () => {
    it('serves simulator snapshots and actions over machine rpc', async () => {
        const module = await import('./daemonSimulatorPreview').catch(() => null);

        expect(module?.registerDaemonSimulatorPreviewHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonSimulatorPreviewHandlers) return;

        const snapshot: SimulatorPreviewSnapshotV1 = {
            v: 1,
            machineId: 'machine_1',
            generatedAt: 1_000,
            refreshState: 'idle',
            resources: [],
            diagnostics: [],
        };
        const result: SimulatorPreviewActionResultV1 = {
            v: 1,
            eventType: 'simulator.devices.list',
            status: 'accepted',
            diagnostics: [],
        };
        const { handlers, registrar } = createRegistrar();
        module.registerDaemonSimulatorPreviewHandlers(registrar, {
            simulatorPreview: {
                getSnapshot: async () => snapshot,
                dispatchAction: async () => result,
            },
        });

        expect((RPC_METHODS as Record<string, string>).DAEMON_SIMULATOR_PREVIEW_SNAPSHOT)
            .toBe('daemon.devices.simulator.preview.snapshot');
        expect((RPC_METHODS as Record<string, string>).DAEMON_SIMULATOR_PREVIEW_ACTION)
            .toBe('daemon.devices.simulator.preview.action');
        await expect(handlers.get(RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT)?.({
            machineId: 'machine_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot,
        });
        await expect(handlers.get(RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_ACTION)?.({
            protocolVersion: 1,
            machineId: 'machine_1',
            event: { type: 'simulator.devices.list' },
        })).resolves.toEqual({
            protocolVersion: 1,
            result,
        });
    });
});
