import { prepareManagedAcquireProvisionerAdmissionV1, prepareManagedPowerProvisionerAdmissionV1, projectAccountManagedProvisioners,
    type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import { createPluginAccountBundledSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { StoredCredentials } from '@/persistence';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

/** The ordinary Account selector admits one exact plugin; no native activation or fleet census. */
export async function prepareCliManagedProvisionerAdmission(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    account: Readonly<{ credentials?: StoredCredentials | null; serverUrl: string; managedMachineAction?: ActionExecutorDeps['managedMachineAction'] }>,
) {
    const readSelected = (pluginId: string) => readCliManagedProvisioners(pluginId, account, request.context.signal);
    if (request.actionId === 'machines.managed.power.set' || request.actionId === 'machines.managed.inspect') {
        const input = ManagedMachineActionInputSchemasV1[request.actionId].parse(request.input);
        if ('when' in input ? input.when !== 'now' : !input.includeGuestDiagnostics) return null;
        const options = 'includeGuestDiagnostics' in input && input.includeGuestDiagnostics ? { includeGuestDiagnostics: true as const } : undefined;
        if (!account.managedMachineAction) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        const result = await account.managedMachineAction({ actionId: 'machines.managed.get',
            input: { homeId: input.homeId, managedId: input.managedId }, context: request.context, signal: request.context.signal });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) return prepareManagedPowerProvisionerAdmissionV1(failure.data, readSelected, request.actionId, options);
        const parsed = ManagedMachineActionOutputSchemasV1['machines.managed.get'].safeParse(result);
        if (!parsed.success || parsed.data.id !== input.managedId || parsed.data.homeId !== input.homeId)
            return { ok: false as const, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' };
        return prepareManagedPowerProvisionerAdmissionV1(parsed.data, readSelected, request.actionId, options);
    }
    return prepareManagedAcquireProvisionerAdmissionV1(request, readSelected);
}

export async function readCliManagedProvisioners(pluginId: string,
    account: Readonly<{ credentials?: StoredCredentials | null; serverUrl: string }>, signal?: AbortSignal): Promise<readonly ManagedProvisionerDiscoveryEntry[] | null> {
    if (!account.credentials) return null;
    try {
        const declaration = loadCurrentBundledPluginLocatorResult({ pluginIds: [pluginId] }).loadedPlugins
            .find(plugin => plugin.pluginId === pluginId);
        const bundled = declaration ? createPluginAccountBundledSelectionV1({
            packageName: declaration.sourceSpec.locator, manifest: declaration.manifest,
        }) : undefined;
        const selection = await readCurrentAccountPluginExecutionSelection({ pluginId,
            credentials: account.credentials, serverUrl: account.serverUrl,
            ...(bundled ? { bundled } : {}), ...(signal ? { signal } : {}),
        });
        return selection.kind !== 'available' ? null : projectAccountManagedProvisioners([selection]);
    } catch {
        return null;
    }
}
