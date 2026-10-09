import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

// The daemon Resource RPC is the network boundary; the read client, admission and hook stay real.
const read = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machinePluginUiResourceRead: read,
}));

afterEach(() => { standardCleanup(); read.mockReset(); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

describe('managed image previews', () => {
    it('reads each declared preview from the controller and keeps only admitted PNGs', async () => {
        read.mockImplementation(async (_machineId: string, opts: { resource: { localId: string } }) => ({
            supported: true,
            result: opts.resource.localId === 'ubuntu-preview'
                ? { ok: true, contentType: 'image/png', digest: 'd', bytesBase64: PNG }
                : { ok: true, contentType: 'text/plain', digest: 'd', bytesBase64: 'aGk=' },
        }));
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
        expect(read).toHaveBeenCalledWith('controller', expect.objectContaining({
            serverId: 'server', expectedCallerOccurrenceId: 'occ-1', callerPluginId: 'happier.machine.lume',
        }));
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
});
