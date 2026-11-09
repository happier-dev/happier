import { PluginError, BackupDestinationOpenV1ProtocolSchema, type BackupDestinationOpenV1 } from '@happier-dev/plugin-sdk';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { environmentSecretBindingIdentityV1, type DeploymentBackupConfigurationV1, type DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupRunInputV1, DeploymentRestoreDestinationV1 } from '@happier-dev/deployments';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createDeploymentBackupEnvironmentForHost, prepareDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';

export type DeploymentBackupDestinationRegistryForHost = Pick<ResolvedExecutablePluginRuntimeRegistry,
    'targetActionInvocations' | 'readPluginOccurrenceId' | 'activateContributionsOnDemand'> & Readonly<{
        contributes: Pick<ResolvedExecutablePluginRuntimeRegistry['contributes'], 'backupDestinations'>;
    }>;

const refuse = (code: 'backup_required' | 'stale_input' | 'unsupported_action', phase?: string): never => {
    throw new PluginError({ code, message: 'The configured backup destination is unavailable',
        ...(phase ? { failureCause: projectActionFailureCauseV1({ name: 'Error', code }, phase) } : {}) });
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
    if (!descriptor) return refuse('backup_required', 'deployment.backup.destination.descriptor');
    if (configuration.occurrenceId !== registry.readPluginOccurrenceId(ref.pluginId)) return refuse('stale_input');
    const action = descriptor.definition.actions.open;
    await registry.activateContributionsOnDemand([{ ...action, family: 'actions' }]);
    const result = await registry.targetActionInvocations.invoke({ ...action,
        input: { config: configuration.config, credentialRoles: configuration.credentialBindings.map(binding => binding.role) },
        surface: 'plugin', requiredReadOnly: true, signal: input.signal, approvalContext: input.context,
    });
    if (result.status !== 'executed') {
        const reason = result.status === 'deferred' ? 'approval_required' : result.code;
        const authoredCause = result.status === 'failed' ? readPluginActionFailureAuthorPayload(result.data).failureCause : undefined;
        throw new PluginError({ code: 'backup_required',
            message: 'The configured backup destination Action did not open', details: { reason },
            failureCause: authoredCause ?? projectActionFailureCauseV1({ name: 'Error', code: reason }, 'deployment.backup.destination.open') });
    }
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

type BackupDestinationPreparation = Readonly<{
    registry: DeploymentBackupDestinationRegistryForHost;
    configuration: DeploymentEnvironmentContentV1['backup'];
    preparation: Omit<Parameters<typeof prepareDeploymentBackupEnvironmentForHost>[0]['preparation'], 'backupDestinationUses'>;
    context: ActionExecutorContext;
    signal: AbortSignal;
    isCurrent(): boolean;
}>;

async function captureBackupDestination(input: BackupDestinationPreparation) {
    const configuration = input.configuration;
    if (!configuration || 'notNeeded' in configuration) return refuse('backup_required');
    if (configuration.ownership.environmentId !== input.preparation.environmentId) return refuse('stale_input');
    const opened = await openDeploymentBackupDestinationForHost({ ...input, configuration });
    const uses = opened.credentialBindings.map(identity => {
        const row = input.preparation.bindings.find(binding =>
            environmentSecretBindingIdentityV1(binding) === environmentSecretBindingIdentityV1(identity));
        if (!row || row.purpose !== 'backupDestination') throw new PluginError({
            code: 'secret_missing', message: 'The configured destination binding is unavailable' });
        return row;
    });
    return { configuration, opened, preparation: { ...input.preparation, backupDestinationUses: uses } };
}

export type OwnServerBackupRepositoryOperandsForHost = ReturnType<typeof createDeploymentBackupEnvironmentForHost> & Readonly<{
    configuration: DeploymentBackupConfigurationV1;
}>;

/** Inventory, verify and retention need destination custody only, never a database binding. */
export async function prepareOwnServerBackupRepositoryOperandsForHost(input: BackupDestinationPreparation): Promise<OwnServerBackupRepositoryOperandsForHost> {
    const { configuration, opened, preparation } = await captureBackupDestination(input);
    return { ...createDeploymentBackupEnvironmentForHost({ ...opened, preparation,
        signal: input.signal, isCurrent: input.isCurrent }), configuration };
}

/** Lazy operands for P41's admitted pre-migration backup. Binding keys are
 * resolved by P42, never interpreted as literal database names by the consumer. */
export async function prepareOwnServerPreMigrationBackupOperandsForHost(input: BackupDestinationPreparation & Readonly<{
    data: NonNullable<DeploymentEnvironmentContentV1['template']>['data'];
}>): Promise<OwnServerPreMigrationBackupOperandsForHost> {
    const configuration = input.configuration;
    if (!configuration || 'notNeeded' in configuration) return refuse('backup_required');
    if (configuration.ownership.environmentId !== input.preparation.environmentId) return refuse('stale_input');
    const dump = configuration.sources.find(source => source.kind === 'dump');
    const data = input.data?.find(database => database.service === dump?.service);
    if (data?.engine !== 'postgres' || data.logicalBackup?.adapter !== 'postgres-v1') return refuse('unsupported_action');
    const databaseKey = data.logicalBackup.database;
    const databaseBinding = input.preparation.bindings.find(binding => binding.purpose === 'variable'
        && binding.phase === 'runtime' && binding.name === databaseKey);
    if (!databaseBinding || databaseBinding.purpose !== 'variable') throw new PluginError({
        code: 'secret_missing', message: 'The configured database binding is unavailable' });
    const { opened, preparation } = await captureBackupDestination(input);
    const prepared = await prepareDeploymentBackupEnvironmentForHost({ ...opened, databaseBinding,
        signal: input.signal, isCurrent: input.isCurrent,
        preparation });
    return { ...prepared, configuration, data,
        destination: { environmentId: input.preparation.environmentId, service: data.service,
            adapter: 'postgres-v1', database: prepared.database } };
}
