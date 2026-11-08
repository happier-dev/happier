import { bindManagedMachineRoleCredentials, ManagedMachineControllerError,
    type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { projectConnectedAccountHostAccessScopes, type ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { PluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readMachineProvisionerActionRolesV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { resolvePluginContributionHostAccessRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';

/** Finite Account controls and reads consume the same selected, reviewed role port. */
export function createCliManagedAccountNativeInvocation(input: Readonly<{
    machine: ManagedMachineV1;
    provisioner: MachineProvisionerContributionV1;
    selected: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>;
    context: ActionExecutorContext;
    signal?: AbortSignal;
    requestId: string;
}>): ManagedNativeInvocation {
    const { machine, provisioner, selected } = input;
    const port = input.context.hostReviewedChild;
    if (!port) throw new ManagedMachineControllerError('admission_unavailable');
    const roles = readMachineProvisionerActionRolesV1(provisioner);
    return async (role, body) => {
        const localId = roles.find(candidate => candidate.role === role)?.action;
        if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
        const identity = { pluginId: machine.launch.provider.pluginId, localId };
        const declaration = selected.manifest.contributes.actions.find(action => action.id === localId);
        if (!declaration) throw new ManagedMachineControllerError('provider_unavailable');
        const requests = resolvePluginContributionHostAccessRequestsV2({ manifest: selected.manifest, pluginId: identity.pluginId,
            contribution: { family: 'actions', localId }, requestIds: declaration.hostAccess ?? [] });
        const authorizations = bindManagedMachineRoleCredentials({
            authorizations: projectConnectedAccountHostAccessScopes(identity.pluginId, requests).map(scope => ({ ...scope,
                purpose: { consumer: identity, purpose: scope.purpose } })),
            provider: machine.launch.provider, credentials: machine.launch.credentials,
            qualification: { descriptor: provisioner, launch: machine.launch.choices },
        });
        let active = true;
        const binding: ConnectedAccountInvocationPurposeBinding = { identity,
            operationId: input.context.operationAcceptance?.operationId ?? input.requestId,
            purposes: authorizations.map(authorization => authorization.purpose),
            purposeBindings: { v: 1, bindings: authorizations.map(authorization => ({ purpose: authorization.purpose,
                target: { kind: 'account', account: authorization.credential.account } })) },
            isCurrent: () => active && !input.signal?.aborted,
            managedOperation: { role, credentialConfigurations: authorizations.flatMap(({ credential }) => credential.configurationRevision === undefined
                ? [] : [{ account: credential.account, revision: credential.configurationRevision }]),
                isCurrent: currentRole => active && currentRole === role && !input.signal?.aborted },
        };
        try {
            const result = await port.invoke({ action: identity, role, input: PluginJsonValueV2Schema.parse(body),
                invocationServices: { managedMachine: machine, connectedAccountPurposeBinding: binding } });
            if (!result.ok) throw new ManagedMachineControllerError(result.errorCode ?? 'provider_unavailable');
            return PluginJsonValueV2Schema.parse(result.result ?? null);
        } finally { active = false; }
    };
}
