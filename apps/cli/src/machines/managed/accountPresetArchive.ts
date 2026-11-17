import { randomBytes } from 'node:crypto';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { MachineAvailabilityDiagnosticV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedMachinePresetGetResultV1Schema, PresetMutationResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { openManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachineProvisionerPreparationInspectResultV1Schema, MachineProvisionerPreparationDestroyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisionerPreparationSchemas';
import { ManagedMachineControllerError, settleManagedMachinePresetPreparationOperationV1,
    managedMachinePresetPreparationNeedsNativeCleanupV1, type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import type { StoredCredentials } from '@/persistence';
import { createCliManagedAccountNativeInvocationForLaunch } from './accountNative';
import { createManagedPresetHydrator } from './presetHydration';

/** Archive spends its admitted parent through retained native cleanup and the final row CAS. */
export async function executeCliMachinePresetArchive(request: Parameters<NonNullable<ActionExecutorDeps['machinePresetArchive']>>[0],
    host: Readonly<{ credentials: StoredCredentials; serverUrl: string;
        readPreparationCleanupUnavailable?: (input: Readonly<{ machineId: string; context: ActionExecutorContext; signal?: AbortSignal }>) =>
            Promise<Extract<MachineAvailabilityDiagnosticV1, { reason: 'machine_revoked' | 'machine_replaced' }>['reason'] | undefined>;
        transport: NonNullable<ActionExecutorDeps['machinePresetAction']> }>) {
    const { input, context, signal } = request;
    const read = async () => {
        const raw = await host.transport({ actionId: 'machines.presets.get', input: { homeId: input.homeId, id: input.id }, context, signal });
        const failure = ActionExecuteFailureSchema.safeParse(raw);
        if (failure.success) throw ManagedMachineControllerError.fromActionFailure(failure.data, 'machines.presets.archive');
        const result = ManagedMachinePresetGetResultV1Schema.parse(raw);
        if (result.kind !== 'found') throw new ManagedMachineControllerError(result.code);
        return result.preset;
    };
    const preset = await read();
    if (preset.revision !== input.expectedRevision) return { kind: 'conflict' as const, currentRevision: preset.revision };
    const hydrator = createManagedPresetHydrator(host);
    const run = async (custody: Parameters<typeof settleManagedMachinePresetPreparationOperationV1>[0]['custody']) => {
        const opening = { presetId: preset.id, content: preset.content };
        const content = custody.mode === 'plain' ? openManagedMachinePresetContentV1({ ...opening, mode: 'plain' })
            : openManagedMachinePresetContentV1({ ...opening, ...custody, recipients: preset.recipients });
        if (!content) throw new ManagedMachineControllerError('credential_unavailable');
        const prepared = content.prepared;
        let revision = preset.revision;
        if (prepared) {
            let invoke: ManagedNativeInvocation = async () => { throw new ManagedMachineControllerError('invalid_request'); };
            let cleanupUnavailable: Parameters<typeof settleManagedMachinePresetPreparationOperationV1>[0]['cleanupUnavailable'];
            if (managedMachinePresetPreparationNeedsNativeCleanupV1(prepared)) {
                const launch = prepared.binding.configuration.launch;
                const selected = await readCurrentAccountPluginExecutionSelection({ pluginId: launch.provider.pluginId,
                    credentials: host.credentials, serverUrl: host.serverUrl, signal });
                if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
                const provisioner = MachineProvisionerContributionV1Schema.safeParse(selected.manifest.contributes.machineProvisioners
                    .find(candidate => candidate.id === launch.provider.localId));
                if (!provisioner.success || provisioner.data.schemaVersion !== launch.schemaVersion || !provisioner.data.preparation) {
                    throw new ManagedMachineControllerError('provider_unavailable');
                }
                const destroyId = provisioner.data.preparation.actions.destroy;
                const destroy = selected.manifest.contributes.actions.find(action => action.id === destroyId);
                if (!destroy) throw new ManagedMachineControllerError('provider_unavailable');
                if (destroy.execution?.target !== 'account' && prepared.binding.machineId) {
                    cleanupUnavailable = await host.readPreparationCleanupUnavailable?.({
                        machineId: prepared.binding.machineId, context, signal });
                }
                if (!cleanupUnavailable) invoke = createCliManagedAccountNativeInvocationForLaunch({ launch,
                    credentialConfigurations: prepared.binding.credentialConfigurations, provisioner: provisioner.data,
                    originalMachineId: prepared.binding.machineId,
                    selected, context, signal, requestId: context.actionRequestId ?? prepared.operationId });
            }
            let first = true;
            const cleanup = await settleManagedMachinePresetPreparationOperationV1({ cleanupOnly: true,
                cleanupUnavailable,
                operationId: prepared.operationId, expectedRevision: input.expectedRevision, custody,
                credentialConfigurations: prepared.binding.credentialConfigurations,
                storage: { read: async () => { if (first) { first = false; return preset; } return await read(); },
                    compareAndSwap: async update => PresetMutationResultV1Schema.parse(await host.transport({
                        actionId: 'machines.presets.update', input: { homeId: input.homeId, id: input.id,
                            expectedRevision: update.expectedRevision, patch: { content: update.content, recipients: update.recipients } }, context, signal })) },
                native: {
                    build: async () => { throw new ManagedMachineControllerError('invalid_request'); },
                    inspect: async body => MachineProvisionerPreparationInspectResultV1Schema.parse(await invoke('preparationInspect', body, {})),
                    destroy: async body => MachineProvisionerPreparationDestroyResultV1Schema.parse(await invoke('preparationDestroy', body, {})),
                } });
            if (cleanup.kind === 'conflict' || cleanup.kind === 'refused') return cleanup;
            if (cleanup.kind !== 'cancelled') throw new ManagedMachineControllerError(cleanup.prepared.code ?? 'native_intent_unconfirmed');
            revision = cleanup.revision;
        }
        return await host.transport({ actionId: 'machines.presets.archive', input: { ...input, expectedRevision: revision }, context, signal });
    };
    return preset.contentEncryptionMode === 'plain' ? await run({ mode: 'plain' })
        : await hydrator.withE2eeAccountKey(account => run({ mode: 'e2ee', ...account, randomBytes }), signal);
}
