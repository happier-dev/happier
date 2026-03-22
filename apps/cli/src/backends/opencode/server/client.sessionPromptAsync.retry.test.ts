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

describe('createOpenCodeServerRuntimeClient sessionPromptAsync managed retry', () => {
    const originalFetch = globalThis.fetch;
    const originalServerUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (typeof originalServerUrl === 'string') {
            process.env.HAPPIER_OPENCODE_SERVER_URL = originalServerUrl;
        } else {
            delete process.env.HAPPIER_OPENCODE_SERVER_URL;
        }
    });

    it('retries prompt_async after a transient managed-server fetch failure', async () => {
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
        let promptAttempts = 0;
        globalThis.fetch = vi.fn(async (input, init) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
            fetchUrls.push(url);

            if (url.includes('127.0.0.1:9999/global/health')) {
                return new Response(JSON.stringify({ healthy: true, version: '1.2.15' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (url.includes('127.0.0.1:10000/global/health')) {
                return new Response(JSON.stringify({ healthy: true, version: '1.2.15' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (url.includes('/prompt_async')) {
                promptAttempts += 1;
                if (promptAttempts === 1) {
                    throw new TypeError('fetch failed');
                }
                return new Response(null, { status: 204 });
            }

            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });

        await expect(client.sessionPromptAsync({
            sessionId: 'ses_1',
            parts: [{ type: 'text', text: 'hello' }],
        })).resolves.toBeUndefined();

        const promptUrls = fetchUrls.filter((url) => url.includes('/prompt_async'));
        expect(promptUrls).toEqual([
            expect.stringContaining('127.0.0.1:9999/session/ses_1/prompt_async'),
            expect.stringContaining('127.0.0.1:10000/session/ses_1/prompt_async'),
        ]);
    });
});
