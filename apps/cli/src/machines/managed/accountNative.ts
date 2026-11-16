import { createExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { projectManagedMachineRolePurposeBindingsV1, readManagedMachineRoleCredentialConfigurationsV1,
    bindManagedMachineRoleCredentials, createManagedOpaquePresetReviewedChildPortV1, ManagedMachineControllerError,
    ManagedMachineNativeEffectGuardRefusal,
    type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { projectConnectedAccountHostAccessScopes, type ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { PluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import { MachineProvisionerContributionV1Schema, readMachineProvisionerActionRolesV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { resolvePluginContributionHostAccessRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { readPluginActionFailureHandlerInvocation } from '@happier-dev/protocol/plugins/actions/invocation';

/** Finite Account controls and reads consume the same selected, reviewed role port. */
export function createCliManagedAccountNativeInvocation(input: Readonly<{
    machine: ManagedMachineFullV1;
    provisioner: MachineProvisionerContributionV1;
    selected: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>;
    context: ActionExecutorContext;
    signal?: AbortSignal;
    requestId: string;
}>): ManagedNativeInvocation {
    return createAccountNativeInvocation({ ...input, launch: input.machine.launch,
        useReviewedParent: Boolean(input.machine.preset) });
}

/** Prepared images retain their original launch and do not require a Machine row. */
export function createCliManagedAccountNativeInvocationForLaunch(input: Readonly<{
    launch: ManagedMachinePresetPreparationBindingV1['configuration']['launch'];
    credentialConfigurations: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'];
    provisioner: MachineProvisionerContributionV1;
    selected: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>;
    context: ActionExecutorContext;
    signal?: AbortSignal;
    requestId: string;
    /** Retained Prepare placement; missing legacy placement cannot select a Machine effect. */
    originalMachineId?: string;
}>): ManagedNativeInvocation {
    return createAccountNativeInvocation({ ...input, useReviewedParent: true,
        originalPreparation: { machineId: input.originalMachineId } });
}

function createAccountNativeInvocation(input: Readonly<{
    launch: ManagedMachinePresetPreparationBindingV1['configuration']['launch'];
    credentialConfigurations?: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'];
    machine?: ManagedMachineFullV1;
    useReviewedParent: boolean;
    provisioner: MachineProvisionerContributionV1;
    selected: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>;
    context: ActionExecutorContext;
    signal?: AbortSignal;
    requestId: string;
    originalPreparation?: Readonly<{ machineId?: string }>;
}>): ManagedNativeInvocation {
    const { launch, provisioner, selected } = input;
    const reviewedParent = input.useReviewedParent ? readHostAdmittedReviewedParentV1(input.context.hostReviewedChild) : null;
    const roles = readMachineProvisionerActionRolesV1(provisioner);
    return async (role, body) => {
        const localId = roles.find(candidate => candidate.role === role)?.action;
        if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
        const identity = { pluginId: launch.provider.pluginId, localId };
        const declaration = selected.manifest.contributes.actions.find(action => action.id === localId);
        if (!declaration) throw new ManagedMachineControllerError('provider_unavailable');
        if (input.originalPreparation && declaration.execution?.target !== 'account') {
            const machineId = input.context.runtimeActionMachineId ?? input.context.externalActionExecutionAuthorization?.binding.machineId;
            // Cross-host routing waits for Home's original-placement admission. Never substitute today's controller.
            if (!input.originalPreparation.machineId || input.originalPreparation.machineId !== machineId) {
                throw new ManagedMachineControllerError('controller_unavailable');
            }
        }
        const port = input.useReviewedParent && reviewedParent
            ? createManagedOpaquePresetReviewedChildPortV1({ parent: reviewedParent, context: input.context,
                launch, provisioner, localId, role,
                execute: async (childInput, childContext) => {
                    const execute = childContext.executeHostReviewedChildAction;
                    return execute ? await execute('action.invoke', { action: identity,
                        input: PluginJsonValueV2Schema.parse(childInput) }, childContext)
                        : { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
                } })
            : input.context.hostReviewedChild;
        if (!port) throw new ManagedMachineControllerError('admission_unavailable');
        const requests = resolvePluginContributionHostAccessRequestsV2({ manifest: selected.manifest, pluginId: identity.pluginId,
            contribution: { family: 'actions', localId }, requestIds: declaration.hostAccess ?? [] });
        const authorizations = bindManagedMachineRoleCredentials({
            authorizations: projectConnectedAccountHostAccessScopes(identity.pluginId, requests).map(scope => ({ ...scope,
                purpose: { consumer: identity, purpose: scope.purpose } })),
            provider: launch.provider, credentials: launch.credentials,
            qualification: { descriptor: provisioner, launch: launch.choices },
        });
        let active = true;
        const binding: ConnectedAccountInvocationPurposeBinding = { identity,
            operationId: input.context.externalActionExecutionAuthorization?.binding.requestId ?? input.requestId,
            purposes: authorizations.map(authorization => authorization.purpose),
            purposeBindings: projectManagedMachineRolePurposeBindingsV1(authorizations),
            actionOperation: { pluginVersion: selected.manifest.version, signal: input.signal ?? new AbortController().signal,
                resolveRequestHeaders: createExternalActionRequesterServerRequestHeaders(input.context) },
            isCurrent: () => active && !input.signal?.aborted,
            managedOperation: { role, credentialConfigurations: input.credentialConfigurations
                    ?? readManagedMachineRoleCredentialConfigurationsV1(authorizations),
                isCurrent: currentRole => active && currentRole === role && !input.signal?.aborted },
        };
        try {
            const result = await port.invoke({ action: identity, role, input: PluginJsonValueV2Schema.parse(body),
                invocationServices: { ...(input.machine ? { managedMachine: input.machine } : {}), connectedAccountPurposeBinding: binding } });
            if (!result.ok) {
                const ErrorClass = readPluginActionFailureHandlerInvocation({ code: result.errorCode, message: result.error,
                    data: result.details }) === 'notStarted'
                    ? ManagedMachineNativeEffectGuardRefusal : ManagedMachineControllerError;
                throw ErrorClass.fromActionFailure(result, 'action.invoke', identity);
            }
            return PluginJsonValueV2Schema.parse(result.result ?? null);
        } finally { active = false; }
    };
}

/** The Account-selected declaration is the local effect-time provider owner. */
export function resolveCliManagedAccountProvisioner(machine: ManagedMachineFullV1,
    selected: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>): MachineProvisionerContributionV1 {
    const declared = selected.manifest.contributes.machineProvisioners.find(candidate => candidate.id === machine.launch.provider.localId);
    const provisioner = MachineProvisionerContributionV1Schema.safeParse(declared);
    if (!provisioner.success || selected.manifest.id !== machine.launch.provider.pluginId
        || provisioner.data.schemaVersion !== machine.launch.schemaVersion) {
        throw new ManagedMachineControllerError('provider_unavailable');
    }
    return provisioner.data;
}
