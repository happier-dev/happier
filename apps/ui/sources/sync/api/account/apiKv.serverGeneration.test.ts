import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return {
        ...actual,
        backoff: immediate,
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

const credentials: AuthCredentials = { token: 'test-token', secret: 'test-secret' };

describe('apiKv server generation guard', () => {
    it('rejects stale kvGet responses after active server generation changes', async () => {
        let generation = 1;

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation,
            }),
        }));

        const fetchMock = vi.fn(async () => {
            generation = 2;
            return {
                ok: true,
                status: 200,
                json: async () => ({ key: 'k', value: 'v', version: 1 }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { kvGet } = await import('./apiKv');
        await expect(kvGet(credentials, 'k')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });
});
