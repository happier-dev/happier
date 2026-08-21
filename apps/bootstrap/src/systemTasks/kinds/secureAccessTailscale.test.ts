import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    let createSecureAccessTailscaleHandler: typeof import('./secureAccessTailscale.js').createSecureAccessTailscaleHandler;

    beforeAll(async () => {
        ({ createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js'));
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('installs missing tailscale before continuing through the existing secure-access flow', async () => {
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
                    running: false,
                    daemonReachable: false,
                    authUrl: null,
                    shareableHttpsUrl: null,
                };
            }
            return {
                installed: true,
                loggedIn: true,
                running: true,
                daemonReachable: true,
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
        tailscaleMocks.runTailscaleStatusJson.mockResolvedValueOnce({
            backendState: 'Running',
            authUrl: null,
            dnsName: 'relay.tailf00.ts.net',
            tailnetName: 'example-tailnet',
            tailscaleIps: ['100.64.0.10'],
            loggedIn: true,
            running: true,
            daemonReachable: true,
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

    it('refuses to claim secure access when the machine is signed in but tailscaled is stopped', async () => {
        // `tailscale down` leaves node identity intact, so the snapshot still
        // reports loggedIn: true — and tailscale keeps replaying the serve
        // config it would apply once the backend comes back up. Trusting that
        // tells the user their relay is reachable from their phone while
        // nothing is listening on it.
        tailscaleMocks.runTailscaleStatusJson.mockResolvedValue({
            backendState: 'Stopped',
            authUrl: null,
            dnsName: 'relay.tailf00.ts.net',
            tailnetName: 'example-tailnet',
            tailscaleIps: ['100.64.0.10'],
            loggedIn: true,
            running: false,
            daemonReachable: true,
        });
        tailscaleMocks.runTailscaleServeStatus.mockResolvedValue([
            'https://relay.tailf00.ts.net',
            '|-- / proxy http://127.0.0.1:3005',
        ].join('\n'));

        await expect(collectHandlerRun({
            handler: createSecureAccessTailscaleHandler(),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/',
                loginPolicy: 'skip',
            },
        })).rejects.toMatchObject({ code: 'tailscale_not_running' });

        expect(tailscaleMocks.runTailscaleServeEnable).not.toHaveBeenCalled();
    });

    it('asks the user to start tailscale, not to sign in, when tailscaled never answered', async () => {
        // Without a reachable daemon there is no login state to report, so
        // `loggedIn: false` must not be read as "sign in again".
        tailscaleMocks.runTailscaleStatusJson.mockResolvedValue({
            backendState: null,
            authUrl: null,
            dnsName: null,
            tailnetName: null,
            tailscaleIps: [],
            loggedIn: false,
            running: false,
            daemonReachable: false,
        });

        await expect(collectHandlerRun({
            handler: createSecureAccessTailscaleHandler({
                loginInteractive: vi.fn(async () => {
                    throw new Error('login must not run while tailscaled is unreachable');
                }),
            }),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/',
                loginPolicy: 'interactive',
            },
        })).rejects.toMatchObject({ code: 'tailscale_not_running' });

        expect(tailscaleMocks.runTailscaleServeEnable).not.toHaveBeenCalled();
    });

    it('polls for serve approval and completes when the expected https URL becomes available', async () => {
        tailscaleMocks.runTailscaleStatusJson.mockResolvedValue({
            backendState: 'Running',
            authUrl: null,
            dnsName: 'relay.tailf00.ts.net',
            tailnetName: 'example-tailnet',
            tailscaleIps: ['100.64.0.10'],
            loggedIn: true,
            running: true,
            daemonReachable: true,
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

    it('stops serve approval polling at the wall-clock deadline', async () => {
        const originalTimeout = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
        const originalInterval = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
        process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = '25';
        process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = '10';
        let now = 0;
        const sleep = vi.fn(async () => undefined);

        tailscaleMocks.runTailscaleStatusJson.mockImplementation(async (options) => {
            if (tailscaleMocks.runTailscaleStatusJson.mock.calls.length === 2) {
                expect((options as any)?.timeoutMs).toBeLessThanOrEqual(25);
                now = 20;
            }
            return {
                backendState: 'Running',
                authUrl: null,
                dnsName: 'relay.tailf00.ts.net',
                tailnetName: 'example-tailnet',
                tailscaleIps: ['100.64.0.10'],
                loggedIn: true,
                running: true,
                daemonReachable: true,
            };
        });
        tailscaleMocks.runTailscaleServeStatus.mockImplementation(async (options) => {
            if (tailscaleMocks.runTailscaleServeStatus.mock.calls.length === 2) {
                expect((options as any)?.timeoutMs).toBeLessThanOrEqual(5);
                now = 25;
            }
            return '';
        });
        tailscaleMocks.runTailscaleServeEnable.mockResolvedValueOnce({
            approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
            httpsUrl: null,
            rawStatus: 'needs approval',
        });

        try {
            const { result } = await collectHandlerRun({
                handler: createSecureAccessTailscaleHandler({
                    sleep,
                    now: () => now,
                }),
                input: {
                    upstreamUrl: 'http://127.0.0.1:3005',
                    servePath: '/',
                    loginPolicy: 'skip',
                },
            });

            expect(sleep).not.toHaveBeenCalled();
            expect(tailscaleMocks.runTailscaleServeStatus).toHaveBeenCalledTimes(2);
            expect(result).toEqual(expect.objectContaining({
                serveEnabled: false,
                shareableHttpsUrl: null,
                requiresApproval: {
                    url: 'https://login.tailscale.com/f/serve?node=node-123',
                },
            }));
        } finally {
            if (originalTimeout === undefined) {
                delete process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = originalTimeout;
            }
            if (originalInterval === undefined) {
                delete process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = originalInterval;
            }
        }
    });

    it('emits a structured needsUserAction prompt when tailscale login requires opening a URL', async () => {
        tailscaleMocks.runTailscaleStatusJson
            .mockResolvedValueOnce({
                backendState: 'NeedsLogin',
                authUrl: 'https://login.tailscale.com/a/example',
                dnsName: null,
                tailnetName: null,
                tailscaleIps: [],
                loggedIn: false,
                running: false,
                daemonReachable: true,
            })
            .mockResolvedValueOnce({
                backendState: 'Running',
                authUrl: null,
                dnsName: 'relay.tailf00.ts.net',
                tailnetName: 'example-tailnet',
                tailscaleIps: ['100.64.0.10'],
                loggedIn: true,
                running: true,
                daemonReachable: true,
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
