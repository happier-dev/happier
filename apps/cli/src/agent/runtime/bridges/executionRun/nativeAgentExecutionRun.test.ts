import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentRuntime,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { createNativeAgentExecutionRunHostRuntime } from './nativeAgentExecutionRun';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('createNativeAgentExecutionRunHostRuntime', () => {
    it('preserves the owning plugin and local id of a qualified execution profile', async () => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const open = vi.fn(async (_request: AgentExecutionRunOpenRequest) => opened);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'happier.agent.deepsec',
                pluginVersion: '1.0.0',
                agentId: 'deepsec',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-1',
                backendId: 'deepsec',
                permissionMode: 'read_only',
                start: Object.freeze({
                    profileId: 'happier.review.deepsec/repository-security-audit',
                }),
            }),
            supportsResume: false,
        });

        await host.provisionSession();
        await host.sendPrompt('run-1', 'Audit this repository');

        expect(open).toHaveBeenCalledOnce();
        expect(open.mock.calls[0]?.[0].profile).toEqual({
            pluginId: 'happier.review.deepsec',
            localId: 'repository-security-audit',
        });
        await host.dispose();
    });

    it.each([
        {
            label: 'create',
            provision: undefined,
            initialPrompt: 'Review this',
        },
        {
            label: 'resume',
            provision: { resumeSessionId: 'checkpoint-1' },
            initialPrompt: undefined,
        },
    ])('passes only the bounded launch environment to $label open requests', async ({ provision, initialPrompt }) => {
        vi.stubEnv('HAPPIER_EXECUTION_RUN_AMBIENT_ONLY', 'must-not-leak');
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const open = vi.fn(async (_request: AgentExecutionRunOpenRequest) => opened);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.sample',
                pluginVersion: '1.0.0',
                agentId: 'acme.sample.agent',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-1',
                backendId: 'acme.sample.agent',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'review' }),
                isolation: Object.freeze({
                    env: Object.freeze({ ALLOWED_VALUE: 'bounded' }),
                    unsetEnvKeys: Object.freeze(['EXPLICITLY_UNSET']),
                }),
            }),
            supportsResume: true,
        });

        await host.provisionSession(provision);
        if (initialPrompt) await host.sendPrompt('run-1', initialPrompt);

        expect(open).toHaveBeenCalledOnce();
        const request = open.mock.calls[0]?.[0];
        expect(request).toMatchObject({
            launchEnvironment: {
                values: { ALLOWED_VALUE: 'bounded' },
                unset: ['EXPLICITLY_UNSET'],
            },
        });
        expect(request?.launchEnvironment?.values).not.toHaveProperty(
            'HAPPIER_EXECUTION_RUN_AMBIENT_ONLY',
        );
        await host.dispose();
    });

    it('disposes a plugin runtime that finishes opening after host disposal starts', async () => {
        let resolveOpened!: (runtime: AgentExecutionRunRuntime) => void;
        const openedPromise = new Promise<AgentExecutionRunRuntime>((resolve) => {
            resolveOpened = resolve;
        });
        const disposeOpened = vi.fn(async () => undefined);
        const open = vi.fn((_request: AgentExecutionRunOpenRequest) => openedPromise);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.sample',
                pluginVersion: '1.0.0',
                agentId: 'acme.sample.agent',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-1',
                backendId: 'acme.sample.agent',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'review' }),
            }),
            supportsResume: false,
        });

        await host.provisionSession();
        const sendResult = host.sendPrompt('run-1', 'Review this').catch((error: unknown) => error);
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        expect(open.mock.calls[0]?.[0]).not.toHaveProperty('launchEnvironment');

        const disposeResult = host.dispose();
        resolveOpened(Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            dispose: disposeOpened,
        }));

        await expect(disposeResult).resolves.toBeUndefined();
        await expect(sendResult).resolves.toBeInstanceOf(Error);
        expect(disposeOpened).toHaveBeenCalledOnce();
    });

    it('settles an active completion waiter when host disposal wins the terminal race', async () => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return Object.freeze({ status: 'admitted' as const });
            },
            async stop() {
                return Object.freeze({ status: 'requested' as const });
            },
            watch() {
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({
                async open() {
                    return opened;
                },
            }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.sample',
                pluginVersion: '1.0.0',
                agentId: 'acme.sample.agent',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                async createRuntime() {
                    return runtime;
                },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-1',
                backendId: 'acme.sample.agent',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'review' }),
            }),
            supportsResume: false,
        });

        await host.provisionSession();
        await host.sendPrompt('run-1', 'Review this');
        const completion = host.waitForTurnCompletion?.();

        await host.dispose();

        await expect(completion).rejects.toMatchObject({
            name: 'AbortError',
            message: 'Native Agent execution run disposed',
        });
    });
});
