import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonPluginUiResourceReadRequestSchema, DaemonPluginUiResourceReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

// Substitute only the network; keep the Resource transport/parser and image admission real.
const read = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(read);
});

afterEach(() => { standardCleanup(); read.mockReset(); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

describe('managed image previews', () => {
    it('reads each declared preview from the controller and keeps only admitted PNGs', async () => {
        read.mockImplementation(async request => {
            expect(request).toMatchObject({ machineId: 'controller', serverId: 'server',
                method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ });
            const payload = DaemonPluginUiResourceReadRequestSchema.parse(request.payload);
            if (!('callerPluginId' in payload)) throw new Error('Expected a declared preview Resource');
            expect(payload).toMatchObject({ machineId: 'controller', expectedCallerOccurrenceId: 'occ-1',
                callerPluginId: 'happier.machine.lume' });
            const common = { ok: true, resource: payload.resource, kind: 'asset', digest: `sha256:${'a'.repeat(64)}` };
            return DaemonPluginUiResourceReadResponseSchema.parse(payload.resource.localId === 'ubuntu-preview'
                ? { ...common, contentType: 'image/png', bytesBase64: PNG }
                : { ...common, contentType: 'text/plain', bytesBase64: 'aGk=' });
        });
        const { useManagedImagePreviews } = await import('./useManagedImagePreviews');
        let seen: ReadonlyMap<string, { uri: string }> = new Map();
        function Probe() {
            seen = useManagedImagePreviews({ serverId: 'server', controllerMachineId: 'controller', pluginId: 'happier.machine.lume',
                occurrenceId: 'occ-1', requests: [
                    { imageId: 'ubuntu', resource: { pluginId: 'happier.machine.lume', localId: 'ubuntu-preview' } },
                    { imageId: 'debian', resource: { pluginId: 'happier.machine.lume', localId: 'debian-notes' } },
                ] });
            return null;
        }
        const screen = await renderScreen(<Probe />);
        await vi.waitFor(() => expect(seen.get('ubuntu')?.uri).toMatch(/^data:image\/png;base64,/));
        expect(seen.has('debian')).toBe(false);
        expect(seen.get('ubuntu')?.uri).toBe(`data:image/png;base64,${PNG}`);
        await screen.unmount();
    });

    it('reads nothing without a controller', async () => {
        const { useManagedImagePreviews } = await import('./useManagedImagePreviews');
        function Probe() {
            useManagedImagePreviews({ serverId: 'server', controllerMachineId: null, pluginId: 'p', occurrenceId: 'o',
                requests: [{ imageId: 'a', resource: { pluginId: 'p', localId: 'a' } }] });
            return null;
        }
        const screen = await renderScreen(<Probe />);
        expect(read).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('keeps malformed Resource replies out of image previews through the real strict transport reader', async () => {
        read.mockResolvedValue({ ok: true, resource: { pluginId: 'happier.machine.lume', localId: 'preview' },
            kind: 'asset', contentType: 'image/png', digest: `sha256:${'a'.repeat(64)}`, bytesBase64: PNG, unexpected: true });
        const { useManagedImagePreviews } = await import('./useManagedImagePreviews');
        const { renderHook, flushHookEffects } = await import('@/dev/testkit');
        const hook = await renderHook(() => useManagedImagePreviews({ serverId: 'server', controllerMachineId: 'controller',
            pluginId: 'happier.machine.lume', occurrenceId: 'occ-1',
            requests: [{ imageId: 'ubuntu', resource: { pluginId: 'happier.machine.lume', localId: 'preview' } }] }));
        await flushHookEffects();
        expect(read.mock.calls).toHaveLength(1);
        expect(hook.getCurrent().size).toBe(0);
        await hook.unmount();
    });
});
