import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedMachinePresetGetResultV1Schema, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectManagedMachinePresetForRecipientV1, type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachinePresetActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { resolveMachineSpawnReadinessV1 } from '@happier-dev/protocol/machines/machineSpawnReadinessV1';
import { readMachineProvisionerActionRolesV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { archiveManagedMachinePreset, ManagedMachineControllerError, managedMachinePresetPreparationNeedsNativeCleanupV1,
    resolveManagedMachinePresetArchiveExecutionTargetV1, type ManagedMachinePresetPreparationOperationInputV1,
    type ManagedMachinePresetPreparationCustodyV1 } from '@happier-dev/cli-common/machines/managed';
import { readMachineProvisionerHostAvailability } from '@happier-dev/cli-common/machines/managed/provisioners';
import { createMachinePresetActionClient, MachinePresetActionError } from '@/sync/api/machines/managedMachinePresets';
import { createUiManagedAccountNativeInvocationForLaunch } from '@/sync/api/machines/managedMachineAccountNative';
import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { captureManagedMachinePresetCustodyV1 } from '@/sync/ops/machines/managedMachinePresetCustody';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';
import type { LazyActionAccountContext } from './actionAccountContext';

type ArchiveRequest = Parameters<NonNullable<ActionExecutorDeps['machinePresetArchive']>>[0];

/** Select the whole Archive root before the receiving host admits its private native children. */
export async function resolveUiMachinePresetArchiveExecutionTarget(rawInput: unknown, account: LazyActionAccountContext,
    signal?: AbortSignal): Promise<Awaited<ReturnType<typeof resolveManagedMachinePresetArchiveExecutionTargetV1>> | ActionExecuteFailure> {
    const parsed = MachinePresetActionInputSchemasV1['machines.presets.archive'].safeParse(rawInput);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    try {
        return await withOpenedPreset(account, parsed.data, signal, async (preset, content) => {
            if (preset.revision !== parsed.data.expectedRevision) return null;
            return await resolveManagedMachinePresetArchiveExecutionTargetV1({ prepared: content.prepared,
                readDestroyExecution: async launch => {
                    const selected = await readPluginAccountAvailability(account.accountLifetime.scope).ensureCurrentAccountExecution(launch.provider.pluginId);
                    if (selected.kind !== 'available') throw new ManagedMachineControllerError(selected.code);
                    const provisioner = readProvisioner(selected.manifest.contributes.machineProvisioners, launch);
                    const destroy = selected.manifest.contributes.actions?.find(action => action.id === provisioner.preparation!.actions.destroy);
                    if (!destroy) throw new ManagedMachineControllerError('provider_unavailable');
                    if (destroy.execution?.target !== 'account') return { execution: destroy.execution };
                    const host = await readRuntimeFetchHost(account.endpointUrl);
                    const { available } = readMachineProvisionerHostAvailability({ host, provisioner });
                    return { execution: destroy.execution, requiresNativeHost: !available };
                },
                readCleanupUnavailable: machineId => readCleanupUnavailable(account, machineId, signal) });
        });
    } catch (error) {
        if (error instanceof ManagedMachineControllerError) return error.toActionFailure('machines.presets.archive');
        throw error;
    }
}

/** Inspect and destroy are reviewed before Archive spends its ordinary admitted parent. */
export async function prepareUiMachinePresetArchive(request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    account: LazyActionAccountContext) {
    const input = MachinePresetActionInputSchemasV1['machines.presets.archive'].parse(request.input);
    return await withOpenedPreset(account, input, request.context.signal, async (_preset, content) => {
        if (!content.prepared || !managedMachinePresetPreparationNeedsNativeCleanupV1(content.prepared)) return null;
        const launch = content.prepared.binding.configuration.launch;
        const selected = await readPluginAccountAvailability(account.accountLifetime.scope).ensureCurrentAccountExecution(launch.provider.pluginId);
        if (selected.kind !== 'available') throw new ManagedMachineControllerError(selected.code);
        const provisioner = readProvisioner(selected.manifest.contributes.machineProvisioners, launch);
        return { children: readMachineProvisionerActionRolesV1(provisioner)
            .filter(({ role }) => role === 'preparationInspect' || role === 'preparationDestroy')
            .map(({ action, role }) => ({ action: { pluginId: launch.provider.pluginId, localId: action }, role })) };
    });
}

/** Common owns native absence, retained references and CAS; the UI owns Account transport and custody. */
export async function executeUiMachinePresetArchive(request: ArchiveRequest, account: LazyActionAccountContext) {
    const { input, context, signal } = request;
    try {
        const client = createMachinePresetActionClient({ request: account.request });
        return await archiveManagedMachinePreset({
            expectedRevision: input.expectedRevision, signal,
            storage: { read: () => readPreset(account, input, signal),
                compareAndSwap: update => client.execute('machines.presets.update', {
                    homeId: input.homeId, id: input.id, expectedRevision: update.expectedRevision,
                    patch: { content: update.content, recipients: update.recipients },
                }, { signal }) },
            withCustody: (preset, run) => withPresetCustody(account, preset, signal, (_custody, preparation) => run(preparation)),
            resolveCleanup: async prepared => {
                const launch = prepared.binding.configuration.launch;
                const selected = readPluginAccountAvailability(account.accountLifetime.scope).readCurrentAccountExecution(launch.provider.pluginId);
                if (selected.kind !== 'available') throw new ManagedMachineControllerError(selected.code);
                const provisioner = readProvisioner(selected.manifest.contributes.machineProvisioners, launch);
                const destroyId = provisioner.preparation!.actions.destroy;
                const destroy = selected.manifest.contributes.actions?.find(action => action.id === destroyId);
                if (!destroy) throw new ManagedMachineControllerError('provider_unavailable');
                if (destroy.execution?.target !== 'account') {
                    const unavailable = await readCleanupUnavailable(account, prepared.binding.machineId, signal);
                    if (unavailable) return { unavailable };
                }
                return { invoke: createUiManagedAccountNativeInvocationForLaunch({ account, launch,
                    credentialConfigurations: prepared.binding.credentialConfigurations, provisioner, selected,
                    originalMachineId: prepared.binding.machineId, context, signal,
                    requestId: context.actionRequestId ?? prepared.operationId }) };
            },
            archive: expectedRevision => client.execute('machines.presets.archive', { ...input, expectedRevision }, { signal }),
        });
    } catch (error) {
        if (error instanceof MachinePresetActionError) return new ManagedMachineControllerError(error.errorCode, error.status, undefined, undefined, error).toActionFailure('machines.presets.archive');
        if (error instanceof ManagedMachineControllerError) return error.toActionFailure('machines.presets.archive');
        throw error;
    }
}

async function readCleanupUnavailable(account: LazyActionAccountContext, machineId: string, signal?: AbortSignal):
    Promise<ManagedMachinePresetPreparationOperationInputV1['cleanupUnavailable']> {
    const rows = await readMachineRows({ readTransport: account.readTransport, request: account.request,
        machineIds: [machineId], signal });
    const readiness = resolveMachineSpawnReadinessV1({ selectedMachineId: machineId,
        machine: rows.get(machineId), machineReachable: false });
    return readiness.status === 'revoked' ? 'machine_revoked' : readiness.status === 'replaced' ? 'machine_replaced' : undefined;
}

function readProvisioner(declarations: readonly MachineProvisionerContributionV1[], launch: NonNullable<ManagedMachinePresetContentV1['prepared']>['binding']['configuration']['launch']) {
    const provisioner = declarations.find(candidate => candidate.id === launch.provider.localId);
    if (!provisioner || provisioner.schemaVersion !== launch.schemaVersion || !provisioner.preparation) {
        throw new ManagedMachineControllerError('provider_unavailable');
    }
    return provisioner;
}

async function readPreset(account: LazyActionAccountContext, input: Pick<ArchiveRequest['input'], 'homeId' | 'id'>,
    signal?: AbortSignal): Promise<ManagedMachinePresetV1> {
    if (input.homeId !== account.serverIdentityId) throw new ManagedMachineControllerError('server_target_mismatch');
    const client = createMachinePresetActionClient({ request: account.request });
    try {
        const result = ManagedMachinePresetGetResultV1Schema.parse(await client.execute('machines.presets.get', {
            homeId: input.homeId, id: input.id,
        }, { signal }));
        if (result.kind !== 'found') throw new ManagedMachineControllerError(result.code);
        return result.preset;
    } catch (error) {
        if (error instanceof MachinePresetActionError) throw new ManagedMachineControllerError(error.errorCode, error.status, undefined, undefined, error);
        throw error;
    }
}

async function withOpenedPreset<TResult>(account: LazyActionAccountContext, input: Pick<ArchiveRequest['input'], 'homeId' | 'id'>,
    signal: AbortSignal | undefined, run: (preset: ManagedMachinePresetV1, content: ManagedMachinePresetContentV1) => Promise<TResult>): Promise<TResult> {
    const preset = await readPreset(account, input, signal);
    return await withPresetCustody(account, preset, signal, async custody => {
        const projection = projectManagedMachinePresetForRecipientV1({ ...preset, recipientAccountId: account.accountId });
        const content = custody.open({ presetId: preset.id, mode: preset.contentEncryptionMode, projection });
        if (!content) throw new ManagedMachineControllerError('credential_unavailable');
        return await run(preset, content);
    });
}

async function withPresetCustody<TResult>(account: LazyActionAccountContext, preset: ManagedMachinePresetV1,
    signal: AbortSignal | undefined, run: (custody: NonNullable<Awaited<ReturnType<typeof captureManagedMachinePresetCustodyV1>>>,
        preparation: ManagedMachinePresetPreparationCustodyV1) => Promise<TResult>): Promise<TResult> {
    const custody = await captureManagedMachinePresetCustodyV1({ account, resourceMode: preset.contentEncryptionMode, signal });
    if (!custody || custody.mode !== preset.contentEncryptionMode) throw new ManagedMachineControllerError('credential_unavailable');
    try {
        if (custody.mode === 'plain') return await run(custody, { mode: 'plain' });
        const result = custody.withAccountKey(key => run(custody, { mode: 'e2ee', ...key, randomBytes: getRandomBytes }));
        if (!result) throw new ManagedMachineControllerError('credential_unavailable');
        return await result;
    } finally { custody.dispose(); }
}
