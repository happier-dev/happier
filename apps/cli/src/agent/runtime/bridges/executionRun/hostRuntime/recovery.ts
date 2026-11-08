import { randomUUID } from 'node:crypto';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import type {
    AgentSessionOpenRequest,
    AgentSessionRuntime,
    AgentSessionRuntimeEvent,
    AgentSessionSendRequest,
    AgentLaunchEnvironment,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import { readAgentSessionProviderIdentityConflict } from '@/agent/runtime/session/turn/agentSessionTurnInvariant';
import type { ExecutionRunHostRuntimeEvent } from '../executionRunHostRuntime';
import { logger } from '@/ui/logger';

type FailedTurn = Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>;
type TerminalTurn = Extract<AgentSessionRuntimeEvent, { kind: 'turn-complete' | 'turn-failed' | 'turn-cancelled' }>;
type RecoveryPreparation = NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>;
type RecoveryWaiting = Extract<ExecutionRunHostRuntimeEvent, { kind: 'recovery-waiting' }>;

/** Scope adapters retain identity/event correlation; the recovery effect order is shared. */
export async function continueNativeRuntimeAfterFailure(params: Readonly<{
    input: Parameters<RecoveryPreparation>[0];
    prepare: RecoveryPreparation;
    retireNative(): Promise<void>;
    resumeNative(environment: AgentLaunchEnvironment | undefined): Promise<void>;
    sendContinuation(input: string): Promise<void>;
}>): Promise<boolean> {
    const { signal } = params.input;
    const result = await params.prepare(params.input);
    signal.throwIfAborted();
    if (result.status !== 'continue') return false;
    await params.retireNative();
    signal.throwIfAborted();
    const environment = await result.prepareResume();
    signal.throwIfAborted();
    await params.resumeNative(environment);
    signal.throwIfAborted();
    await params.sendContinuation(result.input);
    return true;
}

/**
 * One native conversation carrier for finite and retained Runs. Policy, waits,
 * credential selection and continuation text belong to the daemon recovery
 * owner; this carrier retains the native conversation and the caller's turn.
 */
export function createRecoveringAgentSessionRuntime(params: Readonly<{
    session: AgentSessionRuntime;
    request: Extract<AgentSessionOpenRequest, { kind: 'create' | 'resume' }>;
    openSession(request: Extract<AgentSessionOpenRequest, { kind: 'resume' }>): Promise<AgentSessionRuntime>;
    recover: NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>;
    onTurnCompleted?: () => Promise<void>;
    onRecoveryWaiting?: (turnId: string, recovery: SessionUsageLimitRecoveryV1) => void;
    signal: AbortSignal;
}>): AgentSessionRuntime & Readonly<{ readRecoveryWaiting(): RecoveryWaiting | null }> {
    let session = params.session;
    let request = params.request;
    let providerSessionId = request.kind === 'resume' ? request.providerSessionId : null;
    let subscription: ReturnType<AgentSessionRuntime['watch']> | null = null;
    let admittedSource: AgentSessionRuntime | null = null;
    let activeInput: AgentSessionSendRequest | null = null;
    let nativeTurnId: string | null = null;
    let nativeInputIds: readonly string[] = [];
    let continuing = false;
    let recovery: AbortController | null = null;
    let recoveryWaiting: RecoveryWaiting | null = null;
    let identityFailure: FailedTurn['diagnostic'] | null = null;
    let sequence = 0;
    let disposed = false;
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    const initialEvents: AgentSessionRuntimeEvent[] = [];
    let watched = false;

    const publish = (event: AgentSessionRuntimeEvent): void => {
        if (disposed) return;
        const published = { ...event, sequence: ++sequence };
        if (!watched) initialEvents.push(published);
        for (const listener of listeners) listener(published);
    };
    const project = (event: AgentSessionRuntimeEvent): AgentSessionRuntimeEvent => {
        if (activeInput && 'turnId' in event && event.turnId === nativeTurnId) {
            return { ...event, turnId: activeInput.delivery.turnId };
        }
        return event;
    };
    const settle = async (event: TerminalTurn): Promise<void> => {
        const projected = project(event);
        activeInput = null;
        nativeInputIds = [];
        continuing = false;
        if (event.kind === 'turn-complete') await params.onTurnCompleted?.().catch(() => undefined);
        publish(projected);
    };

    const recover = async (failure: FailedTurn, attempt: AbortController): Promise<void> => {
        const interrupted = activeInput;
        const nativeIdentity = providerSessionId;
        if (!interrupted || !nativeIdentity) return;
        const signal = AbortSignal.any([params.signal, attempt.signal]);
        try {
            const recovered = await continueNativeRuntimeAfterFailure({
                input: {
                    diagnostic: failure.diagnostic,
                    providerSessionId: nativeIdentity,
                    interruptedOriginId: failure.turnId,
                    signal,
                    onRecoveryWaiting: waiting => {
                        recoveryWaiting = { kind: 'recovery-waiting', turnId: interrupted.delivery.turnId, recovery: waiting };
                        logger.infoFile('[NativeAgentSession] Recovery phase', {
                            phase: 'recovery_waiting', turnId: interrupted.delivery.turnId,
                            nativeFailureAtMs: failure.emittedAtMs, armedAtMs: waiting.armedAtMs,
                        });
                        params.onRecoveryWaiting?.(interrupted.delivery.turnId, waiting);
                    },
                },
                prepare: params.recover,
                async retireNative() {
                    recoveryWaiting = null;
                    // Retire the native writer before preserving/rematerializing
                    // its state for this exact conversation's continuation.
                    admittedSource = null;
                    subscription?.dispose();
                    subscription = null;
                    await session.dispose('runtime_recovery');
                },
                async resumeNative(launchEnvironment) {
                    const resumedRequest = {
                        ...request,
                        kind: 'resume' as const,
                        providerSessionId: nativeIdentity,
                        ...(launchEnvironment ? { launchEnvironment } : {}),
                    };
                    const resumed = await params.openSession(resumedRequest);
                    if (signal.aborted || disposed || recovery !== attempt) {
                        await resumed.dispose('runtime_recovery');
                        return;
                    }
                    request = resumedRequest;
                    session = resumed;
                    identityFailure = null;
                    const conflict = bind(session, nativeIdentity);
                    if (conflict) throw Object.assign(new Error(conflict.code), { code: conflict.code });
                },
                async sendContinuation(input) {
                    nativeTurnId = `${interrupted.delivery.turnId}:continuation:${randomUUID()}`;
                    nativeInputIds = [`runtime-continuation:${randomUUID()}`];
                    continuing = true;
                    recovery = null;
                    const sent = await session.send({
                        input: { text: input },
                        inputIds: [nativeInputIds[0]!],
                        delivery: { kind: 'newTurn', turnId: nativeTurnId },
                        ...(interrupted.causalPermissionAuthority ? { causalPermissionAuthority: interrupted.causalPermissionAuthority } : {}),
                    }, { signal: params.signal });
                    if (sent.status !== 'admitted' && activeInput === interrupted && recovery === null) {
                        settle({ ...failure, diagnostic: sent.diagnostic });
                    }
                },
            });
            if (!recovered && recovery === attempt && activeInput === interrupted) {
                recovery = null;
                settle(failure);
            }
        } catch (error) {
            if (disposed || (recovery !== null && recovery !== attempt) || activeInput !== interrupted) return;
            recovery = null;
            const diagnostic = error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? { code: error.code, message: error.message, severity: 'error' as const }
                : failure.diagnostic;
            settle({ ...failure, diagnostic });
        }
    };

    function bind(source: AgentSessionRuntime, expectedProviderSessionId?: string): FailedTurn['diagnostic'] | null {
        admittedSource = source;
        // Resume admission concerns this source's first identity, not the
        // identity retained from the runtime it replaces.
        let observedProviderSessionId: string | null = null;
        subscription = source.watch(event => {
            if (disposed || admittedSource !== source) return;
            if (event.kind === 'provider-session-id') {
                const conflict = readAgentSessionProviderIdentityConflict({
                    expectedProviderSessionId,
                    providerSessionId: observedProviderSessionId,
                    event,
                });
                if (conflict) {
                    identityFailure = conflict;
                    admittedSource = null;
                    recovery?.abort(new Error(conflict.code));
                    recovery = null;
                    if (activeInput && nativeTurnId) void settle({
                        kind: 'turn-failed', turnId: nativeTurnId, sequence: event.sequence,
                        sessionId: event.sessionId, emittedAtMs: event.emittedAtMs, diagnostic: conflict,
                    });
                    return;
                }
                observedProviderSessionId = providerSessionId = event.providerSessionId;
            }
            if (recovery && event.kind === 'runtime-ended') return;
            const correlatedInput = 'inputIds' in event && event.inputIds.length === nativeInputIds.length
                && event.inputIds.every(id => nativeInputIds.includes(id));
            if (correlatedInput && (event.kind === 'input-rejected' || event.kind === 'input-custody-unknown' || event.kind === 'input-delivery-failed')) {
                recovery?.abort(new Error('Native input admission failed'));
                recovery = null;
                if (continuing) {
                    void settle({ kind: 'turn-failed', turnId: nativeTurnId!, sequence: event.sequence,
                        sessionId: event.sessionId, emittedAtMs: event.emittedAtMs,
                        diagnostic: event.kind === 'input-rejected' ? event.diagnostic : event.issue });
                } else {
                    // Custody outcomes stay authoritative even if the provider
                    // subsequently emits a failure for this unaccepted turn.
                    activeInput = null;
                    nativeInputIds = [];
                    publish(event);
                }
                return;
            }
            if (continuing && event.kind === 'input-accepted' && correlatedInput) return;
            if (continuing && event.kind === 'turn-start' && event.turnId === nativeTurnId) return;
            if (event.kind === 'turn-failed' && !activeInput && event.turnId === nativeTurnId) return;
            if (event.kind === 'turn-failed' && event.turnId === nativeTurnId && activeInput && providerSessionId && !recovery) {
                const attempt = new AbortController();
                recoveryWaiting = null;
                recovery = attempt;
                void recover(event, attempt);
                return;
            }
            if ((event.kind === 'turn-complete' || event.kind === 'turn-cancelled') && event.turnId === nativeTurnId) {
                settle(event);
                return;
            }
            publish(project(event));
        });
        if (identityFailure) {
            subscription.dispose();
            subscription = null;
        }
        return identityFailure;
    }
    bind(session, request.kind === 'resume' ? request.providerSessionId : undefined);

    return Object.freeze({
        // The recovery owner clears its active attempt before native continuation.
        readRecoveryWaiting: () => recovery && !recovery.signal.aborted ? recoveryWaiting : null,
        get runtimeDescriptorV1() { return session.runtimeDescriptorV1; },
        get runtimeCapabilities() { return session.runtimeCapabilities; },
        get nativeGoalControlsSupported() { return session.nativeGoalControlsSupported; },
        get skillsDelivered() { return session.skillsDelivered; },
        get conversationRollback() { return session.conversationRollback; },
        get runtimeAuth() { return session.runtimeAuth; },
        ...(params.session.refreshSkills ? { refreshSkills: (...args: Parameters<NonNullable<AgentSessionRuntime['refreshSkills']>>) => session.refreshSkills!(...args) } : {}),
        ...(params.session.prepareTerminalPresentation ? { prepareTerminalPresentation: (...args: Parameters<NonNullable<AgentSessionRuntime['prepareTerminalPresentation']>>) => session.prepareTerminalPresentation!(...args) } : {}),
        ...(params.session.observeSourceTranscript ? { observeSourceTranscript: (...args: Parameters<NonNullable<AgentSessionRuntime['observeSourceTranscript']>>) => session.observeSourceTranscript!(...args) } : {}),
        ...(params.session.connectedServiceApplicationSettled ? { connectedServiceApplicationSettled: (...args: Parameters<NonNullable<AgentSessionRuntime['connectedServiceApplicationSettled']>>) => session.connectedServiceApplicationSettled!(...args) } : {}),
        ...(params.session.compact ? { compact: (...args: Parameters<NonNullable<AgentSessionRuntime['compact']>>) => session.compact!(...args) } : {}),
        ...(params.session.updateConfiguration ? {
            async updateConfiguration(update: Parameters<NonNullable<AgentSessionRuntime['updateConfiguration']>>[0], options?: Parameters<NonNullable<AgentSessionRuntime['updateConfiguration']>>[1]) {
                const result = await session.updateConfiguration!(update, options);
                if (result.status === 'applied') {
                    request = { ...request, configuration: update };
                }
                return result;
            },
        } : {}),
        async send(input: AgentSessionSendRequest, options?: Parameters<AgentSessionRuntime['send']>[1]) {
            params.signal.throwIfAborted();
            if (identityFailure) return { status: 'rejected' as const, diagnostic: identityFailure, retryable: false };
            activeInput = input;
            nativeTurnId = input.delivery.turnId;
            nativeInputIds = input.inputIds;
            continuing = false;
            return await session.send(input, options);
        },
        ...(params.session.cancel ? {
            async cancel(input: Parameters<NonNullable<AgentSessionRuntime['cancel']>>[0], options?: Parameters<NonNullable<AgentSessionRuntime['cancel']>>[1]) {
                if (recovery && activeInput?.delivery.turnId === input.turnId) {
                    const attempt = recovery;
                    recovery = null;
                    attempt.abort(new Error('Execution Run recovery cancelled'));
                    settle({ kind: 'turn-cancelled', turnId: nativeTurnId!, cause: input.reason === 'user' ? 'user' : 'hostShutdown', sequence: 0, sessionId: request.sessionId, emittedAtMs: Date.now() });
                    return { status: 'requested' as const, turnId: input.turnId };
                }
                return await session.cancel!({ ...input, turnId: activeInput?.delivery.turnId === input.turnId ? nativeTurnId! : input.turnId }, options);
            },
        } : {}),
        watch(listener: (event: AgentSessionRuntimeEvent) => void) {
            if (!watched) {
                watched = true;
                for (const event of initialEvents.splice(0)) listener(event);
            }
            listeners.add(listener);
            return { dispose() { listeners.delete(listener); } };
        },
        async dispose(reason?: Parameters<AgentSessionRuntime['dispose']>[0]) {
            if (disposed) return;
            disposed = true;
            recovery?.abort(new Error('Execution Run recovery disposed'));
            recovery = null;
            admittedSource = null;
            subscription?.dispose();
            listeners.clear();
            initialEvents.length = 0;
            await session.dispose(reason);
        },
    });
}
