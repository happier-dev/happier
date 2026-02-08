import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/tokenStorage';
import { HappyError } from '@/utils/errors';
import { connectVendorToken, disconnectVendorToken } from './apiVendorTokens';

vi.mock('@/utils/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return {
        ...actual,
        backoff: immediate,
        backoffForever: immediate,
    };
});

const credentials: AuthCredentials = { token: 'test', secret: 'secret' };

function stubFetch(responseFactory: () => Promise<unknown>) {
    vi.stubGlobal('fetch', vi.fn(responseFactory) as unknown as typeof fetch);
}

describe('apiVendorTokens', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe('disconnectVendorToken', () => {
        it('throws a HappyError when a 404 response body is not JSON', async () => {
            stubFetch(async () => ({
                ok: false,
                status: 404,
                json: async () => {
                    throw new Error('invalid json');
                },
            }));

            await expect(disconnectVendorToken(credentials, 'anthropic')).rejects.toMatchObject({
                name: 'HappyError',
                message: 'anthropic account not connected',
            } satisfies Partial<HappyError>);
        });

        it('surfaces success:false responses with a non-retryable HappyError', async () => {
            stubFetch(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ success: false, error: 'not_connected' }),
            }));

            await expect(disconnectVendorToken(credentials, 'anthropic')).rejects.toMatchObject({
                message: expect.stringContaining('not_connected'),
                canTryAgain: false,
            });
        });

        it('throws a generic Error for non-retryable server failures (5xx)', async () => {
            stubFetch(async () => ({
                ok: false,
                status: 503,
                json: async () => ({ error: 'unavailable' }),
            }));

            await expect(disconnectVendorToken(credentials, 'anthropic')).rejects.toThrow(
                'Failed to disconnect anthropic: 503',
            );
        });
    });

    describe('connectVendorToken', () => {
        it('surfaces success:false responses with a non-retryable HappyError', async () => {
            stubFetch(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ success: false, reason: 'bad_token' }),
            }));

            await expect(connectVendorToken(credentials, 'anthropic', 'sk-test')).rejects.toMatchObject({
                message: expect.stringContaining('bad_token'),
                canTryAgain: false,
            });
        });

        it('throws invalid response when successful payload is not JSON', async () => {
            stubFetch(async () => ({
                ok: true,
                status: 200,
                json: async () => {
                    throw new Error('invalid json');
                },
            }));

            await expect(connectVendorToken(credentials, 'anthropic', 'sk-test')).rejects.toMatchObject({
                name: 'HappyError',
                message: expect.stringContaining('invalid response'),
                canTryAgain: false,
            } satisfies Partial<HappyError>);
        });

        it('falls back to default connect message when 4xx body is not JSON', async () => {
            stubFetch(async () => ({
                ok: false,
                status: 400,
                json: async () => {
                    throw new Error('invalid json');
                },
            }));

            await expect(connectVendorToken(credentials, 'anthropic', 'sk-test')).rejects.toMatchObject({
                name: 'HappyError',
                message: 'Failed to connect anthropic',
                canTryAgain: false,
            } satisfies Partial<HappyError>);
        });
    });
});
