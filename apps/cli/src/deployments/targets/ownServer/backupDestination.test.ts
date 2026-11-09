import { expect, it } from 'vitest';
import nacl from 'tweetnacl';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { withTempDir } from '@/testkit/fs/tempDir';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { definePlugin, BackupDestinationOpenV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { DeploymentBackupDestinationCredentialRoleV1ProtocolSchema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployment-protocol';
import { plugin } from '../../../../../../packages/plugins/backup-destinations/src/manifest';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import * as hostRuntime from './ownServerDeploymentHostRuntime';
import { openDeploymentBackupDestinationForHost } from './backupDestination';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { createDeploymentBackupActionForHost } from '@/deployments/actions/backups';
import { createDeploymentRestoreActionForHost } from '@/deployments/actions/restore';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';

const externalConfig = defineProtocolObject({ location: defineProtocolString() }, { policy: 'closed' });
const external = definePlugin({ id: 'external.backup.destination', version: '1.0.0',
    entrypoints: { daemon: './.happier-plugin/daemon.js' }, activation: { events: [] },
    backupDestinations: { custom: { title: 'External storage', configSchema: externalConfig.jsonSchema,
        credentialRoles: [{ role: 'repositoryPassword' }, { role: 'accessKeyId' }, { role: 'secretAccessKey' }], resticTransport: 's3', locality: 'unknown',
        actions: { test: { pluginId: 'external.backup.destination', localId: 'open' },
            open: { pluginId: 'external.backup.destination', localId: 'open' } } } },
    actions: { open: { title: 'Open external storage', surfaces: ['plugin'], execution: { target: 'daemon' },
        dangerLevel: 'safe', readOnly: true,
        inputSchema: defineProtocolObject({ config: externalConfig,
            credentialRoles: defineProtocolArray(DeploymentBackupDestinationCredentialRoleV1ProtocolSchema),
        }, { policy: 'closed' }),
        resultSchema: BackupDestinationOpenV1ProtocolSchema,
        run: ({ config }) => ({ repository: config.location,
            credentialBindings: (['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const).map(role => ({
                purpose: 'backupDestination' as const, configKey: 'destination' as const, role })) }),
    } },
});

it.each(['first-party', 'external'] as const)('opens the configured %s destination through its registered Action and refuses a changed occurrence', async kind => {
    const definition = kind === 'first-party' ? plugin : external;
    const manifest = normalizePluginManifestV2(definition.manifest);
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: definition.manifest,
            files: { '.happier-plugin/daemon.js': 'export function activate() {}', 'package.json': '{"type":"module"}' },
            instantiateCommittedModule: () => ({ activate: definition.activate }) }],
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            }));
        },
    });
    const { registry } = runtime;
    const { targetActionInvocations } = registry;
    const occurrenceId = registry.readPluginOccurrenceId(manifest.id);
    try {
        const prepareOperands = Reflect.get(hostRuntime, 'prepareOwnServerPreMigrationBackupOperandsForHost');
        expect(prepareOperands).toBeTypeOf('function');
        const [descriptor] = manifest.contributes.backupDestinations;
        const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
            destinationRef: { pluginId: manifest.id, localId: descriptor.id }, occurrenceId,
            config: kind === 'first-party' ? { endpoint: 'https://storage.invalid', bucket: 'recovery', prefix: 'one', region: 'eu-west-1' }
                : { location: 's3:https://external.invalid/recorded' },
            credentialBindings: ['repositoryPassword', 'accessKeyId', 'secretAccessKey'].map(role => ({
                purpose: 'backupDestination', configKey: 'destination', role })),
            ownership: { environmentId: 'environment', prefix: 'one' }, retention: { kind: 'keepEverything' },
            sources: [{ kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }],
        });
        const open = Reflect.get(hostRuntime, 'openDeploymentBackupDestinationForHost');
        expect(open).toBeTypeOf('function');
        const request = { registry, configuration, context: {}, signal: new AbortController().signal };
        expect(await open(request)).toEqual({ repository: kind === 'first-party' ? 's3:https://storage.invalid/recovery/one'
            : 's3:https://external.invalid/recorded', credentialBindings: configuration.credentialBindings,
            ...(kind === 'first-party' ? { s3: { region: 'eu-west-1' } } : {}) });
        await expect(open({ ...request, configuration: { ...configuration, occurrenceId: 'retired' } }))
            .rejects.toMatchObject({ data: { code: 'stale_input' } });
        await expect(open({ ...request, configuration: { ...configuration, credentialBindings: configuration.credentialBindings.slice(0, 1) } }))
            .rejects.toMatchObject({ data: { code: 'backup_required' } });
        if (kind === 'first-party') {
            const missing = createTargetActionInvocationRegistry({ actions: [],
                createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver(),
                readCurrentPluginOccurrenceId: () => occurrenceId,
                resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
                    desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                    resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            });
            try {
                const identity = readOrCreateInstallationIdentitySync();
                const cases = [
                    { reason: 'backup_required', invocation: targetActionInvocations, config: configuration.config,
                        descriptorMissing: true },
                    { reason: 'plugin_action_handler_missing', invocation: missing, config: configuration.config },
                    { reason: 'plugin_action_input_schema_invalid', invocation: targetActionInvocations,
                        config: { ...configuration.config, bucket: '' } },
                    { reason: 'approval_required', config: configuration.config, invocation: {
                        ...targetActionInvocations,
                        // Saved Ask-first policy and the user decision are external host boundaries.
                        invoke: (input: Parameters<typeof targetActionInvocations.invoke>[0]) => targetActionInvocations.invoke({
                            ...input, isApprovalRequiredByActionSettings: () => true,
                            requestCurrentIntent: async () => ({ status: 'deferred', artifactId: 'destination-approval' }),
                        }),
                    } },
                ];
                for (const candidate of cases) {
                    const openDestination = () => openDeploymentBackupDestinationForHost({ ...request,
                        configuration: { ...configuration, config: candidate.config },
                        registry: { ...registry, targetActionInvocations: candidate.invocation,
                            ...('descriptorMissing' in candidate ? { contributes: { backupDestinations: [] } } : {}) } });
                    const refusal = await openDestination().catch((error: unknown) => error);
                    const expectedCause = { phase: 'descriptorMissing' in candidate
                        ? 'deployment.backup.destination.descriptor' : 'deployment.backup.destination.open', errorClass: 'Error',
                        errorCode: candidate.reason, httpStatus: null };
                    expect(projectDeploymentFailure('backup_required', refusal)).toMatchObject({
                        errorCode: 'backup_required', failureCause: expectedCause,
                    });
                    const execute = createDeploymentBackupActionForHost({ serverId: 'server', machineId: 'machine',
                        assertCurrent: async context => { context.signal?.throwIfAborted(); },
                        backup: async () => { await openDestination(); throw new Error('Expected destination refusal'); },
                    });
                    for (const actionId of ['deployments.backups.test', 'deployments.backups.run'] as const) {
                        const result = await execute(actionId, { serverId: 'server', environmentId: 'environment',
                            machineId: 'machine', installationId: identity.installationId, targetLinkId: 'runtime',
                            deploymentId: 'deployment', configRevision: 1, expectedRevision: 1 },
                        { operationAcceptance: { actionId, operationId: 'backup-operation', accept() {} } });
                        expect(result).toMatchObject({ ok: false, errorCode: 'backup_required',
                            details: { step: 'native', code: 'backup_required', requiredFact: 'deploymentActionResult',
                                remedy: expect.stringMatching(/\S/) }, failureCause: expectedCause });
                        expect(JSON.stringify(result)).not.toContain('storage.invalid');
                    }
                    const restore = createDeploymentRestoreActionForHost({ serverId: 'server', machineId: 'machine',
                        assertCurrent: async context => { context.signal?.throwIfAborted(); },
                        restore: async () => { await openDestination(); throw new Error('Expected destination refusal'); },
                    });
                    const restored = await restore({ mode: 'prepare', serverId: 'server', environmentId: 'environment',
                        machineId: 'machine', installationId: identity.installationId, targetLinkId: 'runtime',
                        deploymentId: 'deployment', restoreBackupId: 'backup', expectedRevision: 1 },
                    { operationAcceptance: { actionId: 'deployments.backups.restore', operationId: 'restore-operation', accept() {} } });
                    expect(restored).toMatchObject({ ok: false, errorCode: 'backup_required', failureCause: expectedCause,
                        details: { requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
                    expect(JSON.stringify(restored)).not.toContain('storage.invalid');
                }
            } finally { missing.dispose(); }
        }
        await withTempDir('backup-operands-', async root => {
            const seed = new Uint8Array(32).fill(73);
            const publicKey = nacl.sign.keyPair.fromSeed(seed).publicKey;
            const subject = { v: 1 as const, environmentId: 'environment', machineId: 'machine', installationId: 'installed' };
            const database: Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }> = {
                purpose: 'variable', phase: 'runtime', name: 'DB_NAME', source: { kind: 'value', value: 'actual_database' } };
            const uses = configuration.credentialBindings.map(binding => ({ ...binding,
                source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(binding.role), resourceRevision: 1 } }));
            const grants = uses.map(binding => sealMachineSecretGrant({ subject: { ...subject, kind: 'secret',
                resourceId: binding.role, resourceRevision: 1 }, installationPublicKey: publicKey,
                content: { kind: 'secret', value: `credential-${binding.role}` } }));
            grants.push(sealMachineSecretGrant({ subject: { ...subject, kind: 'environmentValues',
                binding: { purpose: 'variable', phase: 'runtime', name: database.name } }, installationPublicKey: publicKey,
                content: { kind: 'environmentValues', definition: database.source } }));
            const data = { engine: 'postgres', service: 'postgres', logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } } as const;
            const unrelated = { engine: 'mysql', service: 'mysql', logicalBackup: { adapter: 'mysql-v1' } } as const;
            const operands = { registry, configuration, data: [unrelated, data], context: {}, signal: request.signal, isCurrent: () => true,
                preparation: { ...subject, installationPrivateSeed: seed, bindings: [...uses, database], grants,
                    backupConfigBaseDir: root, assertCurrent: async () => {} } };
            const prepared = await prepareOperands(operands);
            try {
                expect(prepared.destination).toEqual({ environmentId: 'environment', service: 'postgres', adapter: 'postgres-v1', database: 'actual_database' });
                expect(prepared.readAccess().repository).toBe(kind === 'first-party'
                    ? 's3:https://storage.invalid/recovery/one' : 's3:https://external.invalid/recorded');
                await expect(prepareOperands({ ...operands, data: [unrelated, { ...data, logicalBackup: { ...data.logicalBackup, database: 'ABSENT' } }] }))
                    .rejects.toMatchObject({ data: { code: 'secret_missing' } });
                await expect(prepareOperands({ ...operands, configuration: { ...configuration, ownership: { ...configuration.ownership, environmentId: 'foreign' } } }))
                    .rejects.toMatchObject({ data: { code: 'stale_input' } });
            } finally { await prepared.dispose(); }
        });
    } finally { await runtime.dispose(); }
});
