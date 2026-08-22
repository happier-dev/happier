import { beforeEach, describe, expect, it, vi } from 'vitest';

const tailscaleMocks = vi.hoisted(() => ({
    runTailscaleStatusJson: vi.fn(),
    runTailscaleServeStatus: vi.fn(),
    runTailscaleLogin: vi.fn(),
    runTailscaleServeEnable: vi.fn(),
}));

const relayAccessMocks = vi.hoisted(() => ({
    getRelayAccessProvider: vi.fn(),
}));

const relayAccessActual = vi.hoisted(() => ({
    getRelayAccessProvider: null as unknown as typeof import('@happier-dev/cli-common/relayAccess').getRelayAccessProvider,
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

vi.mock('@happier-dev/cli-common/relayAccess', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/relayAccess')>('@happier-dev/cli-common/relayAccess');
    relayAccessActual.getRelayAccessProvider = actual.getRelayAccessProvider;
    relayAccessMocks.getRelayAccessProvider.mockImplementation((providerId) => actual.getRelayAccessProvider(providerId));
    return {
        ...actual,
        getRelayAccessProvider: relayAccessMocks.getRelayAccessProvider,
    };
});

async function collectHandlerRun(
    params: Readonly<{
        handler: (input: Record<string, unknown>, context?: Readonly<{ signal?: AbortSignal }>) => AsyncGenerator<unknown, unknown, void>;
        input: Record<string, unknown>;
        context?: Readonly<{ signal?: AbortSignal }>;
    }>,
): Promise<Readonly<{
    events: unknown[];
    result: unknown;
}>> {
    const events: unknown[] = [];
    const iterator = params.handler(params.input, params.context);

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
        relayAccessMocks.getRelayAccessProvider.mockImplementation((providerId) => relayAccessActual.getRelayAccessProvider(providerId));
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
            expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
            expect.objectContaining({ type: 'progress', stepId: 'tailscale.install' }),
            expect.objectContaining({
                type: 'progress',
                stepId: 'tailscale.verifyUrl',
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
    }, 25_000);

    it('delegates the secure-access serve enable step to the relay-access tailscaleServe provider', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        const abortController = new AbortController();
        const configure = vi.fn(async () => ({
            state: 'enabled' as const,
            shareUrl: 'https://relay.tailf00.ts.net',
        }));
        const status = vi.fn(async () => ({
            state: 'enabled' as const,
            shareUrl: 'https://relay.tailf00.ts.net',
        }));
        relayAccessMocks.getRelayAccessProvider.mockReturnValue({
            descriptor: {
                id: 'tailscaleServe',
                title: 'Tailscale Serve',
                exposure: 'private',
                prerequisites: [],
            },
            configure,
            status,
            disable: vi.fn(),
        });

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

        const { result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler({
                inspectState: vi.fn(async () => ({
                    installed: true,
                    loggedIn: true,
                    running: true,
                    daemonReachable: true,
                    authUrl: null,
                    shareableHttpsUrl: null,
                })),
            }),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/',
                installPolicy: 'skip',
                loginPolicy: 'skip',
            },
            context: { signal: abortController.signal },
        });

        expect(relayAccessMocks.getRelayAccessProvider).toHaveBeenCalledWith('tailscaleServe');
        expect(configure).toHaveBeenCalledTimes(1);
        expect(configure).toHaveBeenCalledWith(expect.objectContaining({
            signal: abortController.signal,
        }));
        expect(status).toHaveBeenCalledTimes(1);
        expect(status).toHaveBeenCalledWith(expect.objectContaining({
            signal: abortController.signal,
        }));
        expect(tailscaleMocks.runTailscaleServeEnable).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
            shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            serveEnabled: true,
            requiresApproval: null,
        }));
    }, 15_000);

    it('delegates the secure-access enable step to the relay-access tailscaleFunnel provider when requested', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        const configure = vi.fn(async () => ({
            state: 'enabled' as const,
            shareUrl: 'https://relay.tailf00.ts.net',
        }));
        const status = vi.fn(async () => ({
            state: 'enabled' as const,
            shareUrl: 'https://relay.tailf00.ts.net',
        }));
        relayAccessMocks.getRelayAccessProvider.mockReturnValue({
            descriptor: {
                id: 'tailscaleFunnel',
                title: 'Tailscale Funnel',
                exposure: 'public',
                prerequisites: [],
            },
            configure,
            status,
            disable: vi.fn(),
        });

        const { result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler({
                inspectState: vi.fn(async () => ({
                    installed: true,
                    loggedIn: true,
                    running: true,
                    daemonReachable: true,
                    authUrl: null,
                    shareableHttpsUrl: null,
                })),
            }),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                providerId: 'tailscaleFunnel',
                servePath: '/',
                installPolicy: 'skip',
                loginPolicy: 'skip',
            },
        });

        expect(relayAccessMocks.getRelayAccessProvider).toHaveBeenCalledWith('tailscaleFunnel');
        expect(configure).toHaveBeenCalledTimes(1);
        expect(status).toHaveBeenCalledTimes(1);
        expect(result).toEqual(expect.objectContaining({
            shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            serveEnabled: true,
            requiresApproval: null,
        }));
    }, 15_000);

    it('appends the serve path to the relay access share URL', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        relayAccessMocks.getRelayAccessProvider.mockReturnValue({
            descriptor: {
                id: 'tailscaleServe',
                title: 'Tailscale Serve',
                exposure: 'private',
                prerequisites: [],
            },
            configure: vi.fn(),
            status: vi.fn(async () => ({
                state: 'enabled' as const,
                shareUrl: 'https://relay.tailf00.ts.net',
            })),
            disable: vi.fn(),
        });

        const { events, result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler(),
            input: {
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/panel',
                loginPolicy: 'skip',
            },
        });

        expect(events.some((event) => (event as any)?.stepId === 'tailscale.verifyUrl')).toBe(true);
        expect(result).toEqual(expect.objectContaining({
            shareableHttpsUrl: 'https://relay.tailf00.ts.net/panel',
            serveEnabled: true,
            requiresApproval: null,
        }));
    });

    it('polls for serve approval and completes when the expected https URL becomes available', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        relayAccessMocks.getRelayAccessProvider.mockReturnValue({
            descriptor: {
                id: 'tailscaleServe',
                title: 'Tailscale Serve',
                exposure: 'private',
                prerequisites: [],
            },
            configure: vi.fn(async () => ({
                state: 'needs_auth' as const,
                details: {
                    approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
                },
            })),
            status: vi.fn(async () => ({
                state: 'enabled' as const,
                shareUrl: 'https://relay.tailf00.ts.net',
            })),
            disable: vi.fn(),
        });

        const inspectState = vi.fn()
            .mockResolvedValueOnce({
                installed: true,
                loggedIn: true,
                running: true,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: null,
            })
            .mockResolvedValueOnce({
                installed: true,
                loggedIn: true,
                running: true,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: null,
            })
            .mockResolvedValueOnce({
                installed: true,
                loggedIn: true,
                running: true,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            });

        const { events, result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler({
                inspectState,
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
        expect(result).toEqual(expect.objectContaining({
            serveEnabled: true,
            shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            requiresApproval: null,
        }));
    });

    it('stops serve approval polling at the wall-clock deadline when status checks are slow', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');
        const previousPollTimeoutMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
        const previousPollIntervalMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
        let fakeNow = 0;
        const slept: number[] = [];

        relayAccessMocks.getRelayAccessProvider.mockReturnValue({
            descriptor: {
                id: 'tailscaleServe',
                title: 'Tailscale Serve',
                exposure: 'private',
                prerequisites: [],
            },
            configure: vi.fn(async () => ({
                state: 'needs_auth' as const,
                details: {
                    approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
                },
            })),
            status: vi.fn(async () => ({
                state: 'needs_auth' as const,
                details: {
                    approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
                },
            })),
            disable: vi.fn(),
        });

        const inspectState = vi.fn(async () => {
            fakeNow += 20;
            return {
                installed: true,
                loggedIn: true,
                running: true,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: null,
            };
        });

        try {
            process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = '25';
            process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = '10';

            const { result } = await collectHandlerRun({
                handler: createSecureAccessTailscaleHandler({
                    inspectState,
                    sleep: async (ms) => {
                        slept.push(ms);
                        fakeNow += ms;
                    },
                    now: () => fakeNow,
                }),
                input: {
                    upstreamUrl: 'http://127.0.0.1:3005',
                    servePath: '/',
                    loginPolicy: 'skip',
                },
            });

            expect(inspectState).toHaveBeenCalledTimes(2);
            expect(slept).toEqual([5]);
            expect(result).toEqual(expect.objectContaining({
                serveEnabled: false,
                shareableHttpsUrl: null,
                requiresApproval: {
                    url: 'https://login.tailscale.com/f/serve?node=node-123',
                },
            }));
        } finally {
            if (previousPollTimeoutMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = previousPollTimeoutMs;
            }
            if (previousPollIntervalMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = previousPollIntervalMs;
            }
        }
    });

    it('passes the remaining approval poll budget into each status inspection', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');
        const previousPollTimeoutMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
        const previousPollIntervalMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
        let fakeNow = 0;
        const inspectBudgets: Array<number | undefined> = [];
        const inspectDeadlines: Array<unknown> = [];

        relayAccessMocks.getRelayAccessProvider.mockReturnValue({
            descriptor: {
                id: 'tailscaleServe',
                title: 'Tailscale Serve',
                exposure: 'private',
                prerequisites: [],
            },
            configure: vi.fn(async () => ({
                state: 'needs_auth' as const,
                details: {
                    approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
                },
            })),
            status: vi.fn(async () => ({
                state: 'needs_auth' as const,
                details: {
                    approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
                },
            })),
            disable: vi.fn(),
        });

        const inspectState = vi.fn(async (_params, options?: Readonly<{ timeoutMs?: number; deadline?: unknown }>) => {
            inspectBudgets.push(options?.timeoutMs);
            inspectDeadlines.push(options?.deadline);
            fakeNow += 20;
            return {
                installed: true,
                loggedIn: true,
                running: true,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: null,
            };
        });

        try {
            process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = '25';
            process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = '10';

            const { result } = await collectHandlerRun({
                handler: createSecureAccessTailscaleHandler({
                    inspectState,
                    sleep: async (ms) => {
                        fakeNow += ms;
                    },
                    now: () => fakeNow,
                }),
                input: {
                    upstreamUrl: 'http://127.0.0.1:3005',
                    servePath: '/',
                    loginPolicy: 'skip',
                },
            });

            expect(inspectBudgets).toEqual([undefined, 25]);
            expect(inspectDeadlines[1]).toEqual(expect.objectContaining({
                startedAt: 20,
                deadlineAt: 45,
            }));
            expect(result).toEqual(expect.objectContaining({
                serveEnabled: false,
                shareableHttpsUrl: null,
            }));
        } finally {
            if (previousPollTimeoutMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = previousPollTimeoutMs;
            }
            if (previousPollIntervalMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = previousPollIntervalMs;
            }
        }
    });

    it('uses one approval poll deadline across readiness and relay provider status commands', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');
        const previousPollTimeoutMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
        const previousPollIntervalMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
        let fakeNow = 0;

        tailscaleMocks.runTailscaleStatusJson.mockResolvedValue({
            backendState: 'Running',
            authUrl: null,
            dnsName: 'my-machine.tailnet.ts.net',
            tailnetName: 'tailnet.ts.net',
            tailscaleIps: [],
            loggedIn: true,
            running: true,
            daemonReachable: true,
        });
        tailscaleMocks.runTailscaleServeStatus
            .mockResolvedValueOnce('No serve config')
            .mockResolvedValueOnce('https://my-machine.tailnet.ts.net\n|-- / proxy http://127.0.0.1:3005');
        tailscaleMocks.runTailscaleServeEnable.mockResolvedValue({
            approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
            httpsUrl: null,
            rawStatus: 'approval required',
        });

        try {
            process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = '25';
            process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = '10';

            const { result } = await collectHandlerRun({
                handler: createSecureAccessTailscaleHandler({
                    sleep: async (ms) => {
                        fakeNow += ms;
                    },
                    now: () => fakeNow,
                }),
                input: {
                    upstreamUrl: 'http://127.0.0.1:3005',
                    servePath: '/',
                    loginPolicy: 'skip',
                },
            });

            const readinessPollParams = tailscaleMocks.runTailscaleStatusJson.mock.calls[2]?.[0];
            const providerPollParams = tailscaleMocks.runTailscaleStatusJson.mock.calls[3]?.[0];
            const servePollParams = tailscaleMocks.runTailscaleServeStatus.mock.calls[1]?.[0];
            expect(readinessPollParams?.deadline).toEqual(expect.objectContaining({
                startedAt: 0,
                deadlineAt: 25,
            }));
            expect(providerPollParams?.deadline).toBe(readinessPollParams?.deadline);
            expect(servePollParams?.deadline).toBe(readinessPollParams?.deadline);
            expect(providerPollParams?.timeoutMs).toBe(25);
            expect(servePollParams?.timeoutMs).toBe(25);
            expect(result).toEqual(expect.objectContaining({
                serveEnabled: true,
                shareableHttpsUrl: 'https://my-machine.tailnet.ts.net',
                requiresApproval: null,
            }));
        } finally {
            if (previousPollTimeoutMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = previousPollTimeoutMs;
            }
            if (previousPollIntervalMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = previousPollIntervalMs;
            }
        }
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

        relayAccessMocks.getRelayAccessProvider.mockReturnValue({
            descriptor: {
                id: 'tailscaleServe',
                title: 'Tailscale Serve',
                exposure: 'private',
                prerequisites: [],
            },
            configure: vi.fn(),
            status: vi.fn(async () => ({
                state: 'enabled' as const,
                shareUrl: 'https://relay.tailf00.ts.net',
            })),
            disable: vi.fn(),
        });

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

    it('uses the SSH relay host target for Tailscale readiness inspection and relay-access configuration', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        const remoteRunCommand = vi.fn(async () => ({
            command: 'tailscale',
            args: ['status', '--json'],
            exitCode: 0,
            stdout: JSON.stringify({
                backendState: 'Running',
                authUrl: null,
                dnsName: 'relay.tailf00.ts.net',
                tailnetName: 'example-tailnet',
                tailscaleIps: ['100.64.0.10'],
                loggedIn: true,
                running: true,
                daemonReachable: true,
            }),
            stderr: '',
        }));
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
        const createExecutionContext = vi.fn(() => ({
            env: process.env,
            upstreamUrl: 'http://127.0.0.1:3005',
            runCommand: remoteRunCommand,
            resolveCommandOnPath: (command: string) => command,
        }));
        const configure = vi.fn(async () => ({
            state: 'enabled' as const,
            shareUrl: 'https://relay.tailf00.ts.net',
        }));
        const status = vi.fn()
            .mockResolvedValueOnce({
                state: 'disabled' as const,
            })
            .mockResolvedValueOnce({
                state: 'enabled' as const,
                shareUrl: 'https://relay.tailf00.ts.net',
            });

        const { result } = await collectHandlerRun({
            handler: createSecureAccessTailscaleHandler({
                relayAccess: {
                    getProvider: vi.fn(() => ({
                        descriptor: {
                            id: 'tailscaleServe' as const,
                            title: 'Tailscale Serve',
                            exposure: 'private' as const,
                            prerequisites: [],
                        },
                        configure,
                        status,
                        disable: vi.fn(),
                    })),
                    writeConfig: vi.fn(async () => undefined),
                    createExecutionContext,
                },
            }),
            input: {
                target: {
                    kind: 'ssh',
                    ssh: {
                        target: 'dev@example.test',
                        auth: 'agent',
                    },
                },
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/',
                installPolicy: 'skip',
                loginPolicy: 'skip',
            },
        });

        expect(tailscaleMocks.runTailscaleStatusJson).toHaveBeenCalledWith(
            expect.objectContaining({ env: process.env }),
            expect.objectContaining({
                runCommand: remoteRunCommand,
                resolveCommandOnPath: expect.any(Function),
            }),
        );
        expect(createExecutionContext).toHaveBeenCalledWith({
            target: {
                kind: 'ssh',
                ssh: {
                    target: 'dev@example.test',
                    auth: 'agent',
                },
            },
            upstreamUrl: 'http://127.0.0.1:3005',
        });
        expect(configure).toHaveBeenCalledWith(expect.objectContaining({
            ctx: expect.objectContaining({
                runCommand: remoteRunCommand,
                upstreamUrl: 'http://127.0.0.1:3005',
            }),
        }));
        expect(status).toHaveBeenCalledWith(expect.objectContaining({
            ctx: expect.objectContaining({
                runCommand: remoteRunCommand,
                upstreamUrl: 'http://127.0.0.1:3005',
            }),
        }));
        expect(result).toEqual(expect.objectContaining({
            shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            serveEnabled: true,
            requiresApproval: null,
        }));
    });

    it('prompts for manual install when an SSH relay host is missing tailscale', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        tailscaleMocks.runTailscaleStatusJson.mockRejectedValue(new Error('tailscale cli not found'));
        const remoteRunCommand = vi.fn(async () => ({
            command: 'sh',
            args: ['-lc', "uname -s | tr '[:upper:]' '[:lower:]'"],
            exitCode: 0,
            stdout: 'linux\n',
            stderr: '',
        }));
        const createExecutionContext = vi.fn(() => ({
            env: process.env,
            upstreamUrl: 'http://127.0.0.1:3005',
            runCommand: remoteRunCommand,
            resolveCommandOnPath: (command: string) => command,
        }));

        const iterator = createSecureAccessTailscaleHandler({
            relayAccess: {
                getProvider: vi.fn(() => {
                    throw new Error('provider resolution should not run before tailscale is installed');
                }),
                writeConfig: vi.fn(async () => undefined),
                createExecutionContext,
            },
        })({
            target: {
                kind: 'ssh',
                ssh: {
                    target: 'dev@example.test',
                    auth: 'agent',
                },
            },
            upstreamUrl: 'http://127.0.0.1:3005',
            installPolicy: 'installIfMissing',
            loginPolicy: 'skip',
        });

        await expect(iterator.next()).resolves.toEqual(expect.objectContaining({
            done: false,
            value: expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        }));
        await expect(iterator.next()).resolves.toEqual(expect.objectContaining({
            done: false,
            value: expect.objectContaining({ type: 'progress', stepId: 'tailscale.install' }),
        }));
        await expect(iterator.next()).resolves.toEqual(expect.objectContaining({
            done: false,
            value: expect.objectContaining({
                type: 'prompt',
                stepId: 'tailscale.install',
                data: expect.objectContaining({
                    kind: 'tailscaleInstall',
                    platform: 'linux',
                }),
            }),
        }));
        await expect(iterator.next()).rejects.toMatchObject({
            code: 'prompt_required',
        });
    });

    it('rejects malformed relay host targets instead of silently falling back to local execution', async () => {
        const { createSecureAccessTailscaleHandler } = await import('./secureAccessTailscale.js');

        const handler = createSecureAccessTailscaleHandler({
            inspectState: vi.fn(async () => ({
                installed: true,
                loggedIn: true,
                running: true,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: 'https://relay.tailf00.ts.net',
            })),
        });

        await expect(collectHandlerRun({
            handler,
            input: {
                target: {
                    kind: 'bogus',
                },
                upstreamUrl: 'http://127.0.0.1:3005',
                installPolicy: 'skip',
                loginPolicy: 'skip',
            },
        })).rejects.toMatchObject({
            code: 'invalid_params',
        });
    });
});
