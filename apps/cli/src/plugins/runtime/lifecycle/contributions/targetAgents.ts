import { randomUUID } from 'node:crypto';

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    AgentDaemonSpawnHooks,
    AgentDaemonSpawnRuntimeSelectionV1,
    AgentProviderBindingAdapter,
    AgentRuntime,
    AgentRuntimeFactoryContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS,
    validateAgentExternalSessionHookMapEventRequest,
    validateAgentExternalSessionHookMapEventResult,
    validateAgentExternalSessionHookResolveInstallationRequest,
    validateAgentExternalSessionHookResolveInstallationResult,
    type AgentExternalSessionHookMapEventRequest,
    type AgentExternalSessionHookResolveInstallationRequest,
    type AgentExternalSessionHooksContribution,
    type AgentExternalSessionObservationContribution,
    type AgentExternalSessionObservationObserveResourceRequest,
    type AgentExternalSessionObservationReconcileResourceRequest,
    type AgentExternalSessionsContribution,
    type AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS,
    validateAgentExternalSessionTakeoverResolveLaunchRequest,
    validateAgentExternalSessionTakeoverResolveLaunchResult,
    type AgentExternalSessionSource,
    type AgentExternalSessionTakeoverContribution,
    type AgentExternalSessionTakeoverLaunchPlan,
    type AgentExternalSessionTakeoverResolveLaunchRequest,
    type AgentExternalSessionTakeoverResolveLaunchResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    ExternalAgentObservationLinkEvidenceBatchV1Schema,
    ExternalAgentObservationLinkKeyV1Schema,
    ExternalAgentObservationReconcileRequestV1Schema,
    ExternalAgentObservationReconcileResultV1Schema,
    ExternalAgentObservationResourceGroupingV1Schema,
    ExternalAgentObservationResourceKeyV1Schema,
} from '@happier-dev/protocol';
import { logExternalSessionsInternalError } from '@/session/actions/externalSessions/responseErrors';
import { readValidatedAgentSessionRunnerFactory } from '../../api/registrationRightsHost';
import {
    createAgentSessionRunnerFactoryBinding,
    createHostDeclarativeAcpRunnerBinding,
    type AgentSessionRunnerBindingV1,
} from '../../runner/agentSessionRunnerFactoryBinding';
import {
    createHostDeclarativeAcpAgentRuntimeFactory,
} from '../../runner/createHostDeclarativeAcpAgentRuntimeFactory';
import type { ResolvedAgentContribution } from '../../../projection/registry/types';
import {
    indexAgentRoutingIdsByContributionIdentity,
    readAgentRoutingIdForContributionIdentity,
} from '../../../projection/registry/agentRoutingIdentity';
import {
    readAgentPrimaryRuntime,
    readAgentSessionCapabilities,
} from '../../../projection/registry/agentContributionDefinition';

import type {
    AgentContributionRuntimeRegistration,
    ContributionRuntimeRegistration,
} from '../../api/registrationRightsHost';
import { isAgentRuntimeGenerationCurrent } from './agentGenerationCurrentness';
import type { ActivationTarget } from '../activation/targets';
import { runWithOptionalTimeout } from '../utils';
import {
    bindAgentExternalSessionsManagedEndpointRead,
    createBoundedAgentExternalSessionsContribution,
    createUnavailableAgentExternalSessionsManagedEndpointRead,
    EXTERNAL_SESSIONS_INVOCATION_POLICY,
} from '../../../../session/external/agentExternalSessionsInvocation';
import type { AgentExternalSessionsManagedEndpointReadHost } from '../../../../session/external/agentExternalSessionsInvocation';
import type { BoundedAgentExternalSessionsContribution } from '../../../../session/external/agentExternalSessionsInvocation';
import {
    createContributionOwnedManagedServiceEndpointReadHost,
} from '../../../../session/external/contributionOwnedManagedServiceEndpointRead';
import { createPluginInvocationPresentation } from '../../invocation/services/interactions';
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
    ): Promise<GenerationBoundExternalSessionTakeoverResolveLaunchResult>;
}>;

/**
 * The public SDK result remains strict. This one host-private field is
 * admitted only at the generation-bound callback seam, then carried through
 * the daemon-owned spawn and respawn path that owns its use.
 */
type GenerationBoundExternalSessionTakeoverResolveLaunchResult =
    | Extract<AgentExternalSessionTakeoverResolveLaunchResult, { ok: false }>
    | Readonly<{
        ok: true;
        value: AgentExternalSessionTakeoverLaunchPlan;
        nativeResumeReference?: string;
    }>;

const HOST_PRIVATE_NATIVE_RESUME_REFERENCE_KEY = 'nativeResumeReference';

function extractHostPrivateNativeResumeReference(rawResult: unknown): Readonly<{
    publicResult: unknown;
    nativeResumeReference?: string;
}> {
    if (rawResult === null
        || typeof rawResult !== 'object'
        || Array.isArray(rawResult)) {
        return { publicResult: rawResult };
    }

    const descriptor = Object.getOwnPropertyDescriptor(
        rawResult,
        HOST_PRIVATE_NATIVE_RESUME_REFERENCE_KEY,
    );
    if (!descriptor) {
        return { publicResult: rawResult };
    }
    if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(
            'Agent External Session takeover native resume reference must be an enumerable data property',
        );
    }
    const nativeResumeReference = descriptor.value;
    if (typeof nativeResumeReference !== 'string'
        || nativeResumeReference.length === 0
        || nativeResumeReference.length
            > AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxDirectoryCodeUnits) {
        throw new TypeError(
            'Agent External Session takeover native resume reference must contain 1-10000 code units',
        );
    }

    const publicResult = Object.create(Object.getPrototypeOf(rawResult));
    for (const key of Reflect.ownKeys(rawResult)) {
        if (key === HOST_PRIVATE_NATIVE_RESUME_REFERENCE_KEY) continue;
        const property = Object.getOwnPropertyDescriptor(rawResult, key);
        if (property) Object.defineProperty(publicResult, key, property);
    }
    return { publicResult, nativeResumeReference };
}

export type GenerationBoundExternalSessionObservation = Readonly<{
    describeResource:
        AgentExternalSessionObservationContribution['describeResource'];
    observeResource(
        request: Omit<
            AgentExternalSessionObservationObserveResourceRequest,
            'managedEndpointRead'
        > & Readonly<{ managedEndpointSource?: AgentExternalSessionSource }>,
    ): ReturnType<AgentExternalSessionObservationContribution['observeResource']>;
    reconcileResource(
        request: Omit<
            AgentExternalSessionObservationReconcileResourceRequest,
            'managedEndpointRead'
        >,
    ): ReturnType<AgentExternalSessionObservationContribution['reconcileResource']>;
}>;

type AgentRuntimeRegistrationLeaseBase = Readonly<{
    pluginId: string;
    pluginVersion: string;
    /** Host routing id. Qualified for an installed Agent. */
    agentId: string;
    /**
     * The Agent's own manifest-local id. Plugin-contribution identities —
     * invocation seeds, custody keys, qualified contribution ids — are always
     * `{pluginId, localId}`, never the host routing id.
     */
    localAgentId: string;
    generation: string;
    immutableGenerationId?: string | null;
    startupInstructionsVersions?: readonly [1];
    externalSessions?: BoundedAgentExternalSessionsContribution;
    externalSessionHooks?: GenerationBoundExternalSessionHooks;
    externalSessionObservation?: GenerationBoundExternalSessionObservation;
    externalSessionTakeover?: GenerationBoundExternalSessionTakeover;
    daemonSpawnHooks?: AgentDaemonSpawnHooks;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    createAgentRuntimeSurfaceInvocationContext(params: Readonly<{
        cwd: string;
        /** Explicit Happier Session identity; vendor identities must not populate this field. */
        happierSessionId?: string;
    }>): Promise<PluginInvocationContext>;
}>;

export type AgentRuntimeRegistrationLease =
    | (AgentRuntimeRegistrationLeaseBase & Readonly<{
        hasPrimaryRuntime: true;
        providerBinding?: AgentProviderBindingAdapter;
        sessionRunnerFactoryBinding?: AgentSessionRunnerBindingV1;
        createRuntime(params: Readonly<{ signal: AbortSignal }>): Promise<AgentRuntime>;
    }>)
    | (AgentRuntimeRegistrationLeaseBase & Readonly<{
        hasPrimaryRuntime: false;
        providerBinding?: undefined;
        sessionRunnerFactoryBinding?: undefined;
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

function readGenerationBoundDaemonSpawnHookFailure(params: Readonly<{
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
    signal: AbortSignal;
}>): Readonly<{ ok: false; reasonCode: string; errorMessage: string }> | null {
    if (!isAgentRuntimeGenerationCurrent({
        isCurrent: params.isGenerationActive,
        retirementSignal: params.retirementSignal,
    })) {
        return Object.freeze({
            ok: false,
            reasonCode: 'plugin_generation_stale',
            errorMessage: 'Agent daemon spawn hook is unavailable because its plugin generation is no longer current.',
        });
    }
    if (params.signal.aborted) {
        return Object.freeze({
            ok: false,
            reasonCode: 'plugin_spawn_hook_aborted',
            errorMessage: 'Agent daemon spawn prerequisite hook was cancelled.',
        });
    }
    return null;
}

function bindDaemonSpawnHookSelection(params: Readonly<{
    selection: AgentDaemonSpawnRuntimeSelectionV1;
    retirementSignal: AbortSignal;
}>): Readonly<{
    selection: AgentDaemonSpawnRuntimeSelectionV1;
    signal: AbortSignal;
}> {
    const callerSignal = params.selection.tools?.signal;
    const signal = callerSignal
        ? AbortSignal.any([callerSignal, params.retirementSignal])
        : params.retirementSignal;
    return Object.freeze({
        signal,
        selection: Object.freeze({
            ...params.selection,
            ...(params.selection.tools
                ? {
                    tools: Object.freeze({
                        ...params.selection.tools,
                        signal,
                    }),
                }
                : {}),
        }),
    });
}

function readDaemonSpawnHookEnvironment(
    value: unknown,
): Readonly<Record<string, string>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    try {
        const entries = Object.entries(value);
        if (entries.some(([, entry]) => typeof entry !== 'string')) return null;
        return Object.freeze(Object.fromEntries(entries));
    } catch {
        return null;
    }
}

function isDaemonSpawnValidationResult(
    value: unknown,
): value is Awaited<ReturnType<NonNullable<
    AgentDaemonSpawnHooks['resolveRuntimePrerequisites']
>>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const result = value as Readonly<Record<string, unknown>>;
    if (result.ok === true) return true;
    return result.ok === false
        && typeof result.errorMessage === 'string'
        && result.errorMessage.trim().length > 0
        && (result.reasonCode === undefined || typeof result.reasonCode === 'string');
}

function createGenerationBoundAgentDaemonSpawnHooks(params: Readonly<{
    contribution: AgentDaemonSpawnHooks;
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
}>): AgentDaemonSpawnHooks {
    const resolveRuntimePrerequisites = params.contribution.resolveRuntimePrerequisites
        ? async (selection: AgentDaemonSpawnRuntimeSelectionV1) => {
            const bound = bindDaemonSpawnHookSelection({
                selection,
                retirementSignal: params.retirementSignal,
            });
            const unavailableBefore = readGenerationBoundDaemonSpawnHookFailure({
                isGenerationActive: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
                signal: bound.signal,
            });
            if (unavailableBefore) return unavailableBefore;
            try {
                const result = await params.contribution.resolveRuntimePrerequisites!(
                    bound.selection,
                );
                const unavailableAfter = readGenerationBoundDaemonSpawnHookFailure({
                    isGenerationActive: params.isGenerationActive,
                    retirementSignal: params.retirementSignal,
                    signal: bound.signal,
                });
                if (unavailableAfter) return unavailableAfter;
                if (isDaemonSpawnValidationResult(result)) return result;
            } catch {
                const unavailableAfter = readGenerationBoundDaemonSpawnHookFailure({
                    isGenerationActive: params.isGenerationActive,
                    retirementSignal: params.retirementSignal,
                    signal: bound.signal,
                });
                if (unavailableAfter) return unavailableAfter;
            }
            return Object.freeze({
                ok: false,
                reasonCode: 'plugin_spawn_hook_failed',
                errorMessage: 'Agent daemon spawn prerequisite hook failed.',
            });
        }
        : undefined;
    const augmentEnv = params.contribution.augmentEnv
        ? (selection: AgentDaemonSpawnRuntimeSelectionV1) => {
            const bound = bindDaemonSpawnHookSelection({
                selection,
                retirementSignal: params.retirementSignal,
            });
            if (readGenerationBoundDaemonSpawnHookFailure({
                isGenerationActive: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
                signal: bound.signal,
            })) {
                return {};
            }
            try {
                const environment = readDaemonSpawnHookEnvironment(
                    params.contribution.augmentEnv!(bound.selection),
                );
                if (!environment || readGenerationBoundDaemonSpawnHookFailure({
                    isGenerationActive: params.isGenerationActive,
                    retirementSignal: params.retirementSignal,
                    signal: bound.signal,
                })) {
                    return {};
                }
                return environment;
            } catch {
                return {};
            }
        }
        : undefined;
    return Object.freeze({
        ...(resolveRuntimePrerequisites ? { resolveRuntimePrerequisites } : {}),
        ...(augmentEnv ? { augmentEnv } : {}),
    });
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
    identity: Readonly<{
        pluginId: string;
        agentId: string;
        generation: string;
        contributionQualifiedId: string;
        immutableGenerationId: string | null;
    }>;
    assertCurrent(): void;
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
    managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
}>): GenerationBoundExternalSessionObservation {
    const bindManagedEndpointRead = async (
        source: Parameters<typeof bindAgentExternalSessionsManagedEndpointRead>[0]['source']
            | undefined,
        signal: AbortSignal,
        maxResponseBytes?: number,
    ): Promise<AgentExternalSessionsManagedEndpointRead> => {
        if (!source) {
            return createUnavailableAgentExternalSessionsManagedEndpointRead();
        }
        return await bindAgentExternalSessionsManagedEndpointRead({
            identity: params.identity,
            source,
            signal,
            isCurrent: params.isGenerationActive,
            retirementSignal: params.retirementSignal,
            host: params.managedEndpointRead,
            maxResponseBytes,
        });
    };
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
                abort('disposed');
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
            request: Parameters<
                GenerationBoundExternalSessionObservation['observeResource']
            >[0],
        ) {
            assertAdmissible(request.signal);
            const resourceKey = ExternalAgentObservationResourceKeyV1Schema.parse(
                request.resourceKey,
            );
            const composed = composeSignal(request.signal);
            let managedEndpointRead: AgentExternalSessionsManagedEndpointRead;
            try {
                managedEndpointRead = await Promise.race([
                    bindManagedEndpointRead(
                        request.managedEndpointSource,
                        composed.signal,
                    ),
                    composed.terminalPromise.then(() => {
                        throw terminalError(request.signal, composed);
                    }),
                ]);
                if (composed.signal.aborted) {
                    throw terminalError(request.signal, composed);
                }
                assertAdmissible(request.signal);
            } catch (error) {
                composed.cleanup();
                throw terminalError(request.signal, composed, error);
            }
            let acquired: Awaited<
                ReturnType<AgentExternalSessionObservationContribution['observeResource']>
            > | undefined;
            let disposalPromise: Promise<void> | undefined;
            let boundedDisposalPromise: Promise<void> | undefined;
            let disposalStarted = false;
            const disposeOnce = (): Promise<void> => {
                if (disposalPromise) return disposalPromise;
                if (!acquired) return Promise.resolve();
                if (disposalStarted) return Promise.resolve();
                disposalStarted = true;
                let attempt: Promise<void>;
                try {
                    attempt = Promise.resolve(acquired.dispose());
                } catch (error) {
                    attempt = Promise.reject(error);
                }
                disposalPromise = attempt;
                // A rejected physical disposal is retryable at its owner: the
                // observation reconciler keeps an observer whose disposal failed and
                // retries the exact same cleanup. Caching the rejection would make
                // that cleanup permanently unreachable, so release it instead. A
                // disposal that is merely slow stays cached — the retry then awaits
                // the one physical call rather than starting a second one.
                void attempt.catch(() => {
                    if (disposalPromise !== attempt) return;
                    disposalPromise = undefined;
                    disposalStarted = false;
                });
                return attempt;
            };
            const disposeWithinObservationDeadline = (): Promise<void> => {
                if (!acquired) return Promise.resolve();
                if (boundedDisposalPromise) return boundedDisposalPromise;

                const timeoutError = new Error(
                    `Agent External Session observation cleanup timed out after ${EXTERNAL_SESSION_OBSERVATION_POLICY.deadlineMs}ms`,
                );
                // Publish the promise before starting the plugin callback so
                // re-entrant cancellation still shares one physical disposal
                // and one deadline/reporting path.
                let resolveBoundedDisposal!: () => void;
                let rejectBoundedDisposal!: (reason: unknown) => void;
                const boundedAttempt = new Promise<void>((resolve, reject) => {
                    resolveBoundedDisposal = resolve;
                    rejectBoundedDisposal = reject;
                });
                boundedDisposalPromise = boundedAttempt;
                void runWithOptionalTimeout(
                    EXTERNAL_SESSION_OBSERVATION_POLICY.deadlineMs,
                    disposeOnce,
                    () => timeoutError,
                )
                    .then(
                        () => resolveBoundedDisposal(),
                        (error: unknown) => {
                            logExternalSessionsInternalError(
                                'external_session.observation_physical_dispose',
                                error,
                            );
                            // Unfinished cleanup keeps its custody: release the cached
                            // bounded attempt so the next owned retirement re-arms a
                            // deadline over the same physical disposal instead of
                            // replaying a settled rejection forever.
                            if (boundedDisposalPromise === boundedAttempt) {
                                boundedDisposalPromise = undefined;
                            }
                            rejectBoundedDisposal(
                                error === timeoutError
                                    ? timeoutError
                                    : new Error('Agent External Session observation cleanup failed'),
                            );
                        },
                    );
                return boundedAttempt;
            };
            const disposeOnAbort = () => {
                void disposeWithinObservationDeadline().catch(() => undefined);
            };
            composed.signal.addEventListener('abort', disposeOnAbort, { once: true });
            let rawAcquisition: ReturnType<
                AgentExternalSessionObservationContribution['observeResource']
            >;
            try {
                rawAcquisition = params.contribution.observeResource(Object.freeze({
                    resourceKey,
                    signal: composed.signal,
                    managedEndpointRead,
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
                    await disposeWithinObservationDeadline().catch(() => undefined);
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
                            await disposeWithinObservationDeadline();
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
            request: Parameters<
                GenerationBoundExternalSessionObservation['reconcileResource']
            >[0],
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
                const managedEndpointRead = await Promise.race([
                    bindManagedEndpointRead(
                        links[0]?.linkedSource.source,
                        composed.signal,
                        EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveLinkedIdentity
                            .maxSerializedBytes,
                    ),
                    composed.terminalPromise.then(() => {
                        throw terminalError(request.signal, composed);
                    }),
                ]);
                if (composed.signal.aborted) {
                    throw terminalError(request.signal, composed);
                }
                assertAdmissible(request.signal);
                const operation = Promise.resolve(
                    params.contribution.reconcileResource(Object.freeze({
                        purpose: reconciliation.purpose,
                        resourceKey,
                        links,
                        signal: composed.signal,
                        managedEndpointRead,
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
    createInvocationContext(
        signal: AbortSignal,
    ): Promise<PluginInvocationContext>;
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
            operation: async (boundedRequest) =>
                await params.contribution.resolveInstallation(
                    boundedRequest,
                    await params.createInvocationContext(
                        boundedRequest.signal,
                    ),
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
                const privateCarrier =
                    extractHostPrivateNativeResumeReference(rawResult);
                const result =
                    validateAgentExternalSessionTakeoverResolveLaunchResult(
                        privateCarrier.publicResult,
                    );
                if (serializedBytes(rawResult) > maxSerializedBytes) {
                    throw new TypeError(
                        "Agent External Session takeover 'resolveLaunch' result exceeds its serialized-byte limit",
                    );
                }
                assertAdmissible(request.signal);
                if (privateCarrier.nativeResumeReference !== undefined) {
                    if (!result.ok) {
                        throw new TypeError(
                            'Agent External Session takeover native resume reference requires a successful launch result',
                        );
                    }
                    return Object.freeze({
                        ...result,
                        nativeResumeReference:
                            privateCarrier.nativeResumeReference,
                    });
                }
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
    runnerBinding?: AgentSessionRunnerBindingV1;
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
    boundedExternalSessions?: BoundedAgentExternalSessionsContribution;
    boundedExternalSessionHooks?: GenerationBoundExternalSessionHooks;
    boundedExternalSessionObservation?: GenerationBoundExternalSessionObservation;
    boundedExternalSessionTakeover?: GenerationBoundExternalSessionTakeover;
    boundedDaemonSpawnHooks?: AgentDaemonSpawnHooks;
    createAgentInvocationServices?: CreateAgentInvocationServices;
    managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
}>): AgentRuntimeRegistrationLease {
    const assertCurrent = (): void => {
        if (!params.isGenerationActive()) {
            throw new Error(
                `Agent runtime '${params.agentId}' from plugin '${params.pluginId}' belongs to a retired generation`,
            );
        }
    };
    const createInvocationServices = async (
        signal: AbortSignal,
        cwd = process.cwd(),
    ) => (
        await params.createAgentInvocationServices?.({
            pluginId: params.pluginId,
            pluginVersion: params.pluginVersion,
            agentId: params.agentId,
            generation: params.generation,
            correlationId: randomUUID(),
            cwd,
            providerBindingActive:
                params.registration.providerBinding !== undefined,
            signal,
            isGenerationCurrent: params.isGenerationActive,
        })
        ?? createUnavailablePluginServices()
    );
    const createInvocationContext = async (input: Readonly<{
        signal: AbortSignal;
        cwd: string;
        happierSessionId?: string;
    }>): Promise<PluginInvocationContext> => {
        assertCurrent();
        if (input.signal.aborted) {
            throw input.signal.reason instanceof Error
                ? input.signal.reason
                : new Error(`Agent runtime '${params.agentId}' operation was cancelled`);
        }
        const plugin = Object.freeze({
            id: params.pluginId,
            version: params.pluginVersion,
        });
        const contribution = Object.freeze({
            id: params.localAgentId,
            qualifiedId: `${params.pluginId}/agents/${params.localAgentId}`,
        });
        const services = await createInvocationServices(input.signal, input.cwd);
        assertCurrent();
        return Object.freeze({
            plugin,
            contribution,
            surface: 'agent',
            ...(input.happierSessionId ? { session: Object.freeze({ id: input.happierSessionId }) } : {}),
            signal: input.signal,
            services,
            ui: createPluginInvocationPresentation({
                currentSession: null,
                signal: input.signal,
                isGenerationCurrent: params.isGenerationActive,
            }),
        });
    };
    /**
     * A contribution that declares its own managed endpoint service owns the
     * endpoint for every auxiliary read of its sources: acquisition is active
     * and daemon-held, so the read no longer depends on a Session runner being
     * alive. Contributions that declare none keep the Session-runner endpoint
     * host unchanged. Exactly one of the two is in effect for a contribution,
     * so no second endpoint authority is created.
     */
    const contributionOwnedManagedEndpointRead =
        params.registration.externalSessions && params.createAgentInvocationServices
            ? createContributionOwnedManagedServiceEndpointReadHost({
                contribution: params.registration.externalSessions,
                identity: {
                    pluginId: params.pluginId,
                    pluginVersion: params.pluginVersion,
                    agentId: params.agentId,
                    generation: params.generation,
                },
                createAgentInvocationServices: params.createAgentInvocationServices,
                cwd: process.cwd(),
                isGenerationActive: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
            })
            : null;
    const managedEndpointRead = contributionOwnedManagedEndpointRead?.demand
        ?? params.managedEndpointRead;
    const externalSessions = params.boundedExternalSessions
        ?? (params.registration.externalSessions
            ? createBoundedAgentExternalSessionsContribution({
                contribution: params.registration.externalSessions,
                identity: {
                    pluginId: params.pluginId,
                    agentId: params.agentId,
                    generation: params.generation,
                    contributionQualifiedId:
                        `${params.pluginId}/agents/${encodeURIComponent(params.localAgentId)}`,
                    immutableGenerationId: params.immutableGenerationId,
                },
                isCurrent: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
                createInvocationExec: async (signal) => (
                    (await createInvocationServices(signal)).exec
                ),
                ...(managedEndpointRead
                    ? { managedEndpointRead }
                    : {}),
            })
            : undefined);
    /**
     * Observation is passive: it runs from persisted policy, with no user
     * asking for anything. Supervising the contribution's *spawn* declaration
     * is active — it starts and retains a process until the generation
     * retires — so observation must not reach that shape. Attaching to a
     * server the user already runs starts nothing, so following one stays
     * available here through the same owner. When the contribution declares an
     * owned spawn for the source, observation falls back to the Session-runner
     * endpoint host, which reads a server a runner already started, and to a
     * typed unavailable read when there is none.
     */
    const observationManagedEndpointRead: AgentExternalSessionsManagedEndpointReadHost | undefined =
        contributionOwnedManagedEndpointRead
            ? async (input) => (
                await contributionOwnedManagedEndpointRead.attachedOnly(input)
                    ?? await (
                        params.managedEndpointRead?.(input)
                        ?? createUnavailableAgentExternalSessionsManagedEndpointRead()
                    )
            )
            : params.managedEndpointRead;
    const externalSessionObservation = params.boundedExternalSessionObservation
        ?? (params.registration.externalSessionObservation
            ? createGenerationBoundExternalSessionObservation({
                contribution: params.registration.externalSessionObservation,
                identity: {
                    pluginId: params.pluginId,
                    agentId: params.agentId,
                    generation: params.generation,
                    contributionQualifiedId:
                        `${params.pluginId}/agents/${encodeURIComponent(params.localAgentId)}`,
                    immutableGenerationId: params.immutableGenerationId,
                },
                assertCurrent,
                isGenerationActive: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
                ...(observationManagedEndpointRead
                    ? { managedEndpointRead: observationManagedEndpointRead }
                    : {}),
            })
            : undefined);
    const externalSessionHooks = params.boundedExternalSessionHooks
        ?? (params.registration.externalSessionHooks
            ? createGenerationBoundExternalSessionHooks({
                contribution: params.registration.externalSessionHooks,
                async createInvocationContext(signal) {
                    return await createInvocationContext({
                        signal,
                        cwd: process.cwd(),
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
    const daemonSpawnHooks = params.boundedDaemonSpawnHooks
        ?? (params.registration.daemonSpawnHooks
            ? createGenerationBoundAgentDaemonSpawnHooks({
                contribution: params.registration.daemonSpawnHooks,
                isGenerationActive: params.isGenerationActive,
                retirementSignal: params.retirementSignal,
            })
            : undefined);
    const common = Object.freeze({
        pluginId: params.pluginId,
        pluginVersion: params.pluginVersion,
        agentId: params.agentId,
        localAgentId: params.localAgentId,
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
        ...(daemonSpawnHooks
            ? { daemonSpawnHooks }
            : {}),
        retirementSignal: params.retirementSignal,
        isCurrent: params.isGenerationActive,
        createAgentRuntimeSurfaceInvocationContext: async (
            { cwd, happierSessionId }: Parameters<
                AgentRuntimeRegistrationLeaseBase['createAgentRuntimeSurfaceInvocationContext']
            >[0],
        ) =>
            await createInvocationContext({
                signal: params.retirementSignal,
                cwd,
                ...(happierSessionId ? { happierSessionId } : {}),
            }),
    });
    if (!params.registration.factory) {
        return Object.freeze({
            ...common,
            hasPrimaryRuntime: false as const,
        });
    }
    const factory = params.registration.factory;
    const validatedSessionRunnerFactory = readValidatedAgentSessionRunnerFactory(
        params.registration,
    );
    if (params.registration.sessionRunnerFactory && !validatedSessionRunnerFactory) {
        throw new Error(
            `Agent runtime '${params.agentId}' has an unvalidated session runner factory locator`,
        );
    }
    if (params.runnerBinding && validatedSessionRunnerFactory) {
        throw new Error(
            `Agent runtime '${params.agentId}' has competing runner binding owners`,
        );
    }
    const sessionRunnerFactoryBinding = params.runnerBinding
        ?? (validatedSessionRunnerFactory
        && params.immutableGenerationId
        ? createAgentSessionRunnerFactoryBinding({
            v: 1,
            pluginId: params.pluginId,
            pluginVersion: params.pluginVersion,
            agentId: params.agentId,
            localAgentId: params.localAgentId,
            immutableGenerationId: params.immutableGenerationId,
            locator: validatedSessionRunnerFactory.locator,
            normalizedModulePath: validatedSessionRunnerFactory.normalizedModulePath,
            loadMode: validatedSessionRunnerFactory.loadMode,
        })
        : undefined);
    return Object.freeze({
        ...common,
        hasPrimaryRuntime: true as const,
        ...(params.registration.providerBinding
            ? { providerBinding: params.registration.providerBinding }
            : {}),
        ...(sessionRunnerFactoryBinding
            ? { sessionRunnerFactoryBinding }
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
    managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
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
    const selectedAgentIdByIdentity = indexAgentRoutingIdsByContributionIdentity(params.agents);
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
        const agentId = readAgentRoutingIdForContributionIdentity(selectedAgentIdByIdentity, {
            pluginId: candidate.pluginId,
            localId: candidate.registration.localId,
        }) ?? candidate.registration.localId;
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
            ...(params.managedEndpointRead
                ? { managedEndpointRead: params.managedEndpointRead }
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
            return agent.pluginId
                && runtime?.kind === 'acp'
                && readAgentSessionCapabilities(
                    agent.richDefinition?.definition,
                )
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
            factory: createHostDeclarativeAcpAgentRuntimeFactory(transport),
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
        const pluginVersion = existing?.pluginVersion
            ?? declaration.agent.sourceSpec?.resolvedVersion
            ?? null;
        const localAgentId = declaration.agent.identity?.localId
            ?? declaration.agent.id;
        const immutableGenerationId = existing?.immutableGenerationId
            ?? params.immutableGenerationIdsByPluginId?.get(
                declaration.pluginId,
            )
            ?? null;
        const runnerBinding = pluginVersion
            && immutableGenerationId
            ? createHostDeclarativeAcpRunnerBinding({
                kind: 'host_declarative_acp_v1',
                v: 1,
                pluginId: declaration.pluginId,
                pluginVersion,
                agentId: declaration.agent.id,
                qualifiedAgentId:
                    `${declaration.pluginId}/agents/${localAgentId}`,
                localAgentId,
                immutableGenerationId,
            })
            : undefined;
        registry.set(declaration.agent.id, createLease({
            pluginId: declaration.pluginId,
            pluginVersion: pluginVersion ?? '0.0.0',
            agentId: declaration.agent.id,
            localAgentId,
            generation: existing?.generation ?? params.generation,
            immutableGenerationId,
            ...(readStartupInstructionsVersions(declaration.agent)
                ? { startupInstructionsVersions: [1] as const }
                : {}),
            registration,
            ...(runnerBinding ? { runnerBinding } : {}),
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
            ...(existing?.daemonSpawnHooks
                ? { boundedDaemonSpawnHooks: existing.daemonSpawnHooks }
                : {}),
        }));
    }
    return registry;
}
