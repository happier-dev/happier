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
const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { HappyError } = await import('@/utils/errors/errors');

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
  | Readonly<{ ok: false; errorCode: string }>;

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
  // The restore Action's UI transport is not wired yet (the spec has no UI daemon ingress; see the lane report), so
  // the page's `restore` dependency is answered here at the Action result: the input is parsed by the published
  // schema, a refusal arrives as the typed HappyError the front door raises, and a result by its output schema.
  const restore = async (input: unknown) => {
    const parsed = DeploymentActionInputSchemasV1['deployments.backups.restore'].parse({ ...(input as object), serverId: 'home' });
    observed.push(parsed as Record<string, unknown>);
    const outcome = answer(parsed as Record<string, unknown>);
    if (!outcome.ok) throw new HappyError(outcome.errorCode, false, { code: outcome.errorCode });
    return DeploymentActionOutputSchemasV1['deployments.backups.restore'].parse(outcome.result);
  };
  const { ModalProvider } = await import('@/modal');
  const screen = await renderScreen(
    <ModalProvider>
    <DeploymentEnvironmentDetail
      controller={controller}
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
    dispose: () => controller.retire(),
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
  afterEach(standardCleanup);

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
        restoreBackupId: snapshotId,
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
