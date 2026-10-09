import { describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';
import { scopedStorageId } from '@/utils/system/storageScope';

import { buildWorkspaceCacheKey, tryBuildWorkspaceCacheKey, normalizeWorkspaceRootPath } from './workspaceScope';

describe('workspaceScope', () => {
    it('uses the target Home path helper for either tilde separator without sibling-prefix collisions', () => {
        expect(normalizeWorkspaceRootPath('~\\Repo', 'C:\\Users\\alice\\')).toBe('c:/users/alice/repo');
        expect(normalizeWorkspaceRootPath('~/Repo', 'C:/Users/alice/')).toBe('c:/users/alice/repo');
        expect(normalizeWorkspaceRootPath('C:/Users/alice2/Repo', 'C:/Users/alice/')).toBe('c:/users/alice2/repo');
    });
    it('keys equivalent persisted Home aliases through the canonical server-profile owner', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', 'workspace-cache-home-alias');
        const persisted = new MMKV({ id: scopedStorageId('server-profiles', 'workspace-cache-home-alias') });
        persisted.set('server-state-v1', JSON.stringify({ activeServerId: 'profile', servers: { profile: {
            id: 'profile', name: 'Home', serverUrl: 'https://workspace-cache.example.test',
            serverIdentityId: 'srv_workspace_cache_home', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        } } }));
        try {
            vi.resetModules();
            const { buildWorkspaceCacheKey: key } = await import('./workspaceScope');
            const scope = { serverId: 'profile', machineId: 'machine', rootPath: '/repo' };
            expect(key(scope)).toBe(key({ ...scope, serverId: 'srv_workspace_cache_home' }));
            const { upsertWorkspaceRefByScope } = await import('./workspaceRefs');
            const refs = upsertWorkspaceRefByScope([], { scope, nowMs: 1, patch: {} });
            expect(refs[0]?.serverId).toBe('srv_workspace_cache_home');
        } finally {
            persisted.delete('server-state-v1');
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
    describe('tryBuildWorkspaceCacheKey', () => {
        it('returns null for invalid scope', () => {
            expect(tryBuildWorkspaceCacheKey({ serverId: 's', machineId: '', rootPath: '/repo' })).toBe(null);
            expect(tryBuildWorkspaceCacheKey({ serverId: '', machineId: 'm', rootPath: '/repo' })).toBe(null);
            expect(tryBuildWorkspaceCacheKey({ serverId: 's', machineId: 'm', rootPath: '' })).toBe(null);
        });

        it('normalizes rootPath (trim + separators + trailing slashes + windows drive casing)', () => {
            expect(tryBuildWorkspaceCacheKey({ serverId: 's', machineId: 'm', rootPath: '/tmp/repo/' }))
                .toBe('s:m:/tmp/repo');
            expect(tryBuildWorkspaceCacheKey({ serverId: 's', machineId: 'm', rootPath: '/tmp//repo///' }))
                .toBe('s:m:/tmp/repo');
            expect(tryBuildWorkspaceCacheKey({ serverId: 's', machineId: 'm', rootPath: 'C:\\\\Repo\\\\' }))
                .toBe('s:m:c:/repo');
            expect(tryBuildWorkspaceCacheKey({ serverId: 's', machineId: 'm', rootPath: 'C://Repo//Sub//' }))
                .toBe('s:m:c:/repo/sub');
            expect(tryBuildWorkspaceCacheKey({ serverId: 's', machineId: 'm', rootPath: '//Server//Share///Repo///' }))
                .toBe('s:m://server/share/repo');
        });

        it('keeps Home and sibling home boundaries exact while preserving POSIX case', () => {
            const scope = { serverId: 'home', machineId: 'machine', rootPath: 'C:\\Users\\alice\\Repo' };
            expect(tryBuildWorkspaceCacheKey(scope)).toBe(tryBuildWorkspaceCacheKey({ ...scope, rootPath: 'c:/Users/alice/Repo/' }));
            expect(tryBuildWorkspaceCacheKey(scope)).not.toBe(tryBuildWorkspaceCacheKey({ ...scope, rootPath: 'C:/Users/alice2/Repo' }));
            expect(tryBuildWorkspaceCacheKey(scope)).not.toBe(tryBuildWorkspaceCacheKey({ ...scope, serverId: 'other' }));
            expect(tryBuildWorkspaceCacheKey({ ...scope, rootPath: '/Repo' })).not.toBe(tryBuildWorkspaceCacheKey({ ...scope, rootPath: '/repo' }));
        });
    });

    describe('buildWorkspaceCacheKey', () => {
        it('builds a stable cache key', () => {
            expect(buildWorkspaceCacheKey({ serverId: ' server ', machineId: 'm', rootPath: '/tmp/repo' }))
                .toBe('server:m:/tmp/repo');
        });
    });
});
