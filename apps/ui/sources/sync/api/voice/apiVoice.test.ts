import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { completeHappierVoiceSession, fetchHappierVoiceToken } from './apiVoice';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createBundledHostedConversationService } from '@/voice/registry/bundledConversationRuntimeHost';
import { createElevenLabsSessionLifecycle } from '../../../../../../packages/plugins/elevenlabs/src/ui/voice/runtime/sessionLifecycle';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerHomeCarrier: () => null,
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
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
                        bindingNonce: 'nonce-1',
                        expiresAtMs: Date.now() + 60_000,
                    }),
                })) as unknown as typeof fetch,
            );

            const res = await fetchHappierVoiceToken(credentials, { sessionId: 'session-1' });
            expect(res).toMatchObject({
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
                bindingNonce: 'nonce-1',
            });
        });

        it('omits sessionId from request body when not provided', async () => {
            const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
                const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
                expect(body).toEqual({});
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        allowed: true,
                        token: 'voice_token',
                        leaseId: 'lease-1',
                        bindingNonce: 'nonce-1',
                        expiresAtMs: Date.now() + 60_000,
                    }),
                } as any;
            });

            vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

            const res = await fetchHappierVoiceToken(credentials, {});
            expect(res).toMatchObject({
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
                bindingNonce: 'nonce-1',
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

            const res = await fetchHappierVoiceToken(credentials, { sessionId: 'session-1' });
            expect(res).toEqual({ allowed: false, reason: 'upstream_error' });
        });

        it('throws on successful responses with invalid body shape', async () => {
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

            await expect(fetchHappierVoiceToken(credentials, { sessionId: 'session-1' })).rejects.toThrow(
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

            await expect(fetchHappierVoiceToken(credentials, { sessionId: 'session-1' })).rejects.toThrow(
                'Voice token request failed: 500',
            );
        });
    });

    describe('completeHappierVoiceSession', () => {
        it.each(['processing', 'transport'])('retries retained hosted lifecycle identity through HTTP after %s failure', async (failure) => {
            vi.spyOn(TokenStorage, 'getCredentials').mockResolvedValue(credentials);
            let completionAttempts = 0;
            const completedBodies: unknown[] = [];
            vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
                if (url.endsWith('/v1/voice/token')) {
                    return new Response(JSON.stringify({
                        allowed: true, token: 'provider-token', leaseId: 'lease-1', bindingNonce: 'nonce-1', expiresAtMs: 12_000,
                    }));
                }
                expect(url).toBe('https://api.example.test/v1/voice/session/complete');
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test');
                completedBodies.push(JSON.parse(String(init?.body)));
                if (++completionAttempts === 1) {
                    if (failure === 'transport') throw new TypeError('network unavailable');
                    return new Response(JSON.stringify({ ok: false, reason: 'upstream_error' }), { status: 503 });
                }
                return new Response(JSON.stringify({ ok: true, durationSeconds: 5 }));
            }));
            const service = createBundledHostedConversationService({ signal: new AbortController().signal, isCurrent: () => true });
            await service.start({ sessionId: 'session-1' });
            const lifecycle = createElevenLabsSessionLifecycle({ takeHostedConversation: () => service });
            const prepared = { sessionConfig: {}, sessionState: { billingMode: 'happier' as const, leaseId: 'lease-1', expiresAtMs: 12_000 } };
            lifecycle.prepared(1, prepared);
            lifecycle.started({ controlSessionId: 'control-1', conversationId: 'conversation-1', attemptId: 1, prepared });
            await expect(lifecycle.ended()).rejects.toThrow();
            await expect(service.complete({ providerConversationId: 'conversation-2' })).rejects.toMatchObject({
                code: 'hosted_conversation_identity_mismatch',
            });
            await lifecycle.ended();
            await lifecycle.ended();
            expect(completedBodies).toEqual([
                { leaseId: 'lease-1', providerConversationId: 'conversation-1' },
                { leaseId: 'lease-1', providerConversationId: 'conversation-1' },
            ]);
        });

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

        it('throws when the server response is not ok without including response body text', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({
                    ok: false,
                    status: 503,
                    text: async () => 'upstream down',
                })) as unknown as typeof fetch,
            );

            try {
                await completeHappierVoiceSession(credentials, {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                });
                throw new Error('expected rejection');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toContain('Voice session complete failed (503)');
                expect((error as Error).message).not.toContain('upstream down');
            }
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
