import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ManagedMachinePresetGetResultV1Schema, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectManagedMachinePresetForRecipientV1, type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachinePresetActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { readMachineProvisionerActionRolesV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachineProvisionerPreparationInspectResultV1Schema, MachineProvisionerPreparationDestroyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisionerPreparationSchemas';
import { ManagedMachineControllerError, settleManagedMachinePresetPreparationOperationV1, managedMachinePresetPreparationNeedsNativeCleanupV1,
    type ManagedMachinePresetPreparationCustodyV1, type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { createMachinePresetActionClient, MachinePresetActionError } from '@/sync/api/machines/managedMachinePresets';
import { createUiManagedAccountNativeInvocationForLaunch } from '@/sync/api/machines/managedMachineAccountNative';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { captureManagedMachinePresetCustodyV1 } from '@/sync/ops/machines/managedMachinePresetCustody';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { LazyActionAccountContext } from './actionAccountContext';

type ArchiveRequest = Parameters<NonNullable<ActionExecutorDeps['machinePresetArchive']>>[0];

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
    return await withOpenedPreset(account, input, signal, async (preset, content, custody, read) => {
        if (preset.revision !== input.expectedRevision) return { kind: 'conflict' as const, currentRevision: preset.revision };
        let revision = preset.revision;
        const prepared = content.prepared;
        const client = createMachinePresetActionClient({ request: account.request });
        if (prepared) {
            let invoke: ManagedNativeInvocation = async () => { throw new ManagedMachineControllerError('invalid_request'); };
            if (managedMachinePresetPreparationNeedsNativeCleanupV1(prepared)) {
                const launch = prepared.binding.configuration.launch;
                const selected = readPluginAccountAvailability(account.accountLifetime.scope).readCurrentAccountExecution(launch.provider.pluginId);
                if (selected.kind !== 'available') throw new ManagedMachineControllerError(selected.code);
                const provisioner = readProvisioner(selected.manifest.contributes.machineProvisioners, launch);
                invoke = createUiManagedAccountNativeInvocationForLaunch({ account, launch,
                    credentialConfigurations: prepared.binding.credentialConfigurations, provisioner, selected,
                    originalMachineId: prepared.binding.machineId, context, signal,
                    requestId: context.actionRequestId ?? prepared.operationId });
            }
            let first = true;
            const cleanup = await settleManagedMachinePresetPreparationOperationV1({ cleanupOnly: true,
                operationId: prepared.operationId, expectedRevision: input.expectedRevision, custody,
                credentialConfigurations: prepared.binding.credentialConfigurations,
                storage: { read: async () => { if (first) { first = false; return preset; } return await read(); },
                    compareAndSwap: async update => await client.execute('machines.presets.update', {
                        homeId: input.homeId, id: input.id, expectedRevision: update.expectedRevision,
                        patch: { content: update.content, recipients: update.recipients },
                    }, { signal }) },
                native: {
                    build: async () => { throw new ManagedMachineControllerError('invalid_request'); },
                    inspect: async body => MachineProvisionerPreparationInspectResultV1Schema.parse(await invoke('preparationInspect', body, {})),
                    destroy: async body => MachineProvisionerPreparationDestroyResultV1Schema.parse(await invoke('preparationDestroy', body, {})),
                } });
            if (cleanup.kind === 'conflict' || cleanup.kind === 'refused') return cleanup;
            if (cleanup.kind !== 'cancelled') throw new ManagedMachineControllerError(cleanup.prepared.code ?? 'native_intent_unconfirmed');
            revision = cleanup.revision;
        }
        return await client.execute('machines.presets.archive', { ...input, expectedRevision: revision }, { signal });
    });
}

function readProvisioner(declarations: readonly MachineProvisionerContributionV1[], launch: NonNullable<ManagedMachinePresetContentV1['prepared']>['binding']['configuration']['launch']) {
    const provisioner = declarations.find(candidate => candidate.id === launch.provider.localId);
    if (!provisioner || provisioner.schemaVersion !== launch.schemaVersion || !provisioner.preparation) {
        throw new ManagedMachineControllerError('provider_unavailable');
    }
    return provisioner;
}

async function withOpenedPreset<TResult>(account: LazyActionAccountContext, input: Pick<ArchiveRequest['input'], 'homeId' | 'id'>,
    signal: AbortSignal | undefined, run: (preset: ManagedMachinePresetV1, content: ManagedMachinePresetContentV1,
        custody: ManagedMachinePresetPreparationCustodyV1, read: () => Promise<ManagedMachinePresetV1>) => Promise<TResult>): Promise<TResult> {
    try {
        if (input.homeId !== account.serverIdentityId) throw new ManagedMachineControllerError('server_target_mismatch');
        const client = createMachinePresetActionClient({ request: account.request });
        const read = async () => {
            const result = ManagedMachinePresetGetResultV1Schema.parse(await client.execute('machines.presets.get', {
                homeId: input.homeId, id: input.id,
            }, { signal }));
            if (result.kind !== 'found') throw new ManagedMachineControllerError(result.code);
            return result.preset;
        };
        const preset = await read();
        const custody = await captureManagedMachinePresetCustodyV1({ account, resourceMode: preset.contentEncryptionMode, signal });
        if (!custody) throw new ManagedMachineControllerError('credential_unavailable');
        try {
            const projection = projectManagedMachinePresetForRecipientV1({ ...preset, recipientAccountId: account.accountId });
            const content = custody.open({ presetId: preset.id, mode: preset.contentEncryptionMode, projection });
            if (!content) throw new ManagedMachineControllerError('credential_unavailable');
            if (custody.mode === 'plain') return await run(preset, content, { mode: 'plain' }, read);
            const result = custody.withAccountKey(key => run(preset, content, { mode: 'e2ee', ...key, randomBytes: getRandomBytes }, read));
            if (!result) throw new ManagedMachineControllerError('credential_unavailable');
            return await result;
        } finally { custody.dispose(); }
    } catch (error) {
        if (error instanceof MachinePresetActionError) throw new ManagedMachineControllerError(error.errorCode, error.status, undefined, undefined, error);
        throw error;
    }
}
