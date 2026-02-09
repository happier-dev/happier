import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';

vi.mock('@/utils/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/time')>();
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

describe('apiUsage server generation guard', () => {
    it('rejects stale queryUsage responses after active server generation changes', async () => {
        let generation = 1;

        vi.doMock('./serverRuntime', () => ({
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
                json: async () => ({ usage: [] }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { queryUsage } = await import('./apiUsage');
        await expect(queryUsage(credentials, {})).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });
});
