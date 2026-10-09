import { describe, expect, it, vi } from 'vitest';
import type { ServerFetch } from '@/sync/http/client';
import { createMachinePresetActionClient, MachinePresetActionError } from './managedMachinePresets';

describe('managed preset Action transport', () => {
    it('preserves revision conflicts and refusals from the captured Home transport', async () => {
        const request = vi.fn<ServerFetch>(async () => Response.json({ kind: 'conflict', currentRevision: 3 }, { status: 409 }));
        const client = createMachinePresetActionClient({ request });
        const signal = new AbortController().signal;
        await expect(client.execute('machines.presets.update', {
            homeId: 'srv_preset', id: 'preset-a', expectedRevision: 2, patch: { name: 'Draft' },
        }, { signal })).resolves.toEqual({ kind: 'conflict', currentRevision: 3 });
        expect(request).toHaveBeenCalledWith('/v1/machines/presets/update', expect.objectContaining({
            method: 'POST', body: JSON.stringify({ homeId: 'srv_preset', id: 'preset-a', expectedRevision: 2, patch: { name: 'Draft' } }), signal,
        }), { includeAuth: true });
        request.mockResolvedValueOnce(Response.json({ kind: 'refused', code: 'preset_not_found' }, { status: 404 }));
        await expect(client.execute('machines.presets.get', { homeId: 'srv_preset', id: 'preset-a' }))
            .resolves.toEqual({ kind: 'refused', code: 'preset_not_found' });
    });

    it('rejects executable extra fields before transport and malformed response payloads', async () => {
        const request = vi.fn<ServerFetch>(async () => Response.json({ kind: 'listed', presets: [], secret: 'untrusted' }));
        const client = createMachinePresetActionClient({ request });
        await expect(client.execute('machines.presets.list', { homeId: 'srv_preset', ...{ native: true } })).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
        await expect(client.execute('machines.presets.list', { homeId: 'srv_preset' })).rejects.toThrow();
        request.mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
        await expect(client.execute('machines.presets.list', { homeId: 'srv_preset' })).rejects.toMatchObject({
            name: 'MachinePresetActionError', status: 404,
        } satisfies Partial<MachinePresetActionError>);
    });
});
