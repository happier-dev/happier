import { bindManagedMachineRoleCredentials, createManagedOpaquePresetReviewedChildPortV1, ManagedMachineControllerError, projectManagedMachineRolePurposeBindingsV1,
    readManagedMachineRoleCredentialConfigurationsV1,
    type ManagedNativeInvocation, type ManagedReconciliationNative } from '@happier-dev/cli-common/machines/managed';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { projectConnectedAccountHostAccessScopes } from '@happier-dev/cli-common/connectedAccounts';
import { readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readMachineProvisionerActionRolesV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { resolvePluginContributionHostAccessRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { executeDefaultActionInCapturedAccount } from '@/sync/ops/actions/defaultActionExecutor';
import type { createUiManagedAccountCredential } from './managedMachineAccountCredential';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

export type UiManagedAccountNativeAdmission = Readonly<{
    provisioner: MachineProvisionerContributionV1;
    providerPluginId: string;
}>;
export type UiManagedAccountOneOffAcquireInput = Extract<ManagedAcquireInputV1, Readonly<{
    selection: Readonly<{ kind: 'one-off' }>;
}>>;

export function readUiManagedAccountAdmission(context: ActionExecutorContext): UiManagedAccountNativeAdmission & { input: UiManagedAccountOneOffAcquireInput };
export function readUiManagedAccountAdmission(context: ActionExecutorContext, machine: ManagedMachineFullV1): UiManagedAccountNativeAdmission;
/** Preparation names roles; only Home's admitted row supplies retained native effects. */
export function readUiManagedAccountAdmission(context: ActionExecutorContext, machine?: ManagedMachineFullV1) {
    if (machine) {
        const provisioner = machine.reviewedFacts?.provisioner;
        if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
        return { provisioner, providerPluginId: machine.launch.provider.pluginId };
    }
    const parent = readHostAdmittedReviewedParentV1(context.hostReviewedChild);
    if (parent?.actionId !== 'machines.managed.acquire') throw new ManagedMachineControllerError('admission_unavailable');
    // This is the issuer's normalized admitted input, not a caller-supplied review snapshot.
    const input = parent.input as ManagedAcquireInputV1;
    if (input.selection.kind !== 'one-off') throw new ManagedMachineControllerError('admission_unavailable');
    const provisioner = input.reviewedFacts?.provisioner;
    if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
    return { input, provisioner, providerPluginId: input.reviewedFacts!.launch.provider.pluginId };
}

/** Account roles retain the authenticated parent and the exact local launch selection. */
export function createUiManagedAccountNative(params: Readonly<{
    account: LazyActionAccountContext;
    context: ActionExecutorContext;
    requestId: string;
    signal?: AbortSignal;
}>, admitted: UiManagedAccountNativeAdmission, readMachine: () => ManagedMachineFullV1,
readCredentialRevision: () => number | undefined, credential: ReturnType<typeof createUiManagedAccountCredential>): ManagedReconciliationNative {
    const roles = readMachineProvisionerActionRolesV1(admitted.provisioner);
    // The admitted finite operation keeps one host-runtime selection for every reviewed role.
    const selected = readPluginAccountAvailability(params.account.accountLifetime.scope)
        .readCurrentAccountExecution(admitted.providerPluginId);
    const invoke: ManagedNativeInvocation = async (role, body, io) => {
        const signal = io?.signal ?? params.signal;
        signal?.throwIfAborted();
        const localId = roles.find(candidate => candidate.role === role)?.action;
        if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
        if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
        const action = selected.manifest.contributes.actions?.find(candidate => candidate.id === localId);
        if (!action) throw new ManagedMachineControllerError('provider_unavailable');
        const identity = { pluginId: admitted.providerPluginId, localId };
        const machine = readMachine();
        const parent = machine.preset ? readHostAdmittedReviewedParentV1(params.context.hostReviewedChild) : null;
        const port = machine.preset
            ? parent
                ? createManagedOpaquePresetReviewedChildPortV1({
                    parent, context: params.context, launch: machine.launch, provisioner: admitted.provisioner, localId, role,
                    // The opaque issuer places its authenticated child proof and
                    // exact invocation services on this context. Re-enter the
                    // normal contributed-action front door without downgrading
                    // it to an ordinary child (which intentionally strips both).
                    execute: (childInput, childContext) => executeDefaultActionInCapturedAccount(params.account,
                        'action.invoke', { action: identity, input: PluginJsonValueV2Schema.parse(childInput) }, childContext),
                })
                : params.context.hostReviewedChild
            : params.context.hostReviewedChild;
        if (!port) throw new ManagedMachineControllerError('admission_unavailable');
        const requests = resolvePluginContributionHostAccessRequestsV2({ manifest: selected.manifest,
            pluginId: identity.pluginId, contribution: { family: 'actions', localId }, requestIds: action.hostAccess ?? [] });
        const authorizations = bindManagedMachineRoleCredentials({
            authorizations: projectConnectedAccountHostAccessScopes(identity.pluginId, requests).map(scope => ({
                ...scope, purpose: { consumer: identity, purpose: scope.purpose },
            })),
            provider: machine.launch.provider, credentials: machine.launch.credentials,
            qualification: { descriptor: admitted.provisioner, launch: machine.launch.choices },
        });
        let active = true;
        const binding: ConnectedAccountInvocationPurposeBinding = {
            // Same finite operation identity as the installed host: accepted
            // operation when present, otherwise Home's admitted creation request.
            identity, operationId: params.context.operationAcceptance?.operationId ?? params.requestId,
            purposes: authorizations.map(authorization => authorization.purpose),
            purposeBindings: projectManagedMachineRolePurposeBindingsV1(authorizations),
            isCurrent: () => active && !signal?.aborted,
            managedOperation: { role,
                credentialConfigurations: readManagedMachineRoleCredentialConfigurationsV1(authorizations),
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
            if (!result.ok) throw ManagedMachineControllerError.fromActionFailure(result, 'action.invoke', identity);
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
