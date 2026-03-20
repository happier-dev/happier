import { describe, expect, it, vi } from 'vitest';

import { resolveNewSessionPickerReturnRouteKey, setNewSessionPickerReturnParams } from './setNewSessionPickerReturnParams';

describe('resolveNewSessionPickerReturnRouteKey', () => {
    it('prefers the nearest prior /new route over an unrelated modal parent', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 2,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBe('new-route');
    });

    it('skips nested picker routes and keeps the actual /new screen as the return target', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 3,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                { key: 'profile-picker', name: '(app)/new/pick/profile', path: '/new/pick/profile', params: { profileId: 'profile-1' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBe('new-route');
    });

    it('falls back to null when the stack has no prior new-session route', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 1,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBeNull();
    });

    it('does not treat legacy workspace-only params as a new-session return target', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 2,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'legacy-workspace-route', name: 'workspace-legacy', path: '/legacy', params: { workspaceId: 'ws_payments' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBeNull();
    });
});

describe('setNewSessionPickerReturnParams', () => {
    it('dispatches params onto the new-session route when it is still on the stack', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 2,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
        });

        expect(mode).toBe('dispatch');
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            source: 'new-route',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    path: '/repo/selected',
                }),
            }),
        }));
        expect(replace).not.toHaveBeenCalled();
    });

    it('treats directory as canonical new-session path state when dispatching back from pickers', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 2,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { directory: '/repo/selected' },
        });

        expect(mode).toBe('dispatch');
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            source: 'new-route',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    directory: '/repo/selected',
                }),
            }),
        }));
        expect(replace).not.toHaveBeenCalled();
    });

    it('dispatches params to the actual /new route instead of an intermediate picker route', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 3,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                        { key: 'profile-picker', name: '(app)/new/pick/profile', path: '/new/pick/profile', params: { profileId: 'profile-1' } },
                        { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
        });

        expect(mode).toBe('dispatch');
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            source: 'new-route',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    path: '/repo/selected',
                }),
            }),
        }));
        expect(replace).not.toHaveBeenCalled();
    });

    it('replaces back to /new when the picker was opened over a non-new route', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
            replaceParams: { machineId: 'm1', path: '/repo/selected' },
        });

        expect(mode).toBe('replace');
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'm1',
                path: '/repo/selected',
            },
        });
    });

    it('preserves the current new-session context when replace fallback is needed', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
            replaceParams: {
                dataId: 'draft-1',
                machineId: 'm1',
                spawnServerId: 'server-b',
                path: '/repo/selected',
            },
        });

        expect(mode).toBe('replace');
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                dataId: 'draft-1',
                machineId: 'm1',
                spawnServerId: 'server-b',
                path: '/repo/selected',
            },
        });
    });
});
