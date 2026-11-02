import { PluginError, BackupDestinationOpenV1ProtocolSchema, type BackupDestinationOpenV1 } from '@happier-dev/plugin-sdk';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { environmentSecretBindingIdentityV1, type DeploymentBackupConfigurationV1, type DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupRunInputV1, DeploymentRestoreDestinationV1 } from '@happier-dev/deployments';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { prepareDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';

export type DeploymentBackupDestinationRegistryForHost = Pick<ResolvedExecutablePluginRuntimeRegistry,
    'targetActionInvocations' | 'readPluginOccurrenceId'> & Readonly<{
        contributes: Pick<ResolvedExecutablePluginRuntimeRegistry['contributes'], 'backupDestinations'>;
    }>;

const refuse = (code: 'backup_required' | 'stale_input' | 'unsupported_action'): never => {
    throw new PluginError({ code, message: 'The configured backup destination is unavailable' });
};

/** Open the captured destination through its ordinary installed Action. No
 * storage-provider parsing or credential value crosses this host seam. */
export async function openDeploymentBackupDestinationForHost(input: Readonly<{
    registry: DeploymentBackupDestinationRegistryForHost;
    configuration: DeploymentBackupConfigurationV1;
    context: ActionExecutorContext;
    signal: AbortSignal;
}>): Promise<BackupDestinationOpenV1> {
    input.signal.throwIfAborted();
    const { configuration, registry } = input;
    const ref = configuration.destinationRef;
    const descriptor = registry.contributes.backupDestinations.find(entry =>
        entry.identity.pluginId === ref.pluginId && entry.identity.localId === ref.localId);
    if (!descriptor) return refuse('backup_required');
    if (configuration.occurrenceId !== registry.readPluginOccurrenceId(ref.pluginId)) return refuse('stale_input');
    const action = descriptor.definition.actions.open;
    const result = await registry.targetActionInvocations.invoke({ ...action,
        input: { config: configuration.config, credentialRoles: configuration.credentialBindings.map(binding => binding.role) },
        surface: 'plugin', requiredReadOnly: true, signal: input.signal, approvalContext: input.context,
    });
    if (result.status !== 'executed') throw new PluginError({ code: 'backup_required',
        message: 'The configured backup destination Action did not open',
        details: { reason: result.status === 'deferred' ? 'approval_required' : result.code } });
    const opened = BackupDestinationOpenV1ProtocolSchema.safeParse(result.value);
    if (!opened.success) return refuse('unsupported_action');
    if (opened.data.credentialBindings.length !== configuration.credentialBindings.length
        || opened.data.credentialBindings.some(binding =>
            !configuration.credentialBindings.some(configured =>
                environmentSecretBindingIdentityV1(configured) === environmentSecretBindingIdentityV1(binding)))) return refuse('backup_required');
    return opened.data;
}

export type OwnServerPreMigrationBackupOperandsForHost = Awaited<ReturnType<typeof prepareDeploymentBackupEnvironmentForHost>> & Readonly<{
    configuration: DeploymentBackupConfigurationV1;
    data: NonNullable<DeploymentBackupRunInputV1['data']>;
    destination: Pick<DeploymentRestoreDestinationV1, 'environmentId' | 'service' | 'adapter' | 'database'>;
}>;

/** Lazy operands for P41's admitted pre-migration backup. Binding keys are
 * resolved by P42, never interpreted as literal database names by the consumer. */
export async function prepareOwnServerPreMigrationBackupOperandsForHost(input: Readonly<{
    registry: DeploymentBackupDestinationRegistryForHost;
    configuration: DeploymentEnvironmentContentV1['backup'];
    data: DeploymentBackupRunInputV1['data'];
    preparation: Omit<Parameters<typeof prepareDeploymentBackupEnvironmentForHost>[0]['preparation'], 'backupDestinationUses'>;
    context: ActionExecutorContext;
    signal: AbortSignal;
    isCurrent(): boolean;
}>): Promise<OwnServerPreMigrationBackupOperandsForHost> {
    const configuration = input.configuration;
    if (!configuration || 'notNeeded' in configuration) return refuse('backup_required');
    if (configuration.ownership.environmentId !== input.preparation.environmentId) return refuse('stale_input');
    const data = input.data;
    if (data?.engine !== 'postgres' || data.logicalBackup?.adapter !== 'postgres-v1') return refuse('unsupported_action');
    const databaseKey = data.logicalBackup.database;
    const databaseBinding = input.preparation.bindings.find(binding => binding.purpose === 'variable'
        && binding.phase === 'runtime' && binding.name === databaseKey);
    if (!databaseBinding || databaseBinding.purpose !== 'variable') throw new PluginError({
        code: 'secret_missing', message: 'The configured database binding is unavailable' });
    const opened = await openDeploymentBackupDestinationForHost({ ...input, configuration });
    const uses = opened.credentialBindings.map(identity => {
        const row = input.preparation.bindings.find(binding =>
            environmentSecretBindingIdentityV1(binding) === environmentSecretBindingIdentityV1(identity));
        if (!row || row.purpose !== 'backupDestination') throw new PluginError({
            code: 'secret_missing', message: 'The configured destination binding is unavailable' });
        return row;
    });
    const prepared = await prepareDeploymentBackupEnvironmentForHost({ ...opened, databaseBinding,
        signal: input.signal, isCurrent: input.isCurrent,
        preparation: { ...input.preparation, backupDestinationUses: uses } });
    return { ...prepared, configuration, data,
        destination: { environmentId: input.preparation.environmentId, service: data.service,
            adapter: 'postgres-v1', database: prepared.database } };
}
