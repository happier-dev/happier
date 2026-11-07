import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import { DeploymentBackupActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
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
const routerMock = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routerMock.module);
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: vi.fn(async () => {
      throw new Error('controller_unavailable');
    }),
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);

// Only the Home's HTTP boundary is answered; the page's real Action front door, executor and parsers run.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { DeploymentDatabasePage } = await import('./DeploymentDatabasePage');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');
const { ModalProvider } = await import('@/modal');
const {
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  projectExternalActionDeploymentNativeEnvelopeAdmissionV1,
} = await import('@happier-dev/protocol/actions/externalActionApi');
const { computeExternalActionRequestEnvelopeDigestV1 } =
  await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
const { createPlainMachineRowFixture } =
  await import('@/dev/testkit/fixtures/machineFixtures');
const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
const { default: nacl } = await import('tweetnacl');

afterEach(async () => {
  actionOperationStore.reset();
  standardCleanup();
  await homes.reset();
});

const shown = { mounted: true, visible: true, focused: true };
const noReview = { pendingId: null, request: () => {}, open: () => {} };
const page = 'project-deployments.database';
const snapshotId = 'c'.repeat(64);

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

type Answers = Readonly<{
  history?: unknown;
}>;

/** A Postgres Environment opened on its Database page; the receipt keeps a pre-migration backup when asked. */
async function renderDatabase(
  input: Readonly<{
    answers?: Answers;
    database?: string;
    retainedBackup?: boolean;
    restore?: React.ComponentProps<typeof DeploymentDatabasePage>['restore'];
  }> = {},
) {
  const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
  const serverIdentityId = 'srv_database';
  const serverId = await homes.addHome({
    name: 'Database',
    serverUrl: 'https://database-page.test',
    serverIdentityId,
    accountId: 'account-owner',
    currentAccount: true,
  });
  const account = await captureLazyActionAccountContext(serverId);
  const machine = {
    ...createPlainMachineRowFixture({
      id: 'machine-a',
      accountId: 'account-owner',
    }),
    installationId: 'installation-a',
    installationPublicKey: encodeBase64(installation.publicKey),
  };
  homes.answer(serverId, '/v1/machines', { body: [machine] });
  homes.answer(serverId, 'GET /v1/machines/machine-a', { body: { machine } });
  const base = createDeploymentEnvironmentDetailV1();
  const environmentId = base.environment.id;
  const backup = {
    configRevision: 1,
    destinationRef: {
      pluginId: 'happier.backup.destinations',
      localId: 'open',
    },
    occurrenceId: 'nightly',
    config: {},
    credentialBindings: [],
    ownership: { environmentId, prefix: 'shop/' },
    sources: [
      {
        kind: 'dump' as const,
        sourceId: 'database',
        service: 'postgres',
        consistency: 'logical' as const,
      },
    ],
    retention: { kind: 'keepEverything' as const },
  };
  const detail = createDeploymentEnvironmentDetailV1({
    content: {
      ...base.content,
      backup,
      template: {
        templateRef: {
          sourceId: 'apps',
          itemId: 'postgres',
          version: '17',
          ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` },
        },
        definition: {
          kind: 'stored',
          contentRevision: 1,
          composeDigest: `sha256:${'b'.repeat(64)}`,
        },
        services: ['postgres'],
        data: {
          engine: 'postgres',
          version: '17',
          service: 'postgres',
          port: 5432,
        },
      },
    },
  });
  const plain = createDeploymentReceiptDetailV1();
  const receipt = input.retainedBackup
    ? createDeploymentReceiptDetailV1({
        deployment: plain.deployment,
        content: DeploymentOwnServerContentV1Schema.parse({
          ...plain.content,
          ownServer: {
            approvedInputBasis: {
              v: 1,
              environmentId,
              environmentRevision: 1,
              targetLinkId: plain.deployment.targetLinkId,
              targetLinkRevision: 1,
              sourceIntent: plain.content.sourceIntent,
              manifestFingerprint: 'manifest',
              configInputDigests: [],
              physicalProjectName: 'project',
              toolVersion: '2.40.1',
              services: ['app'],
              profiles: [],
              members: [
                { machineId: 'machine-a', installationId: 'installation-a' },
              ],
              bindings: [],
              images: [],
              ownServer: {
                rollout: 'recreate',
                autoRestorePreviousRelease: true,
                migration: { service: 'app', argv: ['migrate'] },
                migrationFailurePolicy: 'ask',
                backupBeforeMigration: true,
              },
            },
            preMigrationBackup: {
              sourceFormat: 'postgresCustom',
              target: {
                service: 'postgres',
                adapter: 'postgres-v1',
                database: 'shop',
              },
              repository: { repository: 's3:https://backup.test/bucket' },
              configuration: backup,
              source: manifest(
                environmentId,
                snapshotId,
                '2026-11-01T12:00:00Z',
              ),
            },
          },
        }),
      })
    : plain;

  const effects: Array<{ actionId: string; input: Record<string, unknown> }> =
    [];
  const respond = (
    actionId: string,
    envelope: { requestId: string },
    result: unknown,
  ) => ({
    body: ExternalActionResponseEnvelopeV1Schema.parse({
      v: 1,
      actionId,
      requestId: envelope.requestId,
      execution: { ok: true, result },
    }),
  });
  for (const actionId of [
    'deployments.backups.history',
    'deployments.backups.run',
  ] as const) {
    homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, {
      select: (body) => {
        const request =
          ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return {
          body: ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1,
            token: 'database-root',
            binding: {
              accountId: 'account-owner',
              authentication: { kind: 'account', tokenEpoch: 0 },
              serverIdentityId,
              machineId: machine.id,
              installationId: machine.installationId,
              custodianAccountId: 'account-owner',
              accountEncryptionMode: 'plain',
              actionId,
              requestId: request.envelope.requestId,
              target: request.envelope.target,
              requestEnvelopeDigest:
                computeExternalActionRequestEnvelopeDigestV1(request.envelope),
              environmentId,
              deploymentNativeAdmission:
                projectExternalActionDeploymentNativeEnvelopeAdmissionV1({
                  actionId,
                  envelope: request.envelope,
                }),
            },
          }),
        };
      },
    });
    homes.answer(serverId, `/v1/actions/${actionId}`, {
      select: (body) => {
        const authorized =
          ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(
          authorized.success ? authorized.data.envelope : body,
        );
        effects.push({
          actionId,
          input: envelope.input as Record<string, unknown>,
        });
        return respond(
          actionId,
          envelope,
          actionId === 'deployments.backups.run'
            ? {
                kind: 'verified',
                operationId: 'manual-backup',
                manifests: [
                  manifest(
                    environmentId,
                    'e'.repeat(64),
                    '2026-11-07T10:00:00Z',
                  ),
                ],
              }
            : (input.answers?.history ?? {
                kind: 'history',
                environmentId,
                configRevision: 1,
                history: { entries: [] },
              }),
        );
      },
    });
  }
  const controller = createDeploymentReadControllerV1({
    // The read controller is scoped to the Environment header's own Home id.
    scope: {
      serverId: detail.environment.serverId,
      accountId: 'account-owner',
      projectSourceId: 'source-app',
    },
    transport: {
      listEnvironments: async () => ({
        ok: true,
        value: { items: [], nextCursor: null },
      }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({
        ok: true,
        value: { ok: true, items: [receipt.deployment], nextCursor: null },
      }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    },
  });
  const navigate = vi.fn();
  const back = vi.fn();
  const screen = await renderScreen(
    <ModalProvider>
      <DeploymentDatabasePage
        controller={controller}
        environmentId={environmentId}
        database={input.database ?? 'postgres'}
        demand={shown}
        phone={false}
        lifetime={account.accountLifetime}
        review={noReview}
        restore={input.restore ?? null}
        onBack={back}
        onNavigate={navigate}
      />
    </ModalProvider>,
  );
  const settle = async (testID: string) => {
    await act(async () => {
      await Promise.race([
        waitForTestEvent(
          screen.subscribe,
          () => screen.findByTestId(testID),
          (node) => node !== null,
        ),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    });
    return screen.findByTestId(testID);
  };
  return {
    screen,
    settle,
    effects,
    environmentId,
    serverIdentityId,
    navigate,
    back,
    dispose: async () => {
      await screen.unmount();
      controller.retire();
      account.dispose();
    },
  };
}

describe('Environment → Data → Database page (P9)', () => {
  it('reads backup history once on open, shows it, and Back up now runs the same Action an agent uses', async () => {
    const view = await renderDatabase({
      answers: {
        history: {
          kind: 'history',
          environmentId: 'ignored',
          configRevision: 1,
          lastSuccessfulBackup: {
            operationId: 'nightly-2',
            completedAt: Date.parse('2026-11-05T03:04:00Z'),
            configRevision: 1,
            snapshotIds: ['f'.repeat(64)],
          },
          history: {
            entries: [
              {
                operationId: 'nightly-3',
                action: 'backup',
                state: 'failed',
                startedAt: 10,
                completedAt: 20,
                configRevision: 1,
                snapshotIds: [],
                code: 'backup_failed',
                step: 'dump',
              },
              {
                operationId: 'nightly-2',
                action: 'backup',
                state: 'succeeded',
                startedAt: 1,
                completedAt: 2,
                configRevision: 1,
                snapshotIds: ['f'.repeat(64)],
              },
            ],
          },
        },
      },
    });
    try {
      expect(await view.settle(`${page}.history.nightly-3`)).not.toBeNull();
      expect(
        view.screen.findByTestId(`${page}.history.nightly-2`),
      ).not.toBeNull();
      expect(view.screen.findByTestId(`${page}.status`)).not.toBeNull();
      expect(view.screen.getTextContent()).toContain('postgres:5432');
      // One history read per opening, sized to this target; the page never polls.
      expect(view.effects.filter((effect) => effect.actionId === 'deployments.backups.history')).toHaveLength(1);
      const history = view.effects.find((effect) => effect.actionId === 'deployments.backups.history')!.input;
      // The agent path is the same Action with the same published input.
      expect(DeploymentBackupActionInputSchemasV1['deployments.backups.history'].parse(history)).toEqual({
        serverId: view.serverIdentityId, environmentId: view.environmentId, expectedRevision: 1, configRevision: 1,
        machineId: 'machine-a', installationId: 'installation-a', targetLinkId: 'target-link', deploymentId: 'deployment-a',
      });
      await view.screen.pressByTestIdAsync(`${page}.controls.run`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(view.effects.find((effect) => effect.actionId === 'deployments.backups.run')?.input).toEqual(history);
    } finally {
      await view.dispose();
    }
  });

  it('says so when the database is no longer in the Environment and leads back to Overview', async () => {
    const view = await renderDatabase({ database: 'gone' });
    try {
      expect(await view.settle(`${page}.gone`)).not.toBeNull();
      expect(view.effects).toEqual([]);
    } finally {
      await view.dispose();
    }
  });

  it('restores the kept backup from the page and shows each step the running restore pushes', async () => {
    let releaseConfirm!: () => void;
    const confirmGate = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    const restore = vi.fn(
      async (
        input: Record<string, unknown>,
        operation?: { actionRequestId: string },
      ) => {
        if (input.mode === 'prepare') {
          return DeploymentActionOutputSchemasV1[
            'deployments.backups.restore'
          ].parse({
            kind: 'prepared',
            operationId: 'prepare-1',
            evidence: {
              input: {},
              native: {
                prepared: {
                  kind: 'prepared',
                  operationId: 'prepare-1',
                  source: manifest(
                    String(input.environmentId),
                    snapshotId,
                    '2026-11-01T12:00:00Z',
                  ),
                  sourceFormat: 'postgresCustom',
                  destination: {
                    service: 'postgres',
                    adapter: 'postgres-v1',
                    database: 'shop',
                    environmentId: input.environmentId,
                    revision: 1,
                    stagingDatabase: 'shop_staging',
                    recoveryDatabase: 'shop_recovery',
                    databaseExists: true,
                    hasMeaningfulData: false,
                    writerServices: ['app'],
                  },
                  repository: { repository: 's3:https://backup.test/bucket' },
                },
                configuration: {
                  configRevision: 1,
                  destinationRef: {
                    pluginId: 'happier.backup.destinations',
                    localId: 'open',
                  },
                  occurrenceId: 'nightly',
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
                  ownership: {
                    environmentId: input.environmentId,
                    prefix: 'shop/',
                  },
                  retention: { kind: 'keepEverything' },
                },
              },
            },
          });
        }
        // The native owner pushes its phase on the restore's own Action operation, named by the request id.
        const { ActionOperationSnapshotV1Schema } =
          await import('@happier-dev/protocol/actions/operations/v1');
        actionOperationStore.mergeSnapshots({
          serverId: 'home',
          snapshots: [
            ActionOperationSnapshotV1Schema.parse({
              version: 1,
              operationId: 'restore-op',
              revision: 2,
              actionId: 'deployments.backups.restore',
              state: 'running',
              scope: { accountId: 'account-owner', machineId: 'machine-a' },
              title: 'Restore',
              requestId: operation?.actionRequestId,
              createdAt: 1,
              startedAt: 2,
              progress: { kind: 'phase', phase: 'restore.stop.running', label: 'Stop writers' },
              cancellation: 'unsupported',
            }),
          ],
        });
        await confirmGate;
        return DeploymentActionOutputSchemasV1[
          'deployments.backups.restore'
        ].parse({
          kind: 'restored',
          verified: true,
          nextAction: 'none',
          evidence: {},
          steps: [
            { id: 'safety', status: 'skipped' },
            { id: 'stop', status: 'completed' },
            { id: 'restore', status: 'completed' },
            { id: 'start', status: 'completed' },
            { id: 'health', status: 'completed' },
          ],
        });
      },
    );
    const view = await renderDatabase({
      retainedBackup: true,
      restore: restore as never,
    });
    try {
      expect(await view.settle(`${page}.restore`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.restore`);
      expect(
        await view.settle('project-deployments.restore.check'),
      ).not.toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      expect(
        await view.settle('project-deployments.restore.confirm'),
      ).not.toBeNull();
      void view.screen.pressByTestIdAsync(
        'project-deployments.restore.confirm',
      );
      expect(
        await view.settle('project-deployments.restore.step.stop'),
      ).not.toBeNull();
      releaseConfirm();
      expect(
        await view.settle('project-deployments.restore.result.restored'),
      ).not.toBeNull();
      expect(
        view.screen.findByTestId('project-deployments.restore.step.health'),
      ).not.toBeNull();
      expect(restore.mock.calls.map(([input]) => input.mode)).toEqual([
        'prepare',
        'confirm',
      ]);
    } finally {
      releaseConfirm();
      await view.dispose();
    }
  });
});
