import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const router = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => router.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const uploadBoundary = vi.hoisted(() => ({ pick: vi.fn(), rpc: vi.fn() }));
// Device selection and encrypted Machine RPC are the two external upload boundaries.
vi.mock('expo-document-picker', () => ({ getDocumentAsync: uploadBoundary.pick }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
  callGuardedMachineRpcWithPolicy: uploadBoundary.rpc,
}));
const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { HappyError } = await import('@/utils/errors/errors');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');

const snapshotId = 'c'.repeat(64);
const safetyId = 'e'.repeat(64);
const shown = { mounted: true, visible: true, focused: true };
const settings = 'project-deployments.environment.settings.backups';

function manifest(environmentId: string, id: string, time: string) {
  return {
    schemaVersion: 1,
    environmentId,
    sourceId: 'database',
    kind: 'dump',
    configRevision: 1,
    repositoryId: 'a'.repeat(64),
    producerChecksumSha256: 'b'.repeat(64),
    totalBytesProcessed: 42,
    totalFilesProcessed: 1,
    snapshot: {
      snapshotId: id,
      treeId: 'd'.repeat(64),
      hostname: 'runtime',
      time,
      paths: ['dump'],
      tags: [],
    },
  };
}

type Answer = (
  input: Record<string, unknown>,
) =>
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; details?: unknown }>;

/** Settings → Backups of an Environment whose serving deploy kept a pre-migration backup; only the HTTP boundary is answered. */
async function renderRestore(answer: Answer) {
  const homeId = `srv_${'a'.repeat(32)}`;
  const serverId = await homes.addHome({
    name: 'Restore',
    serverUrl: 'https://restore-backup.test',
    serverIdentityId: homeId,
    accountId: 'account-owner',
    currentAccount: true,
  });
  const account = await captureLazyActionAccountContext(serverId);
  const scope = {
    serverId,
    accountId: 'account-owner',
    projectSourceId: 'source-app',
  };
  const detail = createDeploymentEnvironmentDetailV1({
    environment: createDeploymentEnvironmentHeaderV1({
      serverId: homeId,
      revision: 7,
    }),
  });
  const environmentId = detail.environment.id;
  const backupConfiguration = {
    configRevision: 1,
    destinationRef: {
      pluginId: 'happier.backup.destinations',
      localId: 'open',
    },
    occurrenceId: 'destination',
    config: {},
    credentialBindings: [],
    sources: [
      {
        kind: 'dump',
        sourceId: 'database',
        service: 'postgres',
        consistency: 'logical',
      },
    ],
    ownership: { environmentId, prefix: 'app' },
    retention: { kind: 'keepEverything' },
  };
  const base = createDeploymentReceiptDetailV1();
  const content = DeploymentOwnServerContentV1Schema.parse({
    ...base.content,
    ownServer: {
      approvedInputBasis: {
        v: 1, environmentId, environmentRevision: 1, targetLinkId: base.deployment.targetLinkId,
        targetLinkRevision: 1, sourceIntent: base.content.sourceIntent, manifestFingerprint: 'manifest',
        configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1', services: ['app'], profiles: [],
        members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [], images: [],
        ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true, migration: { service: 'app', argv: ['migrate'] },
          migrationFailurePolicy: 'ask', backupBeforeMigration: true },
      },
      preMigrationBackup: {
        sourceFormat: 'postgresCustom',
        target: {
          service: 'postgres',
          adapter: 'postgres-v1',
          database: 'shop',
        },
        repository: { repository: 's3:https://backup.test/bucket' },
        configuration: backupConfiguration,
        source: manifest(environmentId, snapshotId, '2026-11-01T12:00:00Z'),
      },
    },
  });
  const receipt = createDeploymentReceiptDetailV1({
    deployment: base.deployment,
    content,
  });
  const withBackup = {
    ...detail,
    content: { ...detail.content, backup: backupConfiguration },
  };
  const controller = createDeploymentReadControllerV1({
    scope: { ...scope, serverId: homeId },
    transport: {
      listEnvironments: async () => ({
        ok: true,
        value: { items: [], nextCursor: null },
      }),
      readEnvironment: async () => ({
        ok: true,
        value: withBackup as typeof detail,
      }),
      listHistory: async () => ({
        ok: true,
        value: { ok: true, items: [receipt.deployment], nextCursor: null },
      }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    },
  });
  const observed: Record<string, unknown>[] = [];
  // The Action transport is the boundary: published schemas parse both directions; native composition
  // and retained-operation behavior are exercised by the CLI public restore tests.
  const restore = async (input: unknown) => {
    const parsed = DeploymentActionInputSchemasV1['deployments.backups.restore'].parse({ ...(input as object), serverId: 'home' });
    observed.push(parsed as Record<string, unknown>);
    const outcome = answer(parsed as Record<string, unknown>);
    if (!outcome.ok) throw new HappyError(outcome.errorCode, false, { code: outcome.errorCode, details: outcome.details });
    return DeploymentActionOutputSchemasV1['deployments.backups.restore'].parse(outcome.result);
  };
  const { ModalProvider } = await import('@/modal');
  const screen = await renderScreen(
    <ModalProvider>
    <DeploymentEnvironmentDetail
      controller={controller}
      lifetime={account.accountLifetime}
      environmentId={environmentId}
      demand={shown}
      accountId={scope.accountId}
      serverId={serverId}
      phone={false}
      deploy={null}
      review={{ pendingId: null, request() {}, open() {} }}
      onOpenReceipt={() => {}}
      destination={{ tab: 'settings', section: null }}
      restore={restore}
    />
    </ModalProvider>,
  );
  const until = async (testID: string) =>
    act(async () => {
      await Promise.race([
        waitForTestEvent(
          screen.subscribe,
          () => screen.findByTestId(testID),
          (node) => node !== null,
        ),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    });
  return {
    screen,
    observed,
    until,
    environmentId,
    dispose: () => { controller.retire(); account.dispose(); },
  };
}

const prepared = (environmentId: string, withSafety: boolean) => ({
  kind: 'prepared',
  operationId: 'prepare-op-1',
  evidence: {
    input: {},
    native: {
      prepared: {
        kind: 'prepared',
        operationId: 'prepare-op-1',
        source: manifest(environmentId, snapshotId, '2026-11-01T12:00:00Z'),
        sourceFormat: 'postgresCustom',
        destination: {
          service: 'postgres',
          adapter: 'postgres-v1',
          database: 'shop',
          environmentId,
          revision: 1,
          stagingDatabase: 'shop_staging',
          recoveryDatabase: 'shop_recovery',
          databaseExists: true,
          hasMeaningfulData: withSafety,
          writerServices: ['app'],
        },
        repository: { repository: 's3:https://backup.test/bucket' },
        ...(withSafety
          ? {
              safetyBackup: {
                kind: 'verified',
                manifests: [
                  manifest(environmentId, safetyId, '2026-11-02T09:30:00Z'),
                ],
              },
            }
          : {}),
      },
      configuration: {
        configRevision: 1,
        destinationRef: {
          pluginId: 'happier.backup.destinations',
          localId: 'open',
        },
        occurrenceId: 'destination',
        config: {},
        credentialBindings: [],
        sources: [
          {
            kind: 'dump',
            sourceId: 'database',
            service: 'postgres',
            consistency: 'logical',
          },
        ],
        ownership: { environmentId, prefix: 'app' },
        retention: { kind: 'keepEverything' },
      },
    },
  },
});

describe('Environment → Settings → Backups: restore a backup (L3B)', () => {
  beforeEach(() => homes.reset());
  afterEach(async () => {
    const { Modal } = await import('@/modal');
    Modal.hideAll();
    standardCleanup();
  });

  it('uploads a local backup through encrypted finite transfer before checking its opaque source', async () => {
    const bytes = new TextEncoder().encode('PGDMP-local-backup');
    const file = Object.assign(new Blob([bytes]), { name: 'backup.dump', lastModified: 0, webkitRelativePath: '' });
    uploadBoundary.pick.mockResolvedValue({ canceled: false, assets: [{ file }] });
    const recipient = createTransferRecipientKeyPair();
    const uploaded: number[] = [];
    const methods: string[] = [];
    uploadBoundary.rpc.mockImplementation(async (request: { method: string; payload: Record<string, unknown> }) => {
      methods.push(request.method);
      if (request.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
        expect(request.payload).toMatchObject({ t: 'deployment_restore_upload_v1', sizeBytes: bytes.length });
        expect(request.payload).not.toHaveProperty('path');
        return { success: true, uploadId: 'upload-backup', chunkSizeBytes: 4,
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
      }
      if (request.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK) {
        const chunk = request.payload;
        uploaded.push(...await decryptEncryptedTransferChunkEnvelope({ transferId: String(chunk.uploadId),
          sequence: Number(chunk.index), payloadBase64: String(chunk.payloadBase64),
          encryptedDataKeyEnvelopeBase64: String(chunk.encryptedDataKeyEnvelopeBase64),
          recipientSecretKeySeed: recipient.recipientSecretKeySeed }));
        return { success: true };
      }
      if (request.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) return {
        success: true, transferId: 'retained-upload', sizeBytes: bytes.length, sha256: 'f'.repeat(64),
      };
      throw new Error(`Unexpected Machine upload method: ${request.method}`);
    });
    const view = await renderRestore(input => {
      if (input.mode !== 'prepare') return { ok: true, result: { kind: 'restored', verified: true, nextAction: 'none', evidence: {} } };
      const result = prepared(String(input.environmentId), true);
      const { repository: _repository, ...native } = result.evidence.native.prepared;
      return { ok: true, result: { ...result, evidence: { input: {}, native: { prepared: { ...native,
        source: { kind: 'upload', transferId: 'retained-upload', sizeBytes: bytes.length, sha256: 'f'.repeat(64) },
      } } } } };
    });
    try {
      await view.until(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync(`${settings}.restore.open`);
      await view.until('project-deployments.restore.upload');
      await view.screen.pressByTestIdAsync('project-deployments.restore.upload');
      await view.until('project-deployments.restore.uploaded');
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      await view.until('project-deployments.restore.confirm');
      expect(view.observed[0]).toMatchObject({ source: { kind: 'upload', transferId: 'retained-upload' },
        destination: { kind: 'database', service: 'postgres', database: 'shop' } });
      expect(uploaded).toEqual([...bytes]);
      expect(methods).not.toContain(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT);
      expect(JSON.stringify(view.observed)).not.toContain('backup.dump');
      await view.screen.pressByTestIdAsync('project-deployments.restore.confirm');
      await view.until('project-deployments.restore.result.restored');
      expect(view.observed[1]).toMatchObject({ source: view.observed[0]!.source,
        destination: view.observed[0]!.destination, prepareOperationId: 'prepare-op-1' });
    } finally { view.dispose(); }
  });

  it('reviews the SQLite destination path through the shared restore preparation owner', async () => {
    const view = await renderRestore(input => {
      const result = prepared(String(input.environmentId), true);
      return { ok: true, result: { ...result, evidence: { ...result.evidence, native: {
        ...result.evidence.native, prepared: { ...result.evidence.native.prepared, sourceFormat: 'sqlite',
          destination: { adapter: 'sqlite-v1', service: 'embedded', path: '/data/shop.sqlite',
            environmentId: input.environmentId, revision: 1, stagingVolume: 'shop_restore',
            hasMeaningfulData: true, writerServices: ['app'] },
        },
      } } } };
    });
    try {
      await view.until(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      await view.until('project-deployments.restore.confirm');
      expect(view.screen.getTextContent()).toContain('/data/shop.sqlite on embedded');
      expect(view.screen.findByTestId('project-deployments.restore.fact.volume')).toBeNull();
    } finally { view.dispose(); }
  });

  it('reviews the native named volume destination without relabeling it as a database', async () => {
    const view = await renderRestore(input => {
      const result = prepared(String(input.environmentId), true);
      return { ok: true, result: { ...result, evidence: { ...result.evidence, native: {
        ...result.evidence.native, prepared: { ...result.evidence.native.prepared,
          source: { ...result.evidence.native.prepared.source, kind: 'volume' }, sourceFormat: 'volume',
          destination: { adapter: 'volume-v1', service: 'app', volume: 'data', currentVolume: 'app_data',
            stagingVolume: 'app_data_restore', environmentId: input.environmentId, revision: 1,
            hasMeaningfulData: true, writerServices: ['app'], runningServices: ['app'] },
        },
      } } } };
    });
    try {
      await view.until(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      await view.until('project-deployments.restore.confirm');
      expect(view.screen.findByTestId('project-deployments.restore.fact.volume')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.restore.fact.database')).toBeNull();
    } finally { view.dispose(); }
  });

  it('explains native snapshot unavailability for a remote Engine while ordinary restore stays available', async () => {
    const view = await renderRestore(input => input.mode === 'prepare'
      ? { ok: true, result: { ...prepared(String(input.environmentId), true), evidence: {
          ...prepared(String(input.environmentId), true).evidence,
          snapshotUnavailable: { code: 'restore_snapshot_remote_engine' },
        } } }
      : { ok: true, result: { kind: 'restored', verified: true, nextAction: 'none', evidence: {} } });
    try {
      await view.until(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      await view.until('project-deployments.restore.confirm');
      expect(view.screen.findByTestId('project-deployments.restore.snapshotUnavailable')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.restore.snapshot')).toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.restore.confirm');
      await view.until('project-deployments.restore.result.restored');
      expect(view.observed[1]).not.toHaveProperty('snapshot');
    } finally { view.dispose(); }
  });

  it.each(['unknown', 'failed'] as const)('reviews native snapshot coverage and stops on %s until a fresh continue choice', async (kind) => {
    const offer = {
      managedId: 'managed-database', intentRevision: 1,
      controller: { machineId: 'controller', installationId: 'controller-installation' },
      resource: { contributionRef: { pluginId: 'happier.machine.digitalocean', localId: 'droplet' }, schemaVersion: 1, value: { id: 123 } },
      contribution: { pluginId: 'happier.machine.digitalocean', localId: 'droplet' },
      coverage: { rootDisk: true, attachedVolumes: false },
      cost: { kind: 'billed', source: 'https://docs.digitalocean.com/products/snapshots/details/pricing/' },
      consistency: 'running',
    };
    const view = await renderRestore(input => {
      if (input.mode === 'prepare') {
        const result = prepared(String(input.environmentId), true);
        return { ok: true, result: { ...result, evidence: { ...result.evidence, snapshot: offer } } };
      }
      return input.snapshot === false
        ? { ok: true, result: { kind: 'restored', verified: true, nextAction: 'none', evidence: {} } }
        : { ok: false, errorCode: 'restore_snapshot_not_confirmed', details: { snapshot: { kind, code: 'provider_unconfirmed' } } };
    });
    try {
      await view.until(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync(`${settings}.restore.open`);
      await view.until('project-deployments.restore.check');
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      await view.until('project-deployments.restore.snapshot');
      expect(view.screen.findByTestId('project-deployments.restore.fact.snapshotCoverage')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.restore.fact.snapshotCost')).not.toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.restore.confirm');
      await view.until('project-deployments.restore.snapshotStopped');
      expect(view.observed).toHaveLength(2);
      expect(view.observed[1]!.snapshot).not.toBe(false);
      expect(view.screen.findByTestId('project-deployments.restore.result.restored')).toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.restore.continueWithoutSnapshot');
      await view.until('project-deployments.restore.result.restored');
      expect(view.observed).toHaveLength(3);
      expect(view.observed[2]).toEqual({ ...view.observed[1], snapshot: false });
    } finally { view.dispose(); }
  });

  it('checks the kept backup first, then replaces data with exactly that check and says the code is unchanged', async () => {
    const view = await renderRestore((input) =>
      input.mode === 'prepare'
        ? { ok: true, result: prepared(String(input.environmentId), true) }
        : {
            ok: true,
            result: {
              kind: 'restored',
              verified: true,
              nextAction: 'none',
              evidence: {},
            },
          },
    );
    try {
      await view.until(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync(`${settings}.restore.open`);
      await view.until('project-deployments.restore');
      // Nothing runs until the person asks for the check.
      expect(view.observed).toHaveLength(0);
      expect(
        view.screen.findByTestId('project-deployments.restore.confirm'),
      ).toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      await view.until('project-deployments.restore.fact.safety');
      const operands = {
        environmentId: view.environmentId,
        expectedRevision: 7,
        machineId: 'machine-a',
        installationId: 'installation-a',
        targetLinkId: 'target-link',
        deploymentId: 'deployment-a',
        source: { kind: 'repository', snapshotId },
      };
      expect(view.observed[0]).toEqual({
        ...operands,
        serverId: expect.any(String),
        mode: 'prepare',
      });
      await view.screen.pressByTestIdAsync(
        'project-deployments.restore.confirm',
      );
      await view.until('project-deployments.restore.result.restored');
      // The confirm names the prepared operation and repeats the same operands.
      expect(view.observed).toHaveLength(2);
      expect(view.observed[1]).toEqual({
        ...operands,
        serverId: view.observed[0]!.serverId,
        mode: 'confirm',
        prepareOperationId: 'prepare-op-1',
      });
    } finally {
      view.dispose();
    }
  });

  it('shows the restore steps the owner reported once the restore settles', async () => {
    const view = await renderRestore((input) =>
      input.mode === 'prepare'
        ? { ok: true, result: prepared(String(input.environmentId), true) }
        : {
            ok: true,
            result: {
              kind: 'rolledBack',
              verified: false,
              nextAction: 'none',
              evidence: { code: 'restore_failed', nativeFailure: { exitCode: 1,
                stderr: 'pg_restore: native import failed [REDACTED]', stderrTruncated: false } },
              steps: [
                { id: 'safety', status: 'completed' },
                { id: 'stop', status: 'completed' },
                { id: 'restore', status: 'failed' },
                { id: 'start', status: 'completed' },
              ],
            },
          },
    );
    try {
      await view.until(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync(`${settings}.restore.open`);
      await view.until('project-deployments.restore.check');
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      await view.until('project-deployments.restore.confirm');
      // Before anything runs there are no steps to show.
      expect(view.screen.findByTestId('project-deployments.restore.steps')).toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.restore.confirm');
      await view.until('project-deployments.restore.result.rolledBack');
      expect(view.screen.getTextContent()).not.toContain('pg_restore: native import failed');
      await view.screen.pressByTestIdAsync('project-deployments.restore.result.rolledBack-details-toggle');
      expect(view.screen.getTextContent()).toContain('restore_failed');
      expect(view.screen.getTextContent()).toContain('pg_restore: native import failed [REDACTED]');
      expect(['safety', 'stop', 'restore', 'start'].map((id) =>
        view.screen.findByTestId(`project-deployments.restore.step.${id}`) !== null)).toEqual([true, true, true, true]);
      expect(view.screen.findByTestId('project-deployments.restore.step.health')).toBeNull();
    } finally {
      view.dispose();
    }
  });

  it('a check that is no longer current returns to Check backup instead of confirming it', async () => {
    const view = await renderRestore((input) =>
      input.mode === 'prepare'
        ? { ok: true, result: prepared(String(input.environmentId), false) }
        : { ok: false, errorCode: 'restore_prepare_required' },
    );
    try {
      await view.until(`${settings}.restore.open`);
      await view.screen.pressByTestIdAsync(`${settings}.restore.open`);
      await view.until('project-deployments.restore.check');
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      await view.until('project-deployments.restore.confirm');
      await view.screen.pressByTestIdAsync(
        'project-deployments.restore.confirm',
      );
      await view.until('project-deployments.restore.refused');
      expect(
        view.screen.findByTestId('project-deployments.restore.confirm'),
      ).toBeNull();
      expect(
        view.screen.findByTestId('project-deployments.restore.check'),
      ).not.toBeNull();
      expect(view.observed.map((input) => input.mode)).toEqual([
        'prepare',
        'confirm',
      ]);
    } finally {
      view.dispose();
    }
  });
});
