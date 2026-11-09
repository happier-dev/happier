import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { pictureStore } from '@/components/atmosphere/pictureStore.web';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';

// Exercise the real browser adapter over the IndexedDB system boundary.
vi.mock('@/components/atmosphere/pictureStore', async () => import('@/components/atmosphere/pictureStore.web'));

const machineTransport = vi.hoisted(() => vi.fn());
// Only the remote Machine transport is replaced; authorization routing and the Settings adapter remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineTransport }));

import { createAtmosphereSettingServices } from './atmosphereSettingServices';

describe('atmosphere Settings Machine acquisition', () => {
    it('returns the complete catalog while visiting only user records in the device library', async () => {
        await pictureStore.put({ localId: 'action-library-user', kind: 'user', data: new Blob(['user']) });
        await pictureStore.put({ localId: 'action-library-builtin', kind: 'builtin', data: new Blob(['catalog']) });
        const services = createAtmosphereSettingServices({ serverId: 'home-a', accountId: 'account-a', credentials: { token: 'plain-token' },
            assertCurrent: () => {}, resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }),
            request: async () => { throw new Error('unexpected_http'); } });
        const visits = vi.spyOn(IDBCursor.prototype, 'continue');
        try {
            const library = await services.readAtmospherePictureLibrary?.();
            expect(library).toMatchObject({ pictures: expect.arrayContaining(ATMOSPHERE_PICTURES.map(picture => expect.objectContaining({ id: picture.id }))),
                user: [expect.objectContaining({ localId: 'action-library-user', kind: 'user' })] });
            expect(visits).toHaveBeenCalledTimes(1);
        } finally {
            visits.mockRestore();
            await pictureStore.remove('action-library-user');
            await pictureStore.remove('action-library-builtin');
        }
    });
    it('reads exact Account Machine bytes with the native AbortSignal contract and rejects an aborted read', async () => {
        const controller = new AbortController();
        Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
        machineTransport.mockResolvedValue({ success: true, content: 'AP+AAw==' });
        const services = createAtmosphereSettingServices({ serverId: 'home-a', accountId: 'account-a', credentials: { token: 'plain-token' },
        assertCurrent: () => {}, resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }),
            request: async () => { throw new Error('unexpected_http'); } });
        expect(await services.readAtmospherePictureFile?.({ machineId: 'machine-a', path: 'C:\\pictures\\photo.png' }, controller.signal))
            .toEqual({ success: true, content: 'AP+AAw==' });
        expect(machineTransport.mock.calls[0]?.[0]).toMatchObject({ serverId: 'home-a', accountId: 'account-a', machineId: 'machine-a',
            method: 'readFile', payload: { path: 'C:\\pictures\\photo.png' } });
        controller.abort();
        await expect(services.readAtmospherePictureFile?.({ machineId: 'machine-a', path: 'C:\\pictures\\photo.png' }, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(machineTransport.mock.calls).toHaveLength(1);
    });
});
