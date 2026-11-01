import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { reorderTodos } from './todoOps';

const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch }));

const credentials: AuthCredentials = { token: 'reorder-test', secret: 'unused-before-encryption' };
const initialState = storage.getInitialState();

describe('reorderTodos outcomes', () => {
    beforeEach(() => {
        storage.setState(initialState, true);
        upsertAndActivateServer({ serverUrl: 'https://server.example.test', scope: 'tab' });
        runtimeFetch.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('reports a missing todo as refused rather than an applied reorder', async () => {
        await expect(reorderTodos(credentials, 'missing', 1, 'undone')).resolves.toBe('refused');
        expect(runtimeFetch).not.toHaveBeenCalled();
    });

    it('reports an unconfirmed server operation as unknown while preserving the optimistic order', async () => {
        storage.getState().applyTodos({
            todos: Object.fromEntries(['a', 'b'].map((id) => [id, { id, title: id, done: false, createdAt: 1, updatedAt: 1 }])),
            undoneOrder: ['a', 'b'],
            doneOrder: [],
            versions: {},
        });
        runtimeFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'test denied' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
        }));
        await expect(reorderTodos(credentials, 'a', 1, 'undone')).resolves.toBe('unknown');
        expect(runtimeFetch).toHaveBeenCalled();
        expect(storage.getState().todoState?.undoneOrder).toEqual(['b', 'a']);
    });

    it('leaves an already-current destination unchanged without writing', async () => {
        storage.getState().applyTodos({
            todos: { a: { id: 'a', title: 'a', done: false, createdAt: 1, updatedAt: 1 } },
            undoneOrder: ['a'], doneOrder: [], versions: {},
        });
        const state = storage.getState().todoState;
        runtimeFetch.mockResolvedValue(new Response('test refused', { status: 403 }));
        await expect(reorderTodos(credentials, 'a', 0, 'undone')).resolves.toBe('unchanged');
        expect(storage.getState().todoState).toBe(state);
        expect(runtimeFetch).not.toHaveBeenCalled();
    });
});
