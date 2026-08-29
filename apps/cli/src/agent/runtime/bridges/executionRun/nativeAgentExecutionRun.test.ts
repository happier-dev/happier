import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    AgentExecutionRunEvent,
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentRuntime,
    AgentRuntimeContext,
    AgentSessionOpenRequest,
    AgentSessionRuntimeEvent,
    AgentSessionRuntime,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    AgentSessionProviderBindingV1Schema,
    ProviderBoundModelRefSchema,
    createProviderErrorV1,
} from '@happier-dev/protocol';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';

import {
    createNativeAgentExecutionRunHostRuntime,
    createNativeAgentSessionInteractionHostRuntime,
} from './nativeAgentExecutionRun';
import {
    composeNativeAgentSessionRuntimeContext,
    createNativeAgentSessionHostServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';

afterEach(() => {
    vi.unstubAllEnvs();
});

async function createUnexpectedAgentRuntimeSurfaceInvocationContext(): Promise<never> {
    throw new Error('Execution-run fixture should not create an Agent runtime surface invocation context');
}

type UnsequencedSessionEvent<T> = T extends AgentSessionRuntimeEvent
    ? Omit<T, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never;

function createVoiceSessionContextLease(params: Readonly<{
    services: AgentSessionRuntimeContext['services'];
    signal: AbortSignal;
    dispose: () => Promise<void>;
}>): Readonly<{
    context: AgentSessionRuntimeContext;
    dispose(): Promise<void>;
}> {
    const sessionServices = createNativeAgentSessionHostServices({
        owners: {
            features: { isEnabled: () => true },
            sessionHooks: {},
            transcripts: { fileFollow: {} },
            accountUsage: {},
            mcp: {},
            toolExecution: {},
        },
        agentId: 'acme.voice/agents/default',
        sessionId: 'session-parent',
        directory: '/repo',
        signal: params.signal,
        isCurrent: () => true,
        session: {
            sessionId: 'session-parent',
            updateMetadata: vi.fn(),
            enqueueAgentMessageCommitted: vi.fn(),
        },
        publications: {
            models: { bind: () => ({ dispose() {} }) },
            activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
        },
        readToolExecutionCapability: () => null,
    } as never);
    return {
        context: composeNativeAgentSessionRuntimeContext({
            identity: {
                pluginId: 'acme.voice',
                pluginVersion: '1.0.0',
                agentId: 'acme.voice/agents/default',
            },
            contributionId: 'default',
            invokedAtMs: 1,
            sessionId: 'session-parent',
            signal: params.signal,
            services: params.services,
            sessionServices,
            ui: {} as AgentSessionRuntimeContext['ui'],
            protocols: {} as AgentSessionRuntimeContext['protocols'],
            workState: {
                publisher() {
                    return {
                        async publish() {
                            return {
                                status: 'unavailable' as const,
                                diagnostic: {
                                    code: 'voice_test_unavailable',
                                    severity: 'info' as const,
                                },
                            };
                        },
                    };
                },
            },
        }),
        dispose: params.dispose,
    };
}

describe('createNativeAgentExecutionRunHostRuntime', () => {
    it('keeps a native Session interaction alive across two complete Voice turns', async () => {
        const nativeListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let sequence = 0;
        let activeTurnId: string | null = null;
        const publish = (event: UnsequencedSessionEvent<AgentSessionRuntimeEvent>) => {
            for (const listener of nativeListeners) listener({
                ...event,
                sequence: ++sequence,
                sessionId: 'session-parent',
                emittedAtMs: sequence,
            } as AgentSessionRuntimeEvent);
        };
        const send = vi.fn(async (request: Parameters<AgentSessionRuntime['send']>[0]) => {
            const turnId = request.delivery.turnId;
            activeTurnId = turnId;
            publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
            publish({ kind: 'turn-start', turnId, startedBy: 'host' });
            publish({ kind: 'message-delta', turnId, channel: 'assistant', text: `answer-${send.mock.calls.length}` });
            if (request.input.text !== 'wait for cancellation') {
                publish({ kind: 'turn-complete', turnId });
                activeTurnId = null;
            }
            return { status: 'admitted' as const };
        });
        const cancel = vi.fn(async ({ turnId }: Parameters<NonNullable<AgentSessionRuntime['cancel']>>[0]) => {
            expect(turnId).toBe(activeTurnId);
            publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
            activeTurnId = null;
            return { status: 'requested' as const, turnId };
        });
        const disposeSession = vi.fn(async () => undefined);
        const disposeSessionContext = vi.fn(async () => undefined);
        const runtime: AgentRuntime = Object.freeze({
            sessions: Object.freeze({
                async open(
                    request: AgentSessionOpenRequest,
                    context: AgentSessionRuntimeContext,
                ) {
                    expect(request.sessionId).toBe('session-parent');
                    expect(context.session.id).toBe('session-parent');
                    expect(context.session.services.features.isEnabled('execution.runs')).toBe(true);
                    await expect(
                        context.workState.publisher('voice').publish({} as never),
                    ).resolves.toMatchObject({ status: 'unavailable' });
                    return {
                        send,
                        cancel,
                        watch(listener: (event: AgentSessionRuntimeEvent) => void) {
                            nativeListeners.add(listener);
                            return {
                                dispose: () => {
                                    nativeListeners.delete(listener);
                                },
                            };
                        },
                        dispose: disposeSession,
                    };
                },
            }),
        });
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.voice',
                pluginVersion: '1.0.0',
                agentId: 'acme.voice/agents/default',
                localAgentId: 'default',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext: createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-voice',
                backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only',
                start: Object.freeze({ intent: 'voice_agent' as const }),
            }),
            supportsResume: true,
            createSessionContext: ({ services, signal }) =>
                createVoiceSessionContextLease({
                    services,
                    signal,
                    dispose: disposeSessionContext,
                }),
        });
        const messages: AgentMessage[] = [];
        host.subscribeMessages((message) => messages.push(message));

        await host.provisionSession();
        await host.sendPrompt('run-voice', 'first');
        await host.waitForTurnCompletion?.();
        await host.sendPrompt('run-voice', 'second');
        await host.waitForTurnCompletion?.();

        expect(send).toHaveBeenCalledTimes(2);
        expect(messages.filter((message) => message.type === 'model-output')).toEqual([
            { type: 'model-output', textDelta: 'answer-1' },
            { type: 'model-output', textDelta: 'answer-2' },
        ]);
        await host.sendPrompt('run-voice', 'wait for cancellation');
        await host.cancel('run-voice');
        await host.waitForTurnCompletion?.();
        expect(cancel).toHaveBeenCalledOnce();
        expect(messages).toContainEqual({ type: 'status', status: 'stopped' });
        await host.dispose();
        expect(disposeSession).toHaveBeenCalledOnce();
        expect(disposeSessionContext).toHaveBeenCalledOnce();
    });

    it('releases Session context custody once when Voice open fails and preserves that admission failure', async () => {
        const openFailure = new Error('voice Session open failed');
        const open = vi.fn(async () => {
            throw openFailure;
        });
        const runtime: AgentRuntime = Object.freeze({
            sessions: Object.freeze({ open }),
        });
        const disposeSessionContext = vi.fn(async () => undefined);
        const createSessionContext = vi.fn(({
            services,
            signal,
        }: Readonly<{
            services: AgentSessionRuntimeContext['services'];
            signal: AbortSignal;
        }>) =>
            createVoiceSessionContextLease({
                services,
                signal,
                dispose: disposeSessionContext,
            }));
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.voice',
                pluginVersion: '1.0.0',
                agentId: 'acme.voice/agents/default',
                localAgentId: 'default',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-voice-open-failure',
                backendId: 'acme.voice/agents/default',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'acme.session/assistant' }),
            }),
            supportsResume: true,
            createSessionContext,
        });

        await expect(host.provisionSession()).rejects.toBe(openFailure);
        await expect(host.provisionSession()).rejects.toBe(openFailure);
        expect(open).toHaveBeenCalledOnce();
        expect(createSessionContext).toHaveBeenCalledOnce();
        expect(disposeSessionContext).toHaveBeenCalledOnce();

        await host.dispose();
        expect(disposeSessionContext).toHaveBeenCalledOnce();
    });

    it('does not invoke provider open after Voice context acquisition races with disposal', async () => {
        let resolveContext!: (value: Readonly<{
            context: AgentSessionRuntimeContext;
            dispose(): Promise<void>;
        }>) => void;
        const contextPromise = new Promise<Readonly<{
            context: AgentSessionRuntimeContext;
            dispose(): Promise<void>;
        }>>((resolve) => { resolveContext = resolve; });
        let current = true;
        const open = vi.fn(async () => {
            throw new Error('provider open must not be reached');
        });
        const disposeContext = vi.fn(async () => undefined);
        const runtime: AgentRuntime = Object.freeze({
            sessions: Object.freeze({ open }),
        });
        const host = createNativeAgentSessionInteractionHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/default',
                localAgentId: 'default', generation: 'generation-1', hasPrimaryRuntime: true,
                isCurrent: () => current, retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext: createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo', runId: 'run-race', backendId: 'acme.voice/default', permissionMode: 'read_only',
                start: Object.freeze({ intent: 'voice_agent' as const }),
            }),
            supportsResume: true,
            createSessionContext: () => contextPromise,
        });
        const provisioning = host.provisionSession();
        await Promise.resolve();
        current = false;
        await host.dispose();
        resolveContext(createVoiceSessionContextLease({
            services: {} as AgentSessionRuntimeContext['services'],
            signal: new AbortController().signal,
            dispose: disposeContext,
        }));
        await expect(provisioning).rejects.toThrow(/retired generation|disposed/);
        expect(open).not.toHaveBeenCalled();
        expect(disposeContext).toHaveBeenCalledOnce();
    });

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
        const open = vi.fn(async (
            _request: AgentExecutionRunOpenRequest,
            _context: AgentRuntimeContext,
        ) => opened);
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

        const beforeAdmission = Date.now();
        await host.provisionSession();
        await host.sendPrompt('run-1', 'Audit this repository');

        expect(open).toHaveBeenCalledOnce();
        expect(open.mock.calls[0]?.[0].profile).toEqual({
            pluginId: 'happier.review.deepsec',
            localId: 'repository-security-audit',
        });
        expect(open.mock.calls[0]?.[1].invokedAtMs).toBeGreaterThanOrEqual(beforeAdmission);
        expect(open.mock.calls[0]?.[1].invokedAtMs).toBeLessThanOrEqual(Date.now());
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
            upstream: {
                protocol: 'openai-responses',
                normalizedUrl: 'https://api.openai.example/v1',
                credential: 'apiKey',
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

    it('isolates a throwing host listener and detaches never-settling finite cleanup after terminal truth', async () => {
        const watchState: { publish?: (event: AgentExecutionRunEvent) => void } = {};
        const disposeRuntime = vi.fn(async () => {
            await new Promise<never>(() => undefined);
        });
        const opened: AgentExecutionRunRuntime = Object.freeze({
            async send() { return { status: 'admitted' as const }; },
            async stop() { return { status: 'requested' as const }; },
            watch(listener: (event: AgentExecutionRunEvent) => void) {
                watchState.publish = listener;
                return { dispose: vi.fn() };
            },
            dispose: disposeRuntime,
        });
        const runtime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ async open() { return opened; } }),
        });
        const host = createNativeAgentExecutionRunHostRuntime({
            runtime,
            lease: Object.freeze({
                pluginId: 'acme.finite',
                pluginVersion: '1.0.0',
                agentId: 'acme.finite/agents/default',
                localAgentId: 'default',
                generation: 'generation-1',
                hasPrimaryRuntime: true,
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
                createAgentRuntimeSurfaceInvocationContext:
                    createUnexpectedAgentRuntimeSurfaceInvocationContext,
                async createRuntime() { return runtime; },
            }),
            options: Object.freeze({
                cwd: '/repo',
                runId: 'run-listener-isolation',
                backendId: 'acme.finite/agents/default',
                permissionMode: 'read_only',
                start: Object.freeze({ profileId: 'delegate' }),
            }),
            supportsResume: false,
        });
        const messages: AgentMessage[] = [];
        host.subscribeMessages((message) => {
            if (message.type === 'status' && message.status === 'stopped') {
                throw new Error('projection failed');
            }
        });
        host.subscribeMessages((message) => messages.push(message));

        await host.provisionSession({ initialPrompt: 'start' });
        watchState.publish?.({
            sequence: 1,
            runId: 'run-listener-isolation',
            emittedAtMs: 1,
            kind: 'run-complete',
        });
        await host.waitForTurnCompletion?.();

        expect(messages).toContainEqual({ type: 'status', status: 'stopped' });
        await expect(host.dispose()).resolves.toBeUndefined();
        await expect(host.dispose()).resolves.toBeUndefined();
        expect(disposeRuntime).toHaveBeenCalledOnce();
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
