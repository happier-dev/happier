import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PluginActionConfirmationV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { PluginActionDangerLevelV2Schema } from '@happier-dev/protocol/plugins/actions/vocabulary';
import { ActionOperationDeclarationV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import type { PluginActionPresentUserGatePolicy, PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import type { InputOption } from '@happier-dev/protocol/inputs';
import { resolveInputTypeOptions, validateInputTypeValue } from '@happier-dev/protocol/inputs/runtime';
import { createRegistryInputTypeDeps } from './actions/createCommittedContributedActionDeps';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

import {
    createTargetActionInvocationRegistry,
    type TargetActionDefinition,
} from './targetActionRegistry';
import {
    resolveCatalogTargetActionPolicy,
    type ResolvedTargetAction,
} from './actionExecutor';
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
import {
    revalidateRegistryConnectedAccountActionFormInput,
    resolveRegistryConnectedAccountActionPurposeBindingSnapshot,
    type ResolveRegistryConnectedAccountOptionalAccess,
    type ResolveRegistryCurrentAutomationEventHistoryGapSource,
} from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type {
    JsonValue,
    PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    readPluginActionInputParser,
    readPluginActionResultParser,
} from '@happier-dev/plugin-sdk/host/registration';

type TargetRegistration = Readonly<{
    pluginId: string;
    occurrenceId: string;
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

function readProjectedActionSurfaces(value: unknown): readonly string[] | null {
    const parsed = ActionSurfaceSchema.safeParse(value);
    if (!parsed.success) return null;
    return Object.freeze(Object.entries(parsed.data).flatMap(([surface, enabled]) => (
        enabled ? [surface] : []
    )));
}

function readTargetDefinition(value: unknown): TargetActionDefinition {
    if (!isRecord(value)) throw new Error('Target action definition is not an object');
    const scopes = readStringArray(value.scopes);
    const surfaces = readProjectedActionSurfaces(value.surfaces);
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
        ...(isRecord(value.outputSchema) ? { resultSchema: value.outputSchema } : {}),
        ...(value.availability === undefined ? {} : { availability: value.availability }),
        ...(value.operation === undefined
            ? {}
            : { operation: ActionOperationDeclarationV1Schema.parse(value.operation) }),
    });
}

/**
 * Re-enters an opaque committed Action registration only after this daemon
 * owner has selected the target realm. The target registry validates both
 * JSON input and result around this call.
 */
function invokeCapturedDaemonActionHandler(
    handler: Extract<ContributionRuntimeRegistration, Readonly<{ family: 'actions' }>>['value'],
    input: JsonValue,
    context: PluginInvocationContext,
): ReturnType<ActionHandler> {
    return Reflect.apply(handler, undefined, [input, context]);
}

export function buildTargetActionInvocationRegistry(params: Readonly<{
    contributes: ResolvedContributionRegistry;
    /** The same runtime-owned Resource reader used by Action options discovery. */
    readRuntimeRegistry?(): Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'readUiResource'> | null;
    readCurrentPluginOccurrenceId?(pluginId: string): PluginRuntimeOccurrenceId | null;
    readCurrentPluginSourceCustody?(pluginId: string): PluginSourceCustodyV1 | null;
    /** Resolved runtime-owned dispatch-time caller provenance lookup. */
    resolveCurrentPluginMaterializationRef?(pluginId: string): import('@happier-dev/protocol').PluginMachineMaterializationRefV1 | null;
    targetRegistrations: readonly TargetRegistration[];
    /** Static facts for immutable fixture/cold registries. */
    targetActivationFacts?: readonly PluginTargetActivationFact[];
    /** Reads mutable generation facts at each refresh/lazy activation boundary. */
    readTargetActivationFacts?: () => readonly PluginTargetActivationFact[];
    resolveAuthorizationFacts: (action: ResolvedTargetAction) => TargetActionAuthorizationFacts;
    /** Read-only runtime final-policy owner; this registry only delegates. */
    resolvePresentUserGatePolicy?: (
        pluginId: string,
        localId: string,
    ) => PluginActionPresentUserGatePolicy | null;
    resolveHostBinding: ResolveTargetActionHostBinding;
    resolveHostPolicy: ResolveTargetActionHostPolicy;
    createServices: CreatePluginInvocationServices;
    redactDiagnosticText?: (
        scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
        value: string,
    ) => string;
    completeDiagnosticScope?: (
        scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
    ) => void;
    resolveCurrentSessionUi?: (sessionId: string) => HostCurrentSessionUiServices | null;
    /** Exact declaration-routed Account truth for submitted dynamic form refs. */
    actionFormConnectedAccounts?: Pick<
        ConnectedAccountPurposeBindingOwner,
        'resolveBindingIntent'
    > & Partial<Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>>;
    /**
     * Canonical host-only source resolver for declared history-gap recovery
     * bindings. The target Action lifecycle remains the operation owner.
     */
    resolveAutomationEventHistoryGapSource?: ResolveRegistryCurrentAutomationEventHistoryGapSource;
    resolveOptionalAccess?: ResolveRegistryConnectedAccountOptionalAccess;
}>) {
    const expectedActions = params.contributes.activationTargets.flatMap((target) => (
        derivePluginDaemonContributionRegistrationRights(
            target.manifest.contributes,
        ).flatMap((right) => right.family === 'actions'
            ? [{ pluginId: target.pluginId, localId: right.localId }]
            : [])
    ));
    const readActions = () => {
        const targetActivationFacts = params.readTargetActivationFacts?.()
            ?? params.targetActivationFacts;
        if (!targetActivationFacts) {
            throw new Error('Target action registry requires current activation facts');
        }
        const expectedActionKeys = new Set<string>();
        for (const fact of targetActivationFacts) {
            if (fact.status !== 'active') continue;
            for (const required of fact.required) {
                if (required.family === 'actions') expectedActionKeys.add(`${fact.pluginId}\u0000${required.localId}`);
            }
        }
        const actions = params.targetRegistrations.flatMap((entry) => {
            if (entry.registration.family !== 'actions') return [];
            const capturedHandler = entry.registration.value;
            const hasActivePluginGeneration = targetActivationFacts.some((fact) => (
                fact.pluginId === entry.pluginId && fact.status === 'active'
            ));
            const activationFact = targetActivationFacts.find((fact) => (
                fact.pluginId === entry.pluginId
                && fact.status === 'active'
                && fact.bound.some((bound) => bound.family === 'actions' && bound.localId === entry.registration.localId)
            ));
            if (!activationFact) {
                // Cold activation deliberately retains diagnostics and may
                // retain a captured registration while the plugin is dormant
                // or unavailable. Such a plugin contributes no callable
                // Actions and must not poison unrelated catalog/hook reads.
                // If the plugin claims any active occurrence, however, a
                // mismatched registration is still invariant corruption and
                // remains fail-closed below.
                if (!hasActivePluginGeneration) return [];
                throw new Error(`Target action '${entry.pluginId}/actions/${entry.registration.localId}' is not backed by an active occurrence fact`);
            }
            const manifest = params.contributes.activationTargets.find((target) => target.pluginId === entry.pluginId)?.manifest;
            const actionDefinition = manifest?.contributes.actions.find((action) => (
                action.id === entry.registration.localId
            ));
            if (!manifest || !actionDefinition) {
                throw new Error(`Target action registration '${entry.pluginId}/actions/${entry.registration.localId}' has no matching manifest action`);
            }
            const actionIdentity = createPluginContributionIdentity({
                pluginId: entry.pluginId,
                localId: entry.registration.localId,
            });
            const actionRegistryKey = buildQualifiedPluginContributionKey(actionIdentity);
            const resolvedAction = params.contributes.actionsById?.get(actionRegistryKey);
            if (
                !resolvedAction
                || resolvedAction.pluginId !== entry.pluginId
                || resolvedAction.definition.id !== entry.registration.localId
            ) {
                throw new Error(`Target action registration '${entry.pluginId}/actions/${entry.registration.localId}' has no matching resolved Action projection`);
            }
            const hostAccessIds = readStringArray(actionDefinition.hostAccess);
            const inputParser = readPluginActionInputParser(capturedHandler);
            const resultParser = readPluginActionResultParser(capturedHandler);
            const occurrenceId = params.readCurrentPluginOccurrenceId?.(entry.pluginId);
            const sourceCustody = params.readCurrentPluginSourceCustody?.(entry.pluginId);
            if (occurrenceId == null || occurrenceId !== entry.occurrenceId || sourceCustody == null) {
                throw new Error(`Target action '${entry.pluginId}/actions/${entry.registration.localId}' lacks host-stamped occurrence or source custody`);
            }
            expectedActionKeys.delete(`${entry.pluginId}\u0000${entry.registration.localId}`);
            return [{
                family: 'actions',
                pluginId: entry.pluginId,
                pluginVersion: activationFact.pluginVersion,
                occurrenceId,
                sourceCustody,
                localId: entry.registration.localId,
                definition: {
                    ...readTargetDefinition(resolvedAction.definition),
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
                ...(inputParser === undefined ? {} : { inputParser }),
                ...(resultParser === undefined ? {} : { resultParser }),
                handler: (input: JsonValue, context: PluginInvocationContext) => invokeCapturedDaemonActionHandler(
                    capturedHandler,
                    input,
                    context,
                ),
            }];
        });
        const missing = expectedActionKeys.values().next().value;
        if (typeof missing === 'string') {
            const [pluginId, localId] = missing.split('\u0000');
            throw new Error(`Active target action '${pluginId}/actions/${localId}' has no committed registration`);
        }
        return actions;
    };
    const resolveCatalogAction = (
        pluginId: string,
        localId: string,
    ): ResolvedTargetAction | null => {
        const actionRegistryKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId }));
        const resolvedAction = params.contributes.actionsById?.get(actionRegistryKey);
        let catalogAction: Pick<ReturnType<typeof readActions>[number], 'definition' | 'occurrenceId' | 'sourceCustody'> | undefined;
        if (resolvedAction?.definition.execution?.target === 'client') {
            // Client handlers belong to the answering UI, not daemon activation.
            // Catalog visibility still uses the same current occurrence and policy owner.
            const manifest = params.contributes.activationTargets.find((target) => target.pluginId === pluginId)?.manifest;
            const declaration = manifest?.contributes.actions.find((action) => action.id === localId);
            const occurrenceId = params.readCurrentPluginOccurrenceId?.(pluginId);
            const sourceCustody = params.readCurrentPluginSourceCustody?.(pluginId);
            if (
                !manifest || declaration?.execution.target !== 'client'
                || resolvedAction.pluginId !== pluginId || resolvedAction.definition.id !== localId
                || occurrenceId == null || sourceCustody == null
            ) return null;
            catalogAction = {
                occurrenceId,
                sourceCustody,
                definition: {
                    ...readTargetDefinition(resolvedAction.definition),
                    hostAccessRequests: resolveManifestHostAccessRequests({
                        manifest,
                        pluginId,
                        contribution: { family: 'actions', localId },
                        requestIds: declaration.hostAccess,
                    }),
                },
            };
        } else {
            catalogAction = readActions().find((candidate) => (
                candidate.pluginId === pluginId && candidate.localId === localId
            ));
        }
        if (!catalogAction?.sourceCustody) return null;
        const availability = resolveTargetActionAvailability({
            availability: catalogAction.definition.availability ?? undefined,
            facts: resolveInvocationContributionPolicyFacts(),
        });
        return resolveCatalogTargetActionPolicy({
            pluginId,
            localId,
            occurrenceId: catalogAction.occurrenceId,
            sourceCustody: catalogAction.sourceCustody,
            dangerLevel: catalogAction.definition.dangerLevel,
            scopes: catalogAction.definition.scopes,
            surfaces: catalogAction.definition.surfaces,
            hostAccessRequests: catalogAction.definition.hostAccessRequests ?? [],
            ...(availability === undefined ? {} : { availability }),
            ...(catalogAction.definition.confirmation === undefined
                ? {}
                : { confirmation: catalogAction.definition.confirmation }),
            resolveHostPolicy: params.resolveHostPolicy,
        });
    };

    return createTargetActionInvocationRegistry({
        actions: readActions(),
        expectedActions,
        readActions,
        evaluateCatalogPolicy: ({ pluginId, localId }) => {
            const action = resolveCatalogAction(pluginId, localId);
            if (!action) {
                return Object.freeze({
                    outcome: 'unavailable' as const,
                    code: 'plugin_action_handler_missing',
                    requiresCurrentIntent: false,
                });
            }
            return evaluateTargetActionCatalogPolicy({
                action,
                authorizationFacts: params.resolveAuthorizationFacts(action),
            });
        },
        ...(params.resolvePresentUserGatePolicy
            ? { resolvePresentUserGatePolicy: params.resolvePresentUserGatePolicy }
            : {}),
        resolveAuthorizationFacts: params.resolveAuthorizationFacts,
        resolveHostBinding: params.resolveHostBinding,
        createServices: params.createServices,
        ...(params.redactDiagnosticText
            ? { redactDiagnosticText: params.redactDiagnosticText }
            : {}),
        ...(params.completeDiagnosticScope
            ? { completeDiagnosticScope: params.completeDiagnosticScope }
            : {}),
        ...(params.resolveCurrentPluginMaterializationRef
            ? {
                resolveCurrentPluginMaterializationRef:
                    params.resolveCurrentPluginMaterializationRef,
            }
            : {}),
        ...(params.readCurrentPluginOccurrenceId
            ? { readCurrentPluginOccurrenceId: params.readCurrentPluginOccurrenceId }
            : {}),
        ...(params.resolveCurrentSessionUi
            ? { resolveCurrentSessionUi: params.resolveCurrentSessionUi }
            : {}),
        revalidateActionFormInput: async (input) => {
            const identity = createPluginContributionIdentity({ pluginId: input.pluginId, localId: input.localId });
            const definition = params.contributes.actionsById?.get(buildQualifiedPluginContributionKey(identity))?.definition;
            const runtime = params.readRuntimeRegistry?.() ?? { contributes: params.contributes };
            const inputTypeDeps = createRegistryInputTypeDeps(runtime);
            const context = { signal: input.signal, ...(input.sessionId ? { defaultSessionId: input.sessionId } : {}) };
            for (const field of resolveEffectiveInputFields({ inputHints: definition?.inputHints ?? undefined }, input.input, { includeHidden: true })) {
                if (!field.inputType) continue;
                const value = readInputPath(input.input, field.path);
                if (value === undefined) continue;
                const type = await inputTypeDeps.resolveInputType(field.inputType, context);
                if (!type) return { status: 'unavailable', code: 'input_type_unavailable', message: 'Input type is unavailable' };
                let options: readonly InputOption[] | undefined;
                if (type.definition.options) {
                    const resolved = await resolveInputTypeOptions({ deps: inputTypeDeps, ctx: context, identity: field.inputType,
                        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                        readFailure: result => {
                            const parsed = ActionExecuteFailureSchema.safeParse(result);
                            return parsed.success ? parsed.data : null;
                        },
                    });
                    if (!resolved.ok) return { status: 'unavailable', code: resolved.errorCode, message: 'Input choices are unavailable' };
                    options = resolved.result;
                }
                const values = field.widget === 'multiselect' && Array.isArray(value) ? value : [value];
                for (const selected of values) {
                    const validation = validateInputTypeValue(type, selected, options);
                    if (validation.status !== 'valid') return { status: 'invalid', code: validation.reasonCode, message: 'Input value is invalid' };
                }
                input.signal.throwIfAborted();
                if (!input.isCurrent()) return { status: 'unavailable', code: 'input_type_retired', message: 'Input invocation is retired' };
            }
            return await revalidateRegistryConnectedAccountActionFormInput({
                registry: params.contributes,
                qualifiedActionId: buildQualifiedPluginContributionKey(
                    createPluginContributionIdentity({
                        pluginId: input.pluginId,
                        localId: input.localId,
                    }),
                ),
                value: input.input,
                ...(params.resolveOptionalAccess
                    ? { resolveOptionalAccess: params.resolveOptionalAccess }
                    : {}),
                ...(params.actionFormConnectedAccounts
                    ? { actionFormConnectedAccounts: params.actionFormConnectedAccounts }
                    : {}),
                signal: input.signal,
                isCurrent: input.isCurrent,
            });
        },
        bindConnectedAccountActionOperation: async (input) => {
            const snapshot = await resolveRegistryConnectedAccountActionPurposeBindingSnapshot({
                registry: params.contributes,
                qualifiedActionId: buildQualifiedPluginContributionKey(
                    createPluginContributionIdentity({
                        pluginId: input.pluginId,
                        localId: input.localId,
                    }),
                ),
                value: input.input,
                ...(params.resolveOptionalAccess
                    ? { resolveOptionalAccess: params.resolveOptionalAccess }
                    : {}),
                ...(params.actionFormConnectedAccounts
                    ? { actionFormConnectedAccounts: params.actionFormConnectedAccounts }
                    : {}),
                ...(params.resolveAutomationEventHistoryGapSource
                    ? {
                        resolveAutomationEventHistoryGapSource:
                            params.resolveAutomationEventHistoryGapSource,
                    }
                    : {}),
                signal: input.signal,
                isCurrent: input.isCurrent,
            });
            if ('status' in snapshot) return snapshot;
            if (snapshot.purposes.length === 0) return null;
            if (!params.actionFormConnectedAccounts?.activatePurposeBindings) {
                return Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_action_form_connected_account_options_unavailable',
                    message: 'Connected Account operation binding is unavailable for this Action',
                });
            }
            const lease = params.actionFormConnectedAccounts.activatePurposeBindings({
                subject: {
                    kind: 'operation',
                    operationId: input.correlationId,
                    consumer: {
                        pluginId: input.pluginId,
                        localId: input.localId,
                    },
                    isCurrent: input.isCurrent,
                },
                purposes: snapshot.purposes,
                bindings: snapshot.bindings,
            });
            if (!input.isCurrent()) {
                lease.dispose();
                return Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_action_generation_retired',
                    message: 'The target Action is no longer current',
                });
            }
            return Object.freeze({
                exactPurposeBindingSubjectId: lease.subjectId,
                dispose: () => lease.dispose(),
            });
        },
    });
}
