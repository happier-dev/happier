import { prepareManagedAcquireProvisionerAdmissionV1, prepareManagedPowerProvisionerAdmissionV1, executeManagedProvisionerDiscovery, projectAccountManagedProvisioners,
    type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import { ManagedMachineActionInputSchemasV1, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionExecutorDeps, ActionExecuteFailure, HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { LazyActionAccountContext } from './actionAccountContext';
import { createManagedMachineActionClient, ManagedMachineActionError } from '@/sync/api/machines/managedMachineActions';
import { resolvePluginActionConnectedAccountUseRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { projectConnectedAccountHostAccessScopes, type ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { bindManagedMachineRoleCredentials, ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { readUiConnectedAccountActionFormOptions } from '@/sync/ops/connectedAccounts/connectedAccountFormOptions';

/** Exact effects demand one selected declaration; chooser discovery retains the family inventory. */
export async function readUiManagedProvisioners(account: LazyActionAccountContext,
    pluginId?: string): Promise<readonly ManagedProvisionerDiscoveryEntry[] | ActionExecuteFailure> {
    const reader = readPluginAccountAvailability(account.accountLifetime.scope);
    if (pluginId !== undefined) {
        const selection = await reader.ensureCurrentAccountExecution(pluginId);
        account.assertCurrent();
        return selection.kind === 'available' ? projectAccountManagedProvisioners([selection])
            : { ok: false, errorCode: selection.code, error: selection.code };
    }
    const declarations = await reader.ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    account.assertCurrent();
    if (declarations.kind === 'unavailable') return { ok: false as const, errorCode: declarations.code, error: declarations.code };
    return projectAccountManagedProvisioners(declarations.declarations);
}

export async function executeUiManagedProvisionerList(account: LazyActionAccountContext,
    input: ManagedMachineActionInputV1<'machines.provisioners.list'>, signal: AbortSignal = new AbortController().signal) {
    const entries = await readUiManagedProvisioners(account, input.contribution?.pluginId);
    return 'ok' in entries ? entries : executeManagedProvisionerDiscovery({
        actionId: 'machines.provisioners.list', value: input, entries,
        // The mounted configurator demands one provider's account choices. The broad
        // chooser only needs declarations and does not read every service's accounts.
        ...(input.contribution ? { readCredentialPurposes: async (entry: ManagedProvisionerDiscoveryEntry) => {
            const selection = readPluginAccountAvailability(account.accountLifetime.scope)
                .readCurrentAccountExecution(entry.contribution.pluginId);
            if (selection.kind !== 'available') return undefined;
            const requests = resolvePluginActionConnectedAccountUseRequestsV2(selection.manifest, entry.descriptor.actions.acquire);
            if (!requests) return undefined;
            const scopes = projectConnectedAccountHostAccessScopes(entry.contribution.pluginId, requests);
            return await Promise.all(scopes.map(async scope => ({
                purpose: { consumer: entry.contribution, purpose: scope.purpose },
                options: [...await readUiConnectedAccountActionFormOptions(account, scope.serviceRefs, signal)],
            })));
        } } : {}),
    });
}

/** Runs at original Action preparation, before the executor reviews any descriptor-derived role. */
export async function prepareUiManagedProvisionerAdmission(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    account: LazyActionAccountContext | undefined,
): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure | null> {
    if (request.actionId === 'machines.provisioners.check' || request.actionId === 'machines.provisioners.options') {
        const actionId = request.actionId;
        const input = ManagedMachineActionInputSchemasV1[actionId].parse(request.input);
        if (input.controller) return null;
        if (!account?.serverIdentityId) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        if (input.homeId !== account.serverIdentityId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        const selected = await readPluginAccountAvailability(account.accountLifetime.scope)
            .ensureCurrentAccountExecution(input.contribution.pluginId);
        account.assertCurrent();
        if (selected.kind !== 'available') return { ok: false, errorCode: selected.code, error: selected.code };
        const entry = projectAccountManagedProvisioners([selected]).find(candidate => candidate.contribution.localId === input.contribution.localId);
        const role = actionId === 'machines.provisioners.check' ? 'check' : 'options';
        const localId = entry?.descriptor.actions[role];
        const requests = localId && resolvePluginActionConnectedAccountUseRequestsV2(selected.manifest, localId);
        if (!entry || !localId || !requests) return { ok: false, errorCode: 'provider_unavailable', error: 'provider_unavailable' };
        const identity = { pluginId: input.contribution.pluginId, localId };
        const roleInput = PluginJsonValueV2Schema.parse(actionId === 'machines.provisioners.options' ? input.selectors ?? {} : {});
        let authorizations;
        try {
            authorizations = bindManagedMachineRoleCredentials({
                authorizations: projectConnectedAccountHostAccessScopes(identity.pluginId, requests).map(scope => ({
                    ...scope, purpose: { consumer: identity, purpose: scope.purpose },
                })),
                providerPluginId: identity.pluginId, credentials: input.credentials,
                qualification: { descriptor: entry.descriptor, launch: input.selectors },
            });
        } catch (error) {
            if (!(error instanceof ManagedMachineControllerError)) throw error;
            return { ok: false, errorCode: error.code, error: error.code };
        }
        // Retain the selected role and its qualified credentials through ordinary
        // child admission; Account discovery never needs a controller or Home write.
        return { children: [{ action: identity, role, input: roleInput }],
            executeAdmittedAction: async ({ context }) => {
                let active = true;
                const binding: ConnectedAccountInvocationPurposeBinding = {
                    identity, operationId: context.operationAcceptance?.operationId ?? context.actionRequestId!,
                    purposes: authorizations.map(authorization => authorization.purpose),
                    purposeBindings: { v: 1, bindings: authorizations.map(authorization => ({ purpose: authorization.purpose,
                        target: { kind: 'account', account: authorization.credential.account } })) },
                    isCurrent: () => active && !context.signal?.aborted,
                    managedOperation: { role,
                        credentialConfigurations: authorizations.flatMap(({ credential }) => credential.configurationRevision === undefined
                            ? [] : [{ account: credential.account, revision: credential.configurationRevision }]),
                        isCurrent: currentRole => active && currentRole === role && !context.signal?.aborted },
                };
                try {
                    const result = await executeManagedProvisionerDiscovery({ actionId, value: input, entries: [entry],
                        invoke: async () => {
                            const invoked = await context.hostReviewedChild!.invoke({ action: identity, role, input: roleInput,
                                invocationServices: { connectedAccountPurposeBinding: binding } });
                            if (!invoked.ok) throw new ManagedMachineControllerError(invoked.errorCode ?? 'provider_unavailable');
                            return invoked.result;
                        } });
                    return { ok: true, result };
                } catch (error) {
                    const code = context.signal?.aborted ? 'cancelled'
                        : error instanceof ManagedMachineControllerError ? error.code : 'provider_unavailable';
                    return { ok: false, errorCode: code, error: code };
                } finally { active = false; }
            } };
    }
    const readSelected = async (pluginId: string) => {
        if (!account) return null;
        const entries = await readUiManagedProvisioners(account, pluginId);
        return 'ok' in entries ? null : entries;
    };
    if (request.actionId === 'machines.managed.power.set' || request.actionId === 'machines.managed.inspect'
        || request.actionId === 'machines.managed.bootstrap.retry' || request.actionId === 'machines.managed.delete'
        || request.actionId === 'machines.managed.cancel') {
        const input = ManagedMachineActionInputSchemasV1[request.actionId].parse(request.input);
        if ('when' in input && input.when !== 'now') return null;
        if (!account?.serverIdentityId) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        if (input.homeId !== account.serverIdentityId) return { ok: false as const, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        try {
            const machine = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get',
                { homeId: input.homeId, managedId: input.managedId }, { signal: request.context.signal });
            account.assertCurrent();
            if (machine.id !== input.managedId || machine.homeId !== input.homeId)
                return { ok: false as const, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' };
            return prepareManagedPowerProvisionerAdmissionV1(machine, readSelected, request.actionId,
                'includeGuestDiagnostics' in input && input.includeGuestDiagnostics ? { includeGuestDiagnostics: true } : undefined);
        } catch (error) {
            const code = request.context.signal?.aborted ? 'cancelled'
                : error instanceof ManagedMachineActionError ? error.code : 'managed_request_failed';
            return prepareManagedPowerProvisionerAdmissionV1({ ok: false, errorCode: code, error: code }, readSelected, request.actionId);
        }
    }
    return prepareManagedAcquireProvisionerAdmissionV1(request, readSelected);
}
