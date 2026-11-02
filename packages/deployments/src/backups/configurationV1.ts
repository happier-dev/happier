import { DeploymentBackupConfigurationV1Schema, validateDeploymentBackupDestinationConfigurationV1,
    type DeploymentBackupConfigurationV1, type DeploymentEnvironmentBackupV1,
    type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';

type Destination = Readonly<{ ref: DeploymentBackupConfigurationV1['destinationRef']; occurrenceId: string;
    descriptor: Parameters<typeof validateDeploymentBackupDestinationConfigurationV1>[0]['descriptor'] }>;
type ConfigurationFailure = Readonly<{ ok: false; code: 'invalid_backup_configuration' | 'invalid_backup_sources'
    | 'destination_changed' | 'environment_mismatch' | 'invalid_destination_config' | 'unsupported_credential_role' }>;
export type DeploymentBackupConfigurationPreparationV1 = ConfigurationFailure | Readonly<{ ok: true;
    configuration: DeploymentBackupConfigurationV1; bindingState: 'bound' | 'needsBinding'; missingRoles: string[] }>;

/** Configure admission consumes the selected catalog descriptor and the opened Environment bindings once. */
export function prepareDeploymentBackupConfigurationV1(input: Readonly<{ environmentId: string; configuration: unknown;
    destination: Destination; bindings: readonly EnvironmentSecretBindingV1[] }>): DeploymentBackupConfigurationPreparationV1 {
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
    const roles = destination.descriptor.credentialRoles;
    if (configuration.credentialBindings.some(binding => !roles.includes(binding.role))) return { ok: false, code: 'unsupported_credential_role' };
    const missingRoles = configuration.credentialBindings.map(binding => binding.role).filter(role => !input.bindings.some(binding => binding.purpose === 'backupDestination'
        && binding.configKey === 'destination' && binding.role === role));
    return { ok: true, configuration: { ...configuration, occurrenceId: destination.occurrenceId },
        bindingState: missingRoles.length ? 'needsBinding' : 'bound', missingRoles };
}

/** The Action host supplies its current configuration and authored-backup Automation lookup, not caller booleans. */
export function prepareDeploymentBackupNotNeededV1(input: Readonly<{ currentBackup?: DeploymentEnvironmentBackupV1;
    activeAutomationIds: readonly string[] }>): Readonly<{ ok: true; backup: { notNeeded: true } }>
    | Readonly<{ ok: false; code: 'active_backup_configuration' | 'active_backup_automation' }> {
    if (input.currentBackup && !('notNeeded' in input.currentBackup)) return { ok: false, code: 'active_backup_configuration' };
    if (input.activeAutomationIds.length) return { ok: false, code: 'active_backup_automation' };
    return { ok: true, backup: { notNeeded: true } };
}
