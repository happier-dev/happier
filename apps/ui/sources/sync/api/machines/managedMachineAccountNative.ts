import { bindManagedMachineRoleCredentials, createManagedOpaquePresetReviewedChildPortV1, ManagedMachineControllerError, projectManagedMachineRolePurposeBindingsV1,
    readManagedMachineRoleCredentialConfigurationsV1,
    type ManagedNativeInvocation, type ManagedReconciliationNative } from '@happier-dev/cli-common/machines/managed';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { projectConnectedAccountHostAccessScopes } from '@happier-dev/cli-common/connectedAccounts';
import { readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { PluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { isManagedPresetAcquireInputV1, type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
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
    if (isManagedPresetAcquireInputV1(input)) throw new ManagedMachineControllerError('admission_unavailable');
    const reviewedFacts = input.reviewedFacts;
    if (!reviewedFacts?.provisioner) throw new ManagedMachineControllerError('provider_unavailable');
    return { input, provisioner: reviewedFacts.provisioner, providerPluginId: reviewedFacts.launch.provider.pluginId };
}

/** Account roles retain the authenticated parent and the exact local launch selection. */
export function createUiManagedAccountNative(params: Readonly<{
    account: LazyActionAccountContext;
    context: ActionExecutorContext;
    requestId: string;
    signal?: AbortSignal;
}>, admitted: UiManagedAccountNativeAdmission, readMachine: () => ManagedMachineFullV1,
readCredentialRevision: () => number | undefined, credential: ReturnType<typeof createUiManagedAccountCredential>): ManagedReconciliationNative {
    const invoke = createUiManagedAccountNativeInvocation({ ...params, ...admitted }, () => {
        const machine = readMachine();
        return { launch: machine.launch, machine,
            readBootstrapCredential: async () => new TextEncoder().encode((await credential.read(machine, readCredentialRevision())).value),
            readGuestHostCredential: async () => {
                const value = (await credential.read(machine, readCredentialRevision())).guestHostPrivateKey;
                if (!value) throw new ManagedMachineControllerError('credential_unavailable');
                return new TextEncoder().encode(value);
            },
        };
    });
    return {
        bootstrapCredentialKind: admitted.provisioner.bootstrapCredential?.kind
            ?? (admitted.provisioner.bootstrapTransport ? undefined : 'ssh'),
        prepareRoles: async () => {}, invoke,
    };
}

/** Prepared images retain their original launch, credential configuration and placement. */
export function createUiManagedAccountNativeInvocationForLaunch(params: Readonly<{
    account: LazyActionAccountContext;
    launch: ManagedMachinePresetPreparationBindingV1['configuration']['launch'];
    credentialConfigurations: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'];
    provisioner: MachineProvisionerContributionV1;
    selected: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>;
    context: ActionExecutorContext;
    requestId: string;
    signal?: AbortSignal;
    originalMachineId?: string;
}>): ManagedNativeInvocation {
    return createUiManagedAccountNativeInvocation({ ...params, providerPluginId: params.launch.provider.pluginId,
        originalPreparation: { machineId: params.originalMachineId } }, () => ({ launch: params.launch,
            credentialConfigurations: params.credentialConfigurations }));
}

function createUiManagedAccountNativeInvocation(params: Readonly<{
    account: LazyActionAccountContext;
    provisioner: MachineProvisionerContributionV1;
    providerPluginId: string;
    selected?: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>;
    context: ActionExecutorContext;
    requestId: string;
    signal?: AbortSignal;
    originalPreparation?: Readonly<{ machineId?: string }>;
}>, read: () => Readonly<{
    launch: ManagedMachinePresetPreparationBindingV1['configuration']['launch'];
    machine?: ManagedMachineFullV1;
    credentialConfigurations?: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'];
    readBootstrapCredential?: () => Promise<Uint8Array>;
    readGuestHostCredential?: () => Promise<Uint8Array>;
}>): ManagedNativeInvocation {
    const roles = readMachineProvisionerActionRolesV1(params.provisioner);
    const selected = params.selected ?? readPluginAccountAvailability(params.account.accountLifetime.scope)
        .readCurrentAccountExecution(params.providerPluginId);
    const invoke: ManagedNativeInvocation = async (role, body, io) => {
        const signal = io?.signal ?? params.signal;
        signal?.throwIfAborted();
        const localId = roles.find(candidate => candidate.role === role)?.action;
        if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
        if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
        const action = selected.manifest.contributes.actions?.find(candidate => candidate.id === localId);
        if (!action) throw new ManagedMachineControllerError('provider_unavailable');
        const identity = { pluginId: params.providerPluginId, localId };
        const state = read();
        const { launch, machine } = state;
        const original = params.originalPreparation;
        const useParent = Boolean(machine?.preset || original);
        const parent = useParent ? readHostAdmittedReviewedParentV1(params.context.hostReviewedChild) : null;
        const port = useParent
            ? parent
                ? createManagedOpaquePresetReviewedChildPortV1({
                    parent, context: params.context, launch, provisioner: params.provisioner, localId, role,
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
        if (original && action.execution?.target !== 'account') {
            const machineId = params.context.runtimeActionMachineId ?? params.context.externalActionExecutionAuthorization?.binding.machineId;
            if (!original.machineId || original.machineId !== machineId) throw new ManagedMachineControllerError('controller_unavailable');
        }
        const requests = resolvePluginContributionHostAccessRequestsV2({ manifest: selected.manifest,
            pluginId: identity.pluginId, contribution: { family: 'actions', localId }, requestIds: action.hostAccess ?? [] });
        const authorizations = bindManagedMachineRoleCredentials({
            authorizations: projectConnectedAccountHostAccessScopes(identity.pluginId, requests).map(scope => ({
                ...scope, purpose: { consumer: identity, purpose: scope.purpose },
            })),
            provider: launch.provider, credentials: launch.credentials,
            qualification: { descriptor: params.provisioner, launch: launch.choices },
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
                credentialConfigurations: state.credentialConfigurations ?? readManagedMachineRoleCredentialConfigurationsV1(authorizations),
                isCurrent: currentRole => active && currentRole === role && !signal?.aborted },
        };
        try {
            await io?.beforeNativeEffect?.();
            const result = await port.invoke({ action: identity, role, input: PluginJsonValueV2Schema.parse(body),
                invocationServices: { ...(machine ? { managedMachine: machine } : {}), connectedAccountPurposeBinding: binding,
                    ...(state.readBootstrapCredential ? { managedBootstrapCredential: {
                        role, isCurrent: () => active && !signal?.aborted,
                        readBootstrapCredential: state.readBootstrapCredential,
                        ...(role === 'acquire' && state.readGuestHostCredential ? { readGuestHostCredential: state.readGuestHostCredential } : {}),
                    } } : {}),
                } });
            if (!result.ok) throw ManagedMachineControllerError.fromActionFailure(result, 'action.invoke', identity);
            return PluginJsonValueV2Schema.parse(result.result ?? null);
        } finally { active = false; }
    };
    return invoke;
}
