import { describe, expect, it } from 'vitest';

import { buildWorkspaceCacheKey, tryBuildWorkspaceCacheKey } from './workspaceScope';

describe('workspaceScope', () => {
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
    });

    describe('buildWorkspaceCacheKey', () => {
        it('builds a stable cache key', () => {
            expect(buildWorkspaceCacheKey({ serverId: ' server ', machineId: 'm', rootPath: '/tmp/repo' }))
                .toBe('server:m:/tmp/repo');
        });
    });
});
