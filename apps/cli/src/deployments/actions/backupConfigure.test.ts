import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import { resolveDeploymentCreationDefaultsV1 } from '@happier-dev/deployments';
import { DeploymentBackupConfigureResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createDeploymentBackupConfigureActionForHost, type DeploymentBackupConfigureHost } from './backupConfigure';

const configuration: DeploymentBackupConfigurationV1 = {
    configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'local' },
    occurrenceId: 'reviewed', config: { path: '/backups' }, credentialBindings: [{ purpose: 'backupDestination',
        configKey: 'destination', role: 'repositoryPassword' }],
    ownership: { environmentId: 'environment', prefix: 'owned' },
    sources: [{ kind: 'volume', sourceId: 'data', service: 'app', volume: 'data', consistency: 'stopDuringCopy' }],
    retention: { kind: 'keepEverything' },
};

function fixture() {
    const environment = createDeploymentEnvironmentDetailV1();
    configuration.ownership.environmentId = environment.environment.id;
    environment.content.bindings = [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 1 } }];
    const counts = { reads: 0, descriptors: 0, native: 0, saves: 0 };
    let nativeResult: { kind: 'reachable'; repositoryId: string } | { kind: 'failed'; step: 'repository';
        reason: 'repository_missing'; nativeExitCode: number; remedy: 'review_destination' } = {
        kind: 'reachable', repositoryId: 'a'.repeat(64) };
    let saved: unknown;
    let automationIds: string[] = [];
    // The host ports stand for Home reads/writes, the installed plugin registry, and native effects.
    const host: DeploymentBackupConfigureHost = {
        serverId: 'home',
        async readEnvironment() { counts.reads++; return { ...environment,
            targetLinks: environment.targetLinks.map(row => row.targetLink) }; },
        async acquirePluginRuntimeRegistryLease() { counts.descriptors++; return { registry: {
            contributes: { backupDestinations: [{ identity: configuration.destinationRef, definition: {
                id: 'local', title: 'Local', resticTransport: 'local' as const, locality: 'local' as const,
                credentialRoles: [{ role: 'repositoryPassword' }], configSchema: { type: 'object' as const, properties: { path: { type: 'string' as const } },
                    required: ['path'], additionalProperties: false },
                actions: { test: configuration.destinationRef, open: configuration.destinationRef },
            } }] }, readPluginOccurrenceId: () => 'current',
        }, async release() {} }; },
        async executeNative() { counts.native++; return { test: nativeResult }; },
        async resolveCreationDefaults(_environment, explicit) { return resolveDeploymentCreationDefaultsV1({
            projectOwner: { kind: 'account', accountId: 'owner' }, target: { kind: 'ownServer', machines: [] }, explicit }); },
        async readActiveBackupAutomationIds() { return automationIds; },
        async saveBackup(input: { backup: unknown }) { counts.saves++; saved = input.backup;
            return { ok: true as const, environmentId: environment.environment.id, revision: environment.environment.revision + 1 }; },
    };
    const input = { serverId: 'home', environmentId: environment.environment.id,
        expectedRevision: environment.environment.revision, configuration };
    return { host, counts, input, environment, saved: () => saved,
        activeAutomation() { automationIds = ['nightly']; },
        failNative() { nativeResult = { kind: 'failed', step: 'repository', reason: 'repository_missing', nativeExitCode: 10,
            remedy: 'review_destination' }; } };
}

describe('backup configure coordinator', () => {
    it('tests the prepared candidate without persisting or replacing the previous configuration', async () => {
        const f = fixture();
        f.environment.content.backup = { ...configuration, configRevision: 7 };
        expect(await createDeploymentBackupConfigureActionForHost(f.host)({ ...f.input, intent: 'test' }, {}))
            .toMatchObject({ kind: 'tested', test: { kind: 'reachable', repositoryId: 'a'.repeat(64) } });
        expect(f.counts).toEqual({ reads: 1, descriptors: 1, native: 1, saves: 0 });
        expect(f.environment.content.backup.configRevision).toBe(7);
    });

    it.each(['save', 'initializeAndSave'] as const)('persists %s only after the native repository proof succeeds', async intent => {
        const f = fixture();
        expect(await createDeploymentBackupConfigureActionForHost(f.host)({ ...f.input, intent }, {}))
            .toMatchObject({ kind: 'configured', revision: f.input.expectedRevision + 1, configuration: { occurrenceId: 'current' } });
        expect(f.counts).toEqual({ reads: 1, descriptors: 1, native: 1, saves: 1 });
        expect(f.saved()).toMatchObject({ occurrenceId: 'current' });
    });

    it('preserves the previous configuration when a repository is missing', async () => {
        const f = fixture(); f.failNative();
        expect(await createDeploymentBackupConfigureActionForHost(f.host)({ ...f.input, intent: 'save' }, {}))
            .toMatchObject({ kind: 'tested', test: { kind: 'failed', reason: 'repository_missing' } });
        expect(f.counts.saves).toBe(0);
    });

    it('rejects a stale Environment before descriptor or native effects', async () => {
        const f = fixture();
        expect(await createDeploymentBackupConfigureActionForHost(f.host)({ ...f.input, intent: 'save', expectedRevision: 999 }, {}))
            .toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect(f.counts).toEqual({ reads: 1, descriptors: 0, native: 0, saves: 0 });
    });

    it('returns needsBinding before any probe or persistence', async () => {
        const f = fixture();
        f.environment.content.bindings = [];
        expect(await createDeploymentBackupConfigureActionForHost(f.host)({ ...f.input, intent: 'save' }, {}))
            .toMatchObject({ kind: 'needsBinding', missingRoles: ['repositoryPassword'] });
        expect(f.counts.native).toBe(0); expect(f.counts.saves).toBe(0);
    });

    it('marks an unconfigured Environment not needed without acquiring or probing a destination', async () => {
        const f = fixture();
        expect(await createDeploymentBackupConfigureActionForHost(f.host)({ serverId: f.input.serverId,
            environmentId: f.input.environmentId, expectedRevision: f.input.expectedRevision, intent: 'markNotNeeded' }, {}))
            .toMatchObject({ kind: 'notNeeded' });
        expect(f.saved()).toEqual({ notNeeded: true });
        expect(f.counts).toEqual({ reads: 1, descriptors: 0, native: 0, saves: 1 });
    });

    it('refuses markNotNeeded while a backup Automation is active', async () => {
        const f = fixture(); f.activeAutomation();
        expect(await createDeploymentBackupConfigureActionForHost(f.host)({ serverId: f.input.serverId,
            environmentId: f.input.environmentId, expectedRevision: f.input.expectedRevision, intent: 'markNotNeeded' }, {}))
            .toMatchObject({ ok: false, errorCode: 'active_backup_automation' });
        expect(f.counts.saves).toBe(0);
    });

    it('uses canonical first-configuration retention defaults and returns their provenance', async () => {
        const f = fixture();
        const { retention: _retention, ...candidate } = f.input.configuration;
        const configured = await createDeploymentBackupConfigureActionForHost({ ...f.host,
            async resolveCreationDefaults(_environment, explicit) { return resolveDeploymentCreationDefaultsV1({
                projectOwner: { kind: 'account', accountId: 'owner' }, target: { kind: 'ownServer', machines: [] },
                explicit, account: { accountId: 'owner', defaults: { backupRetention: { kind: 'keep', last: 7 } } } }); },
        })({ ...f.input, intent: 'save', configuration: candidate }, {});
        expect(configured).toMatchObject({ kind: 'configured', configuration: { retention: { kind: 'keep', last: 7 } },
            review: { creationDefaults: { sources: { backupRetention: 'account', backupDestination: 'explicit' } } } });
    });

    it('does not report configured when the Environment CAS fails after a successful test', async () => {
        const f = fixture();
        expect(await createDeploymentBackupConfigureActionForHost({ ...f.host,
            async saveBackup() { return { ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' }; },
        })({ ...f.input, intent: 'save' }, {})).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
    });

    it('returns the saved revision and reviewed binding references when binding publication fails after the backup CAS', async () => {
        const f = fixture();
        const backupBindings = f.environment.content.bindings.filter(binding => binding.purpose === 'backupDestination');
        let bindingRevision: number | undefined;
        const result = await createDeploymentBackupConfigureActionForHost({ ...f.host,
            async saveBackupBindings(request) {
                bindingRevision = request.expectedRevision;
                return { ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' };
            },
        })({ ...f.input, intent: 'save', backupBindings }, {});
        expect(bindingRevision).toBe(f.input.expectedRevision + 1);
        expect(result).toMatchObject({ ok: false, errorCode: 'deployment_conflict', effectAttempted: true,
            details: { environmentId: f.input.environmentId, revision: bindingRevision, backupBindings } });
        expect(f.saved()).toMatchObject({ occurrenceId: 'current' });
    });

    it('refuses markNotNeeded when a configuration remains active', async () => {
        const f = fixture(); f.environment.content.backup = configuration;
        expect(await createDeploymentBackupConfigureActionForHost(f.host)({ serverId: f.input.serverId,
            environmentId: f.input.environmentId, expectedRevision: f.input.expectedRevision, intent: 'markNotNeeded' }, {}))
            .toMatchObject({ ok: false, errorCode: 'active_backup_configuration' });
        expect(f.counts.native).toBe(0); expect(f.counts.saves).toBe(0);
    });

    it.each(['test', 'save'] as const)('retains settled Another Machine setup after the %s probe so retries reuse its saved identity', async intent => {
        const f = fixture();
        if (intent === 'save') f.failNative();
        const senderIdentity = { publicKey: 'ssh-ed25519 public-only', sshPrivateKey: {
            kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('sender-key'), resourceRevision: 1 } };
        const destinationSetup = { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'installed-receiver',
            receiverInputs: {} };
        const setupOperation = { operationId: 'receiver-operation', runId: 'receiver-run' };
        const result = await createDeploymentBackupConfigureActionForHost({ ...f.host,
            async acquirePluginRuntimeRegistryLease() {
                const lease = await f.host.acquirePluginRuntimeRegistryLease();
                return { ...lease, registry: { ...lease.registry, contributes: { backupDestinations:
                    lease.registry.contributes.backupDestinations.map(entry => ({ ...entry,
                        definition: { ...entry.definition, configSchema: { type: 'object' as const,
                            properties: { path: { type: 'string' as const } }, required: ['path'], additionalProperties: true } } })) } } };
            },
            async prepareAnotherMachine() { return { status: 'ready' as const, senderIdentity, setupOperation, fingerprint: 'SHA256:receiver',
                config: { host: 'receiver.private', port: 22, username: 'backup', path: '/backups',
                    hostKey: 'receiver.private ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }; },
        })({ ...f.input, intent, destinationSetup }, {});
        expect(DeploymentBackupConfigureResultV1Schema.parse(result)).toMatchObject({ kind: 'tested',
            destinationSetup: { ...destinationSetup, senderIdentity }, setupOperation });
        expect(f.counts.saves).toBe(0);
    });

    it('retains settled setup references when publishing the configuration fails', async () => {
        const f = fixture();
        const senderIdentity = { publicKey: 'ssh-ed25519 public-only', sshPrivateKey: {
            kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('sender-key'), resourceRevision: 1 } };
        const destinationSetup = { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'installed-receiver',
            receiverInputs: {} };
        const setupOperation = { operationId: 'receiver-operation', runId: 'receiver-run' };
        const result = await createDeploymentBackupConfigureActionForHost({ ...f.host,
            async prepareAnotherMachine() { return { status: 'ready' as const, senderIdentity, setupOperation, fingerprint: 'SHA256:receiver',
                config: { host: 'receiver.private', port: 22, username: 'backup', path: '/backups',
                    hostKey: 'receiver.private ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }; },
            async acquirePluginRuntimeRegistryLease() {
                const lease = await f.host.acquirePluginRuntimeRegistryLease();
                return { ...lease, registry: { ...lease.registry, contributes: { backupDestinations:
                    lease.registry.contributes.backupDestinations.map(entry => ({ ...entry,
                        definition: { ...entry.definition, configSchema: { type: 'object' as const,
                            properties: { path: { type: 'string' as const } }, required: ['path'], additionalProperties: true } } })) } } };
            },
            async saveBackup() { return { ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' }; },
        })({ ...f.input, intent: 'save', destinationSetup }, {});
        expect(result).toMatchObject({ ok: false, errorCode: 'deployment_conflict', effectAttempted: true,
            details: { destinationSetup: { ...destinationSetup, senderIdentity }, setupOperation } });
    });
});
