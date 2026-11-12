import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { withTempDir } from '@/testkit/fs/tempDir';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { definePlugin, BackupDestinationOpenV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { DeploymentBackupDestinationCredentialRoleV1ProtocolSchema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployment-protocol';
import { buildResticRequestV1 } from '@happier-dev/deployments';
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
import { createPrepareDeploymentBackupConfigurationDestinationForHost, openDeploymentBackupDestinationForHost } from './backupDestination';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { createDeploymentBackupActionForHost } from '@/deployments/actions/backups';
import { createDeploymentRestoreActionForHost } from '@/deployments/actions/restore';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import * as identityStore from '@/daemon/identity/store';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { accountSettingsParse, type ActionExecutorContext } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { getRandomBytes, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { consumeDeploymentExecEnvForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import type { StoredCredentials } from '@/persistence';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

afterEach(() => vi.restoreAllMocks());

it.each([['plain', 's3', false, 'none'], ['e2ee', 's3', false, 'none'], ['plain', 'local', false, 'none'],
    ['plain', 's3', true, 'none'], ['e2ee', 's3', true, 'none'],
    ['plain', 'local', false, 'controller'], ['plain', 'local', false, 'remote']] as const)(
    'prepares an unsaved %s %s destination on its controller (requester %s, runtime %s)', async (mode, destination, requester, runtimeMachine) => {
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: plugin.manifest,
            files: { [plugin.manifest.entrypoints.daemon]: 'export function activate() {}', 'package.json': '{"type":"module"}' },
            instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            }));
        },
    });
    try {
        const detail = createDeploymentEnvironmentDetailV1();
        const accountId = requester ? 'requester' : 'owner';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, mode, destination, requester })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(32).fill(47);
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : {
            type: 'dataKey', machineKey, publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey } };
        const daemonMachineKey = new Uint8Array(32).fill(61);
        const daemonCredentials: StoredCredentials = requester ? {
            token: `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner', mode, destination })).toString('base64url')}.signature`,
            encryption: mode === 'plain' ? null : { type: 'dataKey', machineKey: daemonMachineKey,
                publicKey: nacl.box.keyPair.fromSecretKey(daemonMachineKey).publicKey } } : credentials;
        const key = await createResourceDataKey({ credentials, mode });
        const seed = new Uint8Array(32).fill(51), keys = nacl.sign.keyPair.fromSeed(seed);
        vi.spyOn(identityStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'controller-installation', publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url'), createdAt: 1 });
        const content = { v: 1 as const, name: 'Backup', kind: 'token' as const, value: 'private-candidate-backup-secret' };
        const storedContent = key.mode === 'plain'
            ? sealSavedSecretResourceStoredContentV1({ resourceId: 'credential', mode: 'plain', content })
            : sealSavedSecretResourceStoredContentV1({ resourceId: 'credential', mode: 'e2ee', content,
                resourceDataKey: key.dataKey, randomBytes: getRandomBytes });
        let materialReads = 0;
        // Home resource material is the external authorization boundary; binding
        // selection, mode parsing, seals and operation attachment stay real.
        const settingsContent = credentials.encryption ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
            kind: 'account_settings', material: credentials.encryption, payload: {}, randomBytes: getRandomBytes }) }
            : { t: 'plain', v: {} };
        vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: settingsContent, version: 1 } };
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
            if (!url.endsWith('/v1/account/saved-secrets/resources/materials')) throw new Error('Unexpected Home read');
            expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
            materialReads++;
            return { status: 200, data: { resources: [{ resourceId: 'credential', encryptionMode: mode,
                recipientEnvelope: key.mode === 'plain' ? null : { encryptedDataKey: key.dataEncryptionKey,
                    recipientContentPublicKeyFingerprint: 'owner-content-key' },
                entry: { ref: formatSharedSavedSecretRefV1('credential'), source: 'shared_resource', relationship: 'owner',
                    name: 'Backup', kind: 'token', ownerAccountId: accountId, revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }, storedContent }] } };
        });
        const serverHttpBaseUrl = 'https://home.test';
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl,
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
                loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) },
            async isCurrent() { return true; } });
        const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
            destinationRef: { pluginId: plugin.manifest.id, localId: destination }, occurrenceId: 'candidate',
            config: destination === 'local' ? { path: runtimeMachine === 'controller' ? tmpdir() : '~/candidate-repository' }
                : { endpoint: 'https://storage.invalid', bucket: 'recovery', prefix: 'one', region: 'eu-west-1' },
            credentialBindings: (destination === 'local' ? ['repositoryPassword'] : ['repositoryPassword', 'accessKeyId', 'secretAccessKey']).map(role => ({
                purpose: 'backupDestination', configKey: 'destination', role })),
            ownership: { environmentId: detail.environment.id, prefix: destination === 'local' ? '' : 'candidate-owner' }, retention: { kind: 'keepEverything' },
            sources: [{ kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }] });
        const bindings = configuration.credentialBindings.map(binding => ({ ...binding,
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 1 } }));
        const runtimeLink = { ...detail.targetLinks[0]!.targetLink,
            members: [{ machineId: runtimeMachine, installationId: 'controller-installation', state: 'active' as const }] };
        const environment = { ...detail, environment: { ...detail.environment, controllerMachineId: 'controller',
            runtimeTargetLinkId: runtimeMachine === 'none' ? null : runtimeLink.id },
            content: { ...detail.content, bindings }, targetLinks: runtimeMachine === 'none' ? [] : [runtimeLink] };
        delete environment.content.backup;
        let context: ActionExecutorContext = {};
        if (requester) {
            const channel = await createRequesterCurrentnessSocketHarness();
            onTestFinished(() => channel.close());
            const input = { serverId: 'home', environmentId: detail.environment.id,
                expectedRevision: detail.environment.revision, intent: 'test' as const, configuration };
            const admitted = await admitRequesterAccountActionContext({ credentials, serverId: 'home', serverIdentityId: 'home',
                serverHttpBaseUrl, isCurrent: async () => true,
                authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'candidate-requester-root', binding: {
                    accountId, custodianAccountId: 'daemon-owner', accountEncryptionMode: mode, serverIdentityId: 'home',
                    machineId: 'controller', installationId: 'controller-installation',
                    actionId: 'deployments.backups.configure', environmentId: detail.environment.id,
                    requestId: 'candidate-requester', requestEnvelopeDigest: 'a'.repeat(43),
                    deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', input),
                    target: { kind: 'machine', machineId: 'controller' }, authentication: { kind: 'account', tokenEpoch: 1 },
                } }) });
            if (!admitted) throw new Error('Expected admitted requester custody');
            onTestFinished(() => admitted.dispose());
            const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
                serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl, target: admitted.authorization.binding.target,
                installationId: 'controller-installation', privateKey: keys.secretKey, rootAdmitted: true });
            if (!authorization) throw new Error('Expected admitted requester HTTP projection');
            context = { externalActionExecutionAuthorization: authorization };
        }
        let releases = 0;
        const host = { credentials: daemonCredentials, serverId: 'home', serverHttpBaseUrl, machineId: 'controller',
            ...(requester ? { authorCustody: resolveRequesterSavedSecretActionCustody({
                authorization: context.externalActionExecutionAuthorization, credentials: daemonCredentials }) }
                : { savedSecretOperationContext: operation }), async acquirePluginRuntimeRegistryLease() {
                return { registry: runtime.registry, async release() { releases++; } };
            } };
        const prepareDestination = createPrepareDeploymentBackupConfigurationDestinationForHost(host);
        const request = { environment, configuration, intent: 'test' as const, context, signal: new AbortController().signal };
        await expect(prepareDestination({ ...request, environment: { ...environment,
            environment: { ...environment.environment, controllerMachineId: 'different-controller' } } }))
            .rejects.toMatchObject({ data: { code: 'target_mismatch' } });
        expect(materialReads).toBe(0);
        const prepared = await prepareDestination(request);
        let passwordPath: string | undefined;
        try {
            if (destination === 'local') {
                if (runtimeMachine === 'controller') expect(prepared.capacity).toMatchObject({
                    status: 'known', path: await realpath(tmpdir()), freeBytes: expect.any(Number), observedAt: expect.any(Number) });
                else expect(prepared.capacity).toMatchObject({ status: 'unknown', path: '~/candidate-repository' });
            }
            const attachment = await prepared.execEnv.prepare({ backupDestination: { configKey: 'destination' } });
            const material = await consumeDeploymentExecEnvForHost(attachment);
            try {
                if (destination === 's3') expect(material.env.AWS_ACCESS_KEY_ID).toBe(content.value);
                passwordPath = material.env.RESTIC_PASSWORD_FILE;
                expect(await readFile(material.env.RESTIC_PASSWORD_FILE, 'utf8')).toBe(content.value);
                if (destination === 's3') expect(prepared.readAccess().repository).toBe('s3:https://storage.invalid/recovery/one/candidate-owner');
                else expect(prepared.readAccess().local).toEqual({ path: expandHomeDirPath(String(configuration.config.path)) });
                expect(JSON.stringify(prepared)).not.toContain(content.value);
            } finally { await material.dispose(); }
            expect(materialReads).toBe(1);
        } finally { await prepared.release?.(); }
        await prepared.release?.();
        expect(releases).toBe(1);
        expect(passwordPath).toBeDefined();
        await expect(readFile(passwordPath!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await runtime.dispose(); }
});

const externalRepository = 's3:https://external.invalid/recorded%2Farchive';
const externalConfig = defineProtocolObject({ archive: defineProtocolString() }, { policy: 'closed' });
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
            ownershipPrefix: defineProtocolString().optional(),
        }, { policy: 'closed' }),
        resultSchema: BackupDestinationOpenV1ProtocolSchema,
        run: ({ config, ownershipPrefix }) => {
            expect(ownershipPrefix).toBe('');
            return { repository: config.archive,
            credentialBindings: (['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const).map(role => ({
                purpose: 'backupDestination' as const, configKey: 'destination' as const, role })) };
        },
    } },
});

it.each(['first-party', 'external'] as const)('prepares selected sources through the configured %s destination after its occurrence changes', async kind => {
    const definition = kind === 'first-party' ? plugin : external;
    const manifest = normalizePluginManifestV2(definition.manifest);
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: definition.manifest,
            files: { [definition.manifest.entrypoints.daemon]: 'export function activate() {}', 'package.json': '{"type":"module"}' },
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
                : { archive: externalRepository },
            credentialBindings: ['repositoryPassword', 'accessKeyId', 'secretAccessKey'].map(role => ({
                purpose: 'backupDestination', configKey: 'destination', role })),
            ownership: { environmentId: 'environment', prefix: kind === 'first-party' ? 'one' : '' }, retention: { kind: 'keepEverything' },
            sources: [{ kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }],
        });
        const open = Reflect.get(hostRuntime, 'openDeploymentBackupDestinationForHost');
        expect(open).toBeTypeOf('function');
        const request = { registry, configuration, context: {}, signal: new AbortController().signal };
        expect(await open(request)).toEqual({ repository: kind === 'first-party' ? 's3:https://storage.invalid/recovery/one/one'
            : externalRepository, credentialBindings: configuration.credentialBindings,
            ...(kind === 'first-party' ? { s3: { region: 'eu-west-1' } } : {}) });
        expect(await open({ ...request, configuration: { ...configuration, occurrenceId: 'retired' } }))
            .toEqual(await open(request));
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
                            invocationSurface: 'cli',
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
                        deploymentId: 'deployment', source: { kind: 'repository', snapshotId: 'backup' }, expectedRevision: 1 },
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
                    ? 's3:https://storage.invalid/recovery/one/one' : externalRepository);
                const inventory = buildResticRequestV1({ environmentId: configuration.ownership.environmentId,
                    access: prepared.readAccess(), command: { kind: 'snapshots' } });
                expect(inventory.argv).toEqual(['--repo', kind === 'first-party'
                    ? 's3:https://storage.invalid/recovery/one/one' : externalRepository, '--json',
                    ...(kind === 'first-party' ? ['-o', 's3.region=eu-west-1'] : []),
                    'snapshots', '--host', 'happier-env-environment', '--tag', 'happier,env:environment']);
                await expect(prepareOperands({ ...operands, data: [unrelated, { ...data, logicalBackup: { ...data.logicalBackup, database: 'ABSENT' } }] }))
                    .rejects.toMatchObject({ data: { code: 'secret_missing' } });
                await expect(prepareOperands({ ...operands, configuration: { ...configuration, ownership: { ...configuration.ownership, environmentId: 'foreign' } } }))
                    .rejects.toMatchObject({ data: { code: 'stale_input' } });
            } finally { await prepared.dispose(); }
            const prepareRun = Reflect.get(hostRuntime, 'prepareOwnServerBackupRunOperandsForHost');
            expect(prepareRun).toBeTypeOf('function');
            if (kind === 'first-party') {
                const sqlite = { engine: 'sqlite', service: 'application', logicalBackup: {
                    adapter: 'sqlite-v1', path: '/data/application.sqlite' } } as const;
                const selected = await prepareRun({ ...operands, data: [data, sqlite],
                    configuration: { ...configuration, sources: [{ kind: 'dump', sourceId: 'application',
                        service: 'application', consistency: 'logical' }] } });
                const selectedAttachment = await selected.execEnv.prepare({ backupDestination: { configKey: 'destination' } });
                try {
                    expect(selected.data).toEqual([sqlite]);
                    expect(selected.destinations).toEqual([{ environmentId: 'environment', service: 'application',
                        adapter: 'sqlite-v1', path: '/data/application.sqlite' }]);
                } finally { selectedAttachment.dispose(); await selected.dispose(); }
            }
            const volume = await prepareRun({ ...operands, data: [],
                configuration: { ...configuration, sources: [{ kind: 'volume', sourceId: 'uploads', service: 'app',
                    volume: 'uploads', consistency: 'stopDuringCopy' }] } });
            const volumeAttachment = await volume.execEnv.prepare({ backupDestination: { configKey: 'destination' } });
            try {
                expect(volume).not.toHaveProperty('destination');
                expect(volume.readAccess().repository).toBe(kind === 'first-party'
                    ? 's3:https://storage.invalid/recovery/one/one' : externalRepository);
            } finally { volumeAttachment.dispose(); }
        });
    } finally { await runtime.dispose(); }
});
