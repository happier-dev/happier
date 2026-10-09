import { describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';
import { scopedStorageId } from '@/utils/system/storageScope';
import { readProjectSelectionPreference, resolveProjectSelectionPreferenceKeys, writeProjectSelectionPreference } from './projectSelectionPersistence';

const first = { id: 'checkout', serverId: 'home-a', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };

describe('Project selection preference persistence', () => {
    it('opens a legacy value only when the checkout uniquely proves its Home', () => {
        const keys = resolveProjectSelectionPreferenceKeys([first], first);
        expect(readProjectSelectionPreference({ checkout: '/repo/feature' }, keys)).toBe('/repo/feature');
        const duplicate = { ...first, serverId: 'home-b', rootPath: '/other' };
        const selected = resolveProjectSelectionPreferenceKeys([first, duplicate], duplicate);
        expect(selected?.storageKey).toBe('project-selection:v1:["home-b","checkout"]');
        expect(readProjectSelectionPreference({ checkout: '/repo/feature' }, selected)).toBeNull();
        expect(resolveProjectSelectionPreferenceKeys([first, first], first)).toBeNull();
    });

    it('writes one qualified Home without overwriting another or the retained predecessor bytes', () => {
        const other = { ...first, serverId: 'home-b', rootPath: '/other' };
        const refs = [first, other];
        const a = resolveProjectSelectionPreferenceKeys(refs, first);
        const b = resolveProjectSelectionPreferenceKeys(refs, other);
        const previous = { checkout: '/legacy' };
        const next = writeProjectSelectionPreference(writeProjectSelectionPreference(previous, a, '/a'), b, '/b');
        expect(previous).toEqual({ checkout: '/legacy' });
        expect(readProjectSelectionPreference(next, a)).toBe('/a');
        expect(readProjectSelectionPreference(next, b)).toBe('/b');
        expect(next.checkout).toBe('/legacy');
    });

    it('uses the canonical Home key when the selected checkout retains a profile alias', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', 'project-selection-home-alias');
        const persisted = new MMKV({ id: scopedStorageId('server-profiles', 'project-selection-home-alias') });
        persisted.set('server-state-v1', JSON.stringify({ activeServerId: 'profile', servers: { profile: {
            id: 'profile', name: 'Home', serverUrl: 'https://project-selection.example.test',
            serverIdentityId: 'srv_project_selection_home', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        } } }));
        try {
            vi.resetModules();
            const { resolveProjectSelectionPreferenceKeys: resolveFresh } = await import('./projectSelectionPersistence');
            const ref = { ...first, serverId: 'profile' };
            const keys = resolveFresh([ref], { id: ref.id, serverId: 'srv_project_selection_home' });
            expect(keys?.storageKey).toBe('project-selection:v1:["srv_project_selection_home","checkout"]');
            expect(keys?.predecessorStorageKey).toBe('checkout');
        } finally {
            persisted.delete('server-state-v1');
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
});
