import { prepareManagedAcquireProvisionerAdmissionV1, prepareManagedPowerProvisionerAdmissionV1, projectAccountManagedProvisioners,
    type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { StoredCredentials } from '@/persistence';
import { readCurrentAccountPluginExecutionDeclarations } from '@/plugins/runtime/accountPluginActivationSource';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isManagedControlAdmissionActionIdV1, MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { openManagedMachineRead } from './readManagedMachine';
import { MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { MachinePresetActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetGetResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { readMachineProvisionerActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createManagedPresetHydrator } from './presetHydration';
import { managedMachinePresetPreparationNeedsNativeCleanupV1 } from '@happier-dev/cli-common/machines/managed';

/** The ordinary Account selector admits one exact plugin; no native activation or fleet census. */
export async function prepareCliManagedProvisionerAdmission(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    account: Readonly<{ credentials?: StoredCredentials | null; serverUrl: string; managedMachineAction?: ActionExecutorDeps['managedMachineAction'];
        machinePresetAction?: ActionExecutorDeps['machinePresetAction'] }>,
) {
    const readSelected = (pluginId: string) => readCliManagedProvisioners(pluginId, account, request.context.signal);
    if (request.actionId === MACHINE_PRESET_ARCHIVE_ACTION_ID_V1) {
        const input = MachinePresetActionInputSchemasV1[MACHINE_PRESET_ARCHIVE_ACTION_ID_V1].parse(request.input);
        const credentials = account.credentials;
        const accountId = credentials && readAccountIdFromToken(credentials.token);
        if (!credentials || !accountId || !account.machinePresetAction) {
            return { ok: false as const, errorCode: 'credential_unavailable', error: 'credential_unavailable' };
        }
        const raw = await account.machinePresetAction({ actionId: 'machines.presets.get', input: { homeId: input.homeId, id: input.id },
            context: request.context, signal: request.context.signal });
        const failure = ActionExecuteFailureSchema.safeParse(raw);
        if (failure.success) return failure.data;
        const result = ManagedMachinePresetGetResultV1Schema.parse(raw);
        if (result.kind !== 'found') return { ok: false as const, errorCode: result.code, error: result.code };
        const preset = result.preset;
        const content = await createManagedPresetHydrator({ credentials, serverUrl: account.serverUrl }).openRecipientProjection({
            presetId: preset.id, mode: preset.contentEncryptionMode, signal: request.context.signal,
            projection: projectManagedMachinePresetForRecipientV1({ ...preset, recipientAccountId: accountId }),
        });
        if (!content.prepared || !managedMachinePresetPreparationNeedsNativeCleanupV1(content.prepared)) return null;
        const launch = content.prepared.binding.configuration.launch;
        const selected = (await readSelected(launch.provider.pluginId))?.find(candidate =>
            candidate.contribution.localId === launch.provider.localId && candidate.descriptor.schemaVersion === launch.schemaVersion);
        if (!selected?.descriptor.preparation) return { ok: false as const, errorCode: 'provider_unavailable', error: 'provider_unavailable' };
        return { children: readMachineProvisionerActionRolesV1(selected.descriptor)
            .filter(({ role }) => role === 'preparationInspect' || role === 'preparationDestroy')
            .map(({ action, role }) => ({ action: { pluginId: launch.provider.pluginId, localId: action }, role })) };
    }
    if (isManagedControlAdmissionActionIdV1(request.actionId) || request.actionId === 'machines.managed.inspect'
        || request.actionId === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1) {
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
        const structural = unwrapManagedMachineReadV1(parsed.data);
        if (structural.id !== input.managedId || structural.homeId !== input.homeId) {
            return { ok: false as const, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' };
        }
        if (structural.controller)
            return prepareManagedPowerProvisionerAdmissionV1(structural, readSelected, request.actionId, options);
        if (!account.credentials) return { ok: false as const, errorCode: 'credential_unavailable', error: 'credential_unavailable' };
        try {
            const machine = await openManagedMachineRead({ credentials: account.credentials, serverHttpBaseUrl: account.serverUrl,
                read: parsed.data, ...(request.context.signal ? { signal: request.context.signal } : {}) });
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
