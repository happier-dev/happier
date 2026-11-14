import { prepareManagedAcquireProvisionerAdmissionV1, prepareManagedPowerProvisionerAdmissionV1, projectAccountManagedProvisioners,
    type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { StoredCredentials } from '@/persistence';
import { readCurrentAccountPluginExecutionDeclarations } from '@/plugins/runtime/accountPluginActivationSource';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isManagedControlAdmissionActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { openManagedMachineRead } from './readManagedMachine';

/** The ordinary Account selector admits one exact plugin; no native activation or fleet census. */
export async function prepareCliManagedProvisionerAdmission(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    account: Readonly<{ credentials?: StoredCredentials | null; serverUrl: string; managedMachineAction?: ActionExecutorDeps['managedMachineAction'] }>,
) {
    const readSelected = (pluginId: string) => readCliManagedProvisioners(pluginId, account, request.context.signal);
    if (isManagedControlAdmissionActionIdV1(request.actionId) || request.actionId === 'machines.managed.inspect') {
        const input = ManagedMachineActionInputSchemasV1[request.actionId].parse(request.input);
        if ('when' in input && input.when !== 'now') return null;
        const options = 'includeGuestDiagnostics' in input && input.includeGuestDiagnostics ? { includeGuestDiagnostics: true as const } : undefined;
        if (!account.managedMachineAction) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        const result = await account.managedMachineAction({ actionId: 'machines.managed.get',
            input: { homeId: input.homeId, managedId: input.managedId }, context: request.context, signal: request.context.signal });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) return prepareManagedPowerProvisionerAdmissionV1(failure.data, readSelected, request.actionId, options);
        const parsed = ManagedMachineActionOutputSchemasV1['machines.managed.get'].safeParse(result);
        if (!parsed.success)
            return { ok: false as const, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' };
        if (!account.credentials) return { ok: false as const, errorCode: 'credential_unavailable', error: 'credential_unavailable' };
        try {
            const machine = await openManagedMachineRead({ credentials: account.credentials, serverHttpBaseUrl: account.serverUrl,
                read: parsed.data, ...(request.context.signal ? { signal: request.context.signal } : {}) });
            if (machine.id !== input.managedId || machine.homeId !== input.homeId) {
                return { ok: false as const, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' };
            }
            return prepareManagedPowerProvisionerAdmissionV1(machine, readSelected, request.actionId, options);
        } catch {
            request.context.signal?.throwIfAborted();
            return { ok: false as const, errorCode: 'credential_unavailable', error: 'credential_unavailable' };
        }
    }
    return prepareManagedAcquireProvisionerAdmissionV1(request, readSelected);
}

export async function readCliManagedProvisioners(pluginId: string,
    account: Readonly<{ credentials?: StoredCredentials | null; serverUrl: string }>, signal?: AbortSignal): Promise<readonly ManagedProvisionerDiscoveryEntry[] | null> {
    if (!account.credentials) return null;
    try {
        const selected = await readCurrentAccountPluginExecutionDeclarations({ pluginId, family: 'machineProvisioners',
            credentials: account.credentials, serverUrl: account.serverUrl, ...(signal ? { signal } : {}),
        });
        return selected.kind !== 'available' ? null : projectAccountManagedProvisioners(selected.declarations);
    } catch {
        return null;
    }
}
