import { describe, expect, it } from 'vitest';
import { createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import * as owners from '../index.js';

const descriptor = {
    id: 'storage', title: 'External storage',
    configSchema: { type: 'object', properties: { bucket: { type: 'string', minLength: 1 } },
        required: ['bucket'], additionalProperties: false },
    credentialRoles: ['repositoryPassword'], resticTransport: 's3', locality: 'offHost',
    actions: { test: { pluginId: 'example.storage', localId: 'test' }, open: { pluginId: 'example.storage', localId: 'open' } },
};
const destination = { ref: { pluginId: 'example.storage', localId: 'storage' }, occurrenceId: 'occurrence-1', descriptor };
const configuration = {
    configRevision: 1, destinationRef: destination.ref, occurrenceId: destination.occurrenceId,
    config: { bucket: 'recovery' },
    credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
    sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }],
    ownership: { environmentId: 'environment-a', prefix: 'environments/a' },
    retention: { kind: 'keepEverything' },
};
const secret = createDeploymentSecretVariableBindingV1({ name: 'UNUSED', phase: 'runtime', resourceId: 'secret-a', resourceRevision: 1 }).source;
const bindings = [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword', source: secret }];

function prepare(input: unknown): unknown {
    const owner = Reflect.get(owners, 'prepareDeploymentBackupConfigurationV1');
    return typeof owner === 'function' ? owner(input) : undefined;
}
const input = { environmentId: 'environment-a', configuration, destination, bindings };

describe('backup configuration preparation', () => {
    it('validates the selected external descriptor and reports binding presence without claiming runtime readiness', () => {
        expect(prepare(input)).toEqual({ ok: true, configuration, bindingState: 'bound', missingRoles: [] });
        expect(prepare({ ...input, bindings: [] })).toEqual({ ok: true, configuration,
            bindingState: 'needsBinding', missingRoles: ['repositoryPassword'] });
        expect(prepare({ ...input, destination: { ...destination,
            descriptor: { ...descriptor, credentialRoles: ['repositoryPassword', 'awsSessionToken'] } } }))
            .toEqual({ ok: true, configuration, bindingState: 'bound', missingRoles: [] });
        expect(prepare({ ...input, bindings: [createDeploymentSecretVariableBindingV1({ name: 'PASSWORD', phase: 'runtime',
            resourceId: 'secret-a', resourceRevision: 1 })] }))
            .toMatchObject({ ok: true, bindingState: 'needsBinding', missingRoles: ['repositoryPassword'] });
    });

    it('captures current provenance without turning plugin reload into a permission fence', () => {
        expect(prepare({ ...input, configuration: { ...configuration, occurrenceId: 'retired' } }))
            .toEqual({ ok: true, configuration, bindingState: 'bound', missingRoles: [] });
    });

    it('refuses foreign ownership, undeclared roles and fields outside the selected descriptor', () => {
        for (const [patch, code] of [
            [{ configuration: { ...configuration, destinationRef: { ...configuration.destinationRef, pluginId: 'foreign.storage' } } }, 'destination_changed'],
            [{ configuration: { ...configuration, ownership: { ...configuration.ownership, environmentId: 'foreign' } } }, 'environment_mismatch'],
            [{ configuration: { ...configuration, sources: [] } }, 'invalid_backup_sources'],
            [{ configuration: { ...configuration, config: { bucket: 'recovery', password: 'not-admitted' } } }, 'invalid_destination_config'],
            [{ configuration: { ...configuration, credentialBindings: [...configuration.credentialBindings,
                { purpose: 'backupDestination', configKey: 'destination', role: 'sshPrivateKey' }] } }, 'unsupported_credential_role'],
        ] as const) expect(prepare({ ...input, ...patch })).toEqual({ ok: false, code });
    });

    it('makes omitted retention visible as Keep everything and never guesses a finite policy', () => {
        const { retention: _retention, ...withoutRetention } = configuration;
        expect(prepare({ ...input, configuration: withoutRetention })).toMatchObject({ ok: true,
            configuration: { retention: { kind: 'keepEverything' } } });
    });

    it('marks Not needed only without an active configuration or Automation', () => {
        const owner = Reflect.get(owners, 'prepareDeploymentBackupNotNeededV1');
        const mark = (value: unknown) => typeof owner === 'function' ? owner(value) : undefined;
        expect(mark({ activeAutomationIds: [] })).toEqual({ ok: true, backup: { notNeeded: true } });
        expect(mark({ currentBackup: { notNeeded: true }, activeAutomationIds: [] }))
            .toEqual({ ok: true, backup: { notNeeded: true } });
        expect(mark({ currentBackup: configuration, activeAutomationIds: [] }))
            .toEqual({ ok: false, code: 'active_backup_configuration' });
        expect(mark({ activeAutomationIds: ['automation-a'] }))
            .toEqual({ ok: false, code: 'active_backup_automation' });
    });
});
