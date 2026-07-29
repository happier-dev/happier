import {
    derivePluginDaemonContributionRegistrationRights,
    PluginActionConfirmationV2Schema,
    PluginActionDangerLevelV2Schema,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';

import {
    createTargetActionInvocationRegistry,
    type TargetActionDefinition,
} from './targetActionRegistry';
import type { ResolvedTargetAction } from './actionExecutor';
import type {
    ResolveTargetActionHostBinding,
    ResolveTargetActionHostPolicy,
} from '../hostAccess/resolve';
import { resolveManifestHostAccessRequests } from '../hostAccess/manifestRequests';
import {
    evaluateTargetActionCatalogPolicy,
    resolveInvocationContributionPolicyFacts,
    resolveTargetActionAvailability,
    type TargetActionAuthorizationFacts,
} from '../policy/evaluate';
import type { CreatePluginInvocationServices } from './services/types';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): readonly string[] | null {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? Object.freeze([...value])
        : null;
}

function readTargetDefinition(value: unknown): TargetActionDefinition {
    if (!isRecord(value)) throw new Error('Target action definition is not an object');
    const scopes = readStringArray(value.scopes);
    const surfaces = readStringArray(value.contributionSurfaces ?? value.surfaces);
    if (typeof value.id !== 'string' || !scopes || !surfaces) {
        throw new Error(`Target action '${String(value.id)}' is missing canonical action metadata`);
    }
    return Object.freeze({
        id: value.id,
        dangerLevel: PluginActionDangerLevelV2Schema.parse(value.dangerLevel),
        scopes,
        surfaces,
        ...(value.confirmation === undefined
            ? {}
            : { confirmation: PluginActionConfirmationV2Schema.parse(value.confirmation) }),
        ...(isRecord(value.inputSchema) ? { inputSchema: value.inputSchema } : {}),
        ...(isRecord(value.resultSchema) ? { resultSchema: value.resultSchema } : {}),
        ...(value.availability === undefined ? {} : { availability: value.availability }),
    });
}

export function buildTargetActionInvocationRegistry(params: Readonly<{
    contributes: ResolvedContributionRegistry;
    generation: number;
    targetRegistrations: readonly TargetRegistration[];
    targetActivationFacts: readonly PluginTargetActivationFact[];
    resolveAuthorizationFacts: (action: ResolvedTargetAction) => TargetActionAuthorizationFacts;
    resolveHostBinding: ResolveTargetActionHostBinding;
    resolveHostPolicy: ResolveTargetActionHostPolicy;
    createServices: CreatePluginInvocationServices;
    resolveGenerationLifecycle?(pluginId: string): Readonly<{
        isCurrent(): boolean;
        retirementSignal: AbortSignal;
    }>;
    resolveCurrentSessionUi?: (sessionId: string) => HostCurrentSessionUiServices | null;
}>) {
    const expectedActions = params.contributes.activationTargets.flatMap((target) => (
        derivePluginDaemonContributionRegistrationRights(
            target.manifest.contributes,
        ).flatMap((right) => right.family === 'actions'
            ? [{ pluginId: target.pluginId, localId: right.localId }]
            : [])
    ));
    const readActions = () => {
        const expectedActionKeys = new Set<string>();
        for (const fact of params.targetActivationFacts) {
            if (fact.status !== 'active' || fact.generation !== String(params.generation)) continue;
            for (const required of fact.required) {
                if (required.family === 'actions') expectedActionKeys.add(`${fact.pluginId}\u0000${required.localId}`);
            }
        }
        const actions = params.targetRegistrations.flatMap((entry) => {
            if (entry.registration.family !== 'actions') return [];
            if (entry.generation !== String(params.generation)) {
                throw new Error(`Target action '${entry.pluginId}/actions/${entry.registration.localId}' was published for the wrong generation`);
            }
            const activationFact = params.targetActivationFacts.find((fact) => (
                fact.pluginId === entry.pluginId
                && fact.generation === entry.generation
                && fact.status === 'active'
                && fact.bound.some((bound) => bound.family === 'actions' && bound.localId === entry.registration.localId)
            ));
            if (!activationFact) {
                throw new Error(`Target action '${entry.pluginId}/actions/${entry.registration.localId}' is not backed by an active generation fact`);
            }
            const manifest = params.contributes.activationTargets.find((target) => target.pluginId === entry.pluginId)?.manifest;
            const actionDefinition = manifest?.contributes.actions.find((action) => (
                action.id === entry.registration.localId
            ));
            if (!manifest || !actionDefinition) {
                throw new Error(`Target action registration '${entry.pluginId}/actions/${entry.registration.localId}' has no matching manifest action`);
            }
            const hostAccessIds = readStringArray(actionDefinition.hostAccess);
            expectedActionKeys.delete(`${entry.pluginId}\u0000${entry.registration.localId}`);
            return [{
                family: 'actions',
                pluginId: entry.pluginId,
                pluginVersion: activationFact.pluginVersion,
                generation: entry.generation,
                localId: entry.registration.localId,
                definition: {
                    ...readTargetDefinition(actionDefinition),
                    hostAccessRequests: resolveManifestHostAccessRequests({
                        manifest,
                        pluginId: entry.pluginId,
                        contribution: {
                            family: 'actions',
                            localId: entry.registration.localId,
                        },
                        ...(hostAccessIds ? { requestIds: hostAccessIds } : {}),
                    }),
                },
                handler: entry.registration.value,
            }];
        });
        const missing = expectedActionKeys.values().next().value;
        if (typeof missing === 'string') {
            const [pluginId, localId] = missing.split('\u0000');
            throw new Error(`Active target action '${pluginId}/actions/${localId}' has no committed registration`);
        }
        return actions;
    };
    return createTargetActionInvocationRegistry({
        actions: readActions(),
        expectedActions,
        readActions,
        evaluateCatalogPolicy: ({ pluginId, localId }) => {
            const registration = readActions().find((candidate) => (
                candidate.pluginId === pluginId && candidate.localId === localId
            ));
            if (!registration) {
                return Object.freeze({
                    outcome: 'unavailable' as const,
                    code: 'plugin_action_handler_missing',
                    requiresCurrentIntent: false,
                });
            }
            const availability = resolveTargetActionAvailability({
                availability: registration.definition.availability ?? undefined,
                facts: resolveInvocationContributionPolicyFacts(),
            });
            const action = Object.freeze({
                qualifiedId: `${pluginId}/actions/${localId}`,
                pluginId,
                localId,
                generation: registration.generation,
                dangerLevel: registration.definition.dangerLevel,
                scopes: registration.definition.scopes,
                surfaces: registration.definition.surfaces,
                hostAccess: (registration.definition.hostAccessRequests ?? []).map(({ request, required }) => ({
                    id: request.id,
                    required,
                    status: 'unavailable' as const,
                    code: 'plugin_host_access_context_unavailable',
                    requestFingerprint: '',
                })),
                ...(availability ? { availability } : {}),
                ...(registration.definition.confirmation === undefined
                    ? {}
                    : { confirmation: registration.definition.confirmation }),
                input: null,
                policyFingerprint: '',
            });
            const binding = params.resolveHostPolicy(action, {
                hostAccessRequests: registration.definition.hostAccessRequests ?? [],
                surface: 'catalog',
            });
            return evaluateTargetActionCatalogPolicy({
                action: binding.action,
                authorizationFacts: params.resolveAuthorizationFacts(binding.action),
            });
        },
        resolveAuthorizationFacts: params.resolveAuthorizationFacts,
        resolveHostBinding: params.resolveHostBinding,
        createServices: params.createServices,
        ...(params.resolveGenerationLifecycle
            ? { resolveGenerationLifecycle: params.resolveGenerationLifecycle }
            : {}),
        ...(params.resolveCurrentSessionUi
            ? { resolveCurrentSessionUi: params.resolveCurrentSessionUi }
            : {}),
    });
}
