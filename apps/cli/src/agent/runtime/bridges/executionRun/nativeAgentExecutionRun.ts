import {
    AgentLaunchEnvironmentV1Schema,
    AgentRuntimeJsonValueV1Schema,
} from '@happier-dev/protocol/runtime';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol';
import type {
    AgentExecutionRunEvent,
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentLaunchEnvironment,
    AgentRuntime,
    AgentRuntimeContext,
    AgentSessionInput,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { type PluginServices } from '@happier-dev/plugin-sdk/runtime';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginInvocationUi } from '@/plugins/runtime/invocation/services/ui';

import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';

function createUnavailableAcpComposer(): AgentRuntimeContext['protocols'] {
    return Object.freeze({
        acp: Object.freeze({
            async open(): Promise<never> {
                throw new PluginError({
                    code: 'agent_acp_composition_unavailable',
                    message: 'ACP composition is unavailable for an execution run',
                });
            },
        }),
    });
}

function diagnosticMessage(diagnostic: Readonly<{ code: string; message?: string }> | undefined): string {
    return diagnostic?.message ?? diagnostic?.code ?? 'Native Agent execution run failed';
}

function createDisposedError(): Error {
    const error = new Error('Native Agent execution run disposed');
    error.name = 'AbortError';
    return error;
}

function toHostMessage(event: AgentExecutionRunEvent): AgentMessage | null {
    switch (event.kind) {
        case 'run-start':
        case 'run-progress':
            return { type: 'status', status: 'running' };
        case 'output-delta':
            return event.channel === 'assistant'
                ? { type: 'model-output', textDelta: event.text }
                : { type: 'event', name: 'thinking', payload: { textDelta: event.text } };
        case 'checkpoint':
            return {
                type: 'event',
                name: 'provider_session_id',
                payload: { sessionId: event.checkpointId },
            };
        case 'run-complete':
        case 'run-cancelled':
            return { type: 'status', status: 'stopped' };
        case 'run-failed':
            return { type: 'status', status: 'error', detail: diagnosticMessage(event.diagnostic) };
    }
}

function buildInput(prompt: string, structuredInput: unknown): AgentSessionInput {
    const parsed = AgentRuntimeJsonValueV1Schema.safeParse(structuredInput);
    return Object.freeze({
        text: prompt,
        ...(structuredInput !== undefined && parsed.success ? { structuredInput: parsed.data } : {}),
    });
}

function readRequiredString(value: string | undefined, field: string): string {
    const normalized = value?.trim();
    if (!normalized) {
        throw new Error(`Native Agent execution run requires ${field}`);
    }
    return normalized;
}

function resolveExecutionProfileReference(
    profileId: string,
    fallbackPluginId: string,
): Readonly<{ pluginId: string; localId: string }> {
    const separatorIndex = profileId.indexOf('/');
    if (separatorIndex > 0) {
        const qualified = PluginContributionIdentityV1Schema.safeParse({
            pluginId: profileId.slice(0, separatorIndex),
            localId: profileId.slice(separatorIndex + 1),
        });
        if (qualified.success) return Object.freeze(qualified.data);
    }
    return Object.freeze(PluginContributionIdentityV1Schema.parse({
        pluginId: fallbackPluginId,
        localId: profileId,
    }));
}

function buildLaunchEnvironment(
    options: CreateCliExecutionRunBackendParams,
): AgentLaunchEnvironment | undefined {
    if (options.isolation?.env === undefined && options.isolation?.unsetEnvKeys === undefined) {
        return undefined;
    }
    return AgentLaunchEnvironmentV1Schema.parse({
        values: options.isolation.env ?? {},
        unset: options.isolation.unsetEnvKeys ?? [],
    });
}

export function createNativeAgentExecutionRunHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    lease: AgentRuntimeRegistrationLease;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    generationSignal?: AbortSignal;
    services?: PluginServices;
}>): ExecutionRunHostRuntime {
    const executionRuns = params.runtime.executionRuns;
    if (!executionRuns) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support execution runs`);
    }
    const openExecutionRun = executionRuns.open.bind(executionRuns);
    const runId = readRequiredString(params.options.runId, 'a run id');
    const profileId = readRequiredString(
        params.options.start?.profileId ?? params.options.start?.intent,
        'an execution profile id',
    );
    const profile = resolveExecutionProfileReference(profileId, params.lease.pluginId);
    const launchEnvironment = buildLaunchEnvironment(params.options);
    const ownedAbortController = new AbortController();
    const signal = params.generationSignal
        ? AbortSignal.any([ownedAbortController.signal, params.generationSignal])
        : ownedAbortController.signal;
    const context: AgentRuntimeContext = Object.freeze({
        plugin: Object.freeze({ id: params.lease.pluginId, version: params.lease.pluginVersion }),
        contribution: Object.freeze({
            id: params.lease.agentId,
            qualifiedId: `${params.lease.pluginId}/agents/${params.lease.agentId}`,
        }),
        surface: 'agent',
        signal,
        services: params.services ?? createUnavailablePluginServices(),
        ui: createPluginInvocationUi({
            currentSession: null,
            signal,
            isGenerationCurrent: params.lease.isCurrent,
        }),
        agent: Object.freeze({ id: params.lease.agentId }),
        protocols: createUnavailableAcpComposer(),
    });
    const listeners = new Set<(message: AgentMessage) => void>();
    let provisioned = false;
    let openRequest: AgentExecutionRunOpenRequest | null = null;
    let nativeRuntimePromise: Promise<AgentExecutionRunRuntime> | null = null;
    let nativeRuntime: AgentExecutionRunRuntime | null = null;
    let watchDisposable: { dispose(): void | Promise<void> } | null = null;
    let lastSequence = -1;
    let terminal = false;
    let disposed = false;
    let resolveTerminal!: () => void;
    let rejectTerminal!: (error: Error) => void;
    const terminalPromise = new Promise<void>((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
    });
    void terminalPromise.catch(() => undefined);

    function assertUsable(): void {
        if (disposed) throw new Error('Native Agent execution run is disposed');
        if (!params.lease.isCurrent()) {
            throw new Error(`Agent runtime '${params.lease.agentId}' belongs to a retired generation`);
        }
        signal.throwIfAborted();
    }

    function emit(message: AgentMessage): void {
        for (const listener of listeners) listener(message);
    }

    function failRuntime(message: string): void {
        if (terminal) return;
        terminal = true;
        const error = new Error(message);
        emit({ type: 'status', status: 'error', detail: message });
        rejectTerminal(error);
    }

    function handleEvent(event: AgentExecutionRunEvent): void {
        if (event.runId !== runId) {
            failRuntime(`Native Agent execution run emitted an event for unexpected run '${event.runId}'`);
            return;
        }
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) {
            failRuntime(`Native Agent execution run '${runId}' emitted a non-monotonic event sequence`);
            return;
        }
        if (terminal) return;
        lastSequence = event.sequence;
        const message = toHostMessage(event);
        if (message) emit(message);
        if (event.kind === 'run-complete' || event.kind === 'run-cancelled') {
            terminal = true;
            resolveTerminal();
        } else if (event.kind === 'run-failed') {
            terminal = true;
            rejectTerminal(new Error(diagnosticMessage(event.diagnostic)));
        }
    }

    async function openNative(request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunRuntime> {
        assertUsable();
        if (nativeRuntimePromise) return await nativeRuntimePromise;
        nativeRuntimePromise = Promise.resolve(openExecutionRun(request, context)).then(async (opened) => {
            try {
                assertUsable();
            } catch (error) {
                await opened.dispose();
                throw error;
            }
            nativeRuntime = opened;
            watchDisposable = opened.watch(handleEvent);
            return opened;
        });
        return await nativeRuntimePromise;
    }

    return Object.freeze({
        permissionCapability: 'static' as const,
        async readResumeSupport() {
            return params.supportsResume;
        },
        async provisionSession(options) {
            assertUsable();
            if (provisioned) return { sessionId: runId };
            provisioned = true;
            if (options?.resumeSessionId) {
                if (!params.supportsResume) throw new Error('Backend does not support resume');
                openRequest = Object.freeze({
                    kind: 'resume' as const,
                    runId,
                    cwd: params.options.cwd,
                    profile,
                    ...(launchEnvironment ? { launchEnvironment } : {}),
                    checkpointId: options.resumeSessionId,
                });
                await openNative(openRequest);
            } else if (options?.initialPrompt !== undefined) {
                openRequest = Object.freeze({
                    kind: 'create' as const,
                    runId,
                    cwd: params.options.cwd,
                    profile,
                    ...(launchEnvironment ? { launchEnvironment } : {}),
                    input: buildInput(options.initialPrompt, params.options.start?.intentInput),
                });
                await openNative(openRequest);
            }
            return { sessionId: runId };
        },
        async sendPrompt(sessionId, prompt) {
            assertUsable();
            if (!provisioned || sessionId !== runId) {
                throw new Error(`Native Agent execution run '${runId}' is not provisioned for session '${sessionId}'`);
            }
            if (terminal) throw new Error(`Native Agent execution run '${runId}' has already terminated`);
            const input = buildInput(prompt, params.options.start?.intentInput);
            if (!nativeRuntimePromise) {
                openRequest = Object.freeze({
                    kind: 'create' as const,
                    runId,
                    cwd: params.options.cwd,
                    profile,
                    ...(launchEnvironment ? { launchEnvironment } : {}),
                    input,
                });
                await openNative(openRequest);
                return;
            }
            const opened = await nativeRuntimePromise;
            const result = await opened.send(input, { signal });
            if (result.status !== 'admitted') {
                throw new Error(diagnosticMessage(result.diagnostic));
            }
        },
        async cancel(sessionId) {
            assertUsable();
            if (!provisioned || sessionId !== runId) return;
            const opened = nativeRuntime ?? (nativeRuntimePromise ? await nativeRuntimePromise : null);
            if (!opened) return;
            const result = await opened.stop({ signal });
            if (result.status === 'unavailable' || result.status === 'unsupported') {
                throw new Error(`Native Agent execution run stop is ${result.status}`);
            }
        },
        subscribeMessages(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        async waitForTurnCompletion() {
            if (!nativeRuntimePromise) return;
            await terminalPromise;
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            if (nativeRuntimePromise && !terminal) {
                terminal = true;
                rejectTerminal(createDisposedError());
            }
            ownedAbortController.abort(new Error('Native Agent execution run disposed'));
            const opened = nativeRuntime ?? (nativeRuntimePromise ? await nativeRuntimePromise.catch(() => null) : null);
            const watch = watchDisposable;
            watchDisposable = null;
            listeners.clear();
            await Promise.all([
                Promise.resolve(watch?.dispose()),
                Promise.resolve(opened?.dispose()),
            ]);
        },
    });
}
