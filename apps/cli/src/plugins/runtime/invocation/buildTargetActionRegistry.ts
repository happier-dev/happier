import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { deriveActivationTargetRegistrationRights } from '../lifecycle/activation/targets';
import { PluginActionConfirmationV2Schema, PluginActionConfirmationWhenV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { PluginActionDangerLevelV2Schema } from '@happier-dev/protocol/plugins/actions/vocabulary';
import { ActionOperationDeclarationV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import type { PluginActionPresentUserGatePolicy, PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import type { InputOption } from '@happier-dev/protocol/inputs';
import { resolveInputTypeOptions, readInputFieldOptionsConstraint, validateInputFieldValue } from '@happier-dev/protocol/inputs/runtime';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createRegistryInputTypeDeps } from './actions/createCommittedContributedActionDeps';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

import {
    createTargetActionInvocationRegistry,
    type TargetActionDefinition,
    type TargetActionInvocationRegistration,
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
import type { BeginPluginInvocationDiagnosticScope, CreatePluginInvocationServices } from './services/types';
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
import type { ActionHandler, PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk';
import { PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE } from '../context/storage';
import { createPluginAccountActionSettingsService } from '@happier-dev/cli-common/plugins/registration/accountActionSettings';
import { readPluginActionInputParser, readPluginActionReadObserver, readPluginActionResultParser } from '@happier-dev/cli-common/plugins/registration/actionInputParser';

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
        ...(value.confirmationWhen === undefined ? {} : { confirmationWhen: PluginActionConfirmationWhenV2Schema.parse(value.confirmationWhen) }),
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
async function invokeCapturedActionHandler(
    handler: Extract<ContributionRuntimeRegistration, Readonly<{ family: 'actions' }>>['value'],
    input: JsonValue,
    context: PluginInvocationContext,
    account = false,
    readAccountScope?: (signal: AbortSignal) => Promise<PluginAccountActionContext['accountScope']>,
): Promise<Awaited<ReturnType<ActionHandler>>> {
    if (!account) return Reflect.apply(handler, undefined, [input, context]);
    return Reflect.apply(handler, undefined, [input, createAccountInvocationContext(context, await readAccountScope?.(context.signal))]);
}

function createAccountInvocationContext(context: PluginInvocationContext, accountScope?: PluginAccountActionContext['accountScope']): PluginAccountActionContext {
    return Object.freeze({
        plugin: context.plugin, contribution: context.contribution, surface: context.surface,
        invokedAtMs: context.invokedAtMs, signal: context.signal,
        ...(context.caller ? { caller: context.caller } : {}),
        ...(accountScope ? { accountScope } : {}),
        services: Object.freeze({
            http: context.services.http,
            secrets: context.services.secrets,
            ...(context.services.machineConnectorSecrets ? { machineConnectorSecrets: context.services.machineConnectorSecrets } : {}),
            connectedAccounts: context.services.connectedAccounts,
            storage: Object.freeze({ get account() {
                const accountStorage = context.services.storage.account;
                if (!accountStorage) throw new PluginError({ code: PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE, message: 'Account storage is unavailable' });
                return accountStorage;
            } }),
            actions: Object.freeze({ execute: context.services.actions.execute, observe: context.services.actions.observe,
                executeAdmittedTargetedOperation: context.services.actions.executeAdmittedTargetedOperation,
                observeAdmittedTargetedOperation: context.services.actions.observeAdmittedTargetedOperation }),
            targetedContributions: context.services.targetedContributions,
            settings: createPluginAccountActionSettingsService(context.services.settings),
        }),
    }) satisfies PluginAccountActionContext;
}

export function buildTargetActionInvocationRegistry(params: Readonly<{
    contributes: ResolvedContributionRegistry;
    executionRealm?: 'account';
    /** Authenticated scope captured by the Account runtime; absent is unavailable. */
    readAccountScope?(signal: AbortSignal): Promise<PluginAccountActionContext['accountScope']>;
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
    resolveAuthorizationFacts: (action: ResolvedTargetAction, purpose?: 'declaration') => TargetActionAuthorizationFacts;
    /** Read-only runtime final-policy owner; this registry only delegates. */
    resolvePresentUserGatePolicy?: (
        pluginId: string,
        localId: string,
    ) => PluginActionPresentUserGatePolicy | null;
    resolveHostBinding: ResolveTargetActionHostBinding;
    resolveHostPolicy: ResolveTargetActionHostPolicy;
    createServices: CreatePluginInvocationServices;
    readCurrentTargetedDeclarations?(pluginId: string, signal?: AbortSignal): Promise<readonly import('@happier-dev/plugin-sdk/host/registration').TargetedContributionManifestDeclaration[]>;
    prepareInvocationServices?(input: Readonly<{ pluginId: string; localId: string }>): Promise<void>;
    beginDiagnosticScope?: BeginPluginInvocationDiagnosticScope;
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
        deriveActivationTargetRegistrationRights(target).flatMap((right) => right.family === 'actions'
            ? [{ pluginId: target.pluginId, localId: right.localId }]
            : [])
    ));
    // Native apply descriptors carry opaque bearer placeholders. Treat their
    // declared operands as confidential even when a plugin omits input hints.
    const nativeCredentialApplyKeys = new Set((params.contributes.machineProvisioners ?? []).flatMap((entry) => {
        const localId = entry.definition.nativeCredentialDelivery?.apply;
        return localId ? [buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: entry.pluginId, localId,
        }))] : [];
    }));
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
            const observeRead = readPluginActionReadObserver(capturedHandler);
            const occurrenceId = params.readCurrentPluginOccurrenceId?.(entry.pluginId);
            const sourceCustody = params.readCurrentPluginSourceCustody?.(entry.pluginId);
            const secretInputPaths = [
                ...(actionDefinition.inputHints?.fields ?? [])
                    .filter(field => field.widget === 'secret').map(field => field.path),
                ...(nativeCredentialApplyKeys.has(buildQualifiedPluginContributionKey(actionIdentity))
                    ? ['bindings', 'ownedBindings'] : []),
            ];
            const secretInputLabels = Object.fromEntries((actionDefinition.inputHints?.fields ?? [])
                .filter(field => field.widget === 'secret')
                .map(field => [field.path, typeof field.title === 'string' ? field.title : field.title.fallback]));
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
                    secretInputPaths,
                    ...(Object.keys(secretInputLabels).length ? { secretInputLabels } : {}),
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
                ...(observeRead === undefined ? {} : { observeRead: (async (input, invalidate, context) =>
                    Reflect.apply(observeRead, undefined, [input, invalidate, actionDefinition.execution.target === 'account'
                        ? createAccountInvocationContext(context, await params.readAccountScope?.(context.signal)) : context])) satisfies NonNullable<TargetActionInvocationRegistration['observeRead']> }),
                handler: (input: JsonValue, context: PluginInvocationContext) => invokeCapturedActionHandler(
                    capturedHandler,
                    input,
                    context,
                    actionDefinition.execution.target === 'account',
                    params.readAccountScope,
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
        let catalogAction: Readonly<{
            definition: TargetActionDefinition;
            occurrenceId: string;
            sourceCustody: PluginSourceCustodyV1;
        }> | undefined;
        if (resolvedAction) {
            // Discovery consumes admitted declarations. Daemon handlers activate
            // on invocation; client handlers belong to the answering UI.
            const manifest = params.contributes.activationTargets.find((target) => target.pluginId === pluginId)?.manifest;
            const declaration = manifest?.contributes.actions.find((action) => action.id === localId);
            const occurrenceId = params.readCurrentPluginOccurrenceId?.(pluginId);
            const sourceCustody = params.readCurrentPluginSourceCustody?.(pluginId);
            if (
                !manifest || !declaration || declaration.execution.target !== resolvedAction.definition.execution?.target
                || (params.executionRealm === 'account' && declaration.execution.target !== 'account')
                || (params.executionRealm !== 'account' && declaration.execution.target === 'account')
                || resolvedAction.pluginId !== pluginId || resolvedAction.definition.id !== localId
                || occurrenceId == null || sourceCustody == null
            ) return null;
            const activationFacts = params.readTargetActivationFacts?.() ?? params.targetActivationFacts;
            // No fact is a cold declaration; an explicit inactive fact for this
            // occurrence still suppresses a daemon contribution.
            if (declaration.execution.target === 'daemon' && activationFacts?.some(fact =>
                fact.pluginId === pluginId && fact.occurrenceId === occurrenceId && fact.status !== 'active')) return null;
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
            ...(catalogAction.definition.confirmationWhen === undefined ? {} : { confirmationWhen: catalogAction.definition.confirmationWhen }),
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
                authorizationFacts: params.resolveAuthorizationFacts(action, 'declaration'),
            });
        },
        ...(params.resolvePresentUserGatePolicy
            ? { resolvePresentUserGatePolicy: params.resolvePresentUserGatePolicy }
            : {}),
        resolveAuthorizationFacts: params.resolveAuthorizationFacts,
        resolveHostBinding: params.resolveHostBinding,
        createServices: params.readCurrentTargetedDeclarations ? (seed, ...args) => params.createServices({ ...seed,
            readCurrentTargetedDeclarations: signal => params.readCurrentTargetedDeclarations!(seed.plugin.id, signal),
        }, ...args) : params.createServices,
        ...(params.prepareInvocationServices ? { prepareInvocationServices: params.prepareInvocationServices } : {}),
        ...(params.beginDiagnosticScope
            ? { beginDiagnosticScope: params.beginDiagnosticScope }
            : {}),
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
                const selected = StrictJsonValueSchema.safeParse(value);
                if (!selected.success) return { status: 'invalid', code: 'input_type_value_invalid', message: 'Input value is invalid' };
                const type = 'hostType' in field.inputType ? undefined : await inputTypeDeps.resolveInputType(field.inputType, context);
                if (type === null) return { status: 'unavailable', code: 'input_type_unavailable', message: 'Input type is unavailable' };
                let options: readonly InputOption[] | undefined;
                if (type && readInputFieldOptionsConstraint(field, type).kind === 'dynamic') {
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
                const validation = validateInputFieldValue({ field, value: selected.data, type, options });
                if (validation.status !== 'valid') return { status: validation.status, code: validation.reasonCode, message: 'Input value is invalid' };
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
                ...(input.recordOperationCredentialUse ? { recordOperationCredentialUse: input.recordOperationCredentialUse } : {}),
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
