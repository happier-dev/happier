import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, DeploymentBackupManifestV1Schema, DeploymentBackupRunResultV1Schema,
  DeploymentBackupVerifyResultV1Schema } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, type DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

afterEach(() => vi.restoreAllMocks());

function readinessFixture() {
  let recordedTime = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => recordedTime++);
  const detail = createDeploymentEnvironmentDetailV1();
  Object.assign(detail.environment, { id: 'production', projectSourceId: 'project', controllerMachineId: 'controller', revision: 2 });
  detail.targetLinks = [];
  detail.content.template = { templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1',
      ref: { kind: 'version', version: '1' } },
    definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, services: ['db'],
    data: { engine: 'postgres', service: 'db' } };
  let metadataReads = 0;
  // Only HTTP and target-daemon routing are replaced. Environment metadata,
  // private Artifact opening, access/scope/revision admission and composition stay real.
  const metadata = vi.spyOn(axios, 'request').mockImplementation(async () => {
    metadataReads += 1;
    return { status: 200, data: { ok: true, environment: detail.environment, targetLinks: [] } };
  });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    return { status: 200, data: { id: detail.environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner',
      publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'App' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(detail.content) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
  });
  const identity = createFilesystemEffectAdmission();
  const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account' });
  const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
    serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'controller',
    async resolveRequesterIdentity(context) {
      const requester = await identity.resolveActionRequester!(context);
      try { return requester.identity; } finally { await requester.dispose(); }
    }, readBackupOperations: (target) => operations.readDeploymentBackupOperations({ target }),
    runtime: { acquire: async () => { throw new Error('Unexpected runtime acquisition'); } } });
  const nativeReads: string[] = [];
  const executor = createActionExecutor({ ...deps, routeHostChildAction: async request => {
    nativeReads.push(request.actionId);
    throw new Error('Unexpected native transport');
  } });
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const credentialedExecutor = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null },
    serverId: 'home', serverApiUrl: 'https://home.test', serverIdentityId: 'srv_home', machineId: 'controller',
    projectReadinessRead: deps.projectReadinessRead,
    actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
  return { detail, metadata, executor, credentialedExecutor, operations, nativeReads, metadataReads: () => metadataReads };
}

describe('Project readiness through the public Action', () => {
  it('preserves the metadata transport owner failure code and safe step without private payload', async () => {
    const { executor, metadata } = readinessFixture();
    metadata.mockRejectedValue(Object.assign(new Error('PRIVATE-NATIVE-STDERR'), { code: 'stale_input',
      stderr: 'PRIVATE-NATIVE-STDERR', token: 'PRIVATE-TOKEN' }));
    const result = await executor.execute('projects.readiness.read', {
      serverId: 'home', machineId: 'controller', projectId: 'project',
      environments: [{ environmentId: 'production', expectedRevision: 2 }],
    }, { surface: 'cli', serverId: 'home', runtimeAccountId: 'account' });
    expect(result).toMatchObject({ ok: false, errorCode: 'home_unreachable', error: 'home_unreachable',
      details: { step: 'readiness', code: 'home_unreachable' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');
  });
  it('reports recorded current-source verification without opening the repository or acquiring secrets', async () => {
    const backup: DeploymentBackupConfigurationV1 = { configRevision: 2,
      destinationRef: { pluginId: 'example.storage', localId: 's3' }, occurrenceId: 'storage', config: {}, credentialBindings: [],
      sources: [{ kind: 'dump', sourceId: 'main', service: 'db', consistency: 'logical' },
        { kind: 'dump', sourceId: 'analytics', service: 'analytics', consistency: 'logical' }],
      ownership: { environmentId: 'production', prefix: 'production' }, retention: { kind: 'keepEverything' } };
    const snapshot = { snapshotId: 'a'.repeat(64), treeId: 'b'.repeat(64), hostname: 'backup-host',
      time: '2026-11-04T09:00:00Z', paths: ['/db.dump'], tags: [] };
    const { credentialedExecutor: executor, detail, operations, nativeReads } = readinessFixture();
    detail.content.backup = backup;
    const input = { serverId: 'home', machineId: 'controller', projectId: 'project', environments: [{ environmentId: 'production',
      expectedRevision: 2, backups: { serverId: 'home', machineId: 'controller', installationId: 'installation', targetLinkId: 'link',
        deploymentId: 'deployment', environmentId: 'production', expectedRevision: 2, configRevision: 2 } }] };
    const context = { surface: 'cli', serverId: 'home', runtimeAccountId: 'account' } as const;
    expect(await executor.execute('projects.readiness.read', input, context)).toMatchObject({ ok: true, result: { facts:
      expect.arrayContaining([expect.objectContaining({ kind: 'backups', status: 'actionNeeded', reason: 'no_verified_backup_yet',
        backups: expect.objectContaining({ history: { entries: [] } }) })]) } });
    const target = input.environments[0]!.backups;
    const record = (operationId: string, actionId: string, authoredInput: unknown, result: unknown) => {
      operations.store.create({ operationId, actionId, scope: { accountId: 'account', machineId: 'controller' },
        title: operationId, cancellation: 'unsupported', inputIdentity: JSON.stringify(authoredInput) });
      return operations.store.succeed(operationId, result)!;
    };
    const manifests = backup.sources.map((source, index) => DeploymentBackupManifestV1Schema.parse({
      schemaVersion: 1, environmentId: 'production', sourceId: source.sourceId, kind: 'dump', configRevision: 2,
      repositoryId: 'c'.repeat(64), snapshot: { ...snapshot, snapshotId: (index ? 'd' : 'a').repeat(64) },
      totalBytesProcessed: 1, totalFilesProcessed: 1, producerChecksumSha256: 'e'.repeat(64),
    }));
    const capture = record('capture', 'deployments.backups.run', target,
      DeploymentBackupRunResultV1Schema.parse({ kind: 'verified', operationId: 'capture', manifests }));
    const verify = (index: number) => {
      const snapshotId = manifests[index]!.snapshot.snapshotId;
      return record(`verify-${index}`, 'deployments.backups.verify', { ...target, backupOperationId: 'capture', snapshotId,
        level: 'manifestReadBack' }, DeploymentBackupVerifyResultV1Schema.parse({ kind: 'verified', operationId: `verify-${index}`,
        backupOperationId: 'capture', environmentId: 'production', configRevision: 2, repositoryId: 'c'.repeat(64),
        snapshotId, level: 'manifestReadBack', verified: true }));
    };
    verify(0);
    expect(await executor.execute('projects.readiness.read', input, context)).toMatchObject({ ok: true, result: { facts:
      expect.arrayContaining([expect.objectContaining({ kind: 'backups', status: 'actionNeeded', reason: 'backup_verification_required' })]) } });
    const verified = verify(1);
    expect(await executor.execute('projects.readiness.read', input, context)).toMatchObject({ ok: true, result: { facts:
      expect.arrayContaining([expect.objectContaining({ kind: 'backups', status: 'ready', reason: 'configured_sources_verified', backups: expect.objectContaining({
        lastSuccessfulBackup: { operationId: 'capture', completedAt: capture.settledAt, configRevision: 2,
          snapshotIds: manifests.map(manifest => manifest.snapshot.snapshotId) },
        lastVerification: { operationId: 'verify-1', completedAt: verified.settledAt, configRevision: 2,
          backupOperationId: 'capture', snapshotId: manifests[1]!.snapshot.snapshotId, level: 'manifestReadBack', result: 'verified' },
      }) })]) } });
    expect(nativeReads).toEqual([]);
  });
  it('shows failed backup attempts and pruned snapshots alongside the last verification from scoped receipts', async () => {
    const { executor, detail, operations, nativeReads } = readinessFixture();
    detail.content.backup = { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 's3' },
      occurrenceId: 'storage', config: {}, credentialBindings: [],
      sources: [{ kind: 'dump', sourceId: 'db', service: 'db', consistency: 'logical' }],
      ownership: { environmentId: 'production', prefix: 'production' }, retention: { kind: 'keepEverything' } };
    const target = { serverId: 'home', machineId: 'controller', installationId: 'installation', targetLinkId: 'link',
      deploymentId: 'deployment', environmentId: 'production', expectedRevision: 2, configRevision: 1 };
    const record = (operationId: string, actionId: string, input: unknown) => operations.store.create({
      operationId, actionId, scope: { accountId: 'account', machineId: 'controller' }, title: operationId,
      cancellation: 'unsupported', inputIdentity: JSON.stringify(input),
    });
    record('failed-backup', 'deployments.backups.run', target);
    operations.store.fail('failed-backup', { errorCode: 'backup_failed', error: 'private-native-message' },
      { step: 'backup', privateValue: 'private-native-output' });
    record('prune', 'deployments.backups.prune', { ...target, retention: { kind: 'keep', last: 1 } });
    operations.store.succeed('prune', { kind: 'pruned', environmentId: 'production', configRevision: 1,
      forgottenSnapshotIds: ['a'.repeat(64)] });
    record('verification', 'deployments.backups.verify', { ...target, backupOperationId: 'capture',
      snapshotId: 'b'.repeat(64), level: 'repositoryCheck' });
    operations.store.succeed('verification', DeploymentBackupVerifyResultV1Schema.parse({ kind: 'verified',
      operationId: 'verification', backupOperationId: 'capture', environmentId: 'production', configRevision: 1,
      repositoryId: 'c'.repeat(64), snapshotId: 'b'.repeat(64), level: 'repositoryCheck', verified: true }));
    record('partial-prune', 'deployments.backups.prune', { ...target, retention: { kind: 'keep', last: 1 } });
    operations.store.fail('partial-prune', { errorCode: 'backup_failed', error: 'private-native-message' },
      { step: 'prune', code: 'backup_failed', removedSnapshotIds: ['d'.repeat(64)], uncertainSnapshotIds: [],
        privateValue: 'private-native-output' });
    const result = await executor.execute('projects.readiness.read', {
      serverId: 'home', machineId: 'controller', projectId: 'project',
      environments: [{ environmentId: 'production', expectedRevision: 2, backups: target }],
    }, { surface: 'agent', serverId: 'home', runtimeAccountId: 'account' });
    expect(result).toMatchObject({ ok: true, result: { facts: expect.arrayContaining([
      expect.objectContaining({ kind: 'backups', backups: expect.objectContaining({ history: { entries: [
        expect.objectContaining({ operationId: 'partial-prune', action: 'prune', state: 'failed', snapshotIds: ['d'.repeat(64)] }),
        expect.objectContaining({ operationId: 'verification', action: 'verify', state: 'succeeded', snapshotIds: ['b'.repeat(64)] }),
        expect.objectContaining({ operationId: 'prune', action: 'prune', state: 'succeeded', snapshotIds: ['a'.repeat(64)] }),
        expect.objectContaining({ operationId: 'failed-backup', action: 'backup', state: 'failed', code: 'backup_failed', step: 'backup' }),
      ] }, lastVerification: expect.objectContaining({ operationId: 'verification', result: 'verified' }) }) }),
    ]) } });
    expect(JSON.stringify(result)).not.toContain('private-native');
    expect(nativeReads).toEqual([]);
  });
  it('reports remote backup receipts unavailable without inventing an empty local history', async () => {
    const { credentialedExecutor: executor, detail, nativeReads } = readinessFixture();
    detail.content.backup = { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 's3' },
      occurrenceId: 'storage', config: {}, credentialBindings: [],
      sources: [{ kind: 'dump', sourceId: 'main', service: 'db', consistency: 'logical' }],
      ownership: { environmentId: 'production', prefix: 'production' }, retention: { kind: 'keepEverything' } };
    expect(await executor.execute('projects.readiness.read', {
      serverId: 'home', machineId: 'controller', projectId: 'project', environments: [{ environmentId: 'production',
        expectedRevision: 2, backups: { serverId: 'home', machineId: 'another-target', installationId: 'installation',
          targetLinkId: 'link', deploymentId: 'deployment', environmentId: 'production', expectedRevision: 2, configRevision: 1 } }],
    }, { surface: 'ui', serverId: 'home', runtimeAccountId: 'account' })).toMatchObject({ ok: true, result: { facts:
      expect.arrayContaining([expect.objectContaining({ kind: 'backups', status: 'unavailable', reason: 'service_operation_unavailable' })]) } });
    expect(nativeReads).toEqual([]);
  });
  it.each([
    ['membership', 'target_mismatch'], ['revision', 'stale_input'], ['access', 'deployment_access_denied'],
  ] as const)('does not contact selected native targets when the Environment owner refuses %s', async (refusal, code) => {
    const { executor, detail, nativeReads } = readinessFixture();
    if (refusal === 'membership') detail.environment.projectSourceId = 'another-project';
    else if (refusal === 'revision') detail.environment.revision = 1;
    else detail.environment.capabilities.read = false;
    expect(await executor.execute('projects.readiness.read', {
      serverId: 'home', machineId: 'controller', projectId: 'project',
      environments: [{ environmentId: 'production', expectedRevision: 2,
        health: { serverId: 'home', environmentId: 'production', deploymentId: 'deployment', targetLinkId: 'link',
          machineId: 'native', installationId: 'installation', service: { kind: 'deployment', environmentId: 'production',
            machineId: 'native', environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } },
        backups: { serverId: 'home', environmentId: 'production', expectedRevision: 2, configRevision: 1,
          machineId: 'native', installationId: 'installation', targetLinkId: 'link', deploymentId: 'deployment' } }],
    }, { surface: 'cli', serverId: 'home', runtimeAccountId: 'account' }))
      .toMatchObject({ ok: false, errorCode: code, details: { step: 'readiness', code } });
    expect(nativeReads).toEqual([]);
  });
  it('reads an exact Environment once through the credentialed host factory and discloses missing owners', async () => {
    const { credentialedExecutor: executor, detail, metadataReads } = readinessFixture();
    detail.content.backup = { notNeeded: true };
    const result = await executor.execute('projects.readiness.read', {
      serverId: 'home', machineId: 'controller', projectId: 'project',
      environments: [{ environmentId: 'production', expectedRevision: 2 }],
    }, { surface: 'ui', serverId: 'home', runtimeAccountId: 'account' });
    expect(result).toMatchObject({ ok: true, result: { status: 'unavailable', facts: expect.arrayContaining([
      { kind: 'backups', owner: 'deploymentBackups', environmentId: 'production', status: 'ready', reason: 'notNeeded' },
      expect.objectContaining({ kind: 'ci', status: 'unavailable', reason: 'ci_source_projection_unavailable' }),
      expect.objectContaining({ kind: 'secrets', environmentId: 'production', status: 'unavailable', reason: 'secret_scope_projection_unavailable' }),
    ]) } });
    expect(metadataReads()).toBe(1);
  });

  it('omits backups for an owner-confirmed Environment without durable data and rejects cross-Environment selectors', async () => {
    const { executor, detail } = readinessFixture();
    delete detail.content.template!.data;
    const input = { serverId: 'home', machineId: 'controller', projectId: 'project',
      environments: [{ environmentId: 'production', expectedRevision: 2 }] };
    const context = { surface: 'cli', serverId: 'home', runtimeAccountId: 'account' } as const;
    const result = await executor.execute('projects.readiness.read', input, context);
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toMatchObject({ result: { facts: expect.arrayContaining([expect.objectContaining({ kind: 'backups' })]) } });
    const refused = await executor.execute('projects.readiness.read', { ...input, environments: [{ ...input.environments[0],
      backups: { serverId: 'home', machineId: 'native-target', installationId: 'installation', targetLinkId: 'link',
        deploymentId: 'deployment', environmentId: 'another-environment', expectedRevision: 2, configRevision: 1 },
    }] }, context);
    expect(refused).toMatchObject({ ok: false });
  });
});
