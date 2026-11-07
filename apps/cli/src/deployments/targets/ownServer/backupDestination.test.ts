import { expect, it } from 'vitest';
import nacl from 'tweetnacl';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { withTempDir } from '@/testkit/fs/tempDir';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { definePlugin, BackupDestinationOpenV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { DeploymentBackupDestinationCredentialRoleV1ProtocolSchema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployment-protocol';
import { plugin } from '../../../../../../packages/plugins/backup-destinations/src/manifest';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import * as hostRuntime from './ownServerDeploymentHostRuntime';

const externalConfig = defineProtocolObject({ location: defineProtocolString() }, { policy: 'closed' });
const external = definePlugin({ id: 'external.backup.destination', version: '1.0.0',
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
    const fixture = await createPluginTestkit({ manifest: definition.manifest, module: definition });
    const occurrenceId = createPluginRuntimeOccurrenceId(manifest.id);
    const declarations = projectLoadedPluginContributes({ loadResult: { diagnosticsByPluginId: {}, loadedPlugins: [{
        pluginId: manifest.id, pluginRootPath: '/plugins/backup', manifestPath: '/plugins/backup/plugin.json',
        daemonEntryPath: '/plugins/backup/daemon.js', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: manifest.id, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest,
    }] }, provenance: 'external' });
    const contributes = createResolvedContributionRegistry({ ...declarations, occurrenceIdsByPluginId: { [manifest.id]: occurrenceId } });
    const targetActionInvocations = createTargetActionInvocationRegistry({
        actions: manifest.contributes.actions.map(action => {
            const handler = fixture.registration('actions', action.id);
            if (!handler) throw new Error('Expected registered destination handler');
            return { pluginId: manifest.id, pluginVersion: manifest.version, occurrenceId,
                sourceCustody: createManagedPluginSourceCustody('backup-generation'), localId: action.id, definition: action, handler };
        }),
        createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver(),
        readCurrentPluginOccurrenceId: () => occurrenceId,
        resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
            desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
    });
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
        const registry = { contributes, targetActionInvocations, readPluginOccurrenceId: () => occurrenceId };
        const request = { registry, configuration, context: {}, signal: new AbortController().signal };
        expect(await open(request)).toEqual({ repository: kind === 'first-party' ? 's3:https://storage.invalid/recovery/one'
            : 's3:https://external.invalid/recorded', credentialBindings: configuration.credentialBindings,
            ...(kind === 'first-party' ? { s3: { region: 'eu-west-1' } } : {}) });
        await expect(open({ ...request, configuration: { ...configuration, occurrenceId: 'retired' } }))
            .rejects.toMatchObject({ data: { code: 'stale_input' } });
        await expect(open({ ...request, configuration: { ...configuration, credentialBindings: configuration.credentialBindings.slice(0, 1) } }))
            .rejects.toMatchObject({ data: { code: 'backup_required' } });
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
            const operands = { registry, configuration, data, context: {}, signal: request.signal, isCurrent: () => true,
                preparation: { ...subject, installationPrivateSeed: seed, bindings: [...uses, database], grants,
                    backupConfigBaseDir: root, assertCurrent: async () => {} } };
            const prepared = await prepareOperands(operands);
            try {
                expect(prepared.destination).toEqual({ environmentId: 'environment', service: 'postgres', adapter: 'postgres-v1', database: 'actual_database' });
                expect(prepared.readAccess().repository).toBe(kind === 'first-party'
                    ? 's3:https://storage.invalid/recovery/one' : 's3:https://external.invalid/recorded');
                await expect(prepareOperands({ ...operands, data: { ...data, logicalBackup: { ...data.logicalBackup, database: 'ABSENT' } } }))
                    .rejects.toMatchObject({ data: { code: 'secret_missing' } });
                await expect(prepareOperands({ ...operands, configuration: { ...configuration, ownership: { ...configuration.ownership, environmentId: 'foreign' } } }))
                    .rejects.toMatchObject({ data: { code: 'stale_input' } });
            } finally { await prepared.dispose(); }
        });
    } finally { targetActionInvocations.dispose(); await fixture.dispose(); }
});
