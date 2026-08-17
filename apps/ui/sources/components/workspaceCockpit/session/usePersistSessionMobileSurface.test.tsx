import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const storageState = vi.hoisted(() => ({
    localSettingReads: [] as string[],
    persistedSurfaces: [] as Array<Readonly<{ sessionId: string; surface: string; serverId: string | null }>>,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        storageState.localSettingReads.push(key);
        return null;
    },
    useLocalSettingMutable: () => [null, () => {}],
    usePersistSessionLastMobileSurface: () => (sessionId: string, surface: string, serverId?: string | null) => {
        storageState.persistedSurfaces.push({ sessionId, surface, serverId: serverId ?? null });
    },
}));

describe('usePersistSessionMobileSurface', () => {
    it('persists the current surface without subscribing to the whole persisted surface map', async () => {
        storageState.localSettingReads = [];
        storageState.persistedSurfaces = [];
        const { usePersistSessionMobileSurface } = await import('./usePersistSessionMobileSurface');

        await renderHook(() => usePersistSessionMobileSurface({
            sessionId: 'session-1',
            surface: 'git',
            serverId: 'server-b',
        }));

        expect(storageState.localSettingReads).not.toContain('sessionLastMobileSurfaceBySessionId');
        expect(storageState.persistedSurfaces).toEqual([{ sessionId: 'session-1', surface: 'git', serverId: 'server-b' }]);
    });
});
