import { DeploymentBackupConfigurationV1Schema, validateDeploymentBackupDestinationConfigurationV1, isSettledEnvironmentSecretBindingV1,
    type DeploymentBackupConfigurationV1, type DeploymentBackupRetentionV1, type DeploymentEnvironmentBackupV1,
    type EnvironmentSecretBindingInputV1 } from '@happier-dev/deployment-protocol';

import { readSQLiteRuntimeAvailabilityV1, type SQLiteRuntimeUnavailableV1 } from './sqliteRuntime.js';
import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';

type Destination = Readonly<{ ref: DeploymentBackupConfigurationV1['destinationRef']; occurrenceId: string;
    descriptor: Parameters<typeof validateDeploymentBackupDestinationConfigurationV1>[0]['descriptor'] }>;
type ConfigurationFailure = Readonly<{ ok: false; code: 'invalid_backup_configuration' | 'invalid_backup_sources'
    | 'destination_changed' | 'environment_mismatch' | 'invalid_destination_config' | 'unsupported_credential_role' }>;
export type DeploymentBackupConfigurationPreparationV1 = ConfigurationFailure | SQLiteRuntimeUnavailableV1 | Readonly<{ ok: true;
    configuration: DeploymentBackupConfigurationV1; bindingState: 'bound' | 'needsBinding'; missingRoles: string[] }>;

/** Stable native dump identity, including services namespaced by catalog Add. */
export function createDeploymentDumpBackupSourceIdV1(service: string): string {
    return JSON.stringify(['dump', service]);
}

/** The canonical logical dump choice used by native inventory and catalog intent authoring. */
export function createDeploymentDumpBackupSourceV1(service: string): Extract<DeploymentBackupConfigurationV1['sources'][number], { kind: 'dump' }> {
    return { kind: 'dump', sourceId: createDeploymentDumpBackupSourceIdV1(service), service, consistency: 'logical' };
}

/** Definition review offers only logical sources whose runtime is published. */
export function createDeploymentLogicalBackupSourceChoicesV1(data: NonNullable<DeploymentEnvironmentContentV1['template']>['data'],
    services: readonly string[]): DeploymentBackupConfigurationV1['sources'] {
    return (data ?? []).flatMap(row => {
        if (!services.includes(row.service) || !(row.engine === 'postgres' && row.logicalBackup?.adapter === 'postgres-v1'
            || row.engine === 'sqlite' && row.logicalBackup?.adapter === 'sqlite-v1' && row.logicalBackup.path
                && readSQLiteRuntimeAvailabilityV1().ok)) return [];
        return [createDeploymentDumpBackupSourceV1(row.service)];
    });
}

/** Stable native volume identity, including catalog Add resource aliases. */
export function createDeploymentVolumeBackupSourceIdV1(service: string, volume: string): string {
    return JSON.stringify(['volume', service, volume]);
}

/** Configure admission consumes the selected catalog descriptor and the opened Environment bindings once. */
export function prepareDeploymentBackupConfigurationV1(input: Readonly<{ environmentId: string; configuration: unknown;
    data?: NonNullable<DeploymentEnvironmentContentV1['template']>['data'];
    destination: Destination; bindings: readonly EnvironmentSecretBindingInputV1[] }>): DeploymentBackupConfigurationPreparationV1 {
    const raw = input.configuration;
    const withDefault = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { retention: { kind: 'keepEverything' }, ...raw } : raw;
    const parsed = DeploymentBackupConfigurationV1Schema.safeParse(withDefault);
    if (!parsed.success) return { ok: false, code: parsed.error.issues.some(issue => issue.path[0] === 'sources')
        ? 'invalid_backup_sources' : 'invalid_backup_configuration' };
    const configuration = parsed.data;
    const { destination } = input;
    if (configuration.destinationRef.pluginId !== destination.ref.pluginId || configuration.destinationRef.localId !== destination.ref.localId) {
        return { ok: false, code: 'destination_changed' };
    }
    if (configuration.ownership.environmentId !== input.environmentId) return { ok: false, code: 'environment_mismatch' };
    if (!validateDeploymentBackupDestinationConfigurationV1({ descriptor: destination.descriptor, config: configuration.config })) {
        return { ok: false, code: 'invalid_destination_config' };
    }
    for (const source of configuration.sources) {
        if (source.kind !== 'dump' || input.data?.find(row => row.service === source.service)?.logicalBackup?.adapter !== 'sqlite-v1') continue;
        const availability = readSQLiteRuntimeAvailabilityV1();
        if (!availability.ok) return availability;
    }
    const roles = destination.descriptor.credentialRoles.map(entry => entry.role);
    if (configuration.credentialBindings.some(binding => !roles.includes(binding.role))) return { ok: false, code: 'unsupported_credential_role' };
    const credentialBindings = destination.descriptor.credentialRoles
        .filter(entry => entry.optional !== true || configuration.credentialBindings.some(binding => binding.role === entry.role))
        .map(({ role }) => ({ purpose: 'backupDestination' as const, configKey: 'destination' as const, role }));
    const missingRoles = credentialBindings.map(binding => binding.role).filter(role => !input.bindings.some(binding => binding.purpose === 'backupDestination'
        && binding.configKey === 'destination' && binding.role === role && isSettledEnvironmentSecretBindingV1(binding)));
    return { ok: true, configuration: { ...configuration, credentialBindings, occurrenceId: destination.occurrenceId },
        bindingState: missingRoles.length ? 'needsBinding' : 'bound', missingRoles };
}

/** Retention changes preserve the capture identity used by existing snapshots. */
export function prepareDeploymentBackupRetentionV1(input: Readonly<{ currentBackup?: DeploymentEnvironmentBackupV1;
    configRevision: number; retention: DeploymentBackupRetentionV1 }>): Readonly<{ ok: true;
    configuration: DeploymentBackupConfigurationV1 }> | Readonly<{ ok: false; code: 'backup_required' | 'stale_input' }> {
    if (!input.currentBackup || 'notNeeded' in input.currentBackup) return { ok: false, code: 'backup_required' };
    if (input.currentBackup.configRevision !== input.configRevision) return { ok: false, code: 'stale_input' };
    return { ok: true, configuration: { ...input.currentBackup, retention: input.retention } };
}

/** The Action host supplies its current configuration and authored-backup Automation lookup, not caller booleans. */
export function prepareDeploymentBackupNotNeededV1(input: Readonly<{ currentBackup?: DeploymentEnvironmentBackupV1;
    activeAutomationIds: readonly string[] }>): Readonly<{ ok: true; backup: { notNeeded: true } }>
    | Readonly<{ ok: false; code: 'active_backup_configuration' | 'active_backup_automation' }> {
    if (input.currentBackup && !('notNeeded' in input.currentBackup)) return { ok: false, code: 'active_backup_configuration' };
    if (input.activeAutomationIds.length) return { ok: false, code: 'active_backup_automation' };
    return { ok: true, backup: { notNeeded: true } };
}
