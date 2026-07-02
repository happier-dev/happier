import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCloudAuthCallbackService } from './callback';

async function occupyLoopbackPort(): Promise<Readonly<{ port: number; close(): Promise<void> }>> {
    const server = createServer((_req, res) => {
        res.writeHead(204);
        res.end();
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected TCP loopback address');
    }
    return {
        port: address.port,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        },
    };
}

describe('createCloudAuthCallbackService', () => {
    const cleanup: Array<() => Promise<void>> = [];

    afterEach(async () => {
        const tasks = cleanup.splice(0);
        await Promise.all(tasks.map((task) => task()));
    });

    it('reserves a loopback redirect URI before browser open and resolves code/state from the callback', async () => {
        const service = createCloudAuthCallbackService();
        const created = await service.create({
            mode: 'loopback',
            callbackPath: '/auth/callback',
            timeoutMs: 5_000,
        });

        expect(created.ok).toBe(true);
        if (!created.ok) return;
        cleanup.push(() => created.session.close());

        expect(created.session.redirectUri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/);
        expect(created.session.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
        expect(created.session.state).toMatch(/^[a-f0-9]{64}$/);

        const wait = created.session.wait();
        const callbackUrl = new URL(created.session.callbackUrl!);
        callbackUrl.searchParams.set('code', 'auth-code-1');
        callbackUrl.searchParams.set('state', created.session.state);
        const response = await fetch(callbackUrl);

        expect(response.status).toBe(200);
        await expect(wait).resolves.toEqual({
            ok: true,
            code: 'auth-code-1',
            state: created.session.state,
            redirectUri: created.session.redirectUri,
        });
    });

    it('rejects mismatched callback state without returning the authorization code', async () => {
        const service = createCloudAuthCallbackService();
        const created = await service.create({
            mode: 'loopback',
            callbackPath: '/auth/callback',
            timeoutMs: 5_000,
        });

        expect(created.ok).toBe(true);
        if (!created.ok) return;
        cleanup.push(() => created.session.close());

        const wait = created.session.wait();
        const callbackUrl = new URL(created.session.callbackUrl!);
        callbackUrl.searchParams.set('code', 'secret-auth-code');
        callbackUrl.searchParams.set('state', 'wrong-state');
        const response = await fetch(callbackUrl);

        expect(response.status).toBe(400);
        await expect(wait).resolves.toEqual({
            ok: false,
            code: 'invalid_result',
            diagnostics: [{ code: 'oauth_state_mismatch' }],
        });
    });

    it('validates callback state before accepting provider error callbacks', async () => {
        const service = createCloudAuthCallbackService();
        const created = await service.create({
            mode: 'loopback',
            callbackPath: '/auth/callback',
            timeoutMs: 5_000,
        });

        expect(created.ok).toBe(true);
        if (!created.ok) return;
        cleanup.push(() => created.session.close());

        const wait = created.session.wait();
        const callbackUrl = new URL(created.session.callbackUrl!);
        callbackUrl.searchParams.set('error', 'access_denied');
        callbackUrl.searchParams.set('state', 'wrong-state');
        const response = await fetch(callbackUrl);

        expect(response.status).toBe(400);
        await expect(wait).resolves.toEqual({
            ok: false,
            code: 'invalid_result',
            diagnostics: [{ code: 'oauth_state_mismatch' }],
        });
    });

    it('rejects callback paths that contain query or fragment text', async () => {
        const service = createCloudAuthCallbackService();

        await expect(service.create({
            mode: 'loopback',
            callbackPath: '/auth/callback?unexpected=1',
            timeoutMs: 5_000,
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_result',
            diagnostics: [{ code: 'invalid_callback_path' }],
        });

        await expect(service.create({
            mode: 'paste',
            callbackPath: '/auth/callback#fragment',
            timeoutMs: 5_000,
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_result',
            diagnostics: [{ code: 'invalid_callback_path' }],
        });
    });

    it('uses the host prompt and redirect parser for paste-mode callbacks', async () => {
        let sessionState = '';
        let sessionRedirectUri = '';
        const prompts: string[] = [];
        const service = createCloudAuthCallbackService({
            promptText: async (label) => {
                prompts.push(label);
                return `${sessionRedirectUri}?code=paste-code-1&state=${sessionState}`;
            },
        });
        const created = await service.create({
            mode: 'paste',
            callbackPath: '/auth/callback',
            preferredPort: 1455,
            timeoutMs: 5_000,
        });

        expect(created.ok).toBe(true);
        if (!created.ok) return;
        cleanup.push(() => created.session.close());
        sessionState = created.session.state;
        sessionRedirectUri = created.session.redirectUri;

        await expect(created.session.wait({
            promptLabel: 'Paste Codex redirect URL: ',
        })).resolves.toEqual({
            ok: true,
            code: 'paste-code-1',
            state: created.session.state,
            redirectUri: created.session.redirectUri,
        });
        expect(prompts).toEqual(['Paste Codex redirect URL: ']);
    });

    it('does not prompt after a paste-mode session is closed before waiting', async () => {
        const prompts: string[] = [];
        const service = createCloudAuthCallbackService({
            promptText: async (label) => {
                prompts.push(label);
                return 'http://localhost:1455/auth/callback?code=late-code&state=late-state';
            },
        });
        const created = await service.create({
            mode: 'paste',
            callbackPath: '/auth/callback',
            preferredPort: 1455,
            timeoutMs: 5_000,
        });

        expect(created.ok).toBe(true);
        if (!created.ok) return;

        await created.session.close();

        await expect(created.session.wait({
            promptLabel: 'Paste Codex redirect URL: ',
        })).resolves.toEqual({
            ok: false,
            code: 'cancelled',
            diagnostics: [{ code: 'authentication_cancelled' }],
        });
        expect(prompts).toEqual([]);
    });

    it('resolves a paste-mode wait when the host signal aborts while the prompt is pending', async () => {
        const controller = new AbortController();
        const promptText = vi.fn(async () => await new Promise<string>(() => {}));
        const service = createCloudAuthCallbackService({
            signal: controller.signal,
            promptText,
        });
        const created = await service.create({
            mode: 'paste',
            callbackPath: '/auth/callback',
            preferredPort: 1455,
            timeoutMs: 5_000,
        });

        expect(created.ok).toBe(true);
        if (!created.ok) return;

        const wait = created.session.wait({
            promptLabel: 'Paste Codex redirect URL: ',
        });
        await vi.waitFor(() => {
            expect(promptText).toHaveBeenCalledWith('Paste Codex redirect URL: ');
        });

        controller.abort();

        await expect(Promise.race([
            wait,
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'timeout' }), 100)),
        ])).resolves.toEqual({
            ok: false,
            code: 'cancelled',
            diagnostics: [{ code: 'authentication_cancelled' }],
        });
    });

    it('closes pending loopback waits when the host signal aborts', async () => {
        const controller = new AbortController();
        const service = createCloudAuthCallbackService({ signal: controller.signal });
        const created = await service.create({
            mode: 'loopback',
            callbackPath: '/auth/callback',
            timeoutMs: 5_000,
        });

        expect(created.ok).toBe(true);
        if (!created.ok) return;
        cleanup.push(() => created.session.close());

        const wait = created.session.wait();
        controller.abort();

        await expect(wait).resolves.toEqual({
            ok: false,
            code: 'cancelled',
            diagnostics: [{ code: 'authentication_cancelled' }],
        });
    });

    it('falls back from an occupied preferred loopback port', async () => {
        const occupied = await occupyLoopbackPort();
        cleanup.push(() => occupied.close());
        const service = createCloudAuthCallbackService();
        const created = await service.create({
            mode: 'loopback',
            callbackPath: '/auth/callback',
            preferredPort: occupied.port,
            timeoutMs: 5_000,
        });

        expect(created.ok).toBe(true);
        if (!created.ok) return;
        cleanup.push(() => created.session.close());
        expect(created.session.port).not.toBe(occupied.port);
    });

    it('removes abort listeners when loopback listener startup fails', async () => {
        const occupied = await occupyLoopbackPort();
        cleanup.push(() => occupied.close());
        const controller = new AbortController();
        const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
        const service = createCloudAuthCallbackService({
            signal: controller.signal,
            findAvailableLoopbackPortFn: async () => occupied.port,
            isLoopbackPortAvailableFn: async () => true,
        });

        const created = await service.create({
            mode: 'loopback',
            callbackPath: '/auth/callback',
            preferredPort: occupied.port,
            timeoutMs: 5_000,
        });

        expect(created).toMatchObject({
            ok: false,
            code: 'failed',
            diagnostics: [{ code: 'loopback_listener_start_failed' }],
        });
        expect(removeAbortListener).toHaveBeenCalled();
    });

    it('does not leave a loopback listener open when cancelled before startup completes', async () => {
        const controller = new AbortController();
        const captured: { server?: ReturnType<typeof createServer> } = {};
        const service = createCloudAuthCallbackService({
            signal: controller.signal,
            findAvailableLoopbackPortFn: async () => 0,
            createServerFn: (handler) => {
                const server = createServer(handler);
                captured.server = server;
                const listen = server.listen.bind(server);
                server.listen = ((...args: Parameters<typeof server.listen>) => {
                    controller.abort();
                    setTimeout(() => {
                        listen(...args);
                    }, 20);
                    return server;
                }) as typeof server.listen;
                return server;
            },
        });

        const createdPromise = service.create({
            mode: 'loopback',
            callbackPath: '/auth/callback',
            timeoutMs: 5_000,
        });
        const created = await createdPromise;

        try {
            const server = captured.server;
            if (!server) {
                throw new Error('Expected test server to be created');
            }
            expect(created).toEqual({
                ok: false,
                code: 'cancelled',
                diagnostics: [{ code: 'authentication_cancelled' }],
            });
            expect(server.listening).toBe(false);
        } finally {
            const server = captured.server;
            if (created.ok) {
                await created.session.close();
            } else if (server?.listening) {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        }
    });
});
