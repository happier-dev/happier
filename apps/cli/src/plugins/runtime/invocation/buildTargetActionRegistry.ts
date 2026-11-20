import { captureConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { GITHUB_BROKER_WATCHER_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { GITHUB_EVENT_SETUP_ACTIONS_V1 } from '@happier-dev/protocol/automations/event-setup-result';
import { createDeploymentTargetRoleExecEnvironmentForHost } from '@/deployments/targets/createDeploymentTargetRoleExecEnvironmentForHost';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { deriveActivationTargetRegistrationRights } from '../lifecycle/activation/targets';
import type { PluginActionPresentUserGatePolicy, PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionSecretInputPaths } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { isRecord } from '@happier-dev/protocol/inputs/inputRecords';
import type { InputOption } from '@happier-dev/protocol/inputs';
import { resolveInputTypeOptions, readInputFieldOptionsConstraint, readInputFieldSelectedValues, validateInputTypeValue, validateInputFieldValue } from '@happier-dev/protocol/inputs/runtime';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createRegistryInputTypeDeps } from './actions/createCommittedContributedActionDeps';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';

import type { ResolvedActionAdmittedTarget, ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
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
import {
    evaluateTargetActionCatalogPolicy,
    resolveInvocationContributionPolicyFacts,
    resolveTargetActionAvailability,
    type TargetActionAuthorizationFacts,
} from '../policy/evaluate';
import type { BeginPluginInvocationDiagnosticScope, CreatePluginInvocationServices, PluginInvocationServicesSeed } from './services/types';
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
import { PluginError, isPluginError } from '@happier-dev/plugin-sdk';
import { createAccountInvocationContext } from './createAccountInvocationContext';
import { readPluginActionInputParser, readPluginActionReadObserver, readPluginActionResultParser } from '@happier-dev/cli-common/plugins/registration/actionInputParser';
import { admitDeploymentTargetRoleForHost, type DeploymentTargetRoleAdmissionHost } from '@/deployments/targets/admitDeploymentTargetRoleForHost';
import { admitDeploymentTargetCredentialPrincipalForHost } from '@/deployments/targets/admitDeploymentTargetCredentialPrincipalForHost';
import { DeploymentTargetCredentialPrincipalV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { resolveRegistryConnectedAccountActionCredentialPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { createDeploymentTargetRoleSourceAdmissionForHost } from '@/deployments/targets/createDeploymentTargetRoleAdmissionHost';
import { createDeploymentTargetRoleWorkloadBindingForHost } from '@/deployments/targets/createDeploymentTargetRoleWorkloadBindingForHost';
import { readHostReviewedChildOperationV1, invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';

type TargetRegistration = Readonly<{
    pluginId: string;
    occurrenceId: string;
    registration: ContributionRuntimeRegistration;
}>;

function readAdmittedTargetDefinition(target: ResolvedActionAdmittedTarget): TargetActionDefinition {
    const declaration = target.declaration;
    return Object.freeze({
        id: declaration.id,
        dangerLevel: declaration.dangerLevel,
        ...(declaration.readOnly === undefined ? {} : { readOnly: declaration.readOnly }),
        ...(declaration.approvalScope === undefined ? {} : { approvalScope: declaration.approvalScope }),
        ...(declaration.confirmationWhen === undefined ? {} : { confirmationWhen: declaration.confirmationWhen }),
        ...(declaration.sessionTarget === undefined ? {} : { sessionTarget: declaration.sessionTarget }),
        scopes: declaration.scopes,
        surfaces: target.surfaces,
        ...(declaration.dangerLevel === 'safe' || declaration.confirmation === undefined
            ? {}
            : { confirmation: declaration.confirmation }),
        ...(declaration.inputSchema === undefined ? {} : { inputSchema: declaration.inputSchema }),
        ...(declaration.resultSchema === undefined ? {} : { resultSchema: declaration.resultSchema }),
        ...(declaration.availability === undefined ? {} : { availability: declaration.availability }),
        ...(declaration.operation === undefined
            ? {}
            : { operation: declaration.operation }),
        hostAccessRequests: target.hostAccessRequests,
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

export function buildTargetActionInvocationRegistry(params: Readonly<{
    contributes: ResolvedContributionRegistry;
    executionRealm?: 'account';
    /** Authenticated scope captured by the Account runtime; absent is unavailable. */
    readAccountScope?(signal: AbortSignal): Promise<PluginAccountActionContext['accountScope']>;
    /** The same runtime-owned Resource reader used by Action options discovery. */
    readRuntimeRegistry?(): (Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'readUiResource'>
        & Partial<Pick<ResolvedExecutablePluginRuntimeRegistry, 'projectManagedServices'>>) | null;
    ensureEnvironmentServices?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
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
    readCurrentTargetedDeclarations?(pluginId: string, signal?: AbortSignal,
        resolveMachine?: PluginInvocationServicesSeed['resolveAccountSourceMachine']): Promise<import('@happier-dev/cli-common/plugins/registration').TargetedContributionManifestSnapshot>;
    createAccountSourceMachineResolver?(seed: PluginInvocationServicesSeed): PluginInvocationServicesSeed['resolveAccountSourceMachine'];
    prepareInvocationServices?(input: Readonly<{ pluginId: string; localId: string; family?: 'actions' | 'deploymentTargets' }>): Promise<void>;
    beginDiagnosticScope?: BeginPluginInvocationDiagnosticScope;
    /** `purpose: 'result'` projects a successful result: credential material only, not declared operands. */
    redactDiagnosticText?: (
        scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
        value: string,
        purpose?: 'result',
    ) => string;
    completeDiagnosticScope?: (
        scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
    ) => void;
    resolveCurrentSessionUi?: (sessionId: string) => HostCurrentSessionUiServices | null;
    /** Exact declaration-routed Account truth for submitted dynamic form refs. */
    actionFormConnectedAccounts?: Pick<
        ConnectedAccountPurposeBindingOwner,
        'resolveBindingIntent'
    > & Partial<Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings' | 'resolveBindingIntentSelection'>>
        & Partial<Pick<import('@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime').DaemonConnectedAccountPurposeBindingRuntime, 'admitActionPurposeBindings'>>;
    /**
     * Canonical host-only source resolver for declared history-gap recovery
     * bindings. The target Action lifecycle remains the operation owner.
     */
    resolveAutomationEventHistoryGapSource?: ResolveRegistryCurrentAutomationEventHistoryGapSource;
    bindAutomationEventWatcherRead?: Awaited<ReturnType<typeof import('../composition/automationAssembly').assembleAutomationRuntime>>['bindAutomationEventWatcherRead'];
    resolveOptionalAccess?: ResolveRegistryConnectedAccountOptionalAccess;
    /** Captured invocation custody, never ambient daemon credential fallback. */
    readDeploymentTargetRoleAdmissionHost?(context: import('@happier-dev/protocol').ActionExecutorContext):
        Promise<DeploymentTargetRoleAdmissionHost | null>;
    resolveEnvironmentApprovalScope?: import('@happier-dev/protocol').ActionExecutorDeps['resolveEnvironmentApprovalScope'];
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
            const actionIdentity = createPluginContributionIdentity({
                pluginId: entry.pluginId,
                localId: entry.registration.localId,
            });
            const resolvedAction = readResolvedActionContribution(params.contributes, actionIdentity);
            if (
                !resolvedAction
                || resolvedAction.pluginId !== entry.pluginId
                || resolvedAction.definition.id !== entry.registration.localId
            ) {
                throw new Error(`Target action registration '${entry.pluginId}/actions/${entry.registration.localId}' has no matching resolved Action projection`);
            }
            const admittedTarget = resolvedAction.admittedTarget;
            if (!admittedTarget) {
                throw new Error(`Target action registration '${entry.pluginId}/actions/${entry.registration.localId}' has no admitted manifest action`);
            }
            const actionDefinition = admittedTarget.declaration;
            const inputParser = readPluginActionInputParser(capturedHandler);
            const resultParser = readPluginActionResultParser(capturedHandler);
            const observeRead = readPluginActionReadObserver(capturedHandler);
            const occurrenceId = params.readCurrentPluginOccurrenceId?.(entry.pluginId);
            const sourceCustody = params.readCurrentPluginSourceCustody?.(entry.pluginId);
            const secretInputPaths = [
                ...readActionSecretInputPaths(actionDefinition, {}, { includeInactive: true }),
                ...(nativeCredentialApplyKeys.has(buildQualifiedPluginContributionKey(actionIdentity))
                    ? ['bindings', 'ownedBindings'] : []),
            ];
            const secretInputLabels = Object.fromEntries((actionDefinition.inputHints?.fields ?? [])
                .filter(field => field.widget === 'secret')
                .map(field => [field.path, resolvePluginLocalizedStringV2Text(field.title)]));
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
                ...(admittedTarget.declaration.execution.target === 'account' ? { accountActionDeclaration: admittedTarget.declaration } : {}),
                definition: {
                    ...readAdmittedTargetDefinition(admittedTarget),
                    secretInputPaths,
                    ...(Object.keys(secretInputLabels).length ? { secretInputLabels } : {}),
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
        const resolvedAction = readResolvedActionContribution(params.contributes,
            createPluginContributionIdentity({ pluginId, localId }));
        const target = resolvedAction?.admittedTarget;
        if (!resolvedAction || !target) return null;
        // Discovery consumes the same admitted declaration as invocation;
        // source/occurrence and all live policy are still read for this call.
        const declaration = target.declaration;
        const occurrenceId = params.readCurrentPluginOccurrenceId?.(pluginId);
        const sourceCustody = params.readCurrentPluginSourceCustody?.(pluginId);
        if (
            declaration.execution.target !== resolvedAction.definition.execution?.target
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
        const availability = resolveTargetActionAvailability({
            availability: declaration.availability ?? undefined,
            facts: resolveInvocationContributionPolicyFacts(),
        });
        return resolveCatalogTargetActionPolicy({
            pluginId,
            localId,
            occurrenceId,
            sourceCustody,
            dangerLevel: declaration.dangerLevel,
            ...(declaration.confirmationWhen === undefined ? {} : { confirmationWhen: declaration.confirmationWhen }),
            scopes: declaration.scopes,
            surfaces: target.surfaces,
            hostAccessRequests: target.hostAccessRequests,
            ...(availability === undefined ? {} : { availability }),
            ...(declaration.dangerLevel === 'safe' || declaration.confirmation === undefined
                ? {}
                : { confirmation: declaration.confirmation }),
            resolveHostPolicy: params.resolveHostPolicy,
        });
    };

    return createTargetActionInvocationRegistry({
        actions: readActions(),
        subjectKinds: params.contributes.subjectKinds ?? [],
        expectedActions,
        readActions,
        ...(params.resolveEnvironmentApprovalScope ? { resolveEnvironmentApprovalScope: params.resolveEnvironmentApprovalScope } : {}),
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
        createServices: (seed, ...args) => {
            const resolveAccountSourceMachine = params.createAccountSourceMachineResolver?.(seed);
            return params.createServices({ ...seed,
                ...(resolveAccountSourceMachine ? { resolveAccountSourceMachine } : {}),
                ...(params.readCurrentTargetedDeclarations ? { readCurrentTargetedDeclarations: (signal?: AbortSignal) =>
                    params.readCurrentTargetedDeclarations!(seed.plugin.id, signal, resolveAccountSourceMachine) } : {}),
            }, ...args);
        },
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
            const contribution = readResolvedActionContribution(params.contributes, identity);
            const definition = contribution?.definition;
            const roles = contribution?.admittedTarget?.deploymentTargetRoles;
            let admittedPurposeTarget: import('@happier-dev/protocol').QualifiedConnectedAccountPurposeBindingTargetV1 | undefined;
            let admittedTeamPrincipal: Extract<import('@happier-dev/protocol/plugins/contributions/v2').DeploymentTargetRoleCommonInputV1['credentialPrincipal'], { kind: 'team' }> | undefined;
            let admittedPlatformOperation: Extract<import('@happier-dev/protocol/teams/credentials/directMaterialV1').TeamCredentialDirectMaterialConsumerV1, { kind: 'platform_operation' }> | undefined;
            let admittedPurposeRuntime: ReturnType<typeof import('@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime').createDaemonConnectedAccountPurposeBindingRuntime> | undefined;
            let deploymentSource: PluginInvocationServicesSeed['deploymentSource'];
            let managedWorkloads: PluginInvocationServicesSeed['managedWorkloads'];
            if (roles?.length) {
                const unavailable = (code = 'deployment_target_role_unavailable') => ({ status: 'unavailable' as const, code, message: code });
                const context = { ...input.approvalContext, signal: input.signal };
                const host = await params.readDeploymentTargetRoleAdmissionHost?.(context);
                if (!host) return unavailable();
                const qualifiedActionId = buildQualifiedPluginContributionKey(identity);
                const purposeAuthorization = resolveRegistryConnectedAccountActionCredentialPurposeAuthorization({ registry: params.contributes,
                    qualifiedActionId, fieldPath: 'credentialRef', requireSelect: false,
                    ...(params.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}) });
                const executionTarget = contribution?.admittedTarget?.declaration.execution.target;
                if (executionTarget !== 'account' && executionTarget !== 'daemon') return unavailable();
                try {
                    const admitted = await admitDeploymentTargetRoleForHost({ pluginId: input.pluginId, localId: input.localId,
                        bindings: roles, executionTarget, input: input.input, context, purposeAuthorization }, host);
                    if (admitted.input.credentialPrincipal.kind === 'account') admittedPurposeTarget = admitted.input.credentialPrincipal.target;
                    else {
                        admittedTeamPrincipal = admitted.input.credentialPrincipal;
                        if (admitted.receipt) admittedPlatformOperation = { kind: 'platform_operation', deploymentId: admitted.receipt.deployment.id,
                            environmentId: admitted.receipt.deployment.environmentId, operationId: admitted.receipt.deployment.actionOperationId };
                    }
                    admittedPurposeRuntime = host.readConnectedAccountPurposes?.() ?? undefined;
                    if (admittedTeamPrincipal && !admittedPurposeRuntime) return unavailable();
                    if (executionTarget === 'daemon' && params.ensureEnvironmentServices) {
                        managedWorkloads = createDeploymentTargetRoleWorkloadBindingForHost({ admission: admitted, host, context,
                            ensureEnvironmentServices: params.ensureEnvironmentServices,
                            readOwner: () => params.readRuntimeRegistry?.()?.projectManagedServices });
                    }
                    const runtime = admitted.executionEnvironment && admitted.workloadControl
                        ? { executionEnvironment: admitted.executionEnvironment, workloadControl: admitted.workloadControl } : undefined;
                    if (executionTarget === 'daemon' && admitted.receipt && (runtime || admitted.role === 'uploadDeploy'
                        && readHostReviewedChildOperationV1(context, formatQualifiedPluginActionId(identity), input.input))) {
                        const receipt = admitted.receipt;
                        deploymentSource = { identity: { environmentId: admitted.environment.environment.id, deploymentId: receipt.deployment.id },
                            admit: createDeploymentTargetRoleSourceAdmissionForHost({ ...admitted, receipt }, host, context),
                            ...(runtime ? { createExecEnv: (source, signal, retainCleanup) => createDeploymentTargetRoleExecEnvironmentForHost({
                                admission: { ...admitted, receipt, ...runtime }, host, context, source, signal, retainCleanup,
                                readOwner: () => params.readRuntimeRegistry?.()?.projectManagedServices,
                            }) } : {}) };
                    }
                } catch (error) {
                    if (input.signal.aborted) throw error;
                    if (isPluginError(error)) throw error;
                    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return unavailable(error.code);
                    throw error;
                }
                if (!input.isCurrent()) return unavailable('plugin_action_generation_retired');
            } else if (readInputPath(input.input, 'credentialPrincipal') !== undefined
                && definition?.connectedAccountPurposeBindings?.some(binding => binding.path === 'credentialRef')) {
                const unavailable = (code: string) => ({ status: 'unavailable' as const, code, message: code });
                const principal = DeploymentTargetCredentialPrincipalV1Schema.safeParse(readInputPath(input.input, 'credentialPrincipal'));
                const credentialRef = QualifiedConnectedAccountRefSchema.safeParse(readInputPath(input.input, 'credentialRef'));
                if (!principal.success || !credentialRef.success) return unavailable('deployment_invalid');
                const host = await params.readDeploymentTargetRoleAdmissionHost?.({ ...input.approvalContext, signal: input.signal });
                if (!host) return unavailable('deployment_target_role_unavailable');
                try {
                    const admitted = admitDeploymentTargetCredentialPrincipalForHost({
                        credentialPrincipal: principal.data, credentialRef: credentialRef.data,
                    }, host.credentialOwnerAccountId);
                    if (admitted.kind === 'account') admittedPurposeTarget = admitted.target;
                    else admittedTeamPrincipal = admitted;
                    admittedPurposeRuntime = host.readConnectedAccountPurposes?.() ?? undefined;
                    if (admittedTeamPrincipal && !admittedPurposeRuntime) return unavailable('deployment_target_role_unavailable');
                } catch (error) {
                    if (input.signal.aborted) throw error;
                    if (isPluginError(error)) throw error;
                    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return unavailable(error.code);
                    throw error;
                }
                if (!input.isCurrent()) return unavailable('plugin_action_generation_retired');
            }
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
                    const pages: InputOption[] = [];
                    let cursor: string | undefined;
                    do {
                        const resolved = await resolveInputTypeOptions({ deps: inputTypeDeps, ctx: context, identity: field.inputType,
                            query: { draftInput: isRecord(input.input) ? input.input : undefined, fieldPath: field.path, ...(cursor === undefined ? {} : { cursor }) },
                            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                            readFailure: result => {
                                const parsed = ActionExecuteFailureSchema.safeParse(result);
                                return parsed.success ? parsed.data : null;
                            },
                        });
                        if (!resolved.ok) return { status: 'unavailable', code: resolved.errorCode, message: 'Input choices are unavailable' };
                        pages.push(...resolved.result);
                        cursor = resolved.nextCursor;
                        // A selected value may live beyond the first provider page. Stop once
                        // all selections are admitted; static field narrowing is applied below.
                        if (readInputFieldSelectedValues(field, selected.data).every(value =>
                            validateInputTypeValue(type, value, pages).status === 'valid')) break;
                    } while (cursor !== undefined);
                    options = pages;
                }
                const validation = validateInputFieldValue({ field, value: selected.data, type, options });
                if (validation.status !== 'valid') return { status: validation.status, code: validation.reasonCode, message: 'Input value is invalid' };
                input.signal.throwIfAborted();
                if (!input.isCurrent()) return { status: 'unavailable', code: 'input_type_retired', message: 'Input invocation is retired' };
            }
            const revalidation = await revalidateRegistryConnectedAccountActionFormInput({
                registry: params.contributes,
                qualifiedActionId: buildQualifiedPluginContributionKey(
                    createPluginContributionIdentity({
                        pluginId: input.pluginId,
                        localId: input.localId,
                    }),
                ),
                value: input.input,
                ...(admittedPurposeTarget ? { admittedPurposeTarget } : {}),
                ...(admittedTeamPrincipal ? { admittedTeamPrincipal } : {}),
                ...(params.resolveOptionalAccess
                    ? { resolveOptionalAccess: params.resolveOptionalAccess }
                    : {}),
                ...((admittedPurposeRuntime ?? params.actionFormConnectedAccounts)
                    ? { actionFormConnectedAccounts: admittedPurposeRuntime ?? params.actionFormConnectedAccounts }
                    : {}),
                signal: input.signal,
                isCurrent: input.isCurrent,
            });
            if (revalidation) return revalidation;
            return admittedPurposeTarget || admittedTeamPrincipal || managedWorkloads
                ? { status: 'admitted' as const,
                    ...(admittedPurposeTarget ? { connectedAccountPurposeTarget: admittedPurposeTarget } : {}),
                    ...(admittedTeamPrincipal ? { connectedAccountTeamPrincipal: admittedTeamPrincipal } : {}),
                    ...(admittedPurposeRuntime ? { connectedAccountPurposeRuntime: admittedPurposeRuntime } : {}),
                    ...(admittedPlatformOperation ? { connectedAccountPlatformOperation: admittedPlatformOperation } : {}),
                    ...(deploymentSource ? { deploymentSource } : {}),
                    ...(managedWorkloads ? { managedWorkloads } : {}) } : null;
        },
        bindConnectedAccountActionOperation: async (input) => {
            const actionFormConnectedAccounts = input.admittedPurposeRuntime ?? params.actionFormConnectedAccounts;
            const selectedPurposes = input.approvalContext?.invocationServices?.connectedAccountPurposeBindingSelection;
            const captured = selectedPurposes ? captureConnectedAccountInvocationPurposeBinding({
                ...selectedPurposes, identity: { pluginId: input.pluginId, localId: input.localId },
                operationId: input.approvalContext?.externalActionExecutionAuthorization?.binding.requestId ?? input.correlationId,
                isCurrent: input.isCurrent,
            }) : undefined;
            const snapshot: Awaited<ReturnType<typeof resolveRegistryConnectedAccountActionPurposeBindingSnapshot>> = captured ? {
                purposes: captured.purposes, bindings: captured.purposeBindings.bindings,
                ...(captured.purposeBindings.teamResourceSelections ? { teamResourceSelections: captured.purposeBindings.teamResourceSelections } : {}),
            } : await resolveRegistryConnectedAccountActionPurposeBindingSnapshot({
                registry: params.contributes,
                qualifiedActionId: buildQualifiedPluginContributionKey(
                    createPluginContributionIdentity({
                        pluginId: input.pluginId,
                        localId: input.localId,
                    }),
                ),
                value: input.input,
                ...(input.admittedPurposeTarget ? { admittedPurposeTarget: input.admittedPurposeTarget } : {}),
                ...(input.admittedTeamPrincipal ? { admittedTeamPrincipal: input.admittedTeamPrincipal } : {}),
                ...(params.resolveOptionalAccess
                    ? { resolveOptionalAccess: params.resolveOptionalAccess }
                    : {}),
                ...(actionFormConnectedAccounts ? { actionFormConnectedAccounts } : {}),
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
            if (snapshot.teamResourceSelections?.length) {
                const [selected] = snapshot.teamResourceSelections;
                if (input.pluginId === GITHUB_EVENT_SETUP_ACTIONS_V1.pluginId
                    && input.localId === GITHUB_EVENT_SETUP_ACTIONS_V1.deploymentReview
                    && selected?.selection.deliveryMode === 'brokered') {
                    // Placement is owned by the requested Machine. The local handler runs
                    // one separately admitted repository lookup on the credential custodian.
                    return { dispose() {} };
                }
                if (input.pluginId === GITHUB_BROKER_WATCHER_V1.service.pluginId
                    && input.localId === GITHUB_BROKER_WATCHER_V1.attemptActionId) {
                    const adapter = selected?.selection.deliveryMode === 'brokered'
                        ? params.bindAutomationEventWatcherRead?.({ caller: input.caller, selected, input: input.input })
                        : undefined;
                    return adapter ? { watcherHttpAdapter: adapter, dispose() {} }
                        : { status: 'unavailable' as const, code: 'plugin_connected_account_team_resource_unavailable',
                            message: 'The Team credential requires its current Automation Event watcher' };
                }
                let context = input.approvalContext;
                const action = { pluginId: input.pluginId, localId: input.localId };
                const actionId = formatQualifiedPluginActionId(action);
                if (context?.externalActionExecutionAuthorization?.binding.actionId === ACTION_INVOKE_ACTION_ID_V1
                    && !readHostAdmittedReviewedChildV1(context)) {
                    const reviewed = readHostReviewedChildOperationV1(context, actionId, input.input);
                    if (reviewed) {
                        // Spend the registry's existing exact Action admission; the
                        // issuer supplies its private signed child transport proof.
                        const projected = await invokeHostReviewedChildV1({ parent: reviewed.parent, context,
                            child: { action, role: 'action_invoke', input: input.input },
                            admittedReview: { action, role: 'action_invoke', surface: context.surface ?? 'plugin' },
                            execute: async (_input, childContext) => ({ context: childContext }) });
                        if ('context' in projected) context = projected.context;
                    }
                }
                const authorization = context?.externalActionExecutionAuthorization;
                const resolveRequestHeaders = createExternalActionRequesterServerRequestHeaders(context);
                if (!actionFormConnectedAccounts?.admitActionPurposeBindings || !authorization || !resolveRequestHeaders) {
                    return Object.freeze({ status: 'unavailable' as const, code: 'plugin_connected_account_team_resource_unavailable',
                        message: 'The selected Team credential requires an admitted Action' });
                }
                const admission = await actionFormConnectedAccounts.admitActionPurposeBindings({
                    subject: { kind: 'action_operation', operationId: authorization.binding.requestId,
                        actionId: formatQualifiedPluginActionId({ pluginId: input.pluginId, localId: input.localId }),
                        pluginVersion: input.pluginVersion, consumer: { pluginId: input.pluginId, localId: input.localId },
                        isCurrent: input.isCurrent },
                    purposes: snapshot.purposes, bindings: snapshot.bindings,
                    teamResourceSelections: snapshot.teamResourceSelections, signal: input.signal,
                    ...(snapshot.bindingSelections ? { bindingSelections: snapshot.bindingSelections } : {}),
                    ...(input.recordOperationCredentialUse ? { recordOperationCredentialUse: input.recordOperationCredentialUse } : {}),
                    resolveRequestHeaders,
                });
                if (admission.kind === 'brokered') return Object.freeze({ executeBrokeredAction: admission.execute, dispose() {} });
                return Object.freeze({ exactPurposeBindingSubjectId: admission.lease.subjectId,
                    ...(input.admittedPurposeRuntime ? { connectedAccountsOwner: input.admittedPurposeRuntime.owner } : {}),
                    dispose: () => admission.lease.dispose() });
            }
            if (!actionFormConnectedAccounts?.activatePurposeBindings) {
                return Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_action_form_connected_account_options_unavailable',
                    message: 'Connected Account operation binding is unavailable for this Action',
                });
            }
            if (snapshot.directMaterialOrigins?.length && !input.admittedPlatformOperation) {
                return Object.freeze({ status: 'unavailable' as const, code: 'deployment_target_role_unavailable',
                    message: 'The platform Action has no admitted Deployment receipt' });
            }
            const lease = actionFormConnectedAccounts.activatePurposeBindings({
                subject: {
                    ...(snapshot.directMaterialOrigins?.length && input.admittedPlatformOperation
                        ? input.admittedPlatformOperation : { kind: 'operation' as const, operationId: input.correlationId }),
                    consumer: {
                        pluginId: input.pluginId,
                        localId: input.localId,
                    },
                    isCurrent: input.isCurrent,
                },
                purposes: snapshot.purposes,
                bindings: snapshot.bindings,
                ...(snapshot.directMaterialOrigins ? { directMaterialOrigins: snapshot.directMaterialOrigins } : {}),
                ...(snapshot.bindingSelections ? { bindingSelections: snapshot.bindingSelections } : {}),
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
                ...(input.admittedPurposeRuntime ? { connectedAccountsOwner: input.admittedPurposeRuntime.owner } : {}),
                dispose: () => lease.dispose(),
            });
        },
    });
}
