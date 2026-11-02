import { describe, expect, it } from 'vitest';
import * as owners from '../index.js';
import type { ResticRequestV1 } from '../backups/resticExecutor.js';
import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import { DeploymentBackupConfigurationV1Schema, DeploymentContentV1Schema, OwnServerDeploymentInputBasisV1Schema,
  createDeploymentReceiptArtifactHeaderV1, readDeploymentReceiptArtifactV1,
  type DeploymentPreMigrationBackupV1, type DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';

const environmentId = 'environment-a';
const snapshotId = 'a'.repeat(64), treeId = 'b'.repeat(64), repositoryId = 'c'.repeat(64), checksum = 'd'.repeat(64);
const configuration = { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 's3' },
  occurrenceId: 'storage', config: { bucket: 'recovery' },
  credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
  sources: [{ kind: 'dump', sourceId: 'main', service: 'db', consistency: 'logical' }],
  ownership: { environmentId, prefix: 'environment-a' }, retention: { kind: 'keepEverything' } };
const access = { repository: 's3:https://storage.invalid/recovery/environment-a', passwordFilePath: '/run/secrets/repository-password',
  credentialFiles: [{ hostPath: '/private/operation-password', containerPath: '/run/secrets/repository-password', readOnly: true }],
  environmentVariableNames: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] };
const snapshot = { id: snapshotId, tree: treeId, hostname: `happier-env-${environmentId}`, time: '2026-10-30T19:00:00Z',
  paths: ['/db.dump'], tags: ['happier', `env:${environmentId}`, 'kind:dump', 'src:main'] };

function nativeBoundary(options: Readonly<{ readBackChecksum?: string; producerExitCode?: number; unknownBackup?: boolean;
  truncatedBackup?: boolean; snapshotsExitCode?: number; missingProducer?: boolean; missingProducerChecksum?: boolean }> = {}) {
  const requests: ResticRequestV1[] = [];
  // Only native process IO is substituted. The parent, request builder and
  // restic evidence interpretation are real. This is not native P30 qualification.
  const execute = async (request: ResticRequestV1) => {
    requests.push(request);
    const result = (stdout: string) => ({ kind: 'completed' as const, exitCode: 0, stdout, stdoutTruncated: false });
    if (request.argv.includes('config')) return result(JSON.stringify({ id: repositoryId, version: 2 }));
    if (request.argv.includes('backup')) return options.unknownBackup ? { kind: 'outcome_unknown' as const }
      : { ...result([JSON.stringify({ message_type: 'status', percent_done: 0.5 }), JSON.stringify({ message_type: 'summary', snapshot_id: snapshotId,
        total_bytes_processed: 123, total_files_processed: 1 })].join('\n')), stdoutTruncated: options.truncatedBackup ?? false,
        producer: options.missingProducer ? undefined : { exitCode: options.producerExitCode ?? 0,
          checksumSha256: options.missingProducerChecksum ? undefined : checksum } };
    if (request.argv.includes('snapshots')) return { ...result(JSON.stringify([snapshot])), exitCode: options.snapshotsExitCode ?? 0 };
    if (request.argv.includes('tree')) return result(JSON.stringify({ nodes: [{ name: 'db.dump', type: 'file', size: 123,
      content: ['e'.repeat(64)] }] }));
    if (request.argv.includes('dump')) return { ...result(''), stdoutChecksumSha256: options.readBackChecksum ?? checksum, stdoutBytes: 123 };
    throw new Error('Unexpected native command');
  };
  // This OS-boundary fixture deliberately emits malformed producer metadata in negative cases.
  return { execute: execute as owners.DeploymentBackupRunInputV1['execute'], requests };
}

type CapturedData = NonNullable<NonNullable<DeploymentEnvironmentContentV1['template']>['data']>;
const data: CapturedData = { engine: 'postgres', service: 'db', logicalBackup: { adapter: 'postgres-v1', database: 'DATABASE_NAME' } };
async function run(native: ReturnType<typeof nativeBoundary>, signal = new AbortController().signal,
  capturedData: CapturedData | null = data): Promise<unknown> {
  const run = Reflect.get(owners, 'runDeploymentBackupV1');
  expect(run, 'The actual backup parent must consume native requests and read-back results').toBeTypeOf('function');
  return run({ environmentId, configuration, ...(capturedData ? { data: capturedData } : {}), access, execute: native.execute, signal });
}

describe('backup Action parent', () => {
  it('returns the exact manifest only after selected-repository snapshot, tree and payload read-back', async () => {
    const native = nativeBoundary();
    expect(await run(native)).toMatchObject({ kind: 'verified', manifests: [{ environmentId, sourceId: 'main', configRevision: 1,
      repositoryId, snapshot: { snapshotId, treeId }, producerChecksumSha256: checksum }] });
    const commands = native.requests.map(request => request.argv);
    expect(commands.find(argv => argv.includes('snapshots'))).toContain(snapshotId);
    expect(commands.find(argv => argv.includes('tree'))).toContain(treeId);
    expect(commands.at(-1)).toContain('dump');
    expect(native.requests.every(request => request.runtime === owners.RESTIC_RUNTIME_V1)).toBe(true);
    expect(JSON.stringify(commands)).not.toContain('/private/operation-password');
  });

  it('retains the real snapshot as recovery evidence when payload read-back does not match', async () => {
    await expect(run(nativeBoundary({ readBackChecksum: 'f'.repeat(64) }))).rejects.toMatchObject({ code: 'backup_integrity_failed',
      details: { manifests: [{ snapshot: { snapshotId } }] } });
  });

  it('retains the created snapshot identity even when inventory read-back fails before a manifest exists', async () => {
    await expect(run(nativeBoundary({ snapshotsExitCode: 7 }))).rejects.toMatchObject({ code: 'backup_failed',
      details: { snapshots: [{ environmentId, sourceId: 'main', configRevision: 1, repositoryId, snapshotId }] } });
  });

  it('never turns producer failure or unknown native settlement into a verified backup', async () => {
    const failed = nativeBoundary({ producerExitCode: 7 });
    await expect(run(failed)).rejects.toMatchObject({ code: 'backup_failed' });
    expect(failed.requests.some(request => request.argv.includes('dump'))).toBe(false);
    await expect(run(nativeBoundary({ missingProducer: true }))).rejects.toMatchObject({ code: 'backup_failed' });
    await expect(run(nativeBoundary({ missingProducerChecksum: true }))).rejects.toMatchObject({ code: 'outcome_unknown' });
    const unknown = nativeBoundary({ unknownBackup: true });
    await expect(run(unknown)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(unknown.requests.some(request => request.argv.includes('snapshots'))).toBe(false);
    const truncated = nativeBoundary({ truncatedBackup: true });
    await expect(run(truncated)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(truncated.requests.some(request => request.argv.includes('snapshots'))).toBe(false);
  });

  it('honors local cancellation before any native effect without another authority query', async () => {
    const native = nativeBoundary();
    const controller = new AbortController(); controller.abort();
    await expect(run(native, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(native.requests).toEqual([]);
  });

  it('never infers an undeclared dump adapter or treats SQLite owned-file backup as a stdout producer', async () => {
    for (const capturedData of [null, { engine: 'sqlite', service: 'db', logicalBackup: { adapter: 'sqlite-v1', path: '/data/app.sqlite' } }] as const) {
      const native = nativeBoundary();
      await expect(run(native, undefined, capturedData)).rejects.toMatchObject({ code: 'unsupported_action' });
      expect(native.requests).toEqual([]);
    }
  });
});

const destination = { environmentId, revision: 7, service: 'db', adapter: 'postgres-v1' as const,
  database: 'actual database', stagingDatabase: 'restore-stage', recoveryDatabase: 'restore-recovery',
  databaseExists: true, hasMeaningfulData: true, writerServices: ['app'] };

async function completedPreMigrationReceipt(options: Parameters<typeof nativeBoundary>[0] = {}, writeFailure?: Error) {
  const initial = createDeploymentReceiptDetailV1();
  const basis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1, environmentId, environmentRevision: 1,
    targetLinkId: initial.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: initial.content.sourceIntent,
    manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.39.4',
    services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
    bindings: [], images: initial.content.images, health: [{ service: 'app', participates: false }] });
  let receipt: DeploymentReceiptDetailV1 = createDeploymentReceiptDetailV1({
    deployment: createDeploymentReceiptHeaderV1({ environmentId }),
    content: { ...initial.content, ownServer: { approvedInputBasis: basis } },
  });
  let written = false;
  const native = nativeBoundary(options);
  const result = await owners.runDeploymentBackupV1({ environmentId,
    configuration: DeploymentBackupConfigurationV1Schema.parse(configuration), data,
    access: { ...access, credentialFiles: [{ ...access.credentialFiles[0]!, readOnly: true }],
      environmentVariableNames: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] },
    execute: native.execute, signal: new AbortController().signal,
    preMigrationBackup: { sourceFormat: 'postgresCustom',
      target: { service: destination.service, adapter: destination.adapter, database: destination.database },
      async writeCapture(capture: DeploymentPreMigrationBackupV1) {
        if (writeFailure) throw writeFailure;
        const content = { ...receipt.content, ownServer: { approvedInputBasis: basis, preMigrationBackup: capture } };
        const header = { ...receipt.deployment, contentBodyVersion: receipt.deployment.contentBodyVersion + 1 };
        // Substitute only Artifact persistence; use the real writer projection,
        // serialization and strict reader that the existing CAS publishes.
        const opened = readDeploymentReceiptArtifactV1(header, { artifactId: header.contentArtifactId,
          revision: { headerVersion: header.contentHeaderVersion, bodyVersion: header.contentBodyVersion },
          header: createDeploymentReceiptArtifactHeaderV1('Pre-migration recovery', content), body: JSON.stringify(content) });
        if (!opened.ok) throw new Error(opened.error);
        receipt = { ...receipt, deployment: header, content: opened.content };
        written = true;
      },
    },
  });
  expect(written, 'Verified backup completion must retain its exact capture in the receipt').toBe(true);
  return { receipt, result };
}

describe('pre-migration receipt capture and ID-only restore admission', () => {
  it('round-trips the completed backup through the receipt and resolves its exact capture once without IO', async () => {
    const { receipt, result } = await completedPreMigrationReceipt();
    const capture = receipt.content.ownServer?.preMigrationBackup;
    expect(capture).toEqual({ source: result.manifests[0], sourceFormat: 'postgresCustom',
      target: { service: 'db', adapter: 'postgres-v1', database: destination.database }, configuration,
      repository: { repository: access.repository } });
    expect(owners.resolveDeploymentRestoreCaptureV1({ environmentId, restoreBackupId: snapshotId, receipt, destination }))
      .toEqual({ kind: 'resolved', capture: { source: result.manifests[0], sourceFormat: 'postgresCustom',
        destination, configuration, repository: { repository: access.repository } } });
    expect(JSON.stringify(capture)).not.toContain('passwordFilePath');
    expect(JSON.stringify(capture)).not.toContain('/private/operation-password');
    expect(DeploymentContentV1Schema.safeParse({ ...receipt.content, ownServer: { ...receipt.content.ownServer,
      preMigrationBackup: { ...capture, passwordFilePath: access.passwordFilePath } } }).success).toBe(false);
  });

  it.each(['unknown', 'other-environment', 'foreign', 'changed-target', 'no-backup'] as const)
  ('refuses %s backup selection before credential acquisition or native execution', async kind => {
    const { receipt } = await completedPreMigrationReceipt();
    const source = receipt.content.ownServer!.preMigrationBackup!.source;
    const selected = kind === 'foreign' ? { ...receipt, content: { ...receipt.content, ownServer: { ...receipt.content.ownServer!,
      preMigrationBackup: { ...receipt.content.ownServer!.preMigrationBackup!, source: { ...source,
        snapshot: { ...source.snapshot, hostname: 'happier-env-foreign' } } } } } }
      : kind === 'other-environment' ? { ...receipt, deployment: { ...receipt.deployment, environmentId: 'other' } }
      : kind === 'no-backup' ? { ...receipt, content: { ...receipt.content,
        ownServer: { approvedInputBasis: receipt.content.ownServer!.approvedInputBasis } } } : receipt;
    expect(owners.resolveDeploymentRestoreCaptureV1({ environmentId,
      restoreBackupId: kind === 'unknown' ? 'f'.repeat(64) : snapshotId, receipt: selected,
      destination: kind === 'changed-target' ? { ...destination, database: 'another' } : destination }))
      .toEqual({ kind: 'refused', code: kind === 'other-environment' || kind === 'changed-target' ? 'stale_input' : 'backup_required' });
  });

  it('never records a failed backup as a pre-migration recovery capture', async () => {
    await expect(completedPreMigrationReceipt({ readBackChecksum: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'backup_integrity_failed' });
  });

  it('never reports verified completion when the receipt CAS refuses the capture', async () => {
    const conflict = Object.assign(new Error('Receipt changed'), { code: 'deployment_conflict' });
    await expect(completedPreMigrationReceipt({}, conflict)).rejects.toBe(conflict);
  });
});
