import type { AgentSessionConfigurationSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';
import type { HostSessionRuntimeFactoryParams, HostSessionRuntimeHookRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { HostSessionTerminalRemoteModeLoop } from '@/agent/runtime/session/loop/terminalRemoteModeRuntime';
import type { RuntimeTurnOperations, RuntimeTurnDisposeReason, RuntimeTurnSessionOpenIntent } from '@/agent/runtime/turns/runtimeTurnOperations';
import { logger } from '@/ui/logger';
import type { HostTerminalOrchestration, HostTerminalRunResult, HostTerminalTranscriptFollowBindResult, HostTerminalTranscriptFollowBinding } from './contract';
import { HostTerminalModelSelectionBlockedError, HostTerminalTranscriptFollowAdmissionError } from './contract';
import { waitForNativeAgentTerminalRemoteDisposition } from './providerCliAttachMode';

type NativeAgentTerminalExecutionSurface = NonNullable<BackendExecutionSurfaces['terminalRuntime']>;

function readNativeAgentTerminalRunResult(value: unknown): HostTerminalRunResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Native Agent terminal execution owner returned an invalid result');
    }
    const result = value as Readonly<Record<string, unknown>>;
    if (
        result.type === 'process_exited'
        && typeof result.exitCode === 'number'
        && Number.isFinite(result.exitCode)
    ) {
        return value as HostTerminalRunResult;
    }
    if (
        result.type === 'control_returned'
        && (
            result.reason === 'switch_requested'
            || result.reason === 'pending_input'
            || result.reason === 'terminal_recovery'
        )
    ) {
        return value as HostTerminalRunResult;
    }
    throw new Error('Native Agent terminal execution owner returned an invalid result');
}


/**
 * For an Agent that does not declare explicit terminal follow, transcript follow
 * is an additive capability around the terminal: its failures are reported as
 * diagnostics and never fail the terminal run.
 *
 * Required follow failures retain their typed admission cause, including when
 * a fresh terminal must first publish its native Session identity.
 */
function readTranscriptFollowFailureCode(error: unknown): string {
    if (error instanceof Error) {
        const code = Reflect.get(error, 'code');
        if (typeof code === 'string' && code.trim().length > 0) return code;
        if (error.message.trim().length > 0) return error.message.trim();
    }
    return 'native_agent_terminal_transcript_follow_failed';
}

function observeProviderSessionIdentity(runtime: RuntimeTurnOperations, signal: AbortSignal) {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    let resolveIdentity!: (identity: string) => void;
    let rejectIdentity!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
        resolveIdentity = resolve;
        rejectIdentity = reject;
    });
    const dispose = () => {
        unsubscribe?.();
        unsubscribe = null;
        signal.removeEventListener('abort', unavailable);
    };
    const unavailable = () => {
        if (settled) return;
        settled = true;
        dispose();
        rejectIdentity(new HostTerminalTranscriptFollowAdmissionError(
            'native_agent_terminal_provider_session_unavailable', 'bind', false,
        ));
    };
    // Observation precedes launch: an immediate native hook cannot be lost.
    unsubscribe = runtime.subscribeRuntimeEvents(event => {
        if (settled) return;
        if (event.kind === 'runtime-ended') {
            unavailable();
        } else if (event.kind === 'provider-session-id') {
            const identity = readNonBlankOpaqueIdentifier(event.providerSessionId);
            if (!identity) return;
            settled = true;
            dispose();
            resolveIdentity(identity);
        }
    });
    if (settled) dispose();
    else {
        signal.addEventListener('abort', unavailable, { once: true });
        if (signal.aborted) unavailable();
    }
    // A synchronous launch failure can retire observation before it is awaited.
    void promise.catch(() => undefined);
    return { promise, dispose };
}

export function createNativeAgentTerminalModeBinding<TRuntime extends RuntimeTurnOperations & Pick<HostSessionRuntimeHookRuntime, 'refreshSkills'>>(params: Readonly<{
    runtime: TRuntime;
    terminal: NativeAgentTerminalExecutionSurface;
    agentId: string;
    sessionId: string;
    directory: string;
    readMetadata: () => Readonly<Record<string, unknown>>;
    configuration?: AgentSessionConfigurationSnapshot;
    runWithTerminalModelSelection:
        HostSessionRuntimeFactoryParams['runWithTerminalModelSelection'];
    environment?: Readonly<Record<string, string>>;
    unsetEnvironmentVariables?: readonly string[];
    generationSignal?: AbortSignal;
    /**
     * Declaration-derived terminal-follow eligibility (`ES-PEP-03`/`ES-PEP-05`).
     * Known identities bind before launch. Fresh terminals bind on native
     * identity publication and cannot settle successfully without required
     * follow. Never inferred — it comes from the Agent's `terminalFollow` opt-in.
     */
    requiresTranscriptFollow?: boolean;
    host: HostTerminalOrchestration | null;
}>): Readonly<{
    runtime: TRuntime;
    terminalRemoteModeLoop: HostSessionTerminalRemoteModeLoop | null;
}> {
    const launch = params.terminal.launch;
    if (!launch) {
        return Object.freeze({
            runtime: params.runtime,
            terminalRemoteModeLoop: null,
        });
    }
    const requiresTranscriptFollow = params.requiresTranscriptFollow === true;
    let activeTerminalRun: Promise<unknown> | null = null;

    const lifecycleAbortController = new AbortController();
    const signal = AbortSignal.any([
        lifecycleAbortController.signal,
        ...(params.generationSignal ? [params.generationSignal] : []),
    ]);
    const reportDegradedTranscriptFollow = (
        code: string,
        phase: 'bind' | 'active' | 'release',
    ): void => {
        logger.warn(
            '[NativeAgentSession] terminal transcript follow unavailable; running the terminal without it',
            {
                code,
                phase,
                agentId: params.agentId,
                sessionId: params.sessionId,
            },
        );
    };
    const disposeTranscriptFollowBinding = async (
        binding: HostTerminalTranscriptFollowBinding,
    ): Promise<void> => {
        try {
            await binding.dispose();
        } catch (error) {
            reportDegradedTranscriptFollow(
                readTranscriptFollowFailureCode(error),
                'release',
            );
        }
    };
    const modeLoop: HostSessionTerminalRemoteModeLoop = Object.freeze({
        startingMode: 'remote',
        remoteExitCode: 0,
        async runTerminal() {
            const transcriptFollow = params.host?.transcriptFollow;
            let transcriptFollowBinding: HostTerminalTranscriptFollowBinding | null = null;
            let identityObservation: ReturnType<typeof observeProviderSessionIdentity> | null = null;
            const disposeIdentityObservation = () => identityObservation?.dispose();
            const bindRequiredFollow = async (providerSessionId: string, bindingSignal: AbortSignal) => {
                if (!transcriptFollow) {
                    throw new HostTerminalTranscriptFollowAdmissionError(
                        'plugin_external_follow_unavailable', 'bind', false,
                    );
                }
                let follow: HostTerminalTranscriptFollowBindResult;
                try {
                    follow = await transcriptFollow.bindProviderSession({
                        agentId: params.agentId, providerSessionId, signal: bindingSignal,
                    });
                } catch (error) {
                    throw new HostTerminalTranscriptFollowAdmissionError(readTranscriptFollowFailureCode(error), 'bind');
                }
                if (follow.status === 'unavailable') {
                    throw new HostTerminalTranscriptFollowAdmissionError(follow.code, 'bind', follow.retryable);
                }
                return follow.binding;
            };
            try {
                const terminalRun = params.runWithTerminalModelSelection(
                    async (
                        modelSelection,
                        runWithCurrentPublisherPermit,
                    ) => {
                        const metadata = params.readMetadata();
                        let providerSessionId: string | null = null;
                        try {
                            const candidate =
                                params.runtime.readSessionIdentity().sessionId;
                            providerSessionId = readNonBlankOpaqueIdentifier(candidate);
                        } catch {
                            providerSessionId = null;
                        }
                        // A fresh native process owns its identity. Observe its
                        // publication before launch instead of requiring an id that
                        // only the launch can produce. Known identities keep their
                        // prelaunch admission; optional follow stays additive.
                        if (requiresTranscriptFollow) {
                            if (!transcriptFollow) {
                                throw new HostTerminalTranscriptFollowAdmissionError(
                                    'plugin_external_follow_unavailable',
                                    'bind',
                                    false,
                                );
                            }
                            if (providerSessionId) {
                                transcriptFollowBinding = await bindRequiredFollow(providerSessionId, signal);
                            } else {
                                identityObservation = observeProviderSessionIdentity(params.runtime, signal);
                            }
                        } else if (transcriptFollow) {
                            if (!providerSessionId) {
                                reportDegradedTranscriptFollow(
                                    'native_agent_terminal_provider_session_unavailable',
                                    'bind',
                                );
                            } else {
                                try {
                                    const follow =
                                        await transcriptFollow.bindProviderSession({
                                            agentId: params.agentId,
                                            providerSessionId,
                                            signal,
                                        });
                                    if (follow.status === 'unavailable') {
                                        reportDegradedTranscriptFollow(
                                            follow.code,
                                            'bind',
                                        );
                                    } else {
                                        transcriptFollowBinding = follow.binding;
                                    }
                                } catch (error) {
                                    reportDegradedTranscriptFollow(
                                        readTranscriptFollowFailureCode(error),
                                        'bind',
                                    );
                                }
                            }
                        }
                        // A declaring Agent's terminal must stop when following
                        // stops, so its child is spawned against a run-scoped
                        // signal the race can abort. Every other Agent keeps the
                        // lifecycle signal exactly as before.
                        const runAbort = requiresTranscriptFollow
                            ? new AbortController()
                            : null;
                        const launchSignal = runAbort
                            ? AbortSignal.any([signal, runAbort.signal])
                            : signal;
                        const launchPromise = Promise.resolve(launch({
                            sessionId: params.sessionId,
                            directory: params.directory,
                            metadata: providerSessionId
                                ? {
                                    ...metadata,
                                    providerSessionId,
                                }
                                : metadata,
                            ...(params.configuration ? { configuration: params.configuration } : {}),
                            modelSelection,
                            runWithCurrentPublisherPermit,
                            ...(params.environment || params.unsetEnvironmentVariables
                                ? {
                                    isolation: {
                                        ...(params.environment ? { env: params.environment } : {}),
                                        ...(params.unsetEnvironmentVariables
                                            ? { unsetEnvKeys: params.unsetEnvironmentVariables }
                                            : {}),
                                    },
                                }
                                : {}),
                            signal: launchSignal,
                            ...(params.host ? { host: params.host } : {}),
                        })).then(readNativeAgentTerminalRunResult);
                        if (identityObservation) {
                            try {
                                providerSessionId = await Promise.race([
                                    identityObservation.promise,
                                    launchPromise.then((): never => {
                                        throw new HostTerminalTranscriptFollowAdmissionError(
                                            'native_agent_terminal_provider_session_unavailable', 'bind', false,
                                        );
                                    }),
                                ]);
                                transcriptFollowBinding = await bindRequiredFollow(providerSessionId, launchSignal);
                            } catch (error) {
                                runAbort?.abort(error);
                                void launchPromise.catch(() => undefined);
                                throw error;
                            } finally {
                                disposeIdentityObservation();
                            }
                        }
                        let result: HostTerminalRunResult;
                        if (transcriptFollowBinding && runAbort) {
                            // `ES-PEP-05`: race terminal completion against binding
                            // failure. A declaring Agent must never keep producing
                            // terminal work that no transcript owner is recording, so
                            // a durable follow failure stops the child and wins with a
                            // typed failure. Already committed rows are untouched.
                            const activeBinding = transcriptFollowBinding;
                            const bindingFailure = activeBinding.failure.then(
                                (error): never => {
                                    throw new HostTerminalTranscriptFollowAdmissionError(
                                        readTranscriptFollowFailureCode(error),
                                        'active',
                                    );
                                },
                            );
                            // The race settles on whichever arrives first; the loser
                            // must not surface as an unhandled rejection.
                            bindingFailure.catch(() => undefined);
                            try {
                                result = await Promise.race([
                                    launchPromise,
                                    bindingFailure,
                                ]);
                            } catch (error) {
                                runAbort.abort(error);
                                launchPromise.catch(() => undefined);
                                throw error;
                            }
                        } else {
                            if (transcriptFollowBinding) {
                                const activeBinding = transcriptFollowBinding;
                                void activeBinding.failure.then(
                                    async (error) => {
                                        reportDegradedTranscriptFollow(
                                            readTranscriptFollowFailureCode(error),
                                            'active',
                                        );
                                        await disposeTranscriptFollowBinding(
                                            activeBinding,
                                        );
                                    },
                                    () => undefined,
                                );
                            }
                            result = await launchPromise;
                        }
                        return result.type === 'process_exited'
                            ? { type: 'exit' as const, code: result.exitCode }
                            : { type: 'switch' as const };
                    },
                );
                activeTerminalRun = terminalRun;
                const run = await terminalRun;
                if (run.status === 'blocked') {
                    throw new HostTerminalModelSelectionBlockedError();
                }
                return run.value;
            } finally {
                disposeIdentityObservation();
                if (transcriptFollowBinding) {
                    await disposeTranscriptFollowBinding(transcriptFollowBinding);
                }
                activeTerminalRun = null;
            }
        },
        runRemote: async () => await waitForNativeAgentTerminalRemoteDisposition({
            signal,
            switching: params.host?.switching ?? null,
        }),
        onModeChange: () => undefined,
    });

    const runtime = Object.freeze({
        ...params.runtime,
        ...(params.runtime.refreshSkills ? {
            async refreshSkills(...args: Parameters<NonNullable<HostSessionRuntimeHookRuntime['refreshSkills']>>) {
                if (activeTerminalRun) return { kind: 'restart_required' as const, reason: 'launch_path_unsupported' as const };
                return await params.runtime.refreshSkills!(...args);
            },
        } : {}),
        async resetOrDisposeRuntime(
            reason?: RuntimeTurnDisposeReason,
            nextSessionOpenIntent?: RuntimeTurnSessionOpenIntent,
        ) {
            // Native startup-plan delivery reopens an incarnation within this
            // same Session. Its remote loop must outlive that replacement.
            if (!nextSessionOpenIntent) lifecycleAbortController.abort();
            await params.runtime.resetOrDisposeRuntime(reason, nextSessionOpenIntent);
        },
    });
    return Object.freeze({
        runtime,
        terminalRemoteModeLoop: modeLoop,
    });
}
