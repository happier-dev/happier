import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { completeHappierVoiceSession, fetchHappierVoiceToken, type VoiceTokenResponse } from './apiVoice';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';

const credentials = { token: 'test' } satisfies AuthCredentials;
const fetchSpy = vi.fn<RuntimeFetch>();

describe('apiVoice', () => {
    beforeEach(async () => {
        resetServerProfilesRuntimeForTests();
        fetchSpy.mockReset();
        // Substitute only network I/O; real Home selection and HTTP admission remain active.
        setRuntimeFetch(fetchSpy);
        const home = await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'device' });
        expect(getActiveServerSnapshot()).toMatchObject({ serverId: home.id, serverUrl: home.serverUrl });
    });
    afterEach(() => {
        resetRuntimeFetch();
        resetServerProfilesRuntimeForTests();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('fetchHappierVoiceToken', () => {
        it('returns allowed token payload when response is valid', async () => {
            const payload = {
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
                bindingNonce: 'nonce-1',
                expiresAtMs: Date.now() + 60_000,
            } satisfies VoiceTokenResponse;
            fetchSpy.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

            const res = await fetchHappierVoiceToken(credentials, { sessionId: 'session-1' });
            expect(res).toEqual(payload);
            const [url, init] = fetchSpy.mock.calls[0]!;
            expect(String(url)).toBe('https://api.example.test/v1/voice/token');
            expect(init?.method).toBe('POST');
            const headers = new Headers(init?.headers);
            expect(headers.get('Authorization')).toBe('Bearer test');
            expect(headers.get('Content-Type')).toBe('application/json');
            expect(JSON.parse(String(init?.body))).toEqual({ sessionId: 'session-1' });
        });

        it('omits sessionId from request body when not provided', async () => {
            const payload = {
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
                bindingNonce: 'nonce-1',
                expiresAtMs: Date.now() + 60_000,
            } satisfies VoiceTokenResponse;
            fetchSpy.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

            const res = await fetchHappierVoiceToken(credentials, {});
            expect(res).toEqual(payload);
            const [url, init] = fetchSpy.mock.calls[0]!;
            expect(String(url)).toBe('https://api.example.test/v1/voice/token');
            expect(init?.method).toBe('POST');
            const headers = new Headers(init?.headers);
            expect(headers.get('Authorization')).toBe('Bearer test');
            expect(headers.get('Content-Type')).toBe('application/json');
            expect(JSON.parse(String(init?.body))).toEqual({});
        });

        it('returns denied/upstream_error for 503 responses with invalid payloads', async () => {
            fetchSpy.mockResolvedValue(new Response(JSON.stringify({ malformed: true }), { status: 503 }));

            const res = await fetchHappierVoiceToken(credentials, { sessionId: 'session-1' });
            expect(res).toEqual({ allowed: false, reason: 'upstream_error' });
        });

        it('throws on successful responses with invalid body shape', async () => {
            fetchSpy.mockResolvedValue(new Response(JSON.stringify({
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
                expiresAtMs: Date.now() + 60_000,
            }), { status: 200 }));

            await expect(fetchHappierVoiceToken(credentials, { sessionId: 'session-1' })).rejects.toThrow(
                'Voice token request returned an invalid response',
            );
        });

        it('throws on unexpected non-OK statuses', async () => {
            fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: 'internal' }), { status: 500 }));

            await expect(fetchHappierVoiceToken(credentials, { sessionId: 'session-1' })).rejects.toThrow(
                'Voice token request failed: 500',
            );
        });
    });

    describe('completeHappierVoiceSession', () => {
        it('passes an AbortSignal to fetch', async () => {
            fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

            await completeHappierVoiceSession(credentials, {
                leaseId: 'lease-1',
                providerConversationId: 'conv-1',
            });
            const [url, init] = fetchSpy.mock.calls[0]!;
            expect(String(url)).toBe('https://api.example.test/v1/voice/session/complete');
            expect(init?.method).toBe('POST');
            const headers = new Headers(init?.headers);
            expect(headers.get('Authorization')).toBe('Bearer test');
            expect(headers.get('Content-Type')).toBe('application/json');
            expect(JSON.parse(String(init?.body))).toEqual({ leaseId: 'lease-1', providerConversationId: 'conv-1' });
            expect(init?.signal).toBeInstanceOf(AbortSignal);
        });

        it('throws when the server response is not ok without including response body text', async () => {
            fetchSpy.mockResolvedValue(new Response('upstream down', { status: 503 }));

            try {
                await completeHappierVoiceSession(credentials, {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                });
                throw new Error('expected rejection');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                if (!(error instanceof Error)) throw error;
                expect(error.message).toBe('Voice session complete failed (503)');
                expect(error.message).not.toContain('upstream down');
            }
        });

        it('throws without suffix when response.text() itself fails', async () => {
            // A failed response-body stream is a genuine fetch boundary failure.
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.error(new Error('cannot read body'));
                },
            });
            fetchSpy.mockResolvedValue(new Response(body, { status: 500 }));

            await expect(
                completeHappierVoiceSession(credentials, {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                }),
            ).rejects.toThrow('Voice session complete failed (500)');
        });

        it('aborts when completion request exceeds timeout', async () => {
            vi.useFakeTimers();

            fetchSpy.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                if (signal?.aborted) {
                    abort();
                    return;
                }
                signal?.addEventListener('abort', abort, { once: true });
            }));

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
            expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        });
    });
});
