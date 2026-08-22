import { randomUUID } from 'node:crypto';

import {
    createPluginActionInvocation,
    PluginHostAccessRequestV2Schema,
    type PluginActionPresentUserGatePolicy,
} from '@happier-dev/protocol';
import type { PluginUiSelectedActionInputCarrierV1 } from '@happier-dev/protocol/plugins/ui';
import type {
    MessageActionAvailableSnapshotV1,
    PluginActionAvailabilityV2,
    PluginActionConfirmationV2,
    PluginActionDangerLevelV2,
    PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';

import {
    PluginError,
    type JsonValue,
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
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';

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
}>;

export type TargetActionInvocationRegistration = Readonly<{
    family?: string;
    pluginId: string;
    pluginVersion: string;
    generation: string;
    /** Exact admitted plugin bytes, projected by the runtime owner. */
    immutableGenerationId?: string;
    localId: string;
    definition: TargetActionDefinition;
    handler: ActionHandler<JsonValue, JsonValue | void>;
}>;

export type TargetActionInvocationResult = Readonly<
    | { status: 'executed'; value: JsonValue | null }
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
    status: 'unavailable';
    code: string;
    message: string;
}>;

type TargetActionConnectedAccountOperationBinding = Readonly<{
    exactPurposeBindingSubjectId: string;
    dispose(): void;
}>;

type InvokeTargetActionParams = Readonly<{
    pluginId: string;
    localId: string;
    input: unknown;
    surface: PluginInvocationSurface;
    /** Actual host invocation origin, distinct from the target capability surface. */
    invocationSurface?: PluginInvocationSurface;
    /** Host-stamped provenance for a plugin-to-plugin edge. */
    caller?: PluginInvocationCaller;
    /**
     * Exact target-generation fact from an admitted targeted operation. It is
     * private Action-dispatch evidence, not a caller assertion or SDK input.
     */
    expectedAdmittedTargetGeneration?: Readonly<{
        pluginId: string;
        immutableGenerationId: string;
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
}>;

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
        scope: Readonly<{ pluginId: string; generation: string; correlationId: string }>,
        value: string,
    ) => string;
    completeDiagnosticScope?: (
        scope: Readonly<{ pluginId: string; generation: string; correlationId: string }>,
    ) => void;
    resolveGenerationLifecycle?(pluginId: string): Readonly<{
        isCurrent(): boolean;
        retirementSignal: AbortSignal;
    }>;
    /**
     * Host-private current materialization for the exact target invocation.
     * It is the sole source for restamping a plugin-to-plugin caller edge.
     */
    resolveCurrentPluginMaterializationRef?(pluginId: string): PluginMachineMaterializationRefV1 | null;
    /** Canonical committed immutable-generation authority for final Action admission. */
    resolveCurrentPluginImmutableGenerationId?(pluginId: string): Promise<string | null>;
    resolveCurrentSessionUi?: (sessionId: string) => HostCurrentSessionUiServices | null;
    /**
     * Narrow host-owned Action-form Account recheck. It runs after canonical
     * input-schema admission and immediately before the target handler.
     */
    revalidateConnectedAccountActionFormInput?(input: Readonly<{
        pluginId: string;
        localId: string;
        input: unknown;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<TargetActionPreDispatchResult | null>;
    /**
     * Host-private binding for this one admitted target-Action correlation.
     * It is deliberately neither a generation nor a background-service lease.
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
    invoke(params: InvokeTargetActionParams): Promise<TargetActionInvocationResult>;
    refresh(): void;
    dispose(): void;
}> {
    const generationController = new AbortController();
    type IndexedAction = Readonly<{
        registration: TargetActionInvocationRegistration;
        invocation: ReturnType<typeof createPluginActionInvocation>;
        isCurrent(): boolean;
    }>;

    function buildIndex(registrations: readonly TargetActionInvocationRegistration[]): ReadonlyMap<string, IndexedAction> {
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
            });
            const storedRegistration = Object.freeze({ ...registration, definition });
            const lifecycle = params.resolveGenerationLifecycle?.(registration.pluginId);
            const isRegistrationCurrent = () => (
                !generationController.signal.aborted
                && (params.resolveGenerationLifecycle?.(registration.pluginId).isCurrent() ?? true)
                && actionsByKey.get(key)?.registration.generation === registration.generation
            );
            const invocation = createPluginActionInvocation({
                pluginId: registration.pluginId,
                localId: registration.localId,
                ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
                ...(definition.resultSchema === undefined ? {} : { resultSchema: definition.resultSchema }),
                generationSignal: lifecycle?.retirementSignal ?? generationController.signal,
                isCurrent: isRegistrationCurrent,
            });
            next.set(key, Object.freeze({
                registration: storedRegistration,
                invocation,
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
        expected: NonNullable<InvokeTargetActionParams['expectedAdmittedTargetGeneration']>,
        caller: PluginInvocationCaller | undefined,
    ): Promise<boolean> => {
        if (caller?.kind !== 'plugin' || caller.pluginId !== expected.pluginId) {
            return false;
        }
        try {
            return await params.resolveCurrentPluginImmutableGenerationId?.(
                expected.pluginId,
            ) === expected.immutableGenerationId;
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
        const result = await indexed.invocation.invoke(invocation.input, {
            ...(invocation.signal ? { signal: invocation.signal } : {}),
            ...(params.revalidateConnectedAccountActionFormInput
                ? {
                    preDispatch: ({ input, signal }) => (
                        params.revalidateConnectedAccountActionFormInput!({
                            pluginId: registration.pluginId,
                            localId: registration.localId,
                            input,
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
                // Only the target-action host has the exact immutable
                // generation, contribution and invocation correlation needed
                // to qualify transient status/widget keys. Other invocation
                // paths remain deliberately unavailable rather than inventing
                // a plugin prefix or a mutable-generation substitute.
                const presentationOwner = invocation.sessionId && registration.immutableGenerationId
                    ? Object.freeze({
                        pluginId: registration.pluginId,
                        contributionId: registration.localId,
                        generationId: registration.immutableGenerationId,
                        invocationId: correlationId,
                    })
                    : undefined;
                const messageAction = invocation.messageAction
                    ? Object.freeze({ ...invocation.messageAction })
                    : undefined;
                const seed = Object.freeze({
                    plugin: Object.freeze({ id: registration.pluginId, version: registration.pluginVersion }),
                    contribution: Object.freeze({ id: registration.localId, qualifiedId }),
                    generation: registration.generation,
                    ...(registration.immutableGenerationId === undefined
                        ? {}
                        : { immutableGenerationId: registration.immutableGenerationId }),
                    correlationId,
                    surface: invocation.surface,
                    ...(invocation.caller ? { caller: invocation.caller } : {}),
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
                    isGenerationCurrent: indexed.isCurrent,
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
                    if (!seed.isGenerationCurrent()) {
                        throw new PluginError({
                            code: 'plugin_action_generation_retired',
                            message: 'Plugin action generation retired before dispatch',
                        });
                    }
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
                    if (signal.aborted || lifetime.signal.aborted || !indexed.isCurrent()) {
                        throw new PluginError({
                            code: 'plugin_action_generation_retired',
                            message: 'Plugin action operation retired before dispatch',
                        });
                    }
                    if (
                        invocation.expectedAdmittedTargetGeneration
                        && !(await isExpectedAdmittedTargetCurrent(
                            invocation.expectedAdmittedTargetGeneration,
                            invocation.caller,
                        ))
                    ) {
                        throw new PluginError({
                            code: 'plugin_action_generation_retired',
                            message: 'Admitted target generation is no longer current',
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
                        ...(seed.caller ? { caller: seed.caller } : {}),
                        ...(seed.session ? { session: seed.session } : {}),
                        ...(seed.messageAction ? { messageAction: seed.messageAction } : {}),
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession,
                            signal: seed.signal,
                            isGenerationCurrent: seed.isGenerationCurrent,
                            ...(presentationOwner ? { presentationOwner } : {}),
                        }),
                    });
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
        async invoke(invocation): Promise<TargetActionInvocationResult> {
            const key = actionKey(invocation.pluginId, invocation.localId);
            const indexed = actionsByKey.get(key);
            if (!indexed) return unavailable('plugin_action_handler_missing', 'No committed target action registration exists');
            if (generationController.signal.aborted) {
                return unavailable('plugin_action_generation_retired', 'Plugin action generation is no longer current');
            }
            if (params.resolveGenerationLifecycle?.(indexed.registration.pluginId).isCurrent() === false) {
                return unavailable('plugin_action_generation_retired', 'Plugin action generation is no longer current');
            }
            const correlationId = randomUUID();
            const lifetime = createPluginInvocationLifetime(invocation.signal);
            const diagnosticScope = Object.freeze({
                pluginId: indexed.registration.pluginId,
                generation: indexed.registration.generation,
                correlationId,
            });
            const resolveCurrentAction = (): ResolvedTargetAction | null => {
                const current = actionsByKey.get(key);
                if (!current) return null;
                const { registration } = current;
                const availability = resolveTargetActionAvailability({
                    availability: registration.definition.availability ?? undefined,
                    facts: resolveInvocationContributionPolicyFacts({
                        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                        facts: invocation.facts,
                    }),
                });
                const action = {
                    qualifiedId: `${registration.pluginId}/actions/${registration.localId}`,
                    pluginId: registration.pluginId, localId: registration.localId,
                    generation: registration.generation, dangerLevel: registration.definition.dangerLevel,
                    scopes: registration.definition.scopes, surfaces: registration.definition.surfaces,
                    ...(registration.definition.confirmation === undefined
                        ? {}
                        : { confirmation: registration.definition.confirmation }),
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
                    if (!current || current.registration.generation !== action.generation) {
                        return unavailable('plugin_action_generation_retired', 'Plugin action generation is no longer current');
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
                        invocation.expectedAdmittedTargetGeneration
                        && !(await isExpectedAdmittedTargetCurrent(
                            invocation.expectedAdmittedTargetGeneration,
                            invocation.caller,
                        ))
                    ) {
                        return unavailable(
                            'plugin_action_generation_retired',
                            'Admitted target generation is no longer current',
                        );
                    }
                    return await invokeHandler(
                        current,
                        invocation,
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
            try {
                return await executor.execute({
                    pluginId: invocation.pluginId, localId: invocation.localId, input: invocation.input,
                    surface: invocation.surface,
                    ...(invocation.invocationSurface ? { invocationSurface: invocation.invocationSurface } : {}),
                    ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                    ...(invocation.signal ? { signal: invocation.signal } : {}),
                    ...(invocation.requestCurrentIntent ? { requestCurrentIntent: invocation.requestCurrentIntent } : {}),
                });
            } finally {
                try {
                    params.completeDiagnosticScope?.(diagnosticScope);
                } catch {
                    // Diagnostic lease cleanup cannot replace the action result.
                } finally {
                    lifetime.complete();
                }
            }
        },
        refresh() {
            if (generationController.signal.aborted || !params.readActions) return;
            const next = buildIndex(params.readActions());
            for (const key of next.keys()) expectedActionKeys.add(key);
            actionsByKey = next;
        },
        dispose() {
            if (!generationController.signal.aborted) {
                generationController.abort(new PluginError({
                    code: 'plugin_action_generation_retired',
                    message: 'Plugin action generation retired',
                }));
            }
        },
    });
}
