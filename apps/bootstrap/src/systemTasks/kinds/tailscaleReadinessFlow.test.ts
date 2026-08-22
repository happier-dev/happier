import { describe, expect, it, vi } from 'vitest';

import {
    runTailscaleReadinessFlow,
    type TailscaleReadinessFlowDeps,
    type TailscaleReadinessInspectionOptions,
} from './tailscaleReadinessFlow.js';

type TestParams = Readonly<{
    installPolicy: 'skip' | 'installIfMissing';
    loginPolicy: 'skip' | 'interactive';
    mode: 'normalUser' | 'managedAdmin';
}>;

async function collectReadinessFlow(params: Readonly<{
    deps: TailscaleReadinessFlowDeps<TestParams>;
}>): Promise<unknown[]> {
    const events: unknown[] = [];
    const iterator = runTailscaleReadinessFlow<TestParams>({
        installPolicy: 'skip',
        loginPolicy: 'interactive',
        mode: 'normalUser',
    }, params.deps);

    while (true) {
        const next = await iterator.next();
        if (next.done) {
            return events;
        }
        events.push(next.value);
    }
}

describe('runTailscaleReadinessFlow', () => {
    it('stops login polling at the wall-clock deadline when status checks are slow', async () => {
        const previousPollTimeoutMs = process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS;
        const previousPollIntervalMs = process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS;
        let fakeNow = 0;
        const slept: number[] = [];
        const inspectState = vi.fn(async () => {
            fakeNow += 20;
            return {
                installed: true,
                loggedIn: false,
                running: false,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: null,
            };
        });
        const deps: TailscaleReadinessFlowDeps<TestParams> = {
            inspectState,
            ensureInstalled: vi.fn(async () => ({
                outcome: 'ready' as const,
                installedNow: false,
                installerLaunched: false,
                tailscaleBin: '/tmp/tailscale',
            })),
            loginInteractive: vi.fn(async () => ({
                usedQr: false,
                actionUrl: 'https://login.tailscale.com/a/example',
                result: {
                    command: '/tmp/tailscale',
                    args: ['login'],
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                },
            })),
            resolveInstallPrompt: vi.fn(async () => ({
                platform: 'linux' as const,
                url: 'https://tailscale.com/download',
            })),
            sleep: vi.fn(async (ms) => {
                slept.push(ms);
                fakeNow += ms;
            }),
            now: () => fakeNow,
        };

        try {
            process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS = '25';
            process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS = '10';

            await expect(collectReadinessFlow({ deps })).rejects.toMatchObject({
                code: 'prompt_required',
            });

            expect(inspectState).toHaveBeenCalledTimes(3);
            expect(slept).toEqual([5]);
        } finally {
            if (previousPollTimeoutMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS = previousPollTimeoutMs;
            }
            if (previousPollIntervalMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS = previousPollIntervalMs;
            }
        }
    });

    it('passes the remaining login poll budget into each status inspection', async () => {
        const previousPollTimeoutMs = process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS;
        const previousPollIntervalMs = process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS;
        let fakeNow = 0;
        const inspectBudgets: Array<number | undefined> = [];
        const inspectDeadlines: TailscaleReadinessInspectionOptions['deadline'][] = [];
        const inspectState = vi.fn(async (_params, options?: TailscaleReadinessInspectionOptions) => {
            inspectBudgets.push(options?.timeoutMs);
            inspectDeadlines.push(options?.deadline);
            fakeNow += 20;
            return {
                installed: true,
                loggedIn: false,
                running: false,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: null,
            };
        });
        const deps: TailscaleReadinessFlowDeps<TestParams> = {
            inspectState,
            ensureInstalled: vi.fn(async () => ({
                outcome: 'ready' as const,
                installedNow: false,
                installerLaunched: false,
                tailscaleBin: '/tmp/tailscale',
            })),
            loginInteractive: vi.fn(async () => ({
                usedQr: false,
                actionUrl: 'https://login.tailscale.com/a/example',
                result: {
                    command: '/tmp/tailscale',
                    args: ['login'],
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                },
            })),
            resolveInstallPrompt: vi.fn(async () => ({
                platform: 'linux' as const,
                url: 'https://tailscale.com/download',
            })),
            sleep: vi.fn(async (ms) => {
                fakeNow += ms;
            }),
            now: () => fakeNow,
        };

        try {
            process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS = '25';
            process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS = '10';

            await expect(collectReadinessFlow({ deps })).rejects.toMatchObject({
                code: 'prompt_required',
            });

            expect(inspectBudgets).toEqual([undefined, undefined, 25]);
            expect(inspectDeadlines[2]).toEqual(expect.objectContaining({
                startedAt: 40,
                deadlineAt: 65,
            }));
        } finally {
            if (previousPollTimeoutMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS = previousPollTimeoutMs;
            }
            if (previousPollIntervalMs === undefined) {
                delete process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS = previousPollIntervalMs;
            }
        }
    });
});

describe('runTailscaleReadinessFlow backend liveness', () => {
    function baseDeps(
        inspectState: TailscaleReadinessFlowDeps<TestParams>['inspectState'],
        overrides?: Partial<TailscaleReadinessFlowDeps<TestParams>>,
    ): TailscaleReadinessFlowDeps<TestParams> {
        return {
            inspectState,
            ensureInstalled: vi.fn(async () => ({
                outcome: 'ready' as const,
                installedNow: false,
                installerLaunched: false,
                tailscaleBin: '/tmp/tailscale',
            })),
            loginInteractive: vi.fn(async () => {
                throw new Error('login must not run for a machine that is already signed in');
            }),
            resolveInstallPrompt: vi.fn(async () => ({ platform: 'darwin' as NodeJS.Platform, url: 'https://tailscale.com/download' })),
            sleep: vi.fn(async () => undefined),
            now: () => 0,
            ...overrides,
        };
    }

    async function runFlow(params: Readonly<{
        deps: TailscaleReadinessFlowDeps<TestParams>;
        mode?: 'normalUser' | 'managedAdmin';
    }>): Promise<void> {
        const iterator = runTailscaleReadinessFlow<TestParams>({
            installPolicy: 'skip',
            loginPolicy: 'interactive',
            mode: params.mode ?? 'normalUser',
        }, params.deps);
        while (!(await iterator.next()).done) {
            // drain
        }
    }

    it('refuses to report readiness for a signed-in machine whose backend is stopped', async () => {
        // `tailscale down` keeps node identity, so loggedIn stays true while no
        // traffic can flow. Reporting that as ready hands the user a relay URL
        // their other devices cannot reach.
        const deps = baseDeps(vi.fn(async () => ({
            installed: true,
            loggedIn: true,
            running: false,
            daemonReachable: true,
            authUrl: null,
            shareableHttpsUrl: null,
        })));

        await expect(runFlow({ deps })).rejects.toMatchObject({ code: 'tailscale_not_running' });
    });

    it('asks the user to start tailscale, not to sign in, when tailscaled never answered', async () => {
        const deps = baseDeps(vi.fn(async () => ({
            installed: true,
            loggedIn: false,
            running: false,
            daemonReachable: false,
            authUrl: null,
            shareableHttpsUrl: null,
        })));

        await expect(runFlow({ deps })).rejects.toMatchObject({ code: 'tailscale_not_running' });
        expect(deps.loginInteractive).not.toHaveBeenCalled();
    });

    it('asks a managed admin to start tailscale rather than prompting a fresh sign-in', async () => {
        const deps = baseDeps(vi.fn(async () => ({
            installed: true,
            loggedIn: false,
            running: false,
            daemonReachable: false,
            authUrl: null,
            shareableHttpsUrl: null,
        })));

        await expect(runFlow({ deps, mode: 'managedAdmin' })).rejects.toMatchObject({ code: 'tailscale_not_running' });
    });
});
