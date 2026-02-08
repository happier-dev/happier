import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/tokenStorage';
import { completeHappierVoiceSession, fetchHappierVoiceToken } from './apiVoice';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.example.test',
}));

const credentials: AuthCredentials = { token: 'test', secret: 'secret' };

describe('apiVoice', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('fetchHappierVoiceToken', () => {
        it('returns allowed token payload when response is valid', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        allowed: true,
                        token: 'voice_token',
                        leaseId: 'lease-1',
                        expiresAtMs: Date.now() + 60_000,
                    }),
                })) as unknown as typeof fetch,
            );

            const res = await fetchHappierVoiceToken(credentials, 'session-1');
            expect(res).toMatchObject({
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
            });
        });

        it('returns denied/upstream_error for 503 responses with invalid payloads', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({
                    ok: false,
                    status: 503,
                    json: async () => ({ malformed: true }),
                })) as unknown as typeof fetch,
            );

            const res = await fetchHappierVoiceToken(credentials, 'session-1');
            expect(res).toEqual({ allowed: false, reason: 'upstream_error' });
        });

        it('throws on successful responses with invalid body shape', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({
                    ok: true,
                    status: 200,
                    json: async () => ({ token: 'missing_allowed' }),
                })) as unknown as typeof fetch,
            );

            await expect(fetchHappierVoiceToken(credentials, 'session-1')).rejects.toThrow(
                'Voice token request returned an invalid response',
            );
        });

        it('throws on unexpected non-OK statuses', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({
                    ok: false,
                    status: 500,
                    json: async () => ({ error: 'internal' }),
                })) as unknown as typeof fetch,
            );

            await expect(fetchHappierVoiceToken(credentials, 'session-1')).rejects.toThrow('Voice token request failed: 500');
        });
    });

    describe('completeHappierVoiceSession', () => {
        it('passes an AbortSignal to fetch', async () => {
            const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
                expect(init?.signal).toBeInstanceOf(AbortSignal);
                return { ok: true } as Response;
            });

            vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

            await completeHappierVoiceSession(credentials, {
                leaseId: 'lease-1',
                providerConversationId: 'conv-1',
            });
        });

        it('throws when the server response is not ok and includes response body text', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({
                    ok: false,
                    status: 503,
                    text: async () => 'upstream down',
                })) as unknown as typeof fetch,
            );

            await expect(
                completeHappierVoiceSession(credentials, {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                }),
            ).rejects.toThrow(/Voice session complete failed \(503\): upstream down/);
        });

        it('throws without suffix when response.text() itself fails', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({
                    ok: false,
                    status: 500,
                    text: async () => {
                        throw new Error('cannot read body');
                    },
                })) as unknown as typeof fetch,
            );

            await expect(
                completeHappierVoiceSession(credentials, {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                }),
            ).rejects.toThrow('Voice session complete failed (500)');
        });

        it('aborts when completion request exceeds timeout', async () => {
            vi.useFakeTimers();

            vi.stubGlobal(
                'fetch',
                vi.fn((_url: string, init?: RequestInit) => {
                    return new Promise<Response>((_resolve, reject) => {
                        const signal = init?.signal;
                        signal?.addEventListener(
                            'abort',
                            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                            { once: true },
                        );
                    });
                }) as unknown as typeof fetch,
            );

            const promise = completeHappierVoiceSession(
                credentials,
                {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                },
                { timeoutMs: 5 },
            );
            const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
            await vi.advanceTimersByTimeAsync(5);
            await rejection;
        });
    });
});
