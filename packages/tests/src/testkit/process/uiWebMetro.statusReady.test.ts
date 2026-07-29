import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import { __testables } from './uiWebMetro';

const fetchSpy = vi.fn();

type ProbeDiagnostic = Readonly<{
    outcome: 'ready' | 'http-error' | 'invalid-body' | 'request-failed' | 'timeout';
    latencyMs: number;
    detail: string;
}>;

const metroTestables = __testables as unknown as {
    probeMetroPackagerStatus: (baseUrl: string, env: NodeJS.ProcessEnv) => Promise<ProbeDiagnostic>;
    inspectUiWebEntryPage: (url: string, env: NodeJS.ProcessEnv) => Promise<{ diagnostic: ProbeDiagnostic }>;
    waitForPrimaryAppScriptReady: (baseUrl: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
    formatUiWebHttpProbeDiagnostic: (label: 'status' | 'entry', diagnostic: ProbeDiagnostic | null) => string;
};

async function listenOnLoopback(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected the Metro readiness test server to expose a TCP address');
    }
    return `http://127.0.0.1:${address.port}`;
}

async function closeTestServer(server: Server): Promise<void> {
    server.closeAllConnections();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

async function observeReadinessSettlement(
    readiness: Promise<boolean>,
    watchdogMs: number,
): Promise<'resolved' | 'rejected' | 'watchdog'> {
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            readiness.then(() => 'resolved' as const, () => 'rejected' as const),
            new Promise<'watchdog'>((resolve) => {
                watchdog = setTimeout(() => resolve('watchdog'), watchdogMs);
            }),
        ]);
    } finally {
        if (watchdog) clearTimeout(watchdog);
    }
}

describe('uiWebMetro status readiness', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        fetchSpy.mockReset();
    });

    it('requires the Metro /status body to report packager-status:running', async () => {
        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async () => ({
            ok: true,
            headers: { get: () => 'text/plain' },
            text: async () => 'packager-status:booting',
        } as unknown as Response)));

        const diagnostic = await metroTestables.probeMetroPackagerStatus('http://localhost:19077', {
            NODE_ENV: 'test',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
        });
        expect(diagnostic.outcome).toBe('invalid-body');
        expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('accepts a 200 Metro status response when Metro-identifying headers arrive before the body resolves', async () => {
        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async () => ({
            ok: true,
            headers: {
                get: (name: string) => name.toLowerCase() === 'x-react-native-project-root' ? '/tmp/happier-ui' : null,
            },
            text: async () => {
                throw new DOMException('The operation was aborted.', 'AbortError');
            },
        } as unknown as Response)));

        const diagnostic = await metroTestables.probeMetroPackagerStatus('http://localhost:19077', {
            NODE_ENV: 'test',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
        });
        expect(diagnostic.outcome).toBe('ready');
        expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('does not reject a valid Metro status response merely because it takes longer than 250 ms', async () => {
        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async (_input: unknown, init?: RequestInit) => {
            return await new Promise<Response>((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve({
                        ok: true,
                        headers: { get: () => 'text/plain' },
                        text: async () => 'packager-status:running',
                    } as unknown as Response);
                }, 325);
                init?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(init.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                }, { once: true });
            });
        }));

        const diagnostic = await metroTestables.probeMetroPackagerStatus('http://localhost:19077', { NODE_ENV: 'test' });

        expect(diagnostic.outcome).toBe('ready');
        expect(diagnostic.latencyMs).toBeGreaterThan(250);
        expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('keeps one cold primary-bundle request in flight until it is ready', async () => {
        let scriptFetchCount = 0;
        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async (input: unknown, init?: RequestInit) => {
            const url = String(input);
            if (url === 'http://localhost:19077') {
                return {
                    ok: true,
                    headers: { get: () => 'text/html' },
                    text: async () => '<!doctype html><html><head><script src="/index.bundle"></script></head></html>',
                } as unknown as Response;
            }

            scriptFetchCount += 1;
            return await new Promise<Response>((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve({
                        ok: true,
                        headers: { get: () => 'application/javascript' },
                        text: async () => 'globalThis.__HAPPIER_E2E__ = true;',
                    } as unknown as Response);
                }, 80);
                init?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(init.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                }, { once: true });
            });
        }));

        await expect(metroTestables.waitForPrimaryAppScriptReady('http://localhost:19077', {
            NODE_ENV: 'test',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '250',
        })).resolves.toBe(true);
        expect(scriptFetchCount).toBe(1);
    });

    it('aborts one hung primary-bundle request at the total deadline without issuing a duplicate', async () => {
        let scriptFetchCount = 0;
        let scriptAbortCount = 0;
        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async (input: unknown, init?: RequestInit) => {
            if (String(input) === 'http://localhost:19077') {
                return {
                    ok: true,
                    headers: { get: () => 'text/html' },
                    text: async () => '<!doctype html><html><head><script src="/index.bundle"></script></head></html>',
                } as unknown as Response;
            }

            scriptFetchCount += 1;
            return await new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    scriptAbortCount += 1;
                    reject(init.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                }, { once: true });
            });
        }));

        await expect(metroTestables.waitForPrimaryAppScriptReady('http://localhost:19077', {
            NODE_ENV: 'test',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '80',
        })).rejects.toThrow(/expo web primary script ready/);
        expect(scriptFetchCount).toBe(1);
        expect(scriptAbortCount).toBe(1);
    });

    it('settles at the configured deadline when entry headers arrive but the HTML body stalls', async () => {
        const server = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/html' });
            response.flushHeaders();
        });
        const baseUrl = await listenOnLoopback(server);

        try {
            const startedAtMs = Date.now();
            const outcome = await observeReadinessSettlement(
                metroTestables.waitForPrimaryAppScriptReady(baseUrl, {
                    NODE_ENV: 'test',
                    HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '30',
                    HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '30',
                }),
                200,
            );

            expect(outcome).toBe('rejected');
            expect(Date.now() - startedAtMs).toBeLessThan(200);
        } finally {
            await closeTestServer(server);
        }
    });

    it('settles at the configured deadline when an error script sends headers but stalls its diagnostic body', async () => {
        const server = createServer((request, response) => {
            if (request.url === '/') {
                response.writeHead(200, { 'content-type': 'text/html' });
                response.end('<!doctype html><html><head><script src="/index.bundle"></script></head></html>');
                return;
            }
            response.writeHead(503, { 'content-type': 'application/json' });
            response.flushHeaders();
        });
        const baseUrl = await listenOnLoopback(server);

        try {
            const startedAtMs = Date.now();
            const outcome = await observeReadinessSettlement(
                metroTestables.waitForPrimaryAppScriptReady(baseUrl, {
                    NODE_ENV: 'test',
                    HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '30',
                    HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '30',
                }),
                200,
            );

            expect(outcome).toBe('rejected');
            expect(Date.now() - startedAtMs).toBeLessThan(200);
        } finally {
            await closeTestServer(server);
        }
    });

    it('retains bounded redacted refusal and entry-probe outcomes for terminal diagnostics', async () => {
        const secret = 'METRO_DIAGNOSTIC_SECRET';

        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async (input: unknown) => {
            const endpoint = new URL(String(input)).pathname === '/status' ? 'status' : 'entry';
            throw new TypeError(`${endpoint} ECONNREFUSED authorization: Bearer ${secret}`);
        }));

        const status = await metroTestables.probeMetroPackagerStatus('http://localhost:19077', {
            NODE_ENV: 'test',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
        });
        const entry = await metroTestables.inspectUiWebEntryPage('http://localhost:19077', {
            NODE_ENV: 'test',
            HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
        });
        const terminalDetail = [
            metroTestables.formatUiWebHttpProbeDiagnostic('status', status),
            metroTestables.formatUiWebHttpProbeDiagnostic('entry', entry.diagnostic),
        ].join(' | ');

        expect(terminalDetail).toContain('status=request-failed');
        expect(terminalDetail).toContain('entry=request-failed');
        expect(terminalDetail).toMatch(/latencyMs=\d+/);
        expect(terminalDetail).not.toContain(secret);
        expect(terminalDetail.length).toBeLessThan(1_000);
    });

    it('distinguishes an invalid Metro status body from transport failure', async () => {
        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async () => ({
            ok: true,
            headers: { get: () => 'text/plain' },
            text: async () => 'packager-status:booting',
        } as unknown as Response)));

        const diagnostic = await metroTestables.probeMetroPackagerStatus('http://localhost:19077', {
            NODE_ENV: 'test',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
        });

        expect(diagnostic.outcome).toBe('invalid-body');
        expect(diagnostic.detail).toContain('did not report packager-status:running');
    });
});
