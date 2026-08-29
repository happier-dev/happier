import {
    AgentLaunchEnvironmentV1Schema,
    AgentRuntimeJsonValueV1Schema,
} from '@happier-dev/protocol/runtime';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol';
import type {
    AgentExecutionRunEvent,
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentExecutionRunRuntimeFactory,
    AgentLaunchEnvironment,
    AgentRuntime,
    AgentRuntimeContext,
    AgentSessionInput,
    AgentSessionOpenRequest,
    AgentSessionRuntime,
    AgentSessionRuntimeContext,
    AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { type PluginServices } from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromSessionRuntime } from '@happier-dev/plugin-sdk/host/registration';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { resolveNativeAgentSessionStateSharingPolicy } from '@/agent/runtime/registry/engineRegistry/stateSharingPolicy';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';

import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';

export type NativeAgentSessionContextLeaseFactory = (params: Readonly<{
    services: PluginServices;
    signal: AbortSignal;
}>) => Promise<Readonly<{
    context: AgentSessionRuntimeContext;
    dispose(): Promise<void>;
}>> | Readonly<{
    context: AgentSessionRuntimeContext;
    dispose(): Promise<void>;
}>;

function diagnosticMessage(
    diagnostic: Readonly<{ code: string; message?: string }> | undefined,
    sanitize: (value: string) => string,
): string {
    return sanitize(diagnostic?.message ?? diagnostic?.code ?? 'Native Agent execution run failed');
}

function sanitizeThrownError(
    error: unknown,
    sanitize: (value: string) => string,
): Error & { code?: string } {
    if (!(error instanceof Error)) {
        return new Error(sanitize(String(error)));
    }
    const sanitized = new Error(sanitize(error.message)) as Error & { code?: string };
    sanitized.name = error.name;
    if ('code' in error && typeof error.code === 'string') {
        sanitized.code = error.code;
    }
    return sanitized;
}

function createDisposedError(): Error {
    const error = new Error('Native Agent execution run disposed');
    error.name = 'AbortError';
    return error;
}

function toHostMessage(
    event: AgentExecutionRunEvent,
    sanitize: (value: string) => string,
): AgentMessage | null {
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
            return {
                type: 'status',
                status: 'error',
                detail: diagnosticMessage(event.diagnostic, sanitize),
            };
    }
}

function sessionEventToHostMessage(
    event: AgentSessionRuntimeEvent,
    sanitize: (value: string) => string,
): AgentMessage | null {
    switch (event.kind) {
        case 'message-delta':
            return event.channel === 'assistant'
                ? { type: 'model-output', textDelta: event.text }
                : { type: 'event', name: 'thinking', payload: { textDelta: event.text } };
        case 'provider-session-id':
            return { type: 'event', name: 'provider_session_id', payload: { sessionId: event.providerSessionId } };
        case 'turn-start':
        case 'turn-progress':
            return { type: 'status', status: 'running' };
        case 'turn-complete':
        case 'turn-cancelled':
            return { type: 'status', status: 'stopped' };
        case 'turn-failed':
            return {
                type: 'status',
                status: 'error',
                detail: sanitize(event.diagnostic.message ?? event.diagnostic.code),
            };
        case 'runtime-ended':
            return {
                type: 'status',
                status: 'error',
                detail: sanitize(event.diagnostic?.message ?? event.diagnostic?.code ?? event.cause),
            };
        default:
            return null;
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

function createNativeAgentInvocationContext(params: Readonly<{
    lease: AgentRuntimeRegistrationLease;
    runId: string;
    signal: AbortSignal;
    services: PluginServices;
    invokedAtMs: number;
}>): AgentRuntimeContext {
    return Object.freeze({
        plugin: Object.freeze({ id: params.lease.pluginId, version: params.lease.pluginVersion }),
        contribution: Object.freeze({
            id: params.lease.localAgentId,
            qualifiedId: resolveAgentContributionQualifiedId({
                pluginId: params.lease.pluginId,
                localId: params.lease.localAgentId,
            }),
        }),
        surface: 'agent' as const,
        invokedAtMs: params.invokedAtMs,
        session: Object.freeze({ id: params.runId }),
        signal: params.signal,
        services: params.services,
        ui: createPluginInvocationPresentation({
            currentSession: null,
            signal: params.signal,
            isGenerationCurrent: params.lease.isCurrent,
        }),
        agent: Object.freeze({ id: params.lease.agentId }),
        protocols: createPublicAcpRuntimeProtocols({
            pluginId: params.lease.pluginId,
            agentId: params.lease.agentId,
            signal: params.signal,
            isCurrent: params.lease.isCurrent,
            services: params.services,
        }),
    });
}

export function createNativeAgentExecutionRunHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    lease: AgentRuntimeRegistrationLease;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
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
    const boundedOpenInputs = Object.freeze({
        stateSharing: resolveNativeAgentSessionStateSharingPolicy(params.lease.agentId),
        ...(launchEnvironment ? { launchEnvironment } : {}),
        ...(params.options.modelSelection
            ? { modelSelection: params.options.modelSelection }
            : {}),
        ...(params.options.configuration
            ? { configuration: params.options.configuration }
            : {}),
        ...(params.options.providerBinding
            ? { providerBinding: params.options.providerBinding }
            : {}),
    });
    const sanitizeProviderDiagnosticText =
        params.options.sanitizeProviderDiagnosticText ?? ((value: string) => value);
    const ownedAbortController = new AbortController();
    const signal = params.generationSignal
        ? AbortSignal.any([ownedAbortController.signal, params.generationSignal])
        : ownedAbortController.signal;
    const servicesPromise =
        params.services
        ?? Promise.resolve(createUnavailablePluginServices());
    const listeners = new Set<(message: AgentMessage) => void>();
    let provisionPromise: Promise<Readonly<{ sessionId: string }>> | null = null;
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
        for (const listener of listeners) {
            try {
                listener(message);
            } catch {
                // One host projection cannot interrupt terminal settlement or later listeners.
            }
        }
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
        const message = toHostMessage(event, sanitizeProviderDiagnosticText);
        if (message) emit(message);
        if (event.kind === 'run-complete' || event.kind === 'run-cancelled') {
            terminal = true;
            resolveTerminal();
        } else if (event.kind === 'run-failed') {
            terminal = true;
            rejectTerminal(new Error(diagnosticMessage(
                event.diagnostic,
                sanitizeProviderDiagnosticText,
            )));
        }
    }

    async function openNative(request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunRuntime> {
        assertUsable();
        if (nativeRuntimePromise) return await nativeRuntimePromise;
        const invokedAtMs = Date.now();
        nativeRuntimePromise = (async () => {
            const services = await servicesPromise;
            assertUsable();
            const context = createNativeAgentInvocationContext({
                lease: params.lease,
                runId,
                signal,
                services,
                invokedAtMs,
            });
            let providerCurrent: Awaited<ReturnType<NonNullable<
                CreateCliExecutionRunBackendParams['revalidateProviderBeforeOpen']
            >>> | undefined;
            try {
                providerCurrent = await params.options.revalidateProviderBeforeOpen?.();
            } catch (error) {
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            if (providerCurrent && !providerCurrent.ok) {
                throw Object.assign(
                    new Error(providerCurrent.error.code),
                    { code: providerCurrent.error.code },
                );
            }
            assertUsable();
            let opened: AgentExecutionRunRuntime;
            try {
                opened = await openExecutionRun(request, context);
            } catch (error) {
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            try {
                assertUsable();
                nativeRuntime = opened;
                watchDisposable = opened.watch(handleEvent);
            } catch (error) {
                await opened.dispose();
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            return opened;
        })();
        return await nativeRuntimePromise;
    }

    return Object.freeze({
        permissionCapability: 'static' as const,
        async readResumeSupport() {
            return params.supportsResume;
        },
        async provisionSession(options) {
            assertUsable();
            provisionPromise ??= (async () => {
                if (options?.resumeSessionId) {
                    if (!params.supportsResume) throw new Error('Backend does not support resume');
                    openRequest = Object.freeze({
                        kind: 'resume' as const,
                        runId,
                        cwd: params.options.cwd,
                        profile,
                        ...boundedOpenInputs,
                        checkpointId: options.resumeSessionId,
                    });
                    await openNative(openRequest);
                } else if (options?.initialPrompt !== undefined) {
                    openRequest = Object.freeze({
                        kind: 'create' as const,
                        runId,
                        cwd: params.options.cwd,
                        profile,
                        ...boundedOpenInputs,
                        input: buildInput(options.initialPrompt, params.options.start?.intentInput),
                    });
                    await openNative(openRequest);
                }
                return Object.freeze({ sessionId: runId });
            })();
            return await provisionPromise;
        },
        async sendPrompt(sessionId, prompt) {
            assertUsable();
            if (!provisionPromise || sessionId !== runId) {
                throw new Error(`Native Agent execution run '${runId}' is not provisioned for session '${sessionId}'`);
            }
            await provisionPromise;
            if (terminal) throw new Error(`Native Agent execution run '${runId}' has already terminated`);
            const input = buildInput(prompt, params.options.start?.intentInput);
            if (!nativeRuntimePromise) {
                openRequest = Object.freeze({
                    kind: 'create' as const,
                    runId,
                    cwd: params.options.cwd,
                    profile,
                    ...boundedOpenInputs,
                    input,
                });
                await openNative(openRequest);
                return;
            }
            const opened = await nativeRuntimePromise;
            let result: Awaited<ReturnType<AgentExecutionRunRuntime['send']>>;
            try {
                result = await opened.send(input, { signal });
            } catch (error) {
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            if (result.status !== 'admitted') {
                throw new Error(diagnosticMessage(
                    result.diagnostic,
                    sanitizeProviderDiagnosticText,
                ));
            }
        },
        async cancel(sessionId) {
            assertUsable();
            if (!provisionPromise || sessionId !== runId) return;
            const opened = nativeRuntime ?? (nativeRuntimePromise ? await nativeRuntimePromise : null);
            if (!opened) return;
            let result: Awaited<ReturnType<AgentExecutionRunRuntime['stop']>>;
            try {
                result = await opened.stop({ signal });
            } catch (error) {
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
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
            // The existing terminal fence settles completion waiters first, so
            // waiter settlement and controller retirement are independent of
            // any never-settling provider open or dispose below.
            if (nativeRuntimePromise && !terminal) {
                terminal = true;
                rejectTerminal(createDisposedError());
            }
            ownedAbortController.abort(new Error('Native Agent execution run disposed'));
            const watch = watchDisposable;
            watchDisposable = null;
            listeners.clear();
            // Cleanup is attempted exactly once, best effort: it must not
            // block this return on a provider open that never settles, and a
            // provider cleanup failure is logged nowhere the caller depends
            // on. A late-settling open is disposed when it settles.
            const cleanupOpened = (opened: AgentExecutionRunRuntime | null): void => {
                if (!opened) return;
                void Promise.resolve().then(() => opened.dispose()).catch(() => undefined);
            };
            if (nativeRuntime) {
                cleanupOpened(nativeRuntime);
            } else if (nativeRuntimePromise) {
                void nativeRuntimePromise.then(cleanupOpened, () => undefined);
            }
            if (watch) {
                void Promise.resolve().then(() => watch.dispose()).catch(() => undefined);
            }
        },
    });
}

/**
 * Host-owned finite Run projection for an Agent whose provider-native owner is
 * a Session runtime. The Session receives the same complete host context as an
 * interactive Session; only the bounded Run projection is adapted here.
 */
export function createNativeAgentSessionExecutionRunHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    lease: AgentRuntimeRegistrationLease;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createSessionContext: NativeAgentSessionContextLeaseFactory;
}>): ExecutionRunHostRuntime {
    const sessions = params.runtime.sessions;
    if (!sessions) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support sessions`);
    }
    const executionRuns: AgentExecutionRunRuntimeFactory = Object.freeze({
        async open(
            request: AgentExecutionRunOpenRequest,
            executionContext: AgentRuntimeContext,
        ) {
                if (request.kind === 'fork') {
                    throw new Error('Host-derived Session execution runs do not support fork');
                }
                const sessionContext = await params.createSessionContext({
                    services: executionContext.services,
                    signal: executionContext.signal,
                });
                let execution: AgentExecutionRunRuntime;
                try {
                    execution = await createExecutionRunHostBackendFromSessionRuntime({
                        request,
                        sessionId: sessionContext.context.session.id,
                        openSession: async (sessionRequest) => await sessions.open(
                            sessionRequest,
                            sessionContext.context,
                        ),
                        readCheckpointId: (event) => event.kind === 'provider-session-id'
                            ? event.providerSessionId
                            : null,
                    });
                } catch (error) {
                    try {
                        await sessionContext.dispose();
                    } catch {
                        // Preserve the Session open/admission failure after cleanup was attempted.
                    }
                    throw error;
                }
                let disposed = false;
                return Object.freeze({
                    send: execution.send.bind(execution),
                    stop: execution.stop.bind(execution),
                    watch: execution.watch.bind(execution),
                    async dispose() {
                        if (disposed) return;
                        disposed = true;
                        // The SDK lifecycle has already settled terminal truth.
                        // Both native cleanup leaves are exactly-once, detached,
                        // and best effort so neither can retain the controller.
                        void Promise.resolve().then(() => execution.dispose())
                            .catch(() => undefined);
                        void Promise.resolve().then(() => sessionContext.dispose())
                            .catch(() => undefined);
                    },
                });
        },
    });
    const derivedRuntime: AgentRuntime = Object.freeze({
        executionRuns,
    });
    return createNativeAgentExecutionRunHostRuntime({
        runtime: derivedRuntime,
        lease: params.lease,
        options: params.options,
        supportsResume: params.supportsResume,
        ...(params.generationSignal ? { generationSignal: params.generationSignal } : {}),
        ...(params.services ? { services: params.services } : {}),
    });
}

/**
 * Host-owned retained Session interaction used by multi-turn consumers such as
 * Voice. It deliberately bypasses finite Execution Run terminal semantics and
 * reuses the canonical native Session turn/custody controller for every turn.
 */
export function createNativeAgentSessionInteractionHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    lease: AgentRuntimeRegistrationLease;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createSessionContext: NativeAgentSessionContextLeaseFactory;
}>): ExecutionRunHostRuntime {
    const sessions = params.runtime.sessions;
    if (!sessions) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support sessions`);
    }
    const runId = readRequiredString(params.options.runId, 'a run id');
    const launchEnvironment = buildLaunchEnvironment(params.options);
    const sanitize = params.options.sanitizeProviderDiagnosticText ?? ((value: string) => value);
    const ownedAbortController = new AbortController();
    const signal = params.generationSignal
        ? AbortSignal.any([ownedAbortController.signal, params.generationSignal])
        : ownedAbortController.signal;
    const servicesPromise = params.services ?? Promise.resolve(createUnavailablePluginServices());
    const listeners = new Set<(message: AgentMessage) => void>();
    let operations: ReturnType<typeof createNativeAgentSessionInteractionOperations> | null = null;
    let unsubscribeEvents: (() => void) | null = null;
    let disposeSessionContext: (() => Promise<void>) | null = null;
    let openPromise: Promise<void> | null = null;
    let provisionPromise: Promise<Readonly<{ sessionId: string }>> | null = null;
    let disposed = false;
    let turnOrdinal = 0;

    const assertUsable = (): void => {
        if (disposed) throw new Error('Native Agent Session interaction is disposed');
        if (!params.lease.isCurrent()) {
            throw new Error(`Agent runtime '${params.lease.agentId}' belongs to a retired generation`);
        }
        signal.throwIfAborted();
    };
    const emit = (message: AgentMessage): void => {
        for (const listener of listeners) {
            try {
                listener(message);
            } catch {
                // One Voice projection cannot interrupt the retained Session owner.
            }
        }
    };
    const open = async (resumeSessionId?: string): Promise<void> => {
        assertUsable();
        if (openPromise) return await openPromise;
        openPromise = (async () => {
            const services = await servicesPromise;
            assertUsable();
            const sessionContext = await params.createSessionContext({ services, signal });
            const context = sessionContext.context;
            disposeSessionContext = sessionContext.dispose;
            const common = {
                sessionId: context.session.id,
                cwd: params.options.cwd,
                stateSharing: resolveNativeAgentSessionStateSharingPolicy(params.lease.agentId),
                ...(launchEnvironment ? { launchEnvironment } : {}),
                ...(params.options.modelSelection ? { modelSelection: params.options.modelSelection } : {}),
                ...(params.options.configuration ? { configuration: params.options.configuration } : {}),
                ...(params.options.providerBinding ? { providerBinding: params.options.providerBinding } : {}),
            };
            const request: AgentSessionOpenRequest = resumeSessionId
                ? { ...common, kind: 'resume', providerSessionId: resumeSessionId }
                : { ...common, kind: 'create' };
            let opened: AgentSessionRuntime | null = null;
            try {
                opened = await sessions.open(request, context);
                assertUsable();
                operations = createNativeAgentSessionInteractionOperations({
                    session: opened,
                    sessionId: context.session.id,
                    cwd: params.options.cwd,
                    context,
                    initialConfiguration: params.options.configuration,
                });
                unsubscribeEvents = operations.subscribeRuntimeEvents((event) => {
                    if ('type' in event) return;
                    const message = sessionEventToHostMessage(event, sanitize);
                    if (message) emit(message);
                });
            } catch (error) {
                try {
                    await opened?.dispose('runtime_recovery');
                } finally {
                    await disposeSessionContext?.();
                    disposeSessionContext = null;
                }
                throw error;
            }
        })();
        return await openPromise;
    };

    return Object.freeze({
        permissionCapability: 'static' as const,
        async readResumeSupport() {
            return params.supportsResume;
        },
        async provisionSession(options) {
            assertUsable();
            provisionPromise ??= (async () => {
                if (options?.resumeSessionId && !params.supportsResume) {
                    throw new Error('Backend does not support resume');
                }
                await open(options?.resumeSessionId);
                if (options?.initialPrompt !== undefined) {
                    const turnId = `${runId}-turn-${++turnOrdinal}`;
                    operations!.beginTurnLifecycle();
                    await operations!.sendTurnPrompt(options.initialPrompt, {
                        turnId,
                        localId: `${runId}-input-${turnOrdinal}`,
                    });
                }
                return Object.freeze({ sessionId: runId });
            })();
            return await provisionPromise;
        },
        async sendPrompt(sessionId, prompt, meta) {
            assertUsable();
            if (!provisionPromise || sessionId !== runId) {
                throw new Error(`Native Agent Session interaction '${runId}' is not provisioned for '${sessionId}'`);
            }
            await provisionPromise;
            await open();
            const turnId = `${runId}-turn-${++turnOrdinal}`;
            operations!.beginTurnLifecycle();
            await operations!.sendTurnPrompt(prompt, {
                turnId,
                localId: meta?.localInputId ?? `${runId}-input-${turnOrdinal}`,
                ...(meta?.localInputIds ? { localIds: meta.localInputIds } : {}),
                ...(meta?.userMessageSeq !== undefined ? { userMessageSeq: meta.userMessageSeq } : {}),
                ...(meta?.userMessageSeqs ? { userMessageSeqs: meta.userMessageSeqs } : {}),
            });
        },
        async cancel(sessionId) {
            assertUsable();
            if (!provisionPromise || sessionId !== runId || !operations) return;
            await operations.cancelTurn();
        },
        subscribeMessages(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        async waitForTurnCompletion(timeoutMs) {
            if (!operations) return;
            await operations.waitForTurnCompletion({ timeoutMs: timeoutMs ?? null });
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            ownedAbortController.abort(new Error('Native Agent Session interaction disposed'));
            unsubscribeEvents?.();
            unsubscribeEvents = null;
            listeners.clear();
            try {
                await operations?.resetOrDisposeRuntime('session_closed');
            } finally {
                await disposeSessionContext?.();
            }
        },
    });
}
