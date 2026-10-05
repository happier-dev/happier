import { randomUUID } from 'node:crypto';

import {
    ActionOperationProgressV1Schema,
    createPluginActionInvocation,
    pluginActionRequiresPresentUserIntent,
    PluginHostAccessRequestV2Schema,
    type PluginActionPresentUserGatePolicy,
    type PluginActionInputParser,
} from '@happier-dev/protocol';
import type { PluginUiSelectedActionInputCarrierV1 } from '@happier-dev/protocol/plugins/ui';
import type {
    ActionOperationDeclarationV1,
    MessageActionAvailableSnapshotV1,
    PluginActionAvailabilityV2,
    PluginActionConfirmationV2,
    PluginActionDangerLevelV2,
    PluginMachineMaterializationRefV1,
    PluginSourceCustodyV1,
    TargetActionApprovalReplayPlacementV1,
} from '@happier-dev/protocol';

import {
    PluginError,
    type JsonValue,
    type PluginActionOperationProgressUpdateV1,
    type PluginInvocationCaller,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
    type ActionHandler,
    type PluginActionHandlerInvocation,
} from '@happier-dev/plugin-sdk/actions';
import {
    type PluginInvocationSurface,
} from '@happier-dev/plugin-sdk/interactions';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import {
    createTargetActionExecutor,
    fingerprintTargetActionPolicy,
    type ResolvedTargetAction,
    type TargetActionCurrentIntentRequest,
    type TargetActionCurrentIntentResult,
} from './actionExecutor';
import type { TargetActionAuthorizationFacts } from '../policy/evaluate';
import type {
    ResolveTargetActionHostBinding,
    TargetActionHostAccessRequest,
} from '../hostAccess/resolve';
import { fingerprintPluginHostAccessRequest } from '../hostAccess/scope';
import type {
    CreatePluginInvocationServices,
    PluginExternalActionContext,
    PluginInvocationServiceBinding,
} from './services/types';
import { createPluginInvocationPresentation } from './services/interactions';
import {
    createPluginInvocationLifetime,
    type PluginInvocationLifetime,
} from './lifetime';
import {
    resolveInvocationContributionPolicyFacts,
    resolveTargetActionAvailability,
    type ContributionPolicyFacts,
    type TargetActionPolicyDecision,
} from '../policy/evaluate';
import {
    createHostSessionPresentationOwner,
    type HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';

export type TargetActionDefinition = Readonly<{
    id: string;
    dangerLevel: PluginActionDangerLevelV2;
    scopes: readonly string[];
    surfaces: readonly string[];
    inputSchema?: object;
    resultSchema?: object;
    hostAccessRequests?: readonly TargetActionHostAccessRequest[];
    availability?: PluginActionAvailabilityV2 | null;
    confirmation?: PluginActionConfirmationV2;
    operation?: ActionOperationDeclarationV1;
}>;

/**
 * Invocation-bound bridge to the daemon's canonical operation runner. The
 * runner owns start and terminal state; this registry can only forward
 * plugin-authored progress while the handler remains unsettled.
 */
export type TargetActionOperationProgressPort = Readonly<{
    update(progress: PluginActionOperationProgressUpdateV1): void;
}>;

export type TargetActionInvocationRegistration = Readonly<{
    family?: string;
    pluginId: string;
    pluginVersion: string;
    /** Process-local target occurrence, projected by the runtime owner. */
    occurrenceId: PluginRuntimeOccurrenceId;
    /** Durable source custody stamped by the runtime owner. */
    sourceCustody?: PluginSourceCustodyV1;
    localId: string;
    definition: TargetActionDefinition;
    inputParser?: PluginActionInputParser;
    resultParser?: PluginActionInputParser;
    handler: ActionHandler<JsonValue, JsonValue | void>;
}>;

export type TargetActionInvocationResult = Readonly<
    | { status: 'executed'; value: JsonValue | null }
    | { status: 'deferred'; artifactId: string }
    | {
        status: 'unavailable' | 'invalid' | 'failed';
        code: string;
        message: string;
        /** Failures only, and only for a proven canonical PluginError. */
        retryable?: boolean;
        /** Failures only: the target's own published PluginError contract payload. */
        data?: JsonValue;
        /** Present only when the target handler did not begin. */
        actionHandlerInvocation?: PluginActionHandlerInvocation;
    }
>;

type TargetActionPreDispatchResult = Readonly<{
    status: 'unavailable' | 'invalid';
    code: string;
    message: string;
}>;

type TargetActionConnectedAccountOperationBinding = Readonly<{
    exactPurposeBindingSubjectId: string;
    dispose(): void;
}>;

export type InvokeTargetActionParams = Readonly<{
    pluginId: string;
    localId: string;
    input: unknown;
    surface: PluginInvocationSurface;
    /** Actual host invocation origin, distinct from the target capability surface. */
    invocationSurface?: PluginInvocationSurface;
    /** Host-stamped provenance for a plugin-to-plugin edge. */
    caller?: PluginInvocationCaller;
    initiatingActionCaller?: import('@happier-dev/protocol/actions').ActionCaller;
    startedBy?: import('@happier-dev/protocol').WorkflowRunStartedByV1;
    /** Host-private external API authority; never projected into plugin context. */
    externalActionContext?: PluginExternalActionContext;
    /**
     * Exact target-occurrence fact from an admitted targeted operation. It is
     * private Action-dispatch evidence, not a caller assertion or SDK input.
     */
    expectedAdmittedTargetOccurrence?: Readonly<{
        pluginId: string;
        occurrenceId: string;
    }>;
    /**
     * Daemon ingress revalidates a mounted caller's live machine context at
     * the last owner-controlled point before the target handler can effect.
     * This is request-scoped evidence, never persisted caller authority.
     */
    isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    /** Untrusted transient settlement from the mounted UI ingress only. */
    selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
    /** Bounded whole-message disclosure stamped by the ingress host. */
    messageAction?: MessageActionAvailableSnapshotV1;
    sessionId?: string;
    signal?: AbortSignal;
    facts?: ContributionPolicyFacts;
    requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
    /** Host-stamped durable target for exact API approval replay. */
    replayPlacement?: TargetActionApprovalReplayPlacementV1;
    /** Revalidate a durable approval against current policy before execution. */
    requireCurrentIntent?: true;
    /** Current host Action-settings enablement for this exact qualified target Action. */
    isEnabledByActionSettings?: () => boolean;
    /** Current host Action-settings policy for this exact qualified target Action. */
    isApprovalRequiredByActionSettings?: (manifestDefault: boolean) => boolean;
    /** Present only when the daemon operation runner already owns this invocation. */
    operationProgress?: TargetActionOperationProgressPort;
    /** Host-private custody admission; never projected into plugin context. */
    beforeHandlerInvocation?: () => Promise<void>;
}>;

export type TargetActionInvocationPreparation = Readonly<
    | { kind: 'settled'; result: TargetActionInvocationResult }
    | {
        kind: 'ready';
        run(options?: Readonly<{
            operationProgress?: TargetActionOperationProgressPort;
        }>): Promise<TargetActionInvocationResult>;
    }
>;

function projectPluginOperationProgress(
    update: PluginActionOperationProgressUpdateV1,
): PluginActionOperationProgressUpdateV1 {
    const hasCurrent = update.current !== undefined;
    const hasTotal = update.total !== undefined;
    const hasPhase = update.phase !== undefined;
    if (hasCurrent || hasTotal) {
        if (!hasCurrent || !hasTotal) {
            throw new TypeError('Determinate operation progress requires current and total');
        }
        const candidate = {
            kind: 'determinate' as const,
            current: update.current,
            total: update.total,
            ...(update.label === undefined ? {} : { label: update.label }),
        };
        const parsed = ActionOperationProgressV1Schema.safeParse(candidate);
        if (!parsed.success || parsed.data.kind !== 'determinate') {
            throw new TypeError('Invalid determinate operation progress');
        }
        return Object.freeze({
            current: parsed.data.current,
            total: parsed.data.total,
            ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
        });
    }
    if (hasPhase) {
        if (update.label === undefined) {
            throw new TypeError('Phase operation progress requires a label');
        }
        const parsed = ActionOperationProgressV1Schema.safeParse({
            kind: 'phase',
            phase: update.phase,
            label: update.label,
        });
        if (!parsed.success || parsed.data.kind !== 'phase') {
            throw new TypeError('Invalid phase operation progress');
        }
        return Object.freeze({ phase: parsed.data.phase, label: parsed.data.label });
    }
    const parsed = ActionOperationProgressV1Schema.safeParse({
        kind: 'indeterminate',
        ...(update.label === undefined ? {} : { label: update.label }),
    });
    if (!parsed.success) throw new TypeError('Invalid indeterminate operation progress');
    return Object.freeze(parsed.data.label === undefined ? {} : { label: parsed.data.label });
}

function actionKey(pluginId: string, localId: string): string {
    return `${pluginId}\u0000${localId}`;
}

function unavailable(code: string, message: string): TargetActionInvocationResult {
    return Object.freeze({
        status: 'unavailable',
        code,
        message,
        actionHandlerInvocation: 'notStarted',
    });
}

export function createTargetActionInvocationRegistry(params: Readonly<{
    actions: readonly TargetActionInvocationRegistration[];
    expectedActions?: readonly Readonly<{ pluginId: string; localId: string }>[];
    readActions?: () => readonly TargetActionInvocationRegistration[];
    resolveAuthorizationFacts: (action: ResolvedTargetAction) => TargetActionAuthorizationFacts;
    evaluateCatalogPolicy?: (params: Readonly<{
        pluginId: string;
        localId: string;
    }>) => TargetActionPolicyDecision;
    /**
     * The runtime final-policy owner supplies this read-only projection. The
     * invocation registry only delegates; it does not derive policy facts.
     */
    resolvePresentUserGatePolicy?: (
        pluginId: string,
        localId: string,
    ) => PluginActionPresentUserGatePolicy | null;
    resolveHostBinding: ResolveTargetActionHostBinding;
    createServices: CreatePluginInvocationServices;
    redactDiagnosticText?: (
        scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
        value: string,
    ) => string;
    completeDiagnosticScope?: (
        scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
    ) => void;
    /**
     * Host-private current materialization for the exact target invocation.
     * It is the sole source for restamping a plugin-to-plugin caller edge.
     */
    resolveCurrentPluginMaterializationRef?(pluginId: string): PluginMachineMaterializationRefV1 | null;
    /** Canonical process-local occurrence authority for final Action admission. */
    readCurrentPluginOccurrenceId?(pluginId: string): string | null;
    resolveCurrentSessionUi?: (sessionId: string) => HostCurrentSessionUiServices | null;
    /**
     * Host-owned Action-form recheck. It runs after canonical
     * input-schema admission and immediately before the target handler.
     */
    revalidateActionFormInput?(input: Readonly<{
        pluginId: string;
        localId: string;
        input: unknown;
        sessionId?: string;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<TargetActionPreDispatchResult | null>;
    /**
     * Host-private binding for this one admitted target-Action correlation.
     * It is deliberately neither a occurrenceId nor a background-service lease.
     */
    bindConnectedAccountActionOperation?(input: Readonly<{
        pluginId: string;
        localId: string;
        input: unknown;
        correlationId: string;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<TargetActionConnectedAccountOperationBinding | TargetActionPreDispatchResult | null>;
}>): Readonly<{
    expects(pluginId: string, localId: string): boolean;
    has(pluginId: string, localId: string): boolean;
    evaluateCatalogPolicy(pluginId: string, localId: string): TargetActionPolicyDecision;
    resolvePresentUserGatePolicy?(
        pluginId: string,
        localId: string,
    ): PluginActionPresentUserGatePolicy | null;
    prepare(params: InvokeTargetActionParams): Promise<TargetActionInvocationPreparation>;
    invoke(params: InvokeTargetActionParams): Promise<TargetActionInvocationResult>;
    refresh(): void;
    dispose(): void;
}> {
    const registryController = new AbortController();
    type IndexedAction = Readonly<{
        registration: TargetActionInvocationRegistration;
        invocation: ReturnType<typeof createPluginActionInvocation>;
        /** The exact retirement signal this entry's invocation was prepared against. */
        registrySignal: AbortSignal;
        isCurrent(): boolean;
    }>;

    /**
     * Preparing an invocation compiles the Action's input and result JSON Schemas, which builds a
     * schema compiler and generates a validator for each. `refresh()` runs after every on-demand
     * activation, including the ones that publish nothing, so recompiling an unchanged Action
     * occurrence is the dominant cost of re-indexing and is pure waste.
     *
     * `createPluginActionInvocation` reads only the ids, the two schemas and the registry
     * signal. When all of those are the identical values the previous entry was prepared from,
     * a recompilation can only reproduce the validators it already holds.
     */
    function canReusePreparedInvocation(
        previous: IndexedAction,
        registration: TargetActionInvocationRegistration,
        registrySignal: AbortSignal,
    ): boolean {
        return previous.registrySignal === registrySignal
            && previous.registration.pluginId === registration.pluginId
            && previous.registration.localId === registration.localId
            && previous.registration.occurrenceId === registration.occurrenceId
            && previous.registration.definition.inputSchema === registration.definition.inputSchema
            && previous.registration.definition.resultSchema === registration.definition.resultSchema
            && previous.registration.inputParser === registration.inputParser
            && previous.registration.resultParser === registration.resultParser;
    }

    function buildIndex(
        registrations: readonly TargetActionInvocationRegistration[],
        previous: ReadonlyMap<string, IndexedAction> = new Map(),
    ): ReadonlyMap<string, IndexedAction> {
        const next = new Map<string, IndexedAction>();
        for (const registration of registrations) {
            if (registration.family !== undefined && registration.family !== 'actions') {
                throw new Error(`Target invocation registration has wrong family '${registration.family}'`);
            }
            if (registration.localId !== registration.definition.id) {
                throw new Error(`Target action publication id '${registration.localId}' does not match manifest id '${registration.definition.id}'`);
            }
            const key = actionKey(registration.pluginId, registration.localId);
            if (next.has(key)) throw new Error(`Duplicate target action '${registration.pluginId}/actions/${registration.localId}'`);
            const definition: TargetActionDefinition = Object.freeze({
                id: registration.definition.id,
                dangerLevel: registration.definition.dangerLevel,
                scopes: Object.freeze([...registration.definition.scopes]),
                surfaces: Object.freeze([...registration.definition.surfaces]),
                ...(registration.definition.confirmation === undefined
                    ? {}
                    : { confirmation: registration.definition.confirmation }),
                ...(registration.definition.hostAccessRequests === undefined
                    ? {}
                    : {
                        hostAccessRequests: Object.freeze(registration.definition.hostAccessRequests.map((entry) => Object.freeze({
                            request: PluginHostAccessRequestV2Schema.parse(entry.request),
                            required: entry.required,
                        }))),
                    }),
                ...(registration.definition.inputSchema === undefined ? {} : { inputSchema: registration.definition.inputSchema }),
                ...(registration.definition.resultSchema === undefined ? {} : { resultSchema: registration.definition.resultSchema }),
                ...(registration.definition.availability === undefined ? {} : { availability: registration.definition.availability }),
                ...(registration.definition.operation === undefined
                    ? {}
                    : { operation: Object.freeze({ ...registration.definition.operation }) }),
            });
            const storedRegistration = Object.freeze({ ...registration, definition });
            const isRegistrationCurrent = () => (
                !registryController.signal.aborted
                && actionsByKey.get(key)?.registration.occurrenceId === registration.occurrenceId
                && (registration.occurrenceId === undefined
                    || params.readCurrentPluginOccurrenceId?.(registration.pluginId) === registration.occurrenceId)
            );
            const registrySignal = registryController.signal;
            const reusable = previous.get(key);
            const invocation = reusable
                && canReusePreparedInvocation(reusable, storedRegistration, registrySignal)
                ? reusable.invocation
                : createPluginActionInvocation({
                    pluginId: registration.pluginId,
                    localId: registration.localId,
                    ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
                    ...(registration.inputParser === undefined ? {} : { inputParser: registration.inputParser }),
                    ...(definition.resultSchema === undefined ? {} : { resultSchema: definition.resultSchema }),
                    ...(registration.resultParser === undefined ? {} : { resultParser: registration.resultParser }),
                    occurrenceSignal: registrySignal,
                    isCurrent: isRegistrationCurrent,
                });
            next.set(key, Object.freeze({
                registration: storedRegistration,
                invocation,
                registrySignal,
                isCurrent: isRegistrationCurrent,
            }));
        }
        return next;
    }

    let actionsByKey = buildIndex(params.actions);
    const expectedActionKeys = new Set([
        ...params.actions.map((registration) => actionKey(registration.pluginId, registration.localId)),
        ...(params.expectedActions ?? []).map((expected) => actionKey(expected.pluginId, expected.localId)),
    ]);

    const isExpectedAdmittedTargetCurrent = async (
        expected: NonNullable<InvokeTargetActionParams['expectedAdmittedTargetOccurrence']>,
        caller: PluginInvocationCaller | undefined,
    ): Promise<boolean> => {
        if (caller?.kind !== 'plugin' || caller.pluginId !== expected.pluginId) {
            return false;
        }
        try {
            return params.readCurrentPluginOccurrenceId?.(expected.pluginId)
                === expected.occurrenceId;
        } catch {
            return false;
        }
    };

    async function invokeHandler(
        indexed: IndexedAction,
        invocation: InvokeTargetActionParams,
        serviceBinding: PluginInvocationServiceBinding,
        correlationId: string,
        lifetime: PluginInvocationLifetime,
    ): Promise<TargetActionInvocationResult> {
        const { registration } = indexed;
        let actionHandlerInvocation: PluginActionHandlerInvocation | undefined = 'notStarted';
        const operationProgress = registration.definition.operation
            ? invocation.operationProgress
            : undefined;
        let operationSettled = false;
        const result = await indexed.invocation.invoke(invocation.input, {
            ...(invocation.signal ? { signal: invocation.signal } : {}),
            ...(params.revalidateActionFormInput
                ? {
                    preDispatch: ({ input, signal }) => (
                        params.revalidateActionFormInput!({
                            pluginId: registration.pluginId,
                            localId: registration.localId,
                            input,
                            ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                            signal,
                            isCurrent: indexed.isCurrent,
                        })
                    ),
                }
                : {}),
            handler: async ({ input, qualifiedId, signal }) => {
                const abortContext = () => {
                    lifetime.complete();
                };
                signal.addEventListener('abort', abortContext, { once: true });
                if (signal.aborted) abortContext();
                const currentSession = invocation.sessionId
                    ? params.resolveCurrentSessionUi?.(invocation.sessionId) ?? null
                    : null;
                // Only managed source custody carries the retained immutable
                // package occurrenceId used to qualify Session presentation
                // keys. Live invocation currentness remains occurrence-owned.
                const presentationOwner = invocation.sessionId && registration.sourceCustody?.kind === 'managed'
                    ? createHostSessionPresentationOwner({
                        pluginId: registration.pluginId,
                        contributionId: registration.localId,
                        generationId: registration.sourceCustody.immutableGenerationId,
                        invocationId: correlationId,
                    })
                    : undefined;
                const messageAction = invocation.messageAction
                    ? Object.freeze({ ...invocation.messageAction })
                    : undefined;
                const seed = Object.freeze({
                    plugin: Object.freeze({ id: registration.pluginId, version: registration.pluginVersion }),
                    contribution: Object.freeze({ id: registration.localId, qualifiedId }),
                    occurrenceId: registration.occurrenceId,
                    ...(registration.sourceCustody === undefined
                        ? {}
                        : { sourceCustody: registration.sourceCustody }),
                    correlationId,
                    surface: invocation.surface,
                    ...(invocation.caller ? { caller: invocation.caller } : {}),
                    ...(invocation.initiatingActionCaller ? { initiatingActionCaller: invocation.initiatingActionCaller } : {}),
                    ...(invocation.startedBy ? { startedBy: invocation.startedBy } : {}),
                    ...(invocation.externalActionContext
                        ? { externalActionContext: invocation.externalActionContext }
                        : {}),
                    ...(invocation.selectedActionInputCarrier
                        ? { selectedActionInputCarrier: invocation.selectedActionInputCarrier }
                        : {}),
                    ...(invocation.isMountedCallerCurrent
                        ? { isMountedCallerCurrent: invocation.isMountedCallerCurrent }
                        : {}),
                    ...(params.resolveCurrentPluginMaterializationRef
                        ? {
                            resolveCurrentPluginMaterializationRef: () => (
                                params.resolveCurrentPluginMaterializationRef!(
                                    registration.pluginId,
                                )
                            ),
                        }
                        : {}),
                    ...(invocation.sessionId ? { session: Object.freeze({ id: invocation.sessionId }) } : {}),
                    ...(messageAction ? { messageAction } : {}),
                    ...(currentSession ? { currentSession } : {}),
                    signal: lifetime.signal,
                    redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                    isOccurrenceCurrent: indexed.isCurrent,
                });
                let connectedAccountOperationBinding:
                    | TargetActionConnectedAccountOperationBinding
                    | null = null;
                const disposeConnectedAccountOperationBinding = () => {
                    const binding = connectedAccountOperationBinding;
                    connectedAccountOperationBinding = null;
                    binding?.dispose();
                };
                const abortConnectedAccountOperationBinding = () => {
                    disposeConnectedAccountOperationBinding();
                };
                signal.addEventListener(
                    'abort',
                    abortConnectedAccountOperationBinding,
                    { once: true },
                );
                try {
                    // Currentness was admitted in `prepare` and re-checked once
                    // immediately before this handler (the executor `invoke`
                    // callback). Admitted work now runs under its captured
                    // lease; only cancellation stops it.
                    const operationResult = await params.bindConnectedAccountActionOperation?.({
                        pluginId: registration.pluginId,
                        localId: registration.localId,
                        input,
                        correlationId,
                        signal: lifetime.signal,
                        isCurrent: () => (
                            !signal.aborted
                            && !lifetime.signal.aborted
                            && indexed.isCurrent()
                        ),
                    });
                    if (operationResult && 'status' in operationResult) {
                        throw new PluginError({
                            code: operationResult.code,
                            message: operationResult.message,
                        });
                    }
                    connectedAccountOperationBinding = operationResult ?? null;
                    if (signal.aborted || lifetime.signal.aborted) {
                        throw new PluginError({
                            code: 'plugin_action_generation_retired',
                            message: 'Plugin action operation retired before dispatch',
                        });
                    }
                    const effectiveServiceBinding = connectedAccountOperationBinding
                        ? Object.freeze({
                            ...serviceBinding,
                            exactPurposeBindingSubjectId:
                                connectedAccountOperationBinding.exactPurposeBindingSubjectId,
                        })
                        : serviceBinding;
                    const services = params.createServices(seed, effectiveServiceBinding);
                    const context: PluginInvocationContext = Object.freeze({
                        plugin: seed.plugin,
                        contribution: seed.contribution,
                        surface: seed.surface,
                        invokedAtMs: lifetime.invokedAtMs,
                        ...(seed.caller ? { caller: seed.caller } : {}),
                        ...(seed.session ? { session: seed.session } : {}),
                        ...(seed.messageAction ? { messageAction: seed.messageAction } : {}),
                        ...(registration.definition.operation?.progress === 'reported' && operationProgress
                            ? {
                                operation: Object.freeze({
                                    update: (progress: PluginActionOperationProgressUpdateV1): void => {
                                        if (operationSettled || lifetime.signal.aborted) return;
                                        operationProgress.update(projectPluginOperationProgress(progress));
                                    },
                                }),
                            }
                            : {}),
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession,
                            signal: seed.signal,
                            isOccurrenceCurrent: seed.isOccurrenceCurrent,
                            ...(presentationOwner ? { presentationOwner } : {}),
                        }),
                    });
                    if (invocation.beforeHandlerInvocation) {
                        await invocation.beforeHandlerInvocation();
                        // The custody transition awaits transport. Retirement during that
                        // wait still forbids the plugin effect, even if the server accepted
                        // the transition and must now recover an ambiguous started lease.
                        if (signal.aborted || lifetime.signal.aborted || !indexed.isCurrent()) {
                            throw new PluginError({
                                code: 'plugin_action_generation_retired',
                                message: 'Plugin action retired during custody admission',
                            });
                        }
                    }
                    actionHandlerInvocation = undefined;
                    return await registration.handler(input, context);
                } finally {
                    signal.removeEventListener(
                        'abort',
                        abortConnectedAccountOperationBinding,
                    );
                    disposeConnectedAccountOperationBinding();
                    signal.removeEventListener('abort', abortContext);
                    lifetime.settleContext();
                }
            },
        });
        operationSettled = true;
        if (result.status === 'executed' || actionHandlerInvocation === undefined) {
            return result;
        }
        return Object.freeze({
            ...result,
            actionHandlerInvocation,
        });
    }

    return Object.freeze({
        expects(pluginId, localId) {
            return expectedActionKeys.has(actionKey(pluginId, localId));
        },
        has(pluginId, localId) {
            return actionsByKey.has(actionKey(pluginId, localId));
        },
        evaluateCatalogPolicy(pluginId, localId) {
            return params.evaluateCatalogPolicy?.({ pluginId, localId }) ?? Object.freeze({
                outcome: 'unavailable',
                code: 'plugin_action_authorization_unavailable',
                requiresCurrentIntent: false,
            });
        },
        ...(params.resolvePresentUserGatePolicy
            ? {
                resolvePresentUserGatePolicy(pluginId: string, localId: string) {
                    return params.resolvePresentUserGatePolicy!(pluginId, localId);
                },
            }
            : {}),
        async prepare(invocation: InvokeTargetActionParams): Promise<TargetActionInvocationPreparation> {
            const key = actionKey(invocation.pluginId, invocation.localId);
            const indexed = actionsByKey.get(key);
            if (!indexed) return Object.freeze({
                kind: 'settled' as const,
                result: unavailable('plugin_action_handler_missing', 'No committed target action registration exists'),
            });
            if (registryController.signal.aborted) {
                return Object.freeze({
                    kind: 'settled' as const,
                    result: unavailable('plugin_action_generation_retired', 'Plugin action occurrence is no longer current'),
                });
            }
            if (!indexed.isCurrent()) return Object.freeze({
                kind: 'settled' as const,
                result: unavailable('plugin_action_generation_retired', 'Plugin action occurrence is no longer current'),
            });
            let operationProgress = invocation.operationProgress;
            const correlationId = randomUUID();
            const lifetime = createPluginInvocationLifetime(invocation.signal);
            const diagnosticScope = Object.freeze({
                pluginId: indexed.registration.pluginId,
                occurrenceId: indexed.registration.occurrenceId,
                correlationId,
            });
            const resolveCurrentAction = (): ResolvedTargetAction | null => {
                const current = actionsByKey.get(key);
                if (!current) return null;
                const { registration } = current;
                if (!registration.sourceCustody) return null;
                const availability = resolveTargetActionAvailability({
                    availability: registration.definition.availability ?? undefined,
                    facts: resolveInvocationContributionPolicyFacts({
                        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                        facts: invocation.facts,
                    }),
                });
                let approvalRequiredByActionSettings: boolean | undefined;
                try {
                    approvalRequiredByActionSettings = invocation
                        .isApprovalRequiredByActionSettings?.(pluginActionRequiresPresentUserIntent(
                            registration.definition,
                            invocation.invocationSurface ?? invocation.surface,
                        ));
                } catch {
                    // A failed host settings re-read cannot authorize a plugin Action.
                    approvalRequiredByActionSettings = true;
                }
                const action = {
                    qualifiedId: `${registration.pluginId}/actions/${registration.localId}`,
                    pluginId: registration.pluginId, localId: registration.localId,
                    occurrenceId: registration.occurrenceId, dangerLevel: registration.definition.dangerLevel,
                    sourceCustody: registration.sourceCustody,
                    scopes: registration.definition.scopes, surfaces: registration.definition.surfaces,
                    ...(registration.definition.confirmation === undefined
                        ? {}
                        : { confirmation: registration.definition.confirmation }),
                    ...(approvalRequiredByActionSettings === undefined
                        ? {}
                        : { approvalRequiredByActionSettings }),
                    hostAccess: (registration.definition.hostAccessRequests ?? []).map(({ request, required }) => ({
                        id: request.id,
                        required,
                        status: 'unavailable' as const,
                        code: 'plugin_host_access_context_unavailable',
                        requestFingerprint: fingerprintPluginHostAccessRequest(request),
                    })),
                    ...(availability ? { availability } : {}),
                    input: invocation.input,
                };
                return Object.freeze({ ...action, policyFingerprint: fingerprintTargetActionPolicy(action) });
            };
            const executor = createTargetActionExecutor({
                resolve: resolveCurrentAction,
                resolveAuthorizationFacts: params.resolveAuthorizationFacts,
                resolveHostBinding: async (action) => await params.resolveHostBinding(action, {
                    hostAccessRequests: actionsByKey.get(key)?.registration.definition.hostAccessRequests ?? [],
                    surface: invocation.surface,
                    ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                    ...(invocation.signal ? { signal: invocation.signal } : {}),
                }),
                invoke: async (action, _args, serviceBinding) => {
                    const current = actionsByKey.get(key);
                    if (!current || !indexed.isCurrent()) {
                        return unavailable('plugin_action_generation_retired', 'Plugin action occurrence is no longer current');
                    }
                    try {
                        if (invocation.isEnabledByActionSettings?.() === false) {
                            return unavailable(
                                'plugin_action_unavailable',
                                'Plugin action is disabled by Action settings',
                            );
                        }
                    } catch {
                        return unavailable(
                            'plugin_action_unavailable',
                            'Plugin action settings are unavailable',
                        );
                    }
                    if (invocation.isMountedCallerCurrent) {
                        let mountedCallerCurrent = false;
                        try {
                            mountedCallerCurrent = await invocation.isMountedCallerCurrent();
                        } catch {
                            // The live machine context is external/currentness
                            // evidence. A failed re-read cannot authorize an
                            // already-mounted caller to reach a target handler.
                        }
                        if (!mountedCallerCurrent) {
                            return unavailable(
                                'plugin_mounted_caller_unavailable',
                                'Mounted plugin caller is no longer current',
                            );
                        }
                    }
                    if (
                        invocation.expectedAdmittedTargetOccurrence
                        && !(await isExpectedAdmittedTargetCurrent(
                            invocation.expectedAdmittedTargetOccurrence,
                            invocation.caller,
                        ))
                    ) {
                        return unavailable(
                            'plugin_action_generation_retired',
                            'Admitted target occurrence is no longer current',
                        );
                    }
                    return await invokeHandler(
                        current,
                        Object.freeze({
                            ...invocation,
                            ...(operationProgress ? { operationProgress } : {}),
                        }),
                        serviceBinding,
                        correlationId,
                        lifetime,
                    );
                },
                ...(params.redactDiagnosticText
                    ? {
                        redactFailureText: (_action, value) => params.redactDiagnosticText!(
                            diagnosticScope,
                            value,
                        ),
                    }
                    : {}),
            });
            const complete = (): void => {
                try {
                    params.completeDiagnosticScope?.(diagnosticScope);
                } catch {
                    // Diagnostic lease cleanup cannot replace the action result.
                } finally {
                    lifetime.complete();
                }
            };
            const prepared = await executor.prepare({
                    pluginId: invocation.pluginId, localId: invocation.localId, input: invocation.input,
                    surface: invocation.surface,
                    ...(invocation.invocationSurface ? { invocationSurface: invocation.invocationSurface } : {}),
                    ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                    ...(invocation.signal ? { signal: invocation.signal } : {}),
                    ...(invocation.replayPlacement ? { replayPlacement: invocation.replayPlacement } : {}),
                    ...(invocation.requireCurrentIntent === true ? { requireCurrentIntent: true as const } : {}),
                    ...(invocation.requestCurrentIntent ? { requestCurrentIntent: invocation.requestCurrentIntent } : {}),
            });
            if (prepared.kind === 'settled') {
                complete();
                return prepared;
            }
            let runPromise: Promise<TargetActionInvocationResult> | null = null;
            return Object.freeze({
                kind: 'ready' as const,
                run(options?: Readonly<{
                    operationProgress?: TargetActionOperationProgressPort;
                }>): Promise<TargetActionInvocationResult> {
                    if (runPromise) return runPromise;
                    operationProgress = options?.operationProgress ?? operationProgress;
                    runPromise = prepared.run().finally(complete);
                    return runPromise;
                },
            });
        },
        async invoke(invocation): Promise<TargetActionInvocationResult> {
            const prepared = await (this as Readonly<{
                prepare(input: InvokeTargetActionParams): Promise<TargetActionInvocationPreparation>;
            }>).prepare(invocation);
            return prepared.kind === 'settled'
                ? prepared.result
                : await prepared.run({
                    ...(invocation.operationProgress
                        ? { operationProgress: invocation.operationProgress }
                        : {}),
                });
        },
        refresh() {
            if (registryController.signal.aborted || !params.readActions) return;
            const next = buildIndex(params.readActions(), actionsByKey);
            for (const key of next.keys()) expectedActionKeys.add(key);
            actionsByKey = next;
        },
        dispose() {
            if (!registryController.signal.aborted) {
                registryController.abort(new PluginError({
                    code: 'plugin_action_generation_retired',
                    message: 'Plugin action occurrence retired',
                }));
            }
        },
    });
}
