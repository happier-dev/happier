import { randomUUID } from 'node:crypto';

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    AgentProviderBindingAdapter,
    AgentRuntime,
    AgentRuntimeFactoryContext,
    AgentSessionOpenRequest,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import {
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS,
    AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS,
    validateAgentExternalSessionHookMapEventRequest,
    validateAgentExternalSessionHookMapEventResult,
    validateAgentExternalSessionHookResolveInstallationRequest,
    validateAgentExternalSessionHookResolveInstallationResult,
    validateAgentExternalSessionTakeoverResolveLaunchRequest,
    validateAgentExternalSessionTakeoverResolveLaunchResult,
    type AgentExternalSessionHookMapEventRequest,
    type AgentExternalSessionHookResolveInstallationRequest,
    type AgentExternalSessionHooksContribution,
    type AgentExternalSessionObservationContribution,
    type AgentExternalSessionObservationObserveResourceRequest,
    type AgentExternalSessionObservationReconcileResourceRequest,
    type AgentExternalSessionTakeoverContribution,
    type AgentExternalSessionTakeoverResolveLaunchRequest,
    type AgentExternalSessionTakeoverResolveLaunchResult,
    type AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import {
    ExternalAgentObservationLinkEvidenceBatchV1Schema,
    ExternalAgentObservationLinkKeyV1Schema,
    ExternalAgentObservationReconcileRequestV1Schema,
    ExternalAgentObservationReconcileResultV1Schema,
    ExternalAgentObservationResourceGroupingV1Schema,
    ExternalAgentObservationResourceKeyV1Schema,
} from '@happier-dev/protocol';
import type { ResolvedAgentContribution } from '../../../projection/registry/types';
import { readAgentPrimaryRuntime } from '../../../projection/registry/agentContributionDefinition';

import type {
    AgentContributionRuntimeRegistration,
    ContributionRuntimeRegistration,
} from '../../api/registrationRightsHost';
import type { ActivationTarget } from '../activation/targets';
import { createBoundedAgentExternalSessionsContribution } from '../../../../session/external/agentExternalSessionsInvocation';
import { createPluginInvocationUi } from '../../invocation/services/ui';
import { createUnavailablePluginServices } from '../../invocation/services/unavailable';
import type { CreateAgentInvocationServices } from '../../invocation/services/types';

const EXTERNAL_SESSION_OBSERVATION_POLICY = Object.freeze({
    // This bounds host responsiveness and result admission. It does not contain
    // or preempt non-cooperative plugin work after the host stops awaiting it.
    deadlineMs: 15_000,
});

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

type GenerationBoundExternalSessionHooks = Readonly<{
    installationVariants:
        AgentExternalSessionHooksContribution['installationVariants'];
    resolveInstallation(
        request: Parameters<
            AgentExternalSessionHooksContribution['resolveInstallation']
        >[0],
    ): Promise<Awaited<ReturnType<
        AgentExternalSessionHooksContribution['resolveInstallation']
    >>>;
    mapHookEvent(
        request: Parameters<
            AgentExternalSessionHooksContribution['mapHookEvent']
        >[0],
    ): Promise<Awaited<ReturnType<
        AgentExternalSessionHooksContribution['mapHookEvent']
    >>>;
}>;

type GenerationBoundExternalSessionTakeover = Readonly<{
    resolveLaunch(
        request: AgentExternalSessionTakeoverResolveLaunchRequest,
    ): Promise<AgentExternalSessionTakeoverResolveLaunchResult>;
}>;

type AgentRuntimeRegistrationLeaseBase = Readonly<{
    pluginId: string;
    pluginVersion: string;
    agentId: string;
    generation: string;
    immutableGenerationId?: string | null;
    startupInstructionsVersions?: readonly [1];
    externalSessions?: AgentExternalSessionsContribution;
    externalSessionHooks?: GenerationBoundExternalSessionHooks;
    externalSessionObservation?: AgentExternalSessionObservationContribution;
    externalSessionTakeover?: GenerationBoundExternalSessionTakeover;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
}>;

export type AgentRuntimeRegistrationLease =
    | (AgentRuntimeRegistrationLeaseBase & Readonly<{
        hasPrimaryRuntime: true;
        providerBinding?: AgentProviderBindingAdapter;
        createRuntime(params: Readonly<{ signal: AbortSignal }>): Promise<AgentRuntime>;
    }>)
    | (AgentRuntimeRegistrationLeaseBase & Readonly<{
        hasPrimaryRuntime: false;
        providerBinding?: undefined;
        createRuntime?: undefined;
    }>);

export type AgentRuntimeOwnerDuplicate = Readonly<{
    agentId: string;
    firstPluginId: string;
    secondPluginId: string;
}>;

type AgentRuntimeGenerationLifecycleResolver = (
    pluginId: string,
) => Readonly<{
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

type AgentRuntimeRetirementOwner =
    | Readonly<{
        retirementSignal: AbortSignal;
        resolveGenerationLifecycle?: AgentRuntimeGenerationLifecycleResolver;
    }>
    | Readonly<{
        retirementSignal?: never;
        resolveGenerationLifecycle: AgentRuntimeGenerationLifecycleResolver;
    }>;

function requireAgentRuntimeRetirementSignal(params: Readonly<{
    agentId: string;
    lifecycleSignal?: AbortSignal;
    registrySignal?: AbortSignal;
}>): AbortSignal {
    const signal = params.lifecycleSignal ?? params.registrySignal;
    if (!signal) {
        throw new Error(
            `Agent runtime '${params.agentId}' has no generation retirement signal`,
        );
    }
    return signal;
}

function isAgentRegistration(
    registration: ContributionRuntimeRegistration,
): registration is Extract<ContributionRuntimeRegistration, { family: 'agents' }> {
    return registration.family === 'agents';
}

function assertValidAgentRuntime(value: AgentRuntime): AgentRuntime {
    if (typeof value !== 'object' || value === null) {
        throw new Error('Agent factory returned an invalid Agent runtime');
    }
    const sessions = value.sessions;
    const executionRuns = value.executionRuns;
    const hasSessions = typeof sessions === 'object'
        && sessions !== null
        && typeof sessions.open === 'function';
    const hasExecutionRuns = typeof executionRuns === 'object'
        && executionRuns !== null
        && typeof executionRuns.open === 'function';
    if (!hasSessions && !hasExecutionRuns) {
        throw new Error('Agent factory returned an invalid Agent runtime without a session or execution-run factory');
    }
    return value;
}

function readStartupInstructionsVersions(
    agent: Pick<ResolvedAgentContribution, 'richDefinition'> | undefined,
): readonly [1] | undefined {
    const capabilities = agent?.richDefinition?.definition.capabilities;
    if (!capabilities || !('sessions' in capabilities)) return undefined;
    return capabilities.sessions?.startupInstructions?.versions[0] === 1
        ? [1]
        : undefined;
}

function canonicalizeObservationReconciliationOutcomes<T>(
    outcomes: readonly T[],
    requestedLinkKeys: readonly string[],
    readLinkKey: (outcome: T) => string,
): T[] {
    const outcomesByLinkKey = new Map(
        outcomes.map((outcome) => [readLinkKey(outcome), outcome]),
    );
    if (
        outcomes.length !== requestedLinkKeys.length
        || requestedLinkKeys.some((linkKey) => !outcomesByLinkKey.has(linkKey))
    ) {
        throw new TypeError(
            'Agent External Session reconciliation outcomes must correspond exactly to requested links',
        );
    }
    return requestedLinkKeys.map((linkKey) => outcomesByLinkKey.get(linkKey)!);
}

function createGenerationBoundExternalSessionObservation(params: Readonly<{
    contribution: AgentExternalSessionObservationContribution;
    assertCurrent(): void;
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
}>): AgentExternalSessionObservationContribution {
    const composeSignal = (callerSignal: AbortSignal): Readonly<{
        signal: AbortSignal;
        terminalPromise: Promise<void>;
        abort(reason?: 'cancelled' | 'retired' | 'timed-out' | 'disposed'): void;
        clearDeadline(): void;
        timedOut(): boolean;
        cleanup(): void;
    }> => {
        const controller = new AbortController();
        let terminalReason: 'cancelled' | 'retired' | 'timed-out' | 'disposed' | null = null;
        let resolveTerminal!: () => void;
        const terminalPromise = new Promise<void>((resolve) => {
            resolveTerminal = resolve;
        });
        const abort = (
            reason: 'cancelled' | 'retired' | 'timed-out' | 'disposed' = 'disposed',
        ) => {
            if (terminalReason !== null) return;
            terminalReason = reason;
            controller.abort(reason);
            resolveTerminal();
        };
        const cancel = () => abort('cancelled');
        const retire = () => abort('retired');
        if (params.retirementSignal.aborted) {
            retire();
        } else if (callerSignal.aborted) {
            cancel();
        } else {
            callerSignal.addEventListener('abort', cancel, { once: true });
            params.retirementSignal.addEventListener('abort', retire, { once: true });
        }
        let deadline: ReturnType<typeof setTimeout> | null = setTimeout(
            () => abort('timed-out'),
            EXTERNAL_SESSION_OBSERVATION_POLICY.deadlineMs,
        );
        deadline.unref?.();
        const clearDeadline = (): void => {
            if (!deadline) return;
            clearTimeout(deadline);
            deadline = null;
        };
        return Object.freeze({
            signal: controller.signal,
            terminalPromise,
            abort,
            clearDeadline,
            timedOut: () => terminalReason === 'timed-out',
            cleanup() {
                clearDeadline();
                callerSignal.removeEventListener('abort', cancel);
                params.retirementSignal.removeEventListener('abort', retire);
            },
        });
    };

    const assertAdmissible = (callerSignal?: AbortSignal): void => {
        params.assertCurrent();
        if (params.retirementSignal.aborted) {
            params.assertCurrent();
            throw new Error('Agent External Session observation belongs to a retired generation');
        }
        if (callerSignal?.aborted) {
            throw new Error('Agent External Session observation was cancelled');
        }
    };

    const terminalError = (
        callerSignal: AbortSignal,
        composed: ReturnType<typeof composeSignal>,
        cause?: unknown,
    ): Error => {
        if (params.retirementSignal.aborted || !params.isGenerationActive()) {
            return new Error(
                'Agent External Session observation belongs to a retired generation',
                { cause },
            );
        }
        if (callerSignal.aborted) {
            return new Error('Agent External Session observation was cancelled', { cause });
        }
        if (composed.timedOut()) {
            return new Error(
                `Agent External Session observation timed out after ${EXTERNAL_SESSION_OBSERVATION_POLICY.deadlineMs}ms`,
                { cause },
            );
        }
        return cause instanceof Error
            ? cause
            : new Error('Agent External Session observation failed', { cause });
    };
    return Object.freeze({
        describeResource(request) {
            assertAdmissible();
            const grouping = ExternalAgentObservationResourceGroupingV1Schema.parse(
                params.contribution.describeResource(request),
            );
            assertAdmissible();
            return grouping;
        },
        async observeResource(
            request: AgentExternalSessionObservationObserveResourceRequest,
        ) {
            assertAdmissible(request.signal);
            const resourceKey = ExternalAgentObservationResourceKeyV1Schema.parse(
                request.resourceKey,
            );
            const composed = composeSignal(request.signal);
            let acquired: Awaited<
                ReturnType<AgentExternalSessionObservationContribution['observeResource']>
            > | undefined;
            let disposalPromise: Promise<void> | undefined;
            let disposalStarted = false;
            const disposeOnce = (): Promise<void> => {
                if (disposalPromise) return disposalPromise;
                if (!acquired) return Promise.resolve();
                if (disposalStarted) return Promise.resolve();
                disposalStarted = true;
                try {
                    disposalPromise = Promise.resolve(acquired.dispose());
                } catch (error) {
                    disposalPromise = Promise.reject(error);
                }
                return disposalPromise;
            };
            const disposeOnAbort = () => {
                void disposeOnce().catch(() => undefined);
            };
            composed.signal.addEventListener('abort', disposeOnAbort, { once: true });
            let rawAcquisition: ReturnType<
                AgentExternalSessionObservationContribution['observeResource']
            >;
            try {
                rawAcquisition = params.contribution.observeResource(Object.freeze({
                    resourceKey,
                    signal: composed.signal,
                    emit(batch) {
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isGenerationActive()) {
                            return;
                        }
                        const parsed =
                            ExternalAgentObservationLinkEvidenceBatchV1Schema.parse(batch);
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isGenerationActive()) {
                            return;
                        }
                        request.emit(parsed);
                    },
                    requestReconcile() {
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isGenerationActive()) {
                            return;
                        }
                        request.requestReconcile();
                    },
                    requestTranscriptRefresh(linkKey) {
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isGenerationActive()) {
                            return;
                        }
                        const parsedLinkKey =
                            ExternalAgentObservationLinkKeyV1Schema.parse(linkKey);
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isGenerationActive()) {
                            return;
                        }
                        request.requestTranscriptRefresh(parsedLinkKey);
                    },
                }));
            } catch (error) {
                composed.signal.removeEventListener('abort', disposeOnAbort);
                composed.cleanup();
                throw error;
            }
            const acquisition = Promise.resolve(rawAcquisition).then(async (settled) => {
                if (typeof settled !== 'object'
                    || settled === null
                    || typeof settled.dispose !== 'function') {
                    throw new TypeError(
                        'Agent External Session observation returned an invalid Disposable',
                    );
                }
                acquired = Object.freeze({
                    dispose: settled.dispose.bind(settled),
                });
                if (composed.signal.aborted
                    || params.retirementSignal.aborted
                    || !params.isGenerationActive()) {
                    await disposeOnce().catch(() => undefined);
                    throw terminalError(request.signal, composed);
                }
                return acquired;
            });
            try {
                await Promise.race([
                    acquisition,
                    composed.terminalPromise.then(() => {
                        throw terminalError(request.signal, composed);
                    }),
                ]);
                composed.clearDeadline();
                return Object.freeze({
                    async dispose() {
                        composed.abort('disposed');
                        try {
                            await disposeOnce();
                        } finally {
                            composed.signal.removeEventListener('abort', disposeOnAbort);
                            composed.cleanup();
                        }
                    },
                });
            } catch (error) {
                if (composed.signal.aborted) {
                    composed.signal.removeEventListener('abort', disposeOnAbort);
                    composed.cleanup();
                    throw terminalError(request.signal, composed, error);
                }
                composed.signal.removeEventListener('abort', disposeOnAbort);
                composed.cleanup();
                throw error;
            }
        },
        async reconcileResource(
            request: AgentExternalSessionObservationReconcileResourceRequest,
        ) {
            assertAdmissible(request.signal);
            const resourceKey = ExternalAgentObservationResourceKeyV1Schema.parse(
                request.resourceKey,
            );
            const reconciliation = ExternalAgentObservationReconcileRequestV1Schema.parse({
                purpose: request.purpose,
                linkKeys: request.links.map((link) => link.linkKey),
            });
            const links = Object.freeze(reconciliation.linkKeys.map((linkKey, index) =>
                Object.freeze({
                    linkKey,
                    linkedSource: request.links[index]!.linkedSource,
                })));
            const composed = composeSignal(request.signal);
            try {
                const operation = Promise.resolve(
                    params.contribution.reconcileResource(Object.freeze({
                        purpose: reconciliation.purpose,
                        resourceKey,
                        links,
                        signal: composed.signal,
                    })),
                );
                const result = await Promise.race([
                    operation,
                    composed.terminalPromise.then(() => {
                        throw terminalError(request.signal, composed);
                    }),
                ]);
                assertAdmissible(request.signal);
                const parsed =
                    ExternalAgentObservationReconcileResultV1Schema.parse(result);
                assertAdmissible(request.signal);
                if (parsed.purpose !== reconciliation.purpose) {
                    throw new TypeError(
                        'Agent External Session reconciliation result purpose must match its request',
                    );
                }
                if (parsed.purpose === 'observation_evidence') {
                    return {
                        purpose: parsed.purpose,
                        outcomes: canonicalizeObservationReconciliationOutcomes(
                            parsed.outcomes,
                            reconciliation.linkKeys,
                            (outcome) => outcome.linkKey,
                        ),
                    };
                }
                return {
                    purpose: parsed.purpose,
                    outcomes: canonicalizeObservationReconciliationOutcomes(
                        parsed.outcomes,
                        reconciliation.linkKeys,
                        (outcome) => outcome.kind === 'described'
                            ? outcome.descriptor.linkKey
                            : outcome.linkKey,
                    ),
                };
            } finally {
                composed.cleanup();
            }
        },
    });
}

function createGenerationBoundExternalSessionHooks(params: Readonly<{
    contribution: AgentExternalSessionHooksContribution;
    createInvocationContext(signal: AbortSignal): PluginInvocationContext;
    assertCurrent(): void;
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
}>): GenerationBoundExternalSessionHooks {
    type Invocation = Readonly<{
        signal: AbortSignal;
        deadlineAtMs: number;
        maxSerializedBytes: number;
    }>;
    type CallbackName = keyof typeof AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks;
    const encoder = new TextEncoder();

    const assertAdmissible = (callerSignal?: AbortSignal): void => {
        params.assertCurrent();
        if (params.retirementSignal.aborted) {
            throw new Error(
                'Agent External Session hooks belong to a retired generation',
            );
        }
        if (callerSignal?.aborted) {
            throw new Error('Agent External Session hook invocation was cancelled');
        }
    };

    const serializedBytes = (value: unknown): number => {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new TypeError('Agent External Session hook value is not serializable');
        }
        return encoder.encode(serialized).byteLength;
    };

    async function invoke<TRequest extends Invocation, TResult>(input: Readonly<{
        callbackName: CallbackName;
        request: TRequest;
        validateRequest(value: unknown): TRequest;
        validateResult(value: unknown): TResult;
        operation(request: TRequest): TResult | Promise<TResult>;
    }>): Promise<TResult> {
        const request = input.validateRequest(input.request);
        assertAdmissible(request.signal);
        const policy = AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks[input.callbackName];
        const deadlineAtMs = input.callbackName === 'resolveInstallation'
            ? Math.min(
                request.deadlineAtMs,
                Date.now()
                    + AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks.resolveInstallation.deadlineMs,
            )
            : request.deadlineAtMs;
        const maxSerializedBytes = Math.min(
            request.maxSerializedBytes,
            policy.maxEnvelopeUtf8Bytes,
        );
        const controller = new AbortController();
        let terminalReason: 'cancelled' | 'retired' | 'timed-out' | null = null;
        let resolveTerminal!: () => void;
        const terminalPromise = new Promise<void>((resolve) => {
            resolveTerminal = resolve;
        });
        const terminalError = (): Error => {
            if (params.retirementSignal.aborted || !params.isGenerationActive()) {
                return new Error(
                    'Agent External Session hooks belong to a retired generation',
                );
            }
            if (request.signal.aborted) {
                return new Error(
                    'Agent External Session hook invocation was cancelled',
                );
            }
            return new Error(
                `Agent External Session hook '${input.callbackName}' timed out`,
            );
        };
        const terminate = (reason: NonNullable<typeof terminalReason>): void => {
            if (terminalReason !== null) return;
            terminalReason = reason;
            controller.abort(reason);
            resolveTerminal();
        };
        const cancel = () => terminate('cancelled');
        const retire = () => terminate('retired');
        request.signal.addEventListener('abort', cancel, { once: true });
        params.retirementSignal.addEventListener('abort', retire, { once: true });
        const remainingMs = deadlineAtMs - Date.now();
        let timeout: ReturnType<typeof setTimeout> | null = null;
        if (params.retirementSignal.aborted || !params.isGenerationActive()) {
            retire();
        } else if (request.signal.aborted) {
            cancel();
        } else if (remainingMs <= 0) {
            terminate('timed-out');
        } else {
            timeout = setTimeout(() => terminate('timed-out'), remainingMs);
            timeout.unref?.();
        }

        try {
            if (terminalReason !== null) {
                throw terminalError();
            }
            const boundedRequest = input.validateRequest(Object.freeze({
                ...request,
                signal: controller.signal,
                deadlineAtMs,
                maxSerializedBytes,
            }));
            const operation = Promise.resolve().then(() => input.operation(boundedRequest));
            const rawResult = await Promise.race([
                operation,
                terminalPromise.then(() => {
                    throw terminalError();
                }),
            ]);
            assertAdmissible(request.signal);
            const result = input.validateResult(rawResult);
            if (serializedBytes(result) > maxSerializedBytes) {
                throw new TypeError(
                    `Agent External Session hook '${input.callbackName}' result exceeds its serialized-byte limit`,
                );
            }
            assertAdmissible(request.signal);
            return result;
        } finally {
            if (timeout) clearTimeout(timeout);
            request.signal.removeEventListener('abort', cancel);
            params.retirementSignal.removeEventListener('abort', retire);
        }
    }

    return Object.freeze({
        installationVariants: params.contribution.installationVariants,
        resolveInstallation: async (
            request: AgentExternalSessionHookResolveInstallationRequest,
        ) => await invoke({
            callbackName: 'resolveInstallation',
            request,
            validateRequest: validateAgentExternalSessionHookResolveInstallationRequest,
            validateResult: validateAgentExternalSessionHookResolveInstallationResult,
            operation: (boundedRequest) => params.contribution.resolveInstallation(
                boundedRequest,
                params.createInvocationContext(boundedRequest.signal),
            ),
        }),
        mapHookEvent: async (
            request: AgentExternalSessionHookMapEventRequest,
        ) => await invoke({
            callbackName: 'mapHookEvent',
            request,
            validateRequest: validateAgentExternalSessionHookMapEventRequest,
            validateResult: validateAgentExternalSessionHookMapEventResult,
            operation: params.contribution.mapHookEvent.bind(params.contribution),
        }),
    });
}

function createGenerationBoundExternalSessionTakeover(params: Readonly<{
    contribution: AgentExternalSessionTakeoverContribution;
    assertCurrent(): void;
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
}>): GenerationBoundExternalSessionTakeover {
    const encoder = new TextEncoder();
    const policy =
        AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.callbacks.resolveLaunch;

    const assertAdmissible = (callerSignal: AbortSignal): void => {
        params.assertCurrent();
        if (params.retirementSignal.aborted) {
            throw new Error(
                'Agent External Session takeover belongs to a retired generation',
            );
        }
        if (callerSignal.aborted) {
            throw new Error(
                'Agent External Session takeover invocation was cancelled',
            );
        }
    };

    const serializedBytes = (value: unknown): number => {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new TypeError(
                'Agent External Session takeover result is not serializable',
            );
        }
        return encoder.encode(serialized).byteLength;
    };

    return Object.freeze({
        async resolveLaunch(input) {
            const request =
                validateAgentExternalSessionTakeoverResolveLaunchRequest(
                    input,
                );
            assertAdmissible(request.signal);
            const deadlineAtMs = Math.min(
                request.deadlineAtMs,
                Date.now() + policy.deadlineMs,
            );
            const maxSerializedBytes = Math.min(
                request.maxSerializedBytes,
                policy.maxEnvelopeUtf8Bytes,
            );
            const controller = new AbortController();
            let terminalReason:
                | 'cancelled'
                | 'retired'
                | 'timed-out'
                | null = null;
            let resolveTerminal!: () => void;
            const terminalPromise = new Promise<void>((resolve) => {
                resolveTerminal = resolve;
            });
            const terminalError = (): Error => {
                if (params.retirementSignal.aborted
                    || !params.isGenerationActive()) {
                    return new Error(
                        'Agent External Session takeover belongs to a retired generation',
                    );
                }
                if (request.signal.aborted) {
                    return new Error(
                        'Agent External Session takeover invocation was cancelled',
                    );
                }
                return new Error(
                    "Agent External Session takeover 'resolveLaunch' timed out",
                );
            };
            const terminate = (
                reason: NonNullable<typeof terminalReason>,
            ): void => {
                if (terminalReason !== null) return;
                terminalReason = reason;
                controller.abort(reason);
                resolveTerminal();
            };
            const cancel = () => terminate('cancelled');
            const retire = () => terminate('retired');
            request.signal.addEventListener('abort', cancel, { once: true });
            params.retirementSignal.addEventListener(
                'abort',
                retire,
                { once: true },
            );
            const remainingMs = deadlineAtMs - Date.now();
            let timeout: ReturnType<typeof setTimeout> | null = null;
            if (params.retirementSignal.aborted
                || !params.isGenerationActive()) {
                retire();
            } else if (request.signal.aborted) {
                cancel();
            } else if (remainingMs <= 0) {
                terminate('timed-out');
            } else {
                timeout = setTimeout(
                    () => terminate('timed-out'),
                    remainingMs,
                );
                timeout.unref?.();
            }

            try {
                if (terminalReason !== null) {
                    throw terminalError();
                }
                const boundedRequest =
                    validateAgentExternalSessionTakeoverResolveLaunchRequest(
                        Object.freeze({
                            ...request,
                            signal: controller.signal,
                            deadlineAtMs,
                            maxSerializedBytes,
                        }),
                    );
                const operation = Promise.resolve().then(() =>
                    params.contribution.resolveLaunch(boundedRequest));
                const rawResult = await Promise.race([
                    operation,
                    terminalPromise.then(() => {
                        throw terminalError();
                    }),
                ]);
                assertAdmissible(request.signal);
                const result =
                    validateAgentExternalSessionTakeoverResolveLaunchResult(
                        rawResult,
                    );
                if (serializedBytes(result) > maxSerializedBytes) {
                    throw new TypeError(
                        "Agent External Session takeover 'resolveLaunch' result exceeds its serialized-byte limit",
                    );
                }
                assertAdmissible(request.signal);
                return result;
            } finally {
                if (timeout) clearTimeout(timeout);
                request.signal.removeEventListener('abort', cancel);
                params.retirementSignal.removeEventListener('abort', retire);
            }
        },
    });
}

function createLease(params: Readonly<{
    pluginId: string;
    pluginVersion: string;
    agentId: string;
    localAgentId: string;
    generation: string;
    immutableGenerationId: string | null;
    startupInstructionsVersions?: readonly [1];
    registration: AgentContributionRuntimeRegistration;
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
    boundedExternalSessions?: AgentExternalSessionsContribution;
    boundedExternalSessionHooks?: GenerationBoundExternalSessionHooks;
    boundedExternalSessionObservation?: AgentExternalSessionObservationContribution;
    boundedExternalSessionTakeover?: GenerationBoundExternalSessionTakeover;
    createAgentInvocationServices?: CreateAgentInvocationServices;
}>): AgentRuntimeRegistrationLease {
    const assertCurrent = (): void => {
        if (!params.isGenerationActive()) {
            throw new Error(
                `Agent runtime '${params.agentId}' from plugin '${params.pluginId}' belongs to a retired generation`,
            );
        }
    };
    const externalSessions = params.boundedExternalSessions
        ?? (params.registration.externalSessions
            ? createBoundedAgentExternalSessionsContribution({
                contribution: params.registration.externalSessions,
                identity: {
                    pluginId: params.pluginId,
                    agentId: params.agentId,
                    generation: params.generation,
                },
                isCurrent: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
            })
            : undefined);
    const externalSessionObservation = params.boundedExternalSessionObservation
        ?? (params.registration.externalSessionObservation
            ? createGenerationBoundExternalSessionObservation({
                contribution: params.registration.externalSessionObservation,
                assertCurrent,
                isGenerationActive: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
            })
            : undefined);
    const externalSessionHooks = params.boundedExternalSessionHooks
        ?? (params.registration.externalSessionHooks
            ? createGenerationBoundExternalSessionHooks({
                contribution: params.registration.externalSessionHooks,
                createInvocationContext(signal) {
                    const plugin = Object.freeze({
                        id: params.pluginId,
                        version: params.pluginVersion,
                    });
                    const contribution = Object.freeze({
                        id: params.agentId,
                        qualifiedId: `${params.pluginId}/agents/${params.agentId}`,
                    });
                    const services = params.createAgentInvocationServices?.({
                        pluginId: params.pluginId,
                        pluginVersion: params.pluginVersion,
                        agentId: params.agentId,
                        generation: params.generation,
                        correlationId: randomUUID(),
                        cwd: process.cwd(),
                        providerBindingActive:
                            params.registration.providerBinding !== undefined,
                        signal,
                        isGenerationCurrent: params.isGenerationActive,
                    }) ?? createUnavailablePluginServices();
                    return Object.freeze({
                        plugin,
                        contribution,
                        surface: 'agent',
                        signal,
                        services,
                        ui: createPluginInvocationUi({
                            currentSession: null,
                            signal,
                            isGenerationCurrent: params.isGenerationActive,
                        }),
                    });
                },
                assertCurrent,
                isGenerationActive: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
            })
            : undefined);
    const externalSessionTakeover = params.boundedExternalSessionTakeover
        ?? (params.registration.externalSessionTakeover
            ? createGenerationBoundExternalSessionTakeover({
                contribution: params.registration.externalSessionTakeover,
                assertCurrent,
                isGenerationActive: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
            })
            : undefined);
    const common = Object.freeze({
        pluginId: params.pluginId,
        pluginVersion: params.pluginVersion,
        agentId: params.agentId,
        generation: params.generation,
        immutableGenerationId: params.immutableGenerationId,
        ...(params.startupInstructionsVersions
            ? { startupInstructionsVersions: params.startupInstructionsVersions }
            : {}),
        ...(externalSessions
            ? { externalSessions }
            : {}),
        ...(externalSessionHooks
            ? { externalSessionHooks }
            : {}),
        ...(externalSessionObservation
            ? { externalSessionObservation }
            : {}),
        ...(externalSessionTakeover
            ? { externalSessionTakeover }
            : {}),
        retirementSignal: params.retirementSignal,
        isCurrent: params.isGenerationActive,
    });
    if (!params.registration.factory) {
        return Object.freeze({
            ...common,
            hasPrimaryRuntime: false as const,
        });
    }
    const factory = params.registration.factory;
    return Object.freeze({
        ...common,
        hasPrimaryRuntime: true as const,
        ...(params.registration.providerBinding
            ? { providerBinding: params.registration.providerBinding }
            : {}),
        async createRuntime({ signal }) {
            assertCurrent();
            const context: AgentRuntimeFactoryContext = Object.freeze({
                plugin: Object.freeze({ id: params.pluginId, version: params.pluginVersion }),
                agent: Object.freeze({ id: params.localAgentId }),
                signal,
            });
            const runtime = await factory(context);
            assertCurrent();
            return assertValidAgentRuntime(runtime);
        },
    });
}

export function createTargetAgentRuntimeRegistry(params: Readonly<{
    agents: readonly Pick<
        ResolvedAgentContribution,
        'id' | 'identity' | 'pluginId' | 'richDefinition'
    >[];
    activationTargets: readonly ActivationTarget[];
    targetRegistrations: readonly TargetRegistration[];
    immutableGenerationIdsByPluginId?: ReadonlyMap<string, string>;
    isGenerationActive(): boolean;
    createAgentInvocationServices?: CreateAgentInvocationServices;
    onDuplicate(duplicate: AgentRuntimeOwnerDuplicate): void;
}> & AgentRuntimeRetirementOwner): ReadonlyMap<string, AgentRuntimeRegistrationLease> {
    const targetsByPluginId = new Map(
        params.activationTargets.map((target) => [target.pluginId, target] as const),
    );
    const selectedOwnerByAgentId = new Map(
        params.agents.flatMap((agent) => (
            agent.pluginId ? [[agent.id, agent.pluginId] as const] : []
        )),
    );
    const selectedAgentById = new Map(
        params.agents.map((agent) => [agent.id, agent] as const),
    );
    const selectedAgentIdByPluginAndLocalId = new Map<string, ReadonlyMap<string, string>>();
    for (const agent of params.agents) {
        const pluginId = agent.identity?.pluginId ?? agent.pluginId;
        if (!pluginId) {
            continue;
        }
        const localId = agent.identity?.localId ?? agent.id;
        const localIds = new Map(selectedAgentIdByPluginAndLocalId.get(pluginId));
        localIds.set(localId, agent.id);
        selectedAgentIdByPluginAndLocalId.set(pluginId, localIds);
    }
    const candidates = params.targetRegistrations
        .filter((entry): entry is TargetRegistration & Readonly<{
            registration: Extract<ContributionRuntimeRegistration, { family: 'agents' }>;
        }> => isAgentRegistration(entry.registration))
        .sort((left, right) => (
            left.pluginId.localeCompare(right.pluginId)
            || left.registration.localId.localeCompare(right.registration.localId)
        ));
    const registry = new Map<string, AgentRuntimeRegistrationLease>();

    for (const candidate of candidates) {
        const target = targetsByPluginId.get(candidate.pluginId);
        if (!target) {
            continue;
        }
        const agentId = selectedAgentIdByPluginAndLocalId
            .get(candidate.pluginId)
            ?.get(candidate.registration.localId)
            ?? candidate.registration.localId;
        const selectedPluginId = selectedOwnerByAgentId.get(agentId);
        if (selectedPluginId && selectedPluginId !== candidate.pluginId) {
            params.onDuplicate(Object.freeze({
                agentId,
                firstPluginId: selectedPluginId,
                secondPluginId: candidate.pluginId,
            }));
            continue;
        }
        const existing = registry.get(agentId);
        if (existing) {
            params.onDuplicate(Object.freeze({
                agentId,
                firstPluginId: existing.pluginId,
                secondPluginId: candidate.pluginId,
            }));
            continue;
        }
        const lifecycle = params.resolveGenerationLifecycle?.(candidate.pluginId);
        const startupInstructionsVersions = readStartupInstructionsVersions(
            selectedAgentById.get(agentId),
        );
        registry.set(agentId, createLease({
            pluginId: candidate.pluginId,
            pluginVersion: target.manifest.version,
            agentId,
            localAgentId: candidate.registration.localId,
            generation: candidate.generation,
            immutableGenerationId: params.immutableGenerationIdsByPluginId?.get(candidate.pluginId) ?? null,
            ...(startupInstructionsVersions
                ? { startupInstructionsVersions }
                : {}),
            registration: candidate.registration.value,
            isGenerationActive: lifecycle?.isCurrent ?? params.isGenerationActive,
            retirementSignal: requireAgentRuntimeRetirementSignal({
                agentId,
                ...(lifecycle
                    ? { lifecycleSignal: lifecycle.retirementSignal }
                    : {}),
                ...(params.retirementSignal
                    ? { registrySignal: params.retirementSignal }
                    : {}),
            }),
            ...(params.createAgentInvocationServices
                ? {
                    createAgentInvocationServices:
                        params.createAgentInvocationServices,
                }
                : {}),
        }));
    }
    return registry;
}

export function createDeclarativeAcpAgentRuntimeRegistry(params: Readonly<{
    agents: readonly ResolvedAgentContribution[];
    registered: ReadonlyMap<string, AgentRuntimeRegistrationLease>;
    generation: string;
    immutableGenerationIdsByPluginId?: ReadonlyMap<string, string>;
    isGenerationActive(): boolean;
}> & AgentRuntimeRetirementOwner): Map<string, AgentRuntimeRegistrationLease> {
    const registry = new Map(params.registered);
    const declarations = params.agents
        .flatMap((agent) => {
            const runtime = readAgentPrimaryRuntime(agent.richDefinition?.definition);
            return agent.provenance === 'external'
                && agent.pluginId
                && runtime?.kind === 'acp'
                ? [{ agent, pluginId: agent.pluginId, runtime }]
                : [];
        })
        .sort((left, right) => (
            left.pluginId.localeCompare(right.pluginId)
            || left.agent.id.localeCompare(right.agent.id)
        ));

    for (const declaration of declarations) {
        const lifecycle = params.resolveGenerationLifecycle?.(declaration.pluginId);
        const existing = registry.get(declaration.agent.id);
        if (existing?.hasPrimaryRuntime || (existing && existing.pluginId !== declaration.pluginId)) {
            throw new Error(
                `Declarative ACP Agent '${declaration.agent.id}' from plugin '${declaration.pluginId}' conflicts with runtime owner '${existing.pluginId}'`,
            );
        }
        const transport = declaration.runtime.transport;
        const registration: AgentContributionRuntimeRegistration = Object.freeze({
            factory: async () => Object.freeze({
                sessions: Object.freeze({
                    async open(request: AgentSessionOpenRequest, context: AgentSessionRuntimeContext) {
                        return await context.protocols.acp.open(request, { transport });
                    },
                }),
            }),
            ...(existing?.externalSessions ? { externalSessions: existing.externalSessions } : {}),
            ...(existing?.externalSessionHooks
                ? { externalSessionHooks: existing.externalSessionHooks }
                : {}),
            ...(existing?.externalSessionObservation
                ? { externalSessionObservation: existing.externalSessionObservation }
                : {}),
            ...(existing?.externalSessionTakeover
                ? { externalSessionTakeover: existing.externalSessionTakeover }
                : {}),
        });
        registry.set(declaration.agent.id, createLease({
            pluginId: declaration.pluginId,
            pluginVersion: existing?.pluginVersion
                ?? declaration.agent.sourceSpec?.resolvedVersion
                ?? '0.0.0',
            agentId: declaration.agent.id,
            localAgentId: declaration.agent.identity?.localId ?? declaration.agent.id,
            generation: existing?.generation ?? params.generation,
            immutableGenerationId: existing?.immutableGenerationId
                ?? params.immutableGenerationIdsByPluginId?.get(declaration.pluginId)
                ?? null,
            ...(readStartupInstructionsVersions(declaration.agent)
                ? { startupInstructionsVersions: [1] as const }
                : {}),
            registration,
            isGenerationActive: existing
                ? () => existing.isCurrent() && (lifecycle?.isCurrent() ?? params.isGenerationActive())
                : lifecycle?.isCurrent ?? params.isGenerationActive,
            retirementSignal: existing?.retirementSignal
                ?? requireAgentRuntimeRetirementSignal({
                    agentId: declaration.agent.id,
                    ...(lifecycle
                        ? { lifecycleSignal: lifecycle.retirementSignal }
                        : {}),
                    ...(params.retirementSignal
                        ? { registrySignal: params.retirementSignal }
                        : {}),
                }),
            ...(existing?.externalSessions
                ? { boundedExternalSessions: existing.externalSessions }
                : {}),
            ...(existing?.externalSessionHooks
                ? { boundedExternalSessionHooks: existing.externalSessionHooks }
                : {}),
            ...(existing?.externalSessionObservation
                ? { boundedExternalSessionObservation: existing.externalSessionObservation }
                : {}),
            ...(existing?.externalSessionTakeover
                ? { boundedExternalSessionTakeover: existing.externalSessionTakeover }
                : {}),
        }));
    }
    return registry;
}
