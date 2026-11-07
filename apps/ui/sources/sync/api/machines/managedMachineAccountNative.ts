import { bindManagedMachineRoleCredentials, ManagedMachineControllerError,
    type ManagedNativeInvocation, type ManagedReconciliationNative } from '@happier-dev/cli-common/machines/managed';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { projectConnectedAccountHostAccessScopes } from '@happier-dev/cli-common/connectedAccounts';
import { readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readMachineProvisionerActionRolesV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { resolvePluginContributionHostAccessRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { createUiManagedAccountCredential } from './managedMachineAccountCredential';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

type UiManagedAccountNativeAdmission = Readonly<{
    provisioner: MachineProvisionerContributionV1;
    providerPluginId: string;
}>;

export function readUiManagedAccountAdmission(context: ActionExecutorContext): UiManagedAccountNativeAdmission & { input: ManagedAcquireInputV1 };
export function readUiManagedAccountAdmission(context: ActionExecutorContext, machine: ManagedMachineV1): UiManagedAccountNativeAdmission;
/** Preparation names roles; only Home's admitted row supplies retained native effects. */
export function readUiManagedAccountAdmission(context: ActionExecutorContext, machine?: ManagedMachineV1) {
    if (machine) {
        const provisioner = machine.reviewedFacts?.provisioner;
        if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
        return { provisioner, providerPluginId: machine.launch.provider.pluginId };
    }
    const parent = readHostAdmittedReviewedParentV1(context.hostReviewedChild);
    if (parent?.actionId !== 'machines.managed.acquire') throw new ManagedMachineControllerError('admission_unavailable');
    // This is the issuer's normalized admitted input, not a caller-supplied review snapshot.
    const input = parent.input as ManagedAcquireInputV1;
    const provisioner = input.reviewedFacts?.provisioner;
    if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
    return { input, provisioner, providerPluginId: input.reviewedFacts!.launch.provider.pluginId };
}

/** Account roles use the ordinary reviewed-child executor and exact retained launch selections. */
export function createUiManagedAccountNative(params: Readonly<{
    account: LazyActionAccountContext;
    context: ActionExecutorContext;
    requestId: string;
    signal?: AbortSignal;
}>, admitted: UiManagedAccountNativeAdmission, readMachine: () => ManagedMachineV1,
readCredentialRevision: () => number | undefined, credential: ReturnType<typeof createUiManagedAccountCredential>): ManagedReconciliationNative {
    const port = params.context.hostReviewedChild!;
    const roles = readMachineProvisionerActionRolesV1(admitted.provisioner);
    const invoke: ManagedNativeInvocation = async (role, body, io) => {
        const signal = io?.signal ?? params.signal;
        signal?.throwIfAborted();
        const localId = roles.find(candidate => candidate.role === role)?.action;
        if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
        const selected = readPluginAccountAvailability(params.account.accountLifetime.scope)
            .readCurrentAccountExecution(admitted.providerPluginId);
        if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
        const action = selected.manifest.contributes.actions?.find(candidate => candidate.id === localId);
        if (!action) throw new ManagedMachineControllerError('provider_unavailable');
        const identity = { pluginId: admitted.providerPluginId, localId };
        const machine = readMachine();
        const requests = resolvePluginContributionHostAccessRequestsV2({ manifest: selected.manifest,
            pluginId: identity.pluginId, contribution: { family: 'actions', localId }, requestIds: action.hostAccess ?? [] });
        const authorizations = bindManagedMachineRoleCredentials({
            authorizations: projectConnectedAccountHostAccessScopes(identity.pluginId, requests).map(scope => ({
                ...scope, purpose: { consumer: identity, purpose: scope.purpose },
            })),
            providerPluginId: identity.pluginId, credentials: machine.launch.credentials,
            qualification: { descriptor: admitted.provisioner, launch: machine.launch.choices },
        });
        let active = true;
        const binding: ConnectedAccountInvocationPurposeBinding = {
            // Same finite operation identity as the installed host: accepted
            // operation when present, otherwise Home's admitted creation request.
            identity, operationId: params.context.operationAcceptance?.operationId ?? params.requestId,
            purposes: authorizations.map(authorization => authorization.purpose),
            purposeBindings: { v: 1, bindings: authorizations.map(authorization => ({ purpose: authorization.purpose,
                target: { kind: 'account', account: authorization.credential.account } })) },
            isCurrent: () => active && !signal?.aborted,
            managedOperation: { role,
                credentialConfigurations: authorizations.flatMap(({ credential }) => credential.configurationRevision === undefined
                    ? [] : [{ account: credential.account, revision: credential.configurationRevision }]),
                isCurrent: currentRole => active && currentRole === role && !signal?.aborted },
        };
        try {
            await io?.beforeNativeEffect?.();
            const result = await port.invoke({ action: identity, role, input: PluginJsonValueV2Schema.parse(body),
                invocationServices: { managedMachine: machine, connectedAccountPurposeBinding: binding,
                    managedBootstrapCredential: { role, isCurrent: () => active && !signal?.aborted,
                        readBootstrapCredential: async () => new TextEncoder().encode((await credential.read(machine, readCredentialRevision())).value),
                        ...(role === 'acquire' ? { readGuestHostCredential: async () => {
                            const value = (await credential.read(machine, readCredentialRevision())).guestHostPrivateKey;
                            if (!value) throw new ManagedMachineControllerError('credential_unavailable');
                            return new TextEncoder().encode(value);
                        } } : {}),
                    } } });
            if (!result.ok) throw new ManagedMachineControllerError(result.errorCode ?? 'provider_unavailable');
            return PluginJsonValueV2Schema.parse(result.result ?? null);
        } finally { active = false; }
    };
    return {
        bootstrapCredentialKind: admitted.provisioner.bootstrapCredential?.kind
            ?? (admitted.provisioner.bootstrapTransport ? undefined : 'ssh'),
        prepareRoles: async () => {},
        invoke,
    };
}
