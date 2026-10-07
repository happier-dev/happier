import { randomUUID } from 'node:crypto';

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    AgentCliAuthContributionV1,
    AgentCliSessionCommandDeclarationV1,
    AgentConnectedAccountLaunchContributionV1,
    AgentDaemonSpawnHooks,
    AgentDaemonSpawnRuntimeSelectionV1,
    AgentExperimentalVendorResumeSupportContributionV1,
    AgentPreflightSessionControlsContributionV1,
    AgentProviderCliAttachDeclarationV1,
    AgentProviderBindingAdapter,
    AgentRuntime,
    AgentRuntimeFactoryContext,
    AgentSessionStartupContributionV1,
    AgentTerminalSurface,
    AgentTerminalPromptSubmitVerificationPolicyV1,
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
    type AgentExternalSessionsResult,
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
import { ExternalAgentObservationLinkEvidenceBatchV1Schema, ExternalAgentObservationLinkKeyV1Schema, ExternalAgentObservationReconcileRequestV1Schema, ExternalAgentObservationReconcileResultV1Schema, ExternalAgentObservationResourceGroupingV1Schema, ExternalAgentObservationResourceKeyV1Schema } from '@happier-dev/protocol/sessions/external/externalAgentObservationV1';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { declaresHostSynthesizedAgentResumeOnlyExternalSources } from '@happier-dev/protocol/plugins/contributions/agent-resume-only-sources';
import { logExternalSessionsInternalError } from '@/session/actions/externalSessions/responseErrors';
import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';
import { readValidatedAgentSessionRunnerFactory } from '../../api/registrationRightsHost';
import { readRetainedBundledAgentFactory } from '../../retainedBundledAgentFactory';
import {
    createAgentSessionRunnerFactoryBinding,
    createHostDeclarativeAcpRunnerBinding,
    type AgentSessionRunnerBindingV1,
} from '../../runner/agentSessionRunnerFactoryBinding';
import {
    createHostDeclarativeAcpAgentRuntimeFactory,
} from '../../runner/createHostDeclarativeAcpAgentRuntimeFactory';
import {
    normalizePluginDeclarativeAcpRuntime,
} from '@/agent/acp/runtime/definition/plugin';
import {
    createAcpSessionListingOwner,
    type AcpSessionListingOwner,
} from '@/agent/acp/runtime/sessionListing/createAcpSessionListingContribution';
import type { ResolvedAgentContribution } from '../../../projection/registry/types';
import type { CanonicalPluginManifest } from '../../../manifest/types';
import {
    indexAgentRoutingIdsByContributionIdentity,
    readAgentRoutingIdForContributionIdentity,
    resolveAgentContributionQualifiedId,
} from '../../../projection/registry/agentRoutingIdentity';
import {
    isPrimaryAgentContributionDefinition,
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
    armExternalSessionsDeadline,
    bindAgentExternalSessionsManagedEndpointRead,
    createBoundedAgentExternalSessionsContribution,
    createUnavailableAgentExternalSessionsManagedEndpointRead,
} from '../../../../session/external/agentExternalSessionsInvocation';
import type { AgentExternalSessionsManagedEndpointReadHost } from '../../../../session/external/agentExternalSessionsInvocation';
import type { BoundedAgentExternalSessionsContribution } from '../../../../session/external/agentExternalSessionsInvocation';
import {
    createContributionOwnedManagedServiceEndpointReadHost,
} from '../../../../session/external/contributionOwnedManagedServiceEndpointRead';
import { createPluginInvocationPresentation } from '../../invocation/services/interactions';
import { createUnavailablePluginServices } from '../../invocation/services/unavailable';
import type { CreateAgentInvocationServices } from '../../invocation/services/types';

type TargetRegistration = Readonly<{
    pluginId: string;
    occurrenceId: string;
    registration: ContributionRuntimeRegistration;
}>;

type OccurrenceBoundExternalSessionHooks = Readonly<{
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

export type OccurrenceBoundExternalSessionCandidateLifecycle = Readonly<{
    /**
     * Runs one candidate-listing request and reports the delete support the
     * connection that served *that* request negotiated, under this generation.
     * The capability is request-local and generation-local: it never survives
     * the request that proved it, and a retired generation reports `false`.
     */
    runListingRequest<T>(run: () => Promise<T>): Promise<Readonly<{
        value: T;
        negotiatedDeleteSupport: boolean;
    }>>;
    deleteCandidate(request: Readonly<{
        source: AgentExternalSessionSource;
        remoteSessionId: string;
        signal?: AbortSignal;
    }>): Promise<AgentExternalSessionsResult<void>>;
}>;

type OccurrenceBoundExternalSessionTakeover = Readonly<{
    resolveLaunch(
        request: AgentExternalSessionTakeoverResolveLaunchRequest,
    ): Promise<OccurrenceBoundExternalSessionTakeoverResolveLaunchResult>;
}>;

/**
 * The public SDK result remains strict. This one host-private field is
 * admitted only at the generation-bound callback seam, then carried through
 * the daemon-owned spawn and respawn path that owns its use.
 */
type OccurrenceBoundExternalSessionTakeoverResolveLaunchResult =
    AgentExternalSessionTakeoverResolveLaunchResult;

export type OccurrenceBoundExternalSessionObservation = Readonly<{
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
    occurrenceId: string;
    immutableGenerationId?: string | null;
    sourceCustody: PluginSourceCustodyV1;
    startupInstructionsVersions?: readonly [1];
    externalSessions?: BoundedAgentExternalSessionsContribution;
    /**
     * Host-synthesized Agent session-lifecycle controls for a resume-only ACP
     * source. Deliberately outside `externalSessions`: the public External
     * Sessions contribution owns discovery and transcripts, never destructive
     * control of an Agent's own session records, so a plugin can never supply
     * this facet.
     */
    externalSessionCandidateLifecycle?: OccurrenceBoundExternalSessionCandidateLifecycle;
    externalSessionHooks?: OccurrenceBoundExternalSessionHooks;
    externalSessionObservation?: OccurrenceBoundExternalSessionObservation;
    externalSessionTakeover?: OccurrenceBoundExternalSessionTakeover;
    terminal?: AgentTerminalSurface;
    daemonSpawnHooks?: AgentDaemonSpawnHooks;
    providerCliAttach?: AgentProviderCliAttachDeclarationV1;
    cliSessionCommand?: AgentCliSessionCommandDeclarationV1;
    cliAuth?: AgentCliAuthContributionV1;
    connectedAccountLaunch?: AgentConnectedAccountLaunchContributionV1;
    preflightSessionControls?: AgentPreflightSessionControlsContributionV1;
    terminalPromptSubmitVerification?: AgentTerminalPromptSubmitVerificationPolicyV1;
    sessionStartup?: AgentSessionStartupContributionV1;
    vendorResumeSupport?: AgentExperimentalVendorResumeSupportContributionV1;
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

type AgentRuntimeOccurrenceLifecycleResolver = (
    pluginId: string,
) => Readonly<{
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

type AgentRuntimeRetirementOwner =
    | Readonly<{
        retirementSignal: AbortSignal;
        resolveOccurrenceLifecycle?: AgentRuntimeOccurrenceLifecycleResolver;
    }>
    | Readonly<{
        retirementSignal?: never;
        resolveOccurrenceLifecycle: AgentRuntimeOccurrenceLifecycleResolver;
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

function readOccurrenceBoundDaemonSpawnHookFailure(params: Readonly<{
    isOccurrenceCurrent(): boolean;
    retirementSignal: AbortSignal;
    signal: AbortSignal;
}>): Readonly<{ ok: false; reasonCode: string; errorMessage: string }> | null {
    if (!isAgentRuntimeGenerationCurrent({
        isCurrent: params.isOccurrenceCurrent,
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

function createOccurrenceBoundAgentDaemonSpawnHooks(params: Readonly<{
    contribution: AgentDaemonSpawnHooks;
    isOccurrenceCurrent(): boolean;
    retirementSignal: AbortSignal;
}>): AgentDaemonSpawnHooks {
    const resolveRuntimePrerequisites = params.contribution.resolveRuntimePrerequisites
        ? async (selection: AgentDaemonSpawnRuntimeSelectionV1) => {
            const bound = bindDaemonSpawnHookSelection({
                selection,
                retirementSignal: params.retirementSignal,
            });
            const unavailableBefore = readOccurrenceBoundDaemonSpawnHookFailure({
                isOccurrenceCurrent: params.isOccurrenceCurrent,
                retirementSignal: params.retirementSignal,
                signal: bound.signal,
            });
            if (unavailableBefore) return unavailableBefore;
            try {
                const result = await params.contribution.resolveRuntimePrerequisites!(
                    bound.selection,
                );
                const unavailableAfter = readOccurrenceBoundDaemonSpawnHookFailure({
                    isOccurrenceCurrent: params.isOccurrenceCurrent,
                    retirementSignal: params.retirementSignal,
                    signal: bound.signal,
                });
                if (unavailableAfter) return unavailableAfter;
                if (isDaemonSpawnValidationResult(result)) return result;
            } catch {
                const unavailableAfter = readOccurrenceBoundDaemonSpawnHookFailure({
                    isOccurrenceCurrent: params.isOccurrenceCurrent,
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
            const unavailableBefore = readOccurrenceBoundDaemonSpawnHookFailure({
                isOccurrenceCurrent: params.isOccurrenceCurrent,
                retirementSignal: params.retirementSignal,
                signal: bound.signal,
            });
            if (unavailableBefore) {
                throw new Error(unavailableBefore.errorMessage);
            }
            let rawEnvironment: unknown;
            try {
                rawEnvironment = params.contribution.augmentEnv!(bound.selection);
            } catch {
                throw new Error('Agent daemon spawn environment hook failed.');
            }
            const unavailableAfter = readOccurrenceBoundDaemonSpawnHookFailure({
                isOccurrenceCurrent: params.isOccurrenceCurrent,
                retirementSignal: params.retirementSignal,
                signal: bound.signal,
            });
            if (unavailableAfter) {
                throw new Error(unavailableAfter.errorMessage);
            }
            const environment = readDaemonSpawnHookEnvironment(rawEnvironment);
            if (!environment) {
                throw new TypeError(
                    'Agent daemon spawn environment hook returned an invalid environment.',
                );
            }
            return environment;
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

function assertValidAgentRuntime(
    value: AgentRuntime,
    declaredPrimary: 'sessions' | 'executionRuns' | null,
    declaresExecutionRunContextV1: boolean,
): AgentRuntime {
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
    // The lazy validator compares the manifest primary to the returned
    // runtime: a declared Session runtime must not lazily produce a
    // competing execution-run lifecycle, and an execution-primary runtime
    // must not lazily produce a session lifecycle.
    if (hasSessions && hasExecutionRuns) {
        throw new Error('Session-capable Agent runtimes must not register a competing execution-run lifecycle; the host derives finite Runs from sessions');
    }
    if (declaredPrimary === 'sessions' && !hasSessions) {
        throw new Error('Agent declaration is Session-primary but the factory returned no session runtime');
    }
    if (declaredPrimary === 'executionRuns' && !hasExecutionRuns) {
        throw new Error('Agent declaration is execution-run primary but the factory returned no execution-run runtime');
    }
    const hasExecutionRunContextV1 = hasSessions
        && typeof sessions.executionRunContextV1 === 'object'
        && sessions.executionRunContextV1 !== null
        && typeof sessions.executionRunContextV1.open === 'function';
    if (declaresExecutionRunContextV1 && !hasExecutionRunContextV1) {
        throw new Error('Agent declaration declares detached execution-run context v1 but returned no matching runtime facet');
    }
    if (!declaresExecutionRunContextV1 && hasExecutionRunContextV1) {
        throw new Error('Agent runtime returned a detached execution-run context facet without declaring the matching manifest capability');
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

function createOccurrenceBoundExternalSessionObservation(params: Readonly<{
    contribution: AgentExternalSessionObservationContribution;
    identity: Readonly<{
        pluginId: string;
        agentId: string;
        occurrenceId: string;
        contributionQualifiedId: string;
        sourceCustody: PluginSourceCustodyV1;
    }>;
    assertCurrent(): void;
    isOccurrenceCurrent(): boolean;
    retirementSignal: AbortSignal;
    managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
}>): OccurrenceBoundExternalSessionObservation {
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
            isCurrent: params.isOccurrenceCurrent,
            retirementSignal: params.retirementSignal,
            host: params.managedEndpointRead,
            maxResponseBytes,
        });
    };
    const composeSignal = (callerSignal: AbortSignal): Readonly<{
        signal: AbortSignal;
        terminalPromise: Promise<void>;
        abort(reason?: 'cancelled' | 'retired' | 'disposed'): void;
        cleanup(): void;
    }> => {
        const controller = new AbortController();
        let terminalReason: 'cancelled' | 'retired' | 'disposed' | null = null;
        let resolveTerminal!: () => void;
        const terminalPromise = new Promise<void>((resolve) => {
            resolveTerminal = resolve;
        });
        const abort = (
            reason: 'cancelled' | 'retired' | 'disposed' = 'disposed',
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
        return Object.freeze({
            signal: controller.signal,
            terminalPromise,
            abort,
            cleanup() {
                abort('disposed');
                callerSignal.removeEventListener('abort', cancel);
                params.retirementSignal.removeEventListener('abort', retire);
            },
        });
    };

    // Retirement and caller cancellation remain typed External Sessions
    // outcomes rather than opaque internal errors.
    const retiredError = (cause?: unknown) => new ExternalSessionProviderFailureError({
        code: 'unavailable',
        message: 'Agent External Session observation belongs to a retired generation',
        operation: 'externalSessionObservation',
        retryable: true,
        cause,
    });
    const cancelledError = (cause?: unknown) => new ExternalSessionProviderFailureError({
        code: 'cancelled',
        message: 'Agent External Session observation was cancelled',
        operation: 'externalSessionObservation',
        cause,
    });

    const assertAdmissible = (callerSignal?: AbortSignal): void => {
        params.assertCurrent();
        if (params.retirementSignal.aborted) {
            params.assertCurrent();
            throw retiredError();
        }
        if (callerSignal?.aborted) {
            throw cancelledError();
        }
    };

    const terminalError = (
        callerSignal: AbortSignal,
        composed: ReturnType<typeof composeSignal>,
        cause?: unknown,
    ): Error => {
        if (params.retirementSignal.aborted || !params.isOccurrenceCurrent()) {
            return retiredError(cause);
        }
        if (callerSignal.aborted) {
            return cancelledError(cause);
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
                OccurrenceBoundExternalSessionObservation['observeResource']
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
            const disposeOnce = (): Promise<void> => {
                if (disposalPromise) return disposalPromise;
                if (!acquired) return Promise.resolve();
                const observer = acquired;
                let resolveAttempt!: () => void;
                let rejectAttempt!: (reason: unknown) => void;
                const attempt = new Promise<void>((resolve, reject) => {
                    resolveAttempt = resolve;
                    rejectAttempt = reject;
                });
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
                });
                // Publish custody before entering a callback that can re-enter
                // disposal, while retaining synchronous physical cleanup start.
                try {
                    void Promise.resolve(observer.dispose()).then(resolveAttempt, rejectAttempt);
                } catch (error) {
                    rejectAttempt(error);
                }
                return attempt;
            };
            const disposeObserver = async (): Promise<void> => {
                try {
                    await disposeOnce();
                } catch (error) {
                    logExternalSessionsInternalError('external_session.observation_physical_dispose', error);
                    throw new Error('Agent External Session observation cleanup failed');
                }
            };
            const disposeOnAbort = () => {
                void disposeObserver().catch(() => undefined);
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
                            || !params.isOccurrenceCurrent()) {
                            return;
                        }
                        const parsed =
                            ExternalAgentObservationLinkEvidenceBatchV1Schema.parse(batch);
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isOccurrenceCurrent()) {
                            return;
                        }
                        request.emit(parsed);
                    },
                    requestReconcile() {
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isOccurrenceCurrent()) {
                            return;
                        }
                        request.requestReconcile();
                    },
                    requestTranscriptRefresh(linkKey) {
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isOccurrenceCurrent()) {
                            return;
                        }
                        const parsedLinkKey =
                            ExternalAgentObservationLinkKeyV1Schema.parse(linkKey);
                        if (composed.signal.aborted
                            || params.retirementSignal.aborted
                            || !params.isOccurrenceCurrent()) {
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
                    || !params.isOccurrenceCurrent()) {
                    await disposeObserver().catch(() => undefined);
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
                return Object.freeze({
                    async dispose() {
                        composed.abort('disposed');
                        try {
                            await disposeObserver();
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
                OccurrenceBoundExternalSessionObservation['reconcileResource']
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

function createOccurrenceBoundExternalSessionHooks(params: Readonly<{
    contribution: AgentExternalSessionHooksContribution;
    createInvocationContext(
        signal: AbortSignal,
    ): Promise<PluginInvocationContext>;
    assertCurrent(): void;
    isOccurrenceCurrent(): boolean;
    retirementSignal: AbortSignal;
}>): OccurrenceBoundExternalSessionHooks {
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
        const deadlineAtMs = request.deadlineAtMs;
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
            if (params.retirementSignal.aborted || !params.isOccurrenceCurrent()) {
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
        let cancelDeadline: (() => void) | undefined;
        if (params.retirementSignal.aborted || !params.isOccurrenceCurrent()) {
            retire();
        } else if (request.signal.aborted) {
            cancel();
        } else if (remainingMs <= 0) {
            terminate('timed-out');
        } else {
            cancelDeadline = armExternalSessionsDeadline(deadlineAtMs, () => terminate('timed-out'), { unref: true });
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
            cancelDeadline?.();
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

function createOccurrenceBoundExternalSessionTakeover(params: Readonly<{
    contribution: AgentExternalSessionTakeoverContribution;
    assertCurrent(): void;
    isOccurrenceCurrent(): boolean;
    retirementSignal: AbortSignal;
}>): OccurrenceBoundExternalSessionTakeover {
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
            const deadlineAtMs = request.deadlineAtMs;
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
                    || !params.isOccurrenceCurrent()) {
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
            let cancelDeadline: (() => void) | undefined;
            if (params.retirementSignal.aborted
                || !params.isOccurrenceCurrent()) {
                retire();
            } else if (request.signal.aborted) {
                cancel();
            } else if (remainingMs <= 0) {
                terminate('timed-out');
            } else {
                cancelDeadline = armExternalSessionsDeadline(
                    deadlineAtMs,
                    () => terminate('timed-out'),
                    { unref: true },
                );
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
                cancelDeadline?.();
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
    occurrenceId: string;
    immutableGenerationId: string | null;
    sourceCustody: PluginSourceCustodyV1;
    manifest?: CanonicalPluginManifest;
    declaredPrimary?: 'sessions' | 'executionRuns' | null;
    declaresExecutionRunContextV1?: boolean;
    startupInstructionsVersions?: readonly [1];
    registration: AgentContributionRuntimeRegistration;
    runnerBinding?: AgentSessionRunnerBindingV1;
    isOccurrenceCurrent(): boolean;
    retirementSignal: AbortSignal;
    boundedExternalSessions?: BoundedAgentExternalSessionsContribution;
    acpSessionListingOwner?: AcpSessionListingOwner;
    boundedExternalSessionHooks?: OccurrenceBoundExternalSessionHooks;
    boundedExternalSessionObservation?: OccurrenceBoundExternalSessionObservation;
    boundedExternalSessionTakeover?: OccurrenceBoundExternalSessionTakeover;
    boundedDaemonSpawnHooks?: AgentDaemonSpawnHooks;
    createAgentInvocationServices?: CreateAgentInvocationServices;
    managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
}>): AgentRuntimeRegistrationLease {
    const assertCurrent = (): void => {
        if (!params.isOccurrenceCurrent()) {
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
            occurrenceId: params.occurrenceId,
            correlationId: randomUUID(),
            cwd,
            providerBindingActive:
                params.registration.providerBinding !== undefined,
            signal,
            isOccurrenceCurrent: params.isOccurrenceCurrent,
        })
        ?? createUnavailablePluginServices()
    );
    const createInvocationContext = async (input: Readonly<{
        signal: AbortSignal;
        cwd: string;
        happierSessionId?: string;
    }>): Promise<PluginInvocationContext> => {
        const invokedAtMs = Date.now();
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
            qualifiedId: resolveAgentContributionQualifiedId({
                pluginId: params.pluginId,
                localId: params.localAgentId,
            }),
        });
        const services = await createInvocationServices(input.signal, input.cwd);
        assertCurrent();
        return Object.freeze({
            plugin,
            contribution,
            surface: 'agent',
            invokedAtMs,
            ...(input.happierSessionId ? { session: Object.freeze({ id: input.happierSessionId }) } : {}),
            signal: input.signal,
            services,
            ui: createPluginInvocationPresentation({
                currentSession: null,
                signal: input.signal,
                isOccurrenceCurrent: params.isOccurrenceCurrent,
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
                    occurrenceId: params.occurrenceId,
                },
                createAgentInvocationServices: params.createAgentInvocationServices,
                cwd: process.cwd(),
                isOccurrenceActive: params.isOccurrenceCurrent,
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
                    occurrenceId: params.occurrenceId,
                    contributionQualifiedId:
                        resolveAgentContributionQualifiedId({
                            pluginId: params.pluginId,
                            localId: params.localAgentId,
                        }),
                    sourceCustody: params.sourceCustody,
                },
                isCurrent: params.isOccurrenceCurrent,
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
    /**
     * Bound to this generation exactly like the External Sessions contribution
     * beside it: a retired generation can neither advertise nor perform a
     * destructive Agent-side deletion.
     */
    const externalSessionCandidateLifecycle: OccurrenceBoundExternalSessionCandidateLifecycle | undefined =
        params.acpSessionListingOwner
            ? Object.freeze({
                async runListingRequest(run) {
                    const listed = await params.acpSessionListingOwner!.runListingRequest(run);
                    return Object.freeze({
                        value: listed.value,
                        negotiatedDeleteSupport: listed.negotiatedDeleteSupport
                            && params.isOccurrenceCurrent()
                            && !params.retirementSignal.aborted,
                    });
                },
                async deleteCandidate(request) {
                    if (!params.isOccurrenceCurrent() || params.retirementSignal.aborted) {
                        return { ok: false, code: 'unavailable' };
                    }
                    const controller = new AbortController();
                    const abort = () => controller.abort();
                    request.signal?.addEventListener('abort', abort, { once: true });
                    params.retirementSignal.addEventListener('abort', abort, { once: true });
                    try {
                        if (request.signal?.aborted) return { ok: false, code: 'cancelled' };
                        const exec = (await createInvocationServices(controller.signal)).exec;
                        if (!params.isOccurrenceCurrent() || params.retirementSignal.aborted) {
                            return { ok: false, code: 'unavailable' };
                        }
                        return await params.acpSessionListingOwner!.deleteCandidate({
                            source: request.source,
                            remoteSessionId: request.remoteSessionId,
                            exec,
                            signal: controller.signal,
                        });
                    } finally {
                        request.signal?.removeEventListener('abort', abort);
                        params.retirementSignal.removeEventListener('abort', abort);
                    }
                },
            })
            : undefined;
    const externalSessionObservation = params.boundedExternalSessionObservation
        ?? (params.registration.externalSessionObservation
            ? createOccurrenceBoundExternalSessionObservation({
                contribution: params.registration.externalSessionObservation,
                identity: {
                    pluginId: params.pluginId,
                    agentId: params.agentId,
                    occurrenceId: params.occurrenceId,
                    contributionQualifiedId:
                        resolveAgentContributionQualifiedId({
                            pluginId: params.pluginId,
                            localId: params.localAgentId,
                        }),
                    sourceCustody: params.sourceCustody,
                },
                assertCurrent,
                isOccurrenceCurrent: params.isOccurrenceCurrent,
                retirementSignal: params.retirementSignal,
                ...(observationManagedEndpointRead
                    ? { managedEndpointRead: observationManagedEndpointRead }
                    : {}),
            })
            : undefined);
    const externalSessionHooks = params.boundedExternalSessionHooks
        ?? (params.registration.externalSessionHooks
            ? createOccurrenceBoundExternalSessionHooks({
                contribution: params.registration.externalSessionHooks,
                async createInvocationContext(signal) {
                    return await createInvocationContext({
                        signal,
                        cwd: process.cwd(),
                    });
                },
                assertCurrent,
                isOccurrenceCurrent: params.isOccurrenceCurrent,
                retirementSignal: params.retirementSignal,
            })
            : undefined);
    const externalSessionTakeover = params.boundedExternalSessionTakeover
        ?? (params.registration.externalSessionTakeover
            ? createOccurrenceBoundExternalSessionTakeover({
                contribution: params.registration.externalSessionTakeover,
                assertCurrent,
                isOccurrenceCurrent: params.isOccurrenceCurrent,
                retirementSignal: params.retirementSignal,
            })
            : undefined);
    const terminal = params.registration.terminal
        ? Object.freeze({
            async resolveLaunch(
                request: Parameters<AgentTerminalSurface['resolveLaunch']>[0],
            ) {
                assertCurrent();
                const result = await params.registration.terminal!.resolveLaunch(request);
                assertCurrent();
                return result;
            },
        }) satisfies AgentTerminalSurface
        : undefined;
    const daemonSpawnHooks = params.boundedDaemonSpawnHooks
        ?? (params.registration.daemonSpawnHooks
            ? createOccurrenceBoundAgentDaemonSpawnHooks({
                contribution: params.registration.daemonSpawnHooks,
                isOccurrenceCurrent: params.isOccurrenceCurrent,
                retirementSignal: params.retirementSignal,
            })
            : undefined);
    const common = Object.freeze({
        pluginId: params.pluginId,
        pluginVersion: params.pluginVersion,
        agentId: params.agentId,
        localAgentId: params.localAgentId,
        occurrenceId: params.occurrenceId,
        immutableGenerationId: params.immutableGenerationId,
        sourceCustody: params.sourceCustody,
        ...(params.startupInstructionsVersions
            ? { startupInstructionsVersions: params.startupInstructionsVersions }
            : {}),
        ...(externalSessions
            ? { externalSessions }
            : {}),
        ...(externalSessionCandidateLifecycle
            ? { externalSessionCandidateLifecycle }
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
        ...(terminal ? { terminal } : {}),
        ...(daemonSpawnHooks
            ? { daemonSpawnHooks }
            : {}),
        ...(params.registration.providerCliAttach
            ? { providerCliAttach: params.registration.providerCliAttach }
            : {}),
        ...(params.registration.cliSessionCommand
            ? { cliSessionCommand: params.registration.cliSessionCommand }
            : {}),
        ...(params.registration.cliAuth
            ? { cliAuth: params.registration.cliAuth }
            : {}),
        ...(params.registration.connectedAccountLaunch
            ? { connectedAccountLaunch: params.registration.connectedAccountLaunch }
            : {}),
        ...(params.registration.preflightSessionControls
            ? { preflightSessionControls: params.registration.preflightSessionControls }
            : {}),
        ...(params.registration.terminalPromptSubmitVerification
            ? {
                terminalPromptSubmitVerification:
                    params.registration.terminalPromptSubmitVerification,
            }
            : {}),
        ...(params.registration.sessionStartup
            ? { sessionStartup: params.registration.sessionStartup }
            : {}),
        ...(params.registration.vendorResumeSupport
            ? { vendorResumeSupport: params.registration.vendorResumeSupport }
            : {}),
        retirementSignal: params.retirementSignal,
        isCurrent: params.isOccurrenceCurrent,
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
    const publishedFactory = params.sourceCustody.kind === 'bundled_first_party'
        && validatedSessionRunnerFactory
        ? readRetainedBundledAgentFactory(params.manifest, params.localAgentId)
        : validatedSessionRunnerFactory;
    const sessionRunnerFactoryBinding = params.runnerBinding
        ?? (publishedFactory
        && params.sourceCustody
        ? createAgentSessionRunnerFactoryBinding({
            v: 1,
            pluginId: params.pluginId,
            pluginVersion: params.pluginVersion,
            agentId: params.agentId,
            localAgentId: params.localAgentId,
            sourceCustody: params.sourceCustody,
            locator: publishedFactory.locator,
            normalizedModulePath: publishedFactory.normalizedModulePath,
            loadMode: publishedFactory.loadMode,
        })
        : undefined);
    let runtimePromise: Promise<AgentRuntime> | null = null;
    const awaitRuntime = async (
        promise: Promise<AgentRuntime>,
        signal: AbortSignal,
    ): Promise<AgentRuntime> => {
        if (signal.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new Error(`Agent runtime '${params.agentId}' operation was cancelled`);
        }
        let onAbort: (() => void) | null = null;
        const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new Error(`Agent runtime '${params.agentId}' operation was cancelled`),
            );
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([promise, aborted]);
        } finally {
            if (onAbort) signal.removeEventListener('abort', onAbort);
        }
    };
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
            runtimePromise ??= (async () => {
                const context: AgentRuntimeFactoryContext = Object.freeze({
                    plugin: Object.freeze({ id: params.pluginId, version: params.pluginVersion }),
                    agent: Object.freeze({ id: params.localAgentId }),
                    signal: params.retirementSignal,
                });
                const runtime = await factory(context);
                assertCurrent();
                return assertValidAgentRuntime(
                    runtime,
                    params.declaredPrimary ?? null,
                    params.declaresExecutionRunContextV1 === true,
                );
            })();
            const runtime = await awaitRuntime(runtimePromise, signal);
            assertCurrent();
            return runtime;
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
    readPluginOccurrenceId(pluginId: string): string | null;
    readPluginSourceCustody(pluginId: string): PluginSourceCustodyV1 | null;
    isOccurrenceCurrent(): boolean;
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
        const resolvedAgentId = readAgentRoutingIdForContributionIdentity(selectedAgentIdByIdentity, {
            pluginId: candidate.pluginId,
            localId: candidate.registration.localId,
        });
        // External identity must be resolved from the admitted declaration;
        // falling back to a bare registration local id can collide with a
        // different Agent or dispatch to the wrong runtime. Bundled
        // first-party compatibility ids are already present in the identity
        // index, so no fallback is needed there either.
        const selectedLegacyAgent = selectedAgentById.get(candidate.registration.localId);
        const agentId = resolvedAgentId
            // A few bundled callers still provide the released unqualified
            // id without a structured identity. Keep that narrow compatibility
            // fallback only when the selected projection itself is identity-
            // free; external projected Agents must resolve through the exact
            // `{pluginId, localId}` index above.
            ?? (target.provenance === 'first_party' && selectedLegacyAgent && !selectedLegacyAgent.identity
                ? candidate.registration.localId
                : null);
        if (!agentId) continue;
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
        const lifecycle = params.resolveOccurrenceLifecycle?.(candidate.pluginId);
        const startupInstructionsVersions = readStartupInstructionsVersions(
            selectedAgentById.get(agentId),
        );
        const selectedDefinition = selectedAgentById.get(agentId)?.richDefinition?.definition ?? null;
        const declaredPrimary = selectedDefinition !== null
            && isPrimaryAgentContributionDefinition(selectedDefinition)
            ? selectedDefinition.primary
            : null;
        const declaresExecutionRunContextV1 = readAgentSessionCapabilities(selectedDefinition)
            ?.executionRunContext?.versions.includes(1) === true;
        const occurrenceId = params.readPluginOccurrenceId(candidate.pluginId);
        const sourceCustody = params.readPluginSourceCustody(candidate.pluginId);
        if (!occurrenceId || occurrenceId !== candidate.occurrenceId || !sourceCustody) {
            throw new Error(
                `Agent runtime '${agentId}' has no admitted plugin occurrence or source custody`,
            );
        }
        registry.set(agentId, createLease({
            pluginId: candidate.pluginId,
            pluginVersion: target.manifest.version,
            agentId,
            localAgentId: candidate.registration.localId,
            occurrenceId,
            immutableGenerationId: params.immutableGenerationIdsByPluginId?.get(candidate.pluginId) ?? null,
            sourceCustody,
            manifest: target.manifest,
            declaredPrimary,
            declaresExecutionRunContextV1,
            ...(startupInstructionsVersions
                ? { startupInstructionsVersions }
                : {}),
            registration: candidate.registration.value,
            isOccurrenceCurrent: lifecycle?.isCurrent ?? params.isOccurrenceCurrent,
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

type AgentAuxiliaryRuntimeRegistration = Omit<
    AgentContributionRuntimeRegistration,
    'factory' | 'providerBinding' | 'sessionRunnerFactory'
>;

const AGENT_AUXILIARY_RUNTIME_REGISTRATION_KEYS = Object.freeze([
    'daemonSpawnHooks',
    'providerCliAttach',
    'cliSessionCommand',
    'cliAuth',
    'connectedAccountLaunch',
    'preflightSessionControls',
    'terminalPromptSubmitVerification',
    'sessionStartup',
    'vendorResumeSupport',
    'terminal',
    'externalSessions',
    'externalSessionHooks',
    'externalSessionObservation',
    'externalSessionTakeover',
] as const satisfies readonly (keyof AgentAuxiliaryRuntimeRegistration)[]);

type MissingAgentAuxiliaryRuntimeRegistrationKey = Exclude<
    keyof AgentAuxiliaryRuntimeRegistration,
    (typeof AGENT_AUXILIARY_RUNTIME_REGISTRATION_KEYS)[number]
>;
const AGENT_AUXILIARY_RUNTIME_REGISTRATION_KEYS_ARE_EXHAUSTIVE:
    MissingAgentAuxiliaryRuntimeRegistrationKey extends never ? true : never = true;
void AGENT_AUXILIARY_RUNTIME_REGISTRATION_KEYS_ARE_EXHAUSTIVE;

function retainAgentAuxiliaryRuntimeFacets(
    existing: AgentRuntimeRegistrationLease | undefined,
): Readonly<{
    registration: AgentAuxiliaryRuntimeRegistration;
    boundedLeaseFacets: Readonly<{
        boundedExternalSessions?: BoundedAgentExternalSessionsContribution;
        boundedExternalSessionHooks?: OccurrenceBoundExternalSessionHooks;
        boundedExternalSessionObservation?: OccurrenceBoundExternalSessionObservation;
        boundedExternalSessionTakeover?: OccurrenceBoundExternalSessionTakeover;
        boundedDaemonSpawnHooks?: AgentDaemonSpawnHooks;
    }>;
}> {
    if (!existing) {
        return Object.freeze({
            registration: Object.freeze({}),
            boundedLeaseFacets: Object.freeze({}),
        });
    }
    const source = existing as unknown as Readonly<Record<string, unknown>>;
    const registration: Record<string, unknown> = {};
    for (const key of AGENT_AUXILIARY_RUNTIME_REGISTRATION_KEYS) {
        const value = source[key];
        if (value !== undefined) registration[key] = value;
    }
    return Object.freeze({
        registration: Object.freeze(registration) as AgentAuxiliaryRuntimeRegistration,
        boundedLeaseFacets: Object.freeze({
            ...(existing.externalSessions
                ? { boundedExternalSessions: existing.externalSessions }
                : {}),
            ...(existing.externalSessionHooks
                ? { boundedExternalSessionHooks: existing.externalSessionHooks }
                : {}),
            ...(existing.externalSessionObservation
                ? { boundedExternalSessionObservation: existing.externalSessionObservation }
                : {}),
            ...(existing.externalSessionTakeover
                ? { boundedExternalSessionTakeover: existing.externalSessionTakeover }
                : {}),
            ...(existing.daemonSpawnHooks
                ? { boundedDaemonSpawnHooks: existing.daemonSpawnHooks }
                : {}),
        }),
    });
}

export function createDeclarativeAcpAgentRuntimeRegistry(params: Readonly<{
    agents: readonly ResolvedAgentContribution[];
    registered: ReadonlyMap<string, AgentRuntimeRegistrationLease>;
    immutableGenerationIdsByPluginId?: ReadonlyMap<string, string>;
    readPluginOccurrenceId(pluginId: string): string | null;
    readPluginSourceCustody(pluginId: string): PluginSourceCustodyV1 | null;
    isOccurrenceCurrent(): boolean;
    createAgentInvocationServices?: CreateAgentInvocationServices;
}> & AgentRuntimeRetirementOwner): Map<string, AgentRuntimeRegistrationLease> {
    const registry = new Map(params.registered);
    const declarations = params.agents
        .flatMap((agent) => {
            const runtime = readAgentPrimaryRuntime(agent.richDefinition?.definition);
            const identity = agent.identity;
            return agent.pluginId
                && identity?.pluginId === agent.pluginId
                && runtime?.kind === 'acp'
                && readAgentSessionCapabilities(
                    agent.richDefinition?.definition,
                )
                ? [{ agent, identity, pluginId: agent.pluginId, runtime }]
                : [];
        })
        .sort((left, right) => (
            left.pluginId.localeCompare(right.pluginId)
            || left.agent.id.localeCompare(right.agent.id)
        ));

    for (const declaration of declarations) {
        const lifecycle = params.resolveOccurrenceLifecycle?.(declaration.pluginId);
        const existing = registry.get(declaration.agent.id);
        if (existing?.hasPrimaryRuntime || (existing && existing.pluginId !== declaration.pluginId)) {
            throw new Error(
                `Declarative ACP Agent '${declaration.agent.id}' from plugin '${declaration.pluginId}' conflicts with runtime owner '${existing.pluginId}'`,
            );
        }
        const runtime = normalizePluginDeclarativeAcpRuntime(
            declaration.runtime,
        );
        const declaresExecutionRunContextV1 = readAgentSessionCapabilities(
            declaration.agent.richDefinition?.definition,
        )?.executionRunContext?.versions.includes(1) === true;
        const retainedFacets = retainAgentAuxiliaryRuntimeFacets(existing);
        const externalSessionSources = declaration.agent.richDefinition
            ?.definition.surfaces?.externalSession.sources ?? [];
        // The protocol Agent contribution schema owns the resume-only source
        // contract; this defensive re-check keeps malformed or bypassed
        // installed data from synthesizing a resume listing the Agent's
        // declared Session capabilities cannot fulfill.
        const resumeOnlySourceKinds = new Set(
            declaresHostSynthesizedAgentResumeOnlyExternalSources(
                declaration.agent.richDefinition?.definition,
            )
                ? externalSessionSources.map((source) => source.sourceKind)
                : [],
        );
        if (resumeOnlySourceKinds.size > 0 && retainedFacets.registration.externalSessions) {
            throw new Error(
                `Declarative ACP Agent '${declaration.agent.id}' has competing External Sessions owners`,
            );
        }
        const acpSessionListingOwner = resumeOnlySourceKinds.size > 0
            ? createAcpSessionListingOwner({
                pluginId: declaration.pluginId,
                agentId: declaration.agent.id,
                runtime,
                sourceKinds: resumeOnlySourceKinds,
            })
            : null;
        const registration: AgentContributionRuntimeRegistration = Object.freeze({
            factory: createHostDeclarativeAcpAgentRuntimeFactory(runtime, {
                executionRunContextV1: declaresExecutionRunContextV1,
            }),
            ...retainedFacets.registration,
            ...(acpSessionListingOwner
                ? {
                    externalSessions: acpSessionListingOwner.contribution,
                }
                : {}),
        });
        const pluginVersion = existing?.pluginVersion
            ?? declaration.agent.sourceSpec?.resolvedVersion
            ?? null;
        const localAgentId = declaration.identity.localId;
        const immutableGenerationId = existing?.immutableGenerationId
            ?? params.immutableGenerationIdsByPluginId?.get(
                declaration.pluginId,
            )
            ?? null;
        const sourceCustody = existing?.sourceCustody
            ?? params.readPluginSourceCustody(declaration.pluginId);
        const occurrenceId = existing?.occurrenceId
            ?? params.readPluginOccurrenceId(declaration.pluginId);
        if (!occurrenceId || !sourceCustody) {
            throw new Error(
                `Declarative ACP Agent '${declaration.agent.id}' has no admitted plugin occurrence or source custody`,
            );
        }
        const runnerBinding = pluginVersion
            && sourceCustody
            ? createHostDeclarativeAcpRunnerBinding({
                kind: 'host_declarative_acp_v1',
                v: 1,
                pluginId: declaration.pluginId,
                pluginVersion,
                agentId: declaration.agent.id,
                qualifiedAgentId: resolveAgentContributionQualifiedId({
                    pluginId: declaration.pluginId,
                    localId: localAgentId,
                }),
                localAgentId,
                sourceCustody,
            })
            : undefined;
        registry.set(declaration.agent.id, createLease({
            pluginId: declaration.pluginId,
            pluginVersion: pluginVersion ?? '0.0.0',
            agentId: declaration.agent.id,
            declaresExecutionRunContextV1,
            ...(acpSessionListingOwner ? { acpSessionListingOwner } : {}),
            declaredPrimary: declaration.agent.richDefinition?.definition !== undefined
                && isPrimaryAgentContributionDefinition(declaration.agent.richDefinition.definition)
                ? declaration.agent.richDefinition.definition.primary
                : null,
            localAgentId,
            occurrenceId,
            immutableGenerationId,
            sourceCustody,
            ...(readStartupInstructionsVersions(declaration.agent)
                ? { startupInstructionsVersions: [1] as const }
                : {}),
            registration,
            ...(runnerBinding ? { runnerBinding } : {}),
            isOccurrenceCurrent: existing
                ? () => existing.isCurrent() && (lifecycle?.isCurrent() ?? params.isOccurrenceCurrent())
                : lifecycle?.isCurrent ?? params.isOccurrenceCurrent,
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
            ...retainedFacets.boundedLeaseFacets,
            ...(acpSessionListingOwner ? { acpSessionListingOwner } : {}),
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
