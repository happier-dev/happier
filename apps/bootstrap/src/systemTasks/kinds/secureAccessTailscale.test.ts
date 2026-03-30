import { beforeEach, describe, expect, it, vi } from 'vitest';

const tailscaleMocks = vi.hoisted(() => ({
    runTailscaleStatusJson: vi.fn(),
    runTailscaleServeStatus: vi.fn(),
    runTailscaleLogin: vi.fn(),
    runTailscaleServeEnable: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/tailscale', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/tailscale')>('@happier-dev/cli-common/tailscale');
    return {
        ...actual,
        runTailscaleStatusJson: tailscaleMocks.runTailscaleStatusJson,
        runTailscaleServeStatus: tailscaleMocks.runTailscaleServeStatus,
        runTailscaleLogin: tailscaleMocks.runTailscaleLogin,
        runTailscaleServeEnable: tailscaleMocks.runTailscaleServeEnable,
    };
});

async function collectHandlerRun(
    params: Readonly<{
        handler: (input: Record<string, unknown>, context?: Readonly<{ signal?: AbortSignal }>) => AsyncGenerator<unknown, unknown, void>;
        input: Record<string, unknown>;
    }>,
): Promise<Readonly<{
    events: unknown[];
    result: unknown;
}>> {
    const events: unknown[] = [];
    const iterator = params.handler(params.input);

    while (true) {
        const next = await iterator.next();
        if (next.done) {
            return {
                events,
                result: next.value,
            };
        }
        events.push(next.value);
    }
}

describe('createSecureAccessTailscaleHandler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('installs missing tailscale before continuing through the existing secure-access flow', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');
        let inspectCalls = 0;
        const ensureInstalled = vi.fn(async () => ({
            outcome: 'ready' as const,
            installedNow: true,
            installerLaunched: true,
            tailscaleBin: '/tmp/tailscale',
        }));
        const inspectState = vi.fn(async () => {
            inspectCalls += 1;
            if (inspectCalls === 1) {
                return {
                    installed: false,
                    loggedIn: false,
                    authUrl: null,
                    shareableHttpsUrl: null,
                };
            }
            return {
                installed: true,
                loggedIn: true,
                authUrl: null,
                shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            };
        });

        const deps = {
            inspectState,
            ensureInstalled,
            loginInteractive: vi.fn(async () => {
                throw new Error('login should not run when install finishes into an already-authenticated tailscale state');
            }),
            enableServe: vi.fn(async () => {
                throw new Error('serve enable should not run when the existing shareable URL is already available');
            }),
        };

        const { events, result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler(deps),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                installPolicy: 'installIfMissing',
            },
        });

        expect(ensureInstalled).toHaveBeenCalledTimes(1);
        expect(inspectState).toHaveBeenCalledTimes(2);
        expect(events).toEqual([
            expect.objectContaining({ type: 'progress', stepId: 'detect' }),
            expect.objectContaining({ type: 'progress', stepId: 'install' }),
            expect.objectContaining({
                type: 'progress',
                stepId: 'verify url',
                data: {
                    kind: 'tailscaleSecureAccessUrl',
                    shareableHttpsUrl: 'https://relay.tailf00.ts.net',
                },
            }),
        ]);
        expect(result).toEqual({
            tailscaleInstalled: true,
            tailscaleLoggedIn: true,
            serveEnabled: true,
            shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            requiresApproval: null,
        });
    });

    it('does not treat an unrelated serve https URL as valid when the upstream port does not match', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        tailscaleMocks.runTailscaleStatusJson.mockResolvedValueOnce({
            backendState: 'Running',
            authUrl: null,
            dnsName: 'relay.tailf00.ts.net',
            tailnetName: 'example-tailnet',
            tailscaleIps: ['100.64.0.10'],
            loggedIn: true,
        });
        tailscaleMocks.runTailscaleServeStatus.mockResolvedValueOnce([
            'https://other.tailf00.ts.net',
            '|-- / proxy http://127.0.0.1:9999',
        ].join('\n'));
        tailscaleMocks.runTailscaleServeEnable.mockResolvedValueOnce({
            approvalUrl: null,
            httpsUrl: 'https://relay.tailf00.ts.net',
            rawStatus: '',
        });

        const { events, result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler(),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/',
                loginPolicy: 'skip',
            },
        });

        expect(tailscaleMocks.runTailscaleServeEnable).toHaveBeenCalledTimes(1);
        expect(events.some((event) => (event as any)?.stepId === 'serve enable')).toBe(true);
        expect(result).toEqual(expect.objectContaining({
            shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            serveEnabled: true,
            requiresApproval: null,
        }));
    });

    it('polls for serve approval and completes when the expected https URL becomes available', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        tailscaleMocks.runTailscaleStatusJson.mockResolvedValue({
            backendState: 'Running',
            authUrl: null,
            dnsName: 'relay.tailf00.ts.net',
            tailnetName: 'example-tailnet',
            tailscaleIps: ['100.64.0.10'],
            loggedIn: true,
        });
        tailscaleMocks.runTailscaleServeStatus
            .mockResolvedValueOnce('') // initial inspect: not enabled
            .mockResolvedValueOnce([
                'https://relay.tailf00.ts.net',
                '|-- / proxy http://127.0.0.1:9999',
            ].join('\n')) // first poll: wrong upstream
            .mockResolvedValueOnce([
                'https://relay.tailf00.ts.net',
                '|-- / proxy http://127.0.0.1:3005',
            ].join('\n')); // second poll: approved

        tailscaleMocks.runTailscaleServeEnable.mockResolvedValueOnce({
            approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
            httpsUrl: null,
            rawStatus: 'needs approval',
        });

        const { events, result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler({
                sleep: async () => undefined,
                now: () => 0,
            }),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/',
                loginPolicy: 'skip',
            },
        });

        expect(events.some((event) => (event as any)?.type === 'prompt' && (event as any)?.data?.kind === 'tailscaleServeApproval')).toBe(true);
        expect(tailscaleMocks.runTailscaleServeStatus).toHaveBeenCalledTimes(3);
        expect(result).toEqual(expect.objectContaining({
            serveEnabled: true,
            shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            requiresApproval: null,
        }));
    });

    it('emits a structured needsUserAction prompt when tailscale login requires opening a URL', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        tailscaleMocks.runTailscaleStatusJson
            .mockResolvedValueOnce({
                backendState: 'NeedsLogin',
                authUrl: 'https://login.tailscale.com/a/example',
                dnsName: null,
                tailnetName: null,
                tailscaleIps: [],
                loggedIn: false,
            })
            .mockResolvedValueOnce({
                backendState: 'Running',
                authUrl: null,
                dnsName: 'relay.tailf00.ts.net',
                tailnetName: 'example-tailnet',
                tailscaleIps: ['100.64.0.10'],
                loggedIn: true,
            });

        tailscaleMocks.runTailscaleLogin.mockResolvedValueOnce({
            usedQr: false,
            actionUrl: 'https://login.tailscale.com/a/example',
            result: {
                command: '/bin/tailscale',
                args: ['login'],
                exitCode: 0,
                stdout: 'visit https://login.tailscale.com/a/example',
                stderr: '',
            },
        });

        tailscaleMocks.runTailscaleServeStatus.mockResolvedValueOnce([
            'https://relay.tailf00.ts.net',
            '|-- / proxy http://127.0.0.1:3005',
        ].join('\n'));

        const { events, result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler({
                sleep: async () => undefined,
                now: () => 0,
            }),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/',
                loginPolicy: 'interactive',
            },
        });

        expect(events.some((event) => (event as any)?.type === 'prompt' && (event as any)?.data?.kind === 'needsUserAction.openUrl')).toBe(true);
        expect(result).toEqual(expect.objectContaining({
            tailscaleLoggedIn: true,
            shareableHttpsUrl: 'https://relay.tailf00.ts.net',
        }));
    });
});
