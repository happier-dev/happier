import { describe, expect, it } from 'vitest';

import {
    areSessionSplitCanvasScopesCompatible,
    resolveSessionSplitCanvasScope,
    resolveSessionSplitCanvasScopeKey,
} from './sessionSplitCanvasScope';

describe('sessionSplitCanvasScope', () => {
    it('normalizes a workspace target into a canonical session split-canvas scope', () => {
        expect(resolveSessionSplitCanvasScope({
            workspaceCacheKey: 'stale-key',
            serverId: ' server-a ',
            machineId: ' machine-1 ',
            rootPath: '/repo//nested/',
        })).toEqual({
            workspaceCacheKey: 'server-a:machine-1:/repo/nested',
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo/nested',
        });
    });

    it('uses the route-scoped server id when present so persistence keys cannot drift across servers', () => {
        expect(resolveSessionSplitCanvasScope({
            workspaceCacheKey: 'stale-key',
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo',
        }, {
            routeServerId: ' server-route ',
        })).toEqual({
            workspaceCacheKey: 'server-route:machine-1:/repo',
            serverId: 'server-route',
            machineId: 'machine-1',
            rootPath: '/repo',
        });
    });

    it('returns null when the workspace target cannot produce a canonical workspace scope', () => {
        expect(resolveSessionSplitCanvasScope(null)).toBeNull();
        expect(resolveSessionSplitCanvasScope(undefined)).toBeNull();
        expect(resolveSessionSplitCanvasScope({
            workspaceCacheKey: 'broken',
            serverId: 'server-a',
            machineId: '',
            rootPath: '/repo',
        })).toBeNull();
    });

    it('uses the canonical workspace cache key for session split-canvas persistence', () => {
        expect(resolveSessionSplitCanvasScopeKey({
            workspaceCacheKey: 'server-a:machine-1:/repo',
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo',
        })).toBe('server-a:machine-1:/repo');
        expect(resolveSessionSplitCanvasScopeKey(null)).toBeNull();
    });

    it('matches compatibility by canonical workspace cache key', () => {
        const scope = {
            workspaceCacheKey: 'server-a:machine-1:/repo',
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo',
        } as const;

        expect(areSessionSplitCanvasScopesCompatible(scope, scope)).toBe(true);
        expect(areSessionSplitCanvasScopesCompatible(scope, {
            ...scope,
            workspaceCacheKey: 'server-a:machine-1:/other',
            rootPath: '/other',
        })).toBe(false);
        expect(areSessionSplitCanvasScopesCompatible(scope, null)).toBe(false);
    });
});
