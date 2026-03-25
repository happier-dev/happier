import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sharedManagedServer', () => ({
    ensureSharedManagedOpenCodeServerBaseUrl: vi.fn(),
    isLoopbackManagedOpenCodeBaseUrl: (rawBaseUrl: string) => {
        const value = rawBaseUrl.trim();
        if (!value) return false;
        try {
            const url = new URL(value);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
            const port = Number.parseInt(url.port, 10);
            if (!Number.isFinite(port) || port <= 0) return false;
            const host = url.hostname.toLowerCase();
            return host === 'localhost' || host === '::1' || host.startsWith('127.');
        } catch {
            return false;
        }
    },
    readSharedManagedOpenCodeServerStateBestEffort: vi.fn(),
}));

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

describe('createOpenCodeServerRuntimeClient sessionMessagesList managed retry', () => {
    const originalFetch = globalThis.fetch;
    const originalServerUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;
    const originalHttpTimeoutMs = process.env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        delete process.env.HAPPIER_OPENCODE_SERVER_URL;
        delete process.env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (typeof originalServerUrl === 'string') {
            process.env.HAPPIER_OPENCODE_SERVER_URL = originalServerUrl;
        } else {
            delete process.env.HAPPIER_OPENCODE_SERVER_URL;
        }
        if (typeof originalHttpTimeoutMs === 'string') {
            process.env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS = originalHttpTimeoutMs;
        } else {
            delete process.env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS;
        }
    });

    it('aborts hung HTTP requests within the configured timeout so probes and prompts do not hang forever', async () => {
        process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://127.0.0.1:9999';
        process.env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS = '1000';

        vi.useFakeTimers();

        globalThis.fetch = vi.fn(async (input, init) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');

            if (url.includes('/global/health')) {
                return jsonResponse({ healthy: true, version: '1.2.27' });
            }

            if (url.includes('/session/status')) {
                return await new Promise<Response>((resolve, reject) => {
                    const signal = init?.signal;
                    const timer = setTimeout(() => resolve(jsonResponse({})), 2000);
                    timer.unref?.();
                    if (signal) {
                        if (signal.aborted) {
                            clearTimeout(timer);
                            reject(new Error('aborted'));
                            return;
                        }
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('aborted'));
                        }, { once: true });
                    }
                });
            }

            return jsonResponse({});
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });

        const statusPromise = client.sessionStatusList();
        const assertion = expect(statusPromise).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
        vi.useRealTimers();
    });

    it('treats too-small timeout overrides as invalid to avoid flaking managed OpenCode calls', async () => {
        process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://127.0.0.1:9999';
        process.env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS = '25';

        vi.useFakeTimers();

        globalThis.fetch = vi.fn(async (input, init) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');

            if (url.includes('/global/health')) {
                return jsonResponse({ healthy: true, version: '1.2.27' });
            }

            if (url.includes('/session/status')) {
                return await new Promise<Response>((resolve, reject) => {
                    const signal = init?.signal;
                    const timer = setTimeout(() => resolve(jsonResponse({})), 40);
                    timer.unref?.();
                    if (signal) {
                        if (signal.aborted) {
                            clearTimeout(timer);
                            reject(new Error('aborted'));
                            return;
                        }
                        signal.addEventListener(
                            'abort',
                            () => {
                                clearTimeout(timer);
                                reject(new Error('aborted'));
                            },
                            { once: true },
                        );
                    }
                });
            }

            return jsonResponse({});
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });

        const statusPromise = client.sessionStatusList();
        const assertion = expect(statusPromise).resolves.toEqual({});
        await vi.advanceTimersByTimeAsync(50);
        await assertion;
        vi.useRealTimers();
    });

    it('retries session messages after a transient managed-server fetch failure', async () => {
        const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
        const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
        const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;

        ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
        readMock.mockResolvedValueOnce({
            baseUrl: 'http://127.0.0.1:10000',
            pid: process.pid,
            startedAtMs: Date.now(),
        });

        const fetchUrls: string[] = [];
        let messageAttempts = 0;
        globalThis.fetch = vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
            fetchUrls.push(url);

            if (url.includes('127.0.0.1:9999/global/health')) {
                return jsonResponse({ healthy: true, version: '1.2.15' });
            }

            if (url.includes('127.0.0.1:10000/global/health')) {
                return jsonResponse({ healthy: true, version: '1.2.15' });
            }

            if (url.includes('/session/ses_1/message')) {
                messageAttempts += 1;
                if (messageAttempts === 1) {
                    throw new TypeError('fetch failed');
                }
                return jsonResponse([{ id: 'msg_1', role: 'assistant', parts: [] }]);
            }

            return jsonResponse({});
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });

        await expect(client.sessionMessagesList({ sessionId: 'ses_1' })).resolves.toEqual([
            { id: 'msg_1', role: 'assistant', parts: [] },
        ]);

        const messageUrls = fetchUrls.filter((url) => url.includes('/session/ses_1/message'));
        expect(messageUrls).toEqual([
            expect.stringContaining('127.0.0.1:9999/session/ses_1/message'),
            expect.stringContaining('127.0.0.1:10000/session/ses_1/message'),
        ]);
    });

    it('retries permission list after a transient managed-server fetch failure', async () => {
        const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
        const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
        const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;

        ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
        readMock.mockResolvedValueOnce({
            baseUrl: 'http://127.0.0.1:10000',
            pid: process.pid,
            startedAtMs: Date.now(),
        });

        const fetchUrls: string[] = [];
        let attempts = 0;
        globalThis.fetch = vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
            fetchUrls.push(url);

            if (url.includes('127.0.0.1:9999/global/health')) {
                return jsonResponse({ healthy: true, version: '1.2.15' });
            }
            if (url.includes('127.0.0.1:10000/global/health')) {
                return jsonResponse({ healthy: true, version: '1.2.15' });
            }

            if (url.includes('/permission')) {
                attempts += 1;
                if (attempts === 1) {
                    throw new TypeError('fetch failed');
                }
                return jsonResponse([{ id: 'perm_1', sessionID: 'ses_1' }]);
            }

            return jsonResponse({});
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });

        await expect(client.permissionList()).resolves.toEqual([
            { id: 'perm_1', sessionID: 'ses_1' },
        ]);

        const urls = fetchUrls.filter((url) => url.includes('/permission'));
        expect(urls).toEqual([
            expect.stringContaining('127.0.0.1:9999/permission'),
            expect.stringContaining('127.0.0.1:10000/permission'),
        ]);
    });

    it('retries question list after a transient managed-server fetch failure', async () => {
        const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
        const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
        const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;

        ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
        readMock.mockResolvedValueOnce({
            baseUrl: 'http://127.0.0.1:10000',
            pid: process.pid,
            startedAtMs: Date.now(),
        });

        const fetchUrls: string[] = [];
        let attempts = 0;
        globalThis.fetch = vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
            fetchUrls.push(url);

            if (url.includes('127.0.0.1:9999/global/health')) {
                return jsonResponse({ healthy: true, version: '1.2.15' });
            }
            if (url.includes('127.0.0.1:10000/global/health')) {
                return jsonResponse({ healthy: true, version: '1.2.15' });
            }

            if (url.includes('/question')) {
                attempts += 1;
                if (attempts === 1) {
                    throw new TypeError('fetch failed');
                }
                return jsonResponse([{ id: 'q_1', sessionID: 'ses_1' }]);
            }

            return jsonResponse({});
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });

        await expect(client.questionList()).resolves.toEqual([
            { id: 'q_1', sessionID: 'ses_1' },
        ]);

        const urls = fetchUrls.filter((url) => url.includes('/question'));
        expect(urls).toEqual([
            expect.stringContaining('127.0.0.1:9999/question'),
            expect.stringContaining('127.0.0.1:10000/question'),
        ]);
    });
});
