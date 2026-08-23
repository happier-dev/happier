import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    AgentExecutionRunEvent,
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    AgentSessionProviderBindingV1Schema,
    ProviderBoundModelRefSchema,
    createProviderErrorV1,
} from '@happier-dev/protocol';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';

import { createNativeAgentExecutionRunHostRuntime } from './nativeAgentExecutionRun';

afterEach(() => {
    vi.unstubAllEnvs();
});

async function createUnexpectedAgentRuntimeSurfaceInvocationContext(): Promise<never> {
    throw new Error('Execution-run fixture should not create an Agent runtime surface invocation context');
}

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
                localAgentId: 'deepsec',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
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
                localAgentId: 'agent',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
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

    it('carries the exact Provider selection and bounded launch inputs without persistent Session inputs', async () => {
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() { return Object.freeze({ status: 'admitted' as const }); },
            async stop() { return Object.freeze({ status: 'requested' as const }); },
            watch() { return Object.freeze({ dispose: vi.fn() }); },
            async dispose() {},
        });
        const open = vi.fn(async (_request: AgentExecutionRunOpenRequest) => opened);
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const modelSelection = ProviderBoundModelRefSchema.parse({
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_openai',
            modelId: 'gpt-5.1-codex',
        });
        const configuration = Object.freeze({
            mode: Object.freeze({ value: null, updatedAtMs: 0 }),
            model: Object.freeze({ value: 'gpt-5.1-codex', updatedAtMs: 5 }),
            permissionIntent: Object.freeze({ value: 'default', updatedAtMs: 5 }),
            options: Object.freeze({
                reasoning_effort: Object.freeze({ value: 'high', updatedAtMs: 5 }),
            }),
        });
        const providerBinding = AgentSessionProviderBindingV1Schema.parse({
            connectionId: 'pc_openai',
            model: {
                id: 'gpt-5.1-codex',
                name: 'GPT-5.1 Codex',
            },
            materialization: {
                v: 1 as const,
                kind: 'engineConfig' as const,
                engineConfig: { provider: 'openai' },
            },
        });
        const options: CreateCliExecutionRunBackendParams = Object.freeze({
            cwd: '/repo',
            runId: 'run-1',
            backendId: 'codex',
            permissionMode: 'default',
            start: Object.freeze({ profileId: 'delegate' }),
            modelSelection,
            configuration,
            providerBinding,
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'happier.agent.codex',
                pluginVersion: '1.0.0',
                agentId: 'codex',
                localAgentId: 'codex',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options,
            supportsResume: true,
        });

        await host.provisionSession({ resumeSessionId: 'checkpoint-1' });

        expect(open).toHaveBeenCalledWith(expect.objectContaining({
            modelSelection,
            configuration,
            providerBinding,
        }), expect.anything());
        expect(open.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({
            connectedAccounts: expect.anything(),
            mcpServers: expect.anything(),
            startupInstructions: expect.anything(),
        }));
        await host.dispose();
    });

    it('revalidates Provider authority after wrapper construction and rejects drift before public open', async () => {
        const open = vi.fn(async () => {
            throw new Error('public open must not run');
        });
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const revalidateProviderBeforeOpen = vi.fn(async () => ({
            ok: false as const,
            error: createProviderErrorV1('provider_authorization_changed', {
                connectionId: 'pc_openai',
                machineId: 'machine-1',
            }),
        }));
        const options: CreateCliExecutionRunBackendParams & Readonly<{
            revalidateProviderBeforeOpen: typeof revalidateProviderBeforeOpen;
            sanitizeProviderDiagnosticText: (value: string) => string;
        }> = Object.freeze({
            cwd: '/repo',
            runId: 'run-provider-drift',
            backendId: 'codex',
            permissionMode: 'default',
            start: Object.freeze({ profileId: 'delegate' }),
            revalidateProviderBeforeOpen,
            sanitizeProviderDiagnosticText: (value) => value,
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'happier.agent.codex',
                pluginVersion: '1.0.0',
                agentId: 'codex',
                localAgentId: 'codex',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options,
            supportsResume: true,
        });

        expect(revalidateProviderBeforeOpen).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        await expect(host.provisionSession({ resumeSessionId: 'checkpoint-1' }))
            .rejects.toMatchObject({ message: 'provider_authorization_changed' });
        expect(revalidateProviderBeforeOpen).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        await host.dispose();
    });

    it('sanitizes Provider secrets echoed by async open, send, stop, and run-failed diagnostics', async () => {
        const secret = 'provider-secret-value';
        const sanitizeProviderDiagnosticText = (value: string) =>
            value.replaceAll(secret, '[REDACTED]');
        const createLease = (runtime: AgentRuntime) => Object.freeze({
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.0.0',
            agentId: 'codex',
            localAgentId: 'codex',
            generation: 'generation-1',
            hasPrimaryRuntime: true,
            isCurrent: () => true,
            retirementSignal: new AbortController().signal,
            createAgentRuntimeSurfaceInvocationContext:
                createUnexpectedAgentRuntimeSurfaceInvocationContext,
            async createRuntime() { return runtime; },
        });
        const baseOptions = Object.freeze({
            cwd: '/repo',
            runId: 'run-provider-redaction',
            backendId: 'codex',
            permissionMode: 'default',
            start: Object.freeze({ profileId: 'delegate' }),
            revalidateProviderBeforeOpen: async () => ({ ok: true as const }),
            sanitizeProviderDiagnosticText,
        });
        const failingOpenRuntime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({
                async open() { throw new Error(`open echoed ${secret}`); },
            }),
        });
        const failingOpenHost = createNativeAgentExecutionRunHostRuntime({
            runtime: failingOpenRuntime,
            lease: createLease(failingOpenRuntime),
            options: baseOptions,
            supportsResume: false,
        });

        await expect(failingOpenHost.provisionSession({ initialPrompt: 'start' }))
            .rejects.toThrow('open echoed [REDACTED]');
        await failingOpenHost.dispose();

        const watchState: {
            listener?: (event: AgentExecutionRunEvent) => void;
        } = {};
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() {
                return {
                    status: 'rejected' as const,
                    diagnostic: {
                        code: 'provider_send_rejected',
                        severity: 'error' as const,
                        message: `send echoed ${secret}`,
                    },
                };
            },
            async stop() { throw new Error(`stop echoed ${secret}`); },
            watch(listener: (event: AgentExecutionRunEvent) => void) {
                watchState.listener = listener;
                return Object.freeze({ dispose: vi.fn() });
            },
            async dispose() {},
        });
        const activeRuntime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ async open() { return opened; } }),
        });
        const activeHost = createNativeAgentExecutionRunHostRuntime({
            runtime: activeRuntime,
            lease: createLease(activeRuntime),
            options: baseOptions,
            supportsResume: false,
        });
        const messages: AgentMessage[] = [];
        activeHost.subscribeMessages((message) => messages.push(message));

        await activeHost.provisionSession({ initialPrompt: 'start' });
        await expect(activeHost.sendPrompt('run-provider-redaction', 'again'))
            .rejects.toThrow('send echoed [REDACTED]');
        await expect(activeHost.cancel('run-provider-redaction'))
            .rejects.toThrow('stop echoed [REDACTED]');
        watchState.listener?.({
            sequence: 0,
            runId: 'run-provider-redaction',
            emittedAtMs: 1,
            kind: 'run-failed',
            diagnostic: {
                code: 'provider_run_failed',
                severity: 'error',
                message: `event echoed ${secret}`,
            },
        });
        expect(messages).toContainEqual({
            type: 'status',
            status: 'error',
            detail: 'event echoed [REDACTED]',
        });
        await activeHost.dispose();
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
                localAgentId: 'agent',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
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
                localAgentId: 'agent',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
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
