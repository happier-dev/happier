import { randomUUID } from 'node:crypto';

import {
    createPluginActionInvocation,
    PluginHostAccessRequestV2Schema,
} from '@happier-dev/protocol';
import type {
    PluginActionAvailabilityV2,
    PluginActionConfirmationV2,
    PluginActionDangerLevelV2,
} from '@happier-dev/protocol';

import {
    PluginError,
    type JsonValue,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
    type ActionHandler,
    type PluginInvocationSurface,
} from '@happier-dev/plugin-sdk/runtime';
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
import { createPluginInvocationUi } from './services/ui';
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
    localId: string;
    definition: TargetActionDefinition;
    handler: ActionHandler<JsonValue, JsonValue | void>;
}>;

export type TargetActionInvocationResult = Readonly<
    | { status: 'executed'; value: JsonValue | null }
    | { status: 'unavailable' | 'invalid' | 'failed'; code: string; message: string }
>;

type InvokeTargetActionParams = Readonly<{
    pluginId: string;
    localId: string;
    input: unknown;
    surface: PluginInvocationSurface;
    sessionId?: string;
    signal?: AbortSignal;
    facts?: ContributionPolicyFacts;
    requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
}>;

function actionKey(pluginId: string, localId: string): string {
    return `${pluginId}\u0000${localId}`;
}

function unavailable(code: string, message: string): TargetActionInvocationResult {
    return Object.freeze({ status: 'unavailable', code, message });
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
    resolveHostBinding: ResolveTargetActionHostBinding;
    createServices: CreatePluginInvocationServices;
    resolveGenerationLifecycle?(pluginId: string): Readonly<{
        isCurrent(): boolean;
        retirementSignal: AbortSignal;
    }>;
    resolveCurrentSessionUi?: (sessionId: string) => HostCurrentSessionUiServices | null;
}>): Readonly<{
    expects(pluginId: string, localId: string): boolean;
    has(pluginId: string, localId: string): boolean;
    evaluateCatalogPolicy(pluginId: string, localId: string): TargetActionPolicyDecision;
    invoke(params: InvokeTargetActionParams): Promise<TargetActionInvocationResult>;
    refresh(): void;
    dispose(): void;
}> {
    const generationController = new AbortController();
    type IndexedAction = Readonly<{
        registration: TargetActionInvocationRegistration;
        invocation: ReturnType<typeof createPluginActionInvocation>;
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
            const invocation = createPluginActionInvocation({
                pluginId: registration.pluginId,
                localId: registration.localId,
                ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
                ...(definition.resultSchema === undefined ? {} : { resultSchema: definition.resultSchema }),
                generationSignal: lifecycle?.retirementSignal ?? generationController.signal,
                isCurrent: () => (
                    !generationController.signal.aborted
                    && (lifecycle?.isCurrent() ?? true)
                    && actionsByKey.get(key)?.registration.generation === registration.generation
                ),
            });
            next.set(key, Object.freeze({ registration: storedRegistration, invocation }));
        }
        return next;
    }

    let actionsByKey = buildIndex(params.actions);
    const expectedActionKeys = new Set([
        ...params.actions.map((registration) => actionKey(registration.pluginId, registration.localId)),
        ...(params.expectedActions ?? []).map((expected) => actionKey(expected.pluginId, expected.localId)),
    ]);

    async function invokeHandler(indexed: IndexedAction, invocation: InvokeTargetActionParams, serviceBinding: PluginInvocationServiceBinding): Promise<TargetActionInvocationResult> {
        const { registration } = indexed;
        return await indexed.invocation.invoke(invocation.input, {
            ...(invocation.signal ? { signal: invocation.signal } : {}),
            handler: async ({ input, qualifiedId, signal }) => {
                const currentSession = invocation.sessionId
                    ? params.resolveCurrentSessionUi?.(invocation.sessionId) ?? null
                    : null;
                const seed = Object.freeze({
                    plugin: Object.freeze({ id: registration.pluginId, version: registration.pluginVersion }),
                    contribution: Object.freeze({ id: registration.localId, qualifiedId }),
                    generation: registration.generation,
                    correlationId: randomUUID(),
                    surface: invocation.surface,
                    ...(invocation.sessionId ? { session: Object.freeze({ id: invocation.sessionId }) } : {}),
                    ...(currentSession ? { currentSession } : {}),
                    signal,
                    isGenerationCurrent: () => (
                        !generationController.signal.aborted
                        && (
                            params.resolveGenerationLifecycle?.(registration.pluginId).isCurrent()
                            ?? true
                        )
                        && actionsByKey.get(actionKey(registration.pluginId, registration.localId))?.registration.generation === registration.generation
                    ),
                });
                const services = params.createServices(seed, serviceBinding);
                const context: PluginInvocationContext = Object.freeze({
                    plugin: seed.plugin,
                    contribution: seed.contribution,
                    surface: seed.surface,
                    ...(seed.session ? { session: seed.session } : {}),
                    signal: seed.signal,
                    services,
                    ui: createPluginInvocationUi({
                        currentSession,
                        signal: seed.signal,
                        isGenerationCurrent: seed.isGenerationCurrent,
                    }),
                });
                return await registration.handler(input as JsonValue, context);
            },
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
                    return await invokeHandler(current, invocation, serviceBinding);
                },
            });
            return await executor.execute({
                pluginId: invocation.pluginId, localId: invocation.localId, input: invocation.input,
                surface: invocation.surface, ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
                ...(invocation.signal ? { signal: invocation.signal } : {}),
                ...(invocation.requestCurrentIntent ? { requestCurrentIntent: invocation.requestCurrentIntent } : {}),
            });
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
