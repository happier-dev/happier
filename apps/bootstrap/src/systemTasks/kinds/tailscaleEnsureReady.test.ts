import { describe, expect, it, vi } from 'vitest';

import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';

async function collectHandlerRun(
    params: Readonly<{
        handler: (input: Record<string, unknown>, context?: Readonly<{ signal?: AbortSignal }>) => AsyncGenerator<unknown, unknown, void>;
        input: Record<string, unknown>;
    }>,
): Promise<Readonly<{
    events: unknown[];
    result?: unknown;
    error?: unknown;
}>> {
    const events: unknown[] = [];
    const iterator = params.handler(params.input);

    try {
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
    } catch (error) {
        return {
            events,
            error,
        };
    }
}

describe('createTailscaleEnsureReadyHandler', () => {
    it('installs missing tailscale, completes interactive login, and returns structured readiness data', async () => {
        const { createTailscaleEnsureReadyHandler } = await import('./tailscaleEnsureReady.js');

        let inspectCalls = 0;
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
            if (inspectCalls === 2) {
                return {
                    installed: true,
                    loggedIn: false,
                    running: false,
                    daemonReachable: true,
                    authUrl: 'https://login.tailscale.com/a/example',
                    shareableHttpsUrl: null,
                };
            }
            return {
                installed: true,
                loggedIn: true,
                running: true,
                daemonReachable: true,
                authUrl: null,
                shareableHttpsUrl: null,
            };
        });

        const { events, result, error } = await collectHandlerRun({
            handler: createTailscaleEnsureReadyHandler({
                inspectState,
                ensureInstalled: vi.fn(async () => ({
                    outcome: 'ready' as const,
                    installedNow: true,
                    installerLaunched: true,
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
                sleep: async () => undefined,
            }),
            input: {
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
            },
        });

        expect(error).toBeUndefined();
        expect(events).toEqual([
            expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
            expect.objectContaining({ type: 'progress', stepId: 'tailscale.install' }),
            expect.objectContaining({
                type: 'prompt',
                stepId: 'tailscale.login',
                data: {
                    kind: 'needsUserAction.openUrl',
                    url: 'https://login.tailscale.com/a/example',
                    usedQr: false,
                },
            }),
        ]);
        expect(result).toEqual({
            tailscaleInstalled: true,
            tailscaleLoggedIn: true,
            authUrl: null,
        });
    });

    it('surfaces a structured install prompt when tailscale is still missing', async () => {
        const { createTailscaleEnsureReadyHandler } = await import('./tailscaleEnsureReady.js');

        const { events, error } = await collectHandlerRun({
            handler: createTailscaleEnsureReadyHandler({
                inspectState: vi.fn(async () => ({
                    installed: false,
                    loggedIn: false,
                    running: false,
                    daemonReachable: false,
                    authUrl: null,
                    shareableHttpsUrl: null,
                })),
                ensureInstalled: vi.fn(async () => ({
                    outcome: 'prompt' as const,
                    installerLaunched: false,
                    prompt: {
                        platform: process.platform,
                        url: 'https://tailscale.com/download',
                        reason: 'manual_install_required' as const,
                    },
                })),
            }),
            input: {
                installPolicy: 'installIfMissing',
            },
        });

        expect(events).toEqual([
            expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
            expect.objectContaining({ type: 'progress', stepId: 'tailscale.install' }),
            expect.objectContaining({
                type: 'prompt',
                stepId: 'tailscale.install',
                data: {
                    kind: 'tailscaleInstall',
                    platform: process.platform,
                    url: 'https://tailscale.com/download',
                },
            }),
        ]);
        expect(error).toBeInstanceOf(SystemTaskExecutionError);
        expect((error as SystemTaskExecutionError).code).toBe('prompt_required');
    });

    it('prompts for interactive login when tailscale is installed but logged out', async () => {
        const { createTailscaleEnsureReadyHandler } = await import('./tailscaleEnsureReady.js');

        let inspectCalls = 0;
        let nowMs = 0;
        const inspectState = vi.fn(async () => {
            inspectCalls += 1;
            return {
                installed: true,
                loggedIn: false,
                running: false,
                daemonReachable: true,
                authUrl: 'https://login.tailscale.com/a/example',
                shareableHttpsUrl: null,
            };
        });

        const { events, error } = await collectHandlerRun({
            handler: createTailscaleEnsureReadyHandler({
                inspectState,
                loginInteractive: vi.fn(async () => ({
                    usedQr: true,
                    actionUrl: 'https://login.tailscale.com/a/example',
                    result: {
                        command: '/tmp/tailscale',
                        args: ['login', '--qr'],
                        exitCode: 0,
                        stdout: '',
                        stderr: '',
                    },
                })),
                sleep: async (ms) => {
                    nowMs += ms;
                },
                now: () => nowMs,
            }),
            input: {
                loginPolicy: 'interactive',
            },
        });

        expect(events.some((event) => (event as { stepId?: string }).stepId === 'tailscale.login')).toBe(true);
        expect(error).toBeInstanceOf(SystemTaskExecutionError);
        expect((error as SystemTaskExecutionError).code).toBe('prompt_required');
    });
});
