import { randomBytes } from 'node:crypto';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { readCurrentAccountMachinePreparationCleanupHost } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedMachinePresetGetResultV1Schema, PresetMutationResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { ManagedMachinePresetPreparedV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import type { MachinePresetActionInputV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { archiveManagedMachinePreset, ManagedMachineControllerError,
    resolveManagedMachinePresetArchiveExecutionTargetV1 } from '@happier-dev/cli-common/machines/managed';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import type { StoredCredentials } from '@/persistence';
import { createCliManagedAccountNativeInvocationForLaunch } from './accountNative';
import { createManagedPresetHydrator } from './presetHydration';
import { readManagedMachinePreset } from './readManagedMachine';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

type ArchiveAccount = Readonly<{ credentials: StoredCredentials; serverUrl: string }>;

async function readArchivePreparationProvider(launch: ManagedMachinePresetPreparedV1['binding']['configuration']['launch'],
    host: ArchiveAccount, signal?: AbortSignal) {
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
    return { selected, provisioner: provisioner.data, destroy };
}

/** Keep Archive and its private native children together on the original image host. */
export async function resolveCliMachinePresetArchiveExecutionTarget(input: MachinePresetActionInputV1<'machines.presets.archive'>,
    host: ArchiveAccount & Readonly<{ authorization?: ExternalActionExecutionAuthorizationV1; signal?: AbortSignal }>):
    Promise<Readonly<{ kind: 'machine'; machineId: string }> | null> {
    const preset = await readManagedMachinePreset({ ...input, credentials: host.credentials, serverHttpBaseUrl: host.serverUrl,
        authorization: host.authorization, signal: host.signal });
    if (preset.revision !== input.expectedRevision) return null;
    const accountId = readAccountIdFromToken(host.credentials.token);
    if (!accountId) throw new ManagedMachineControllerError('credential_unavailable');
    const content = await createManagedPresetHydrator(host).openRecipientProjection({ presetId: preset.id,
        mode: preset.contentEncryptionMode, projection: projectManagedMachinePresetForRecipientV1({ ...preset, recipientAccountId: accountId }),
        signal: host.signal });
    return await resolveManagedMachinePresetArchiveExecutionTargetV1({ prepared: content.prepared,
        readDestroyExecution: async launch => ({ execution: (await readArchivePreparationProvider(launch, host, host.signal)).destroy.execution }),
        readCleanupUnavailable: async machineId => (await readCurrentAccountMachinePreparationCleanupHost({ machineId,
            serverHttpBaseUrl: host.serverUrl,
            ...(host.authorization ? { authorization: host.authorization } : { token: host.credentials.token }),
            signal: host.signal })).unavailable });
}

/** Archive spends its admitted parent through retained native cleanup and the final row CAS. */
export async function executeCliMachinePresetArchive(request: Parameters<NonNullable<ActionExecutorDeps['machinePresetArchive']>>[0],
    host: Readonly<{ credentials: StoredCredentials; serverUrl: string; executingMachineId?: string;
        readPreparationCleanupHost?: (input: Readonly<{ machineId: string; context: ActionExecutorContext; signal?: AbortSignal }>) =>
            ReturnType<typeof readCurrentAccountMachinePreparationCleanupHost>;
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
    return await archiveManagedMachinePreset({
        expectedRevision: input.expectedRevision, signal,
        storage: { read, compareAndSwap: async update => PresetMutationResultV1Schema.parse(await host.transport({
            actionId: 'machines.presets.update', input: { homeId: input.homeId, id: input.id,
                expectedRevision: update.expectedRevision, patch: { content: update.content, recipients: update.recipients } }, context, signal })) },
        withCustody: async (preset, run) => preset.contentEncryptionMode === 'plain'
            ? await run({ mode: 'plain' })
            : await createManagedPresetHydrator(host).withE2eeAccountKey(account => run({ mode: 'e2ee', ...account, randomBytes }), signal),
        resolveCleanup: async prepared => {
            const launch = prepared.binding.configuration.launch;
            const { selected, provisioner, destroy } = await readArchivePreparationProvider(launch, host, signal);
            const cleanupHost = destroy.execution?.target !== 'account'
                ? await host.readPreparationCleanupHost?.({ machineId: prepared.binding.machineId, context, signal }) : undefined;
            if (cleanupHost?.unavailable) return { unavailable: cleanupHost.unavailable };
            return { invoke: createCliManagedAccountNativeInvocationForLaunch({ launch,
                credentialConfigurations: prepared.binding.credentialConfigurations, provisioner,
                originalMachineId: prepared.binding.machineId, originalHost: cleanupHost?.host,
                executingMachineId: host.executingMachineId,
                selected, context, signal, requestId: context.actionRequestId ?? prepared.operationId }) };
        },
        archive: expectedRevision => host.transport({ actionId: 'machines.presets.archive', input: { ...input, expectedRevision }, context, signal }),
    });
}
