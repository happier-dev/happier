import * as React from 'react';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import { DeploymentBackupActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
  act,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/registries';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

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

afterEach(async () => {
  const { Modal } = await import('@/modal');
  Modal.hideAll();
  actionOperationStore.reset();
  await standardCleanup();
  await homes.reset();
});

const shown = { mounted: true, visible: true, focused: true };
const noReview = { pendingId: null, request: () => {}, open: () => {} };
const page = 'project-deployments.database';
let homeCount = 0;
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
    setBindings?: React.ComponentProps<typeof DeploymentDatabasePage>['setBindings'];
    /** The Environment shares the database on a private network (its saved export). */
    shared?: boolean;
  }> = {},
) {
  await homes.reset();
  // A fresh Home per case.
  const serverIdentityId = `srv_database_${++homeCount}`;
  const machineId = `machine-${homeCount}`;
  const serverId = await homes.addHome({
    name: 'Database',
    serverUrl: 'https://database-page.test',
    serverIdentityId,
    accountId: 'account-owner',
    currentAccount: true,
  });
  const account = await captureLazyActionAccountContext(serverId);
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
  const authored = createDeploymentEnvironmentDetailV1({
    content: {
      ...base.content,
      backup,
      ...(input.shared ? { ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: true, serviceExports: [
        { key: 'database', service: 'postgres', containerPort: 5432, scheme: 'postgres', exposure: 'privateNetwork' as const,
          privateNetwork: 'shop-net' },
      ] } } : {}),
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
  // Each case uses its own Home and Machine.
  const detail = { ...authored, targetLinks: authored.targetLinks.map((row) => ({ ...row, targetLink: { ...row.targetLink,
    ...('machines' in row.targetLink && Array.isArray(row.targetLink.machines) ? { machines: [machineId] } : {}),
    ...('members' in row.targetLink && Array.isArray(row.targetLink.members)
      ? { members: row.targetLink.members.map((member) => ({ ...member, machineId })) } : {}) } })) } as typeof authored;
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
                { machineId, installationId: 'installation-a' },
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
  for (const actionId of [
    'deployments.backups.history',
    'deployments.backups.run',
    'deployments.backups.inventory',
  ] as const) {
    await answerExternalActionAccountForHome(homes, serverId, {
      machineId,
      installationId: 'installation-a',
      actionId,
      tokenEpoch: 0,
      execute: (operand) => {
        effects.push({
          actionId,
          input: DeploymentBackupActionInputSchemasV1[actionId].parse(operand),
        });
        return actionId === 'deployments.backups.inventory'
            ? { kind: 'inventory', environmentId, configRevision: 1, repositoryId: 'a'.repeat(64), snapshots: [
              { snapshot: manifest(environmentId, snapshotId, '2026-11-01T12:00:00Z').snapshot,
                source: { sourceId: 'database', kind: 'dump' },
                verification: { kind: 'verified', backupOperationId: 'pre-migration', configRevision: 1 } },
              { snapshot: manifest(environmentId, 'f'.repeat(64), '2026-11-06T03:00:00Z').snapshot,
                source: { sourceId: 'database', kind: 'dump' },
                verification: { kind: 'verified', backupOperationId: 'nightly', configRevision: 1 } },
            ] }
            : actionId === 'deployments.backups.run'
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
              });
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
        value: { items: [
          { environment: detail.environment, title: 'Shop database' },
          { environment: createDeploymentEnvironmentHeaderV1({ id: 'environment-web', revision: 4 }), title: 'Shop web' },
        ], nextCursor: null },
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
        setBindings={input.setBindings ?? null}
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
    machineId,
    navigate,
    back,
    dispose: async () => {
      await screen.unmount();
      controller.retire();
      account.dispose();
    },
  };
}

describe('Environment → Data → Add (P10)', () => {
  it.each(['applied', 'template_service_conflict'] as const)('applies the reviewed database from the Add button through the confirmed Action front door (%s)', async outcome => {
    const { showDeploymentAddSheet } = await import('./DeploymentDatabasePage');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const serverUrl = `https://database-add-${outcome}.test`;
    const catalogUrl = `${serverUrl}/apps.json`;
    const sourceId = deriveMarketplaceSourceId(catalogUrl);
    const serverId = await homes.addHome({ name: 'Database Add', serverUrl, serverIdentityId: 'srv_database_add',
      accountId: 'account-owner', currentAccount: true });
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
      sources: [{ id: sourceId, title: 'Apps', url: catalogUrl, format: 'happier-catalog', kinds: ['app'], enabled: true, addedAt: 1 }],
      disabledSourceIds: [] } }] });
    for (const path of ['/v1/account/entity-rows/prompt-library', '/v1/account/entity-rows/prompt-library/registry-sources']) {
      homes.answer(serverId, path, { body: await (await catalog.handle(path))!.json() });
    }
    const bundled: unknown = JSON.parse(await readFile(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
    if (!bundled || typeof bundled !== 'object' || !('apps' in bundled) || !Array.isArray(bundled.apps)) throw new Error('Expected bundled catalog');
    const entry: unknown = bundled.apps.find((value: { itemId: string }) => value.itemId === 'postgresql');
    if (!entry || typeof entry !== 'object' || !('app' in entry)) throw new Error('Expected bundled PostgreSQL');
    const app = DeploymentTemplateV1Schema.parse(entry.app);
    homes.answer(serverId, '/apps.json', { body: { schemaVersion: 1, apps: [{ itemId: 'postgresql', app }] } });
    const account = await captureLazyActionAccountContext(serverId);
    const { storage } = await import('@/sync/domains/state/storage');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    storage.setState({ settingsScope: account.accountLifetime.scope, profileScope: account.accountLifetime.scope });
    storage.getState().activateProfileScope(account.accountLifetime.scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, runtimeTargetLink: createDeploymentTargetLinkHeaderV1(), memberVersions: {},
      content: { ...base.content, definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: 'services:\n  app:\n    image: app:1\n', profiles: [], services: ['app'], primaryService: 'app' } } };
    const link = detail.runtimeTargetLink;
    if (link.targetKind !== 'ownServer') throw new Error('Expected own server');
    const member = link.members[0]!;
    homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: { ...detail.environment, controllerMachineId: member.machineId }, targetLinks: [] } });
    const applied: unknown[] = [];
    const receivedApplyResults: Array<Readonly<{ ok: boolean; errorCode?: string }>> = [];
    const templateHost = (raw: unknown) => {
        const input = DeploymentTemplateInstantiateInputV1Schema.parse(raw);
        if (input.mode === 'preview') return DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'preview',
          review: { templateRef: input.templateRef, profiles: app.compose.profiles, services: app.compose.services, bindings: [],
            generatedSecrets: app.generatedSecrets.map(secret => ({ name: secret.key, phase: 'runtime', key: secret.key, profile: secret.profile })),
            domains: [], ...(input.deploy ? { deploy: input.deploy } : {}) } });
        applied.push(input);
        if (outcome !== 'applied') return ActionExecuteFailureSchema.parse({ ok: false, errorCode: outcome, error: outcome });
        return DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'applied', environmentId: detail.environment.id,
          revision: 2, targetLinkId: link.id, savedSecrets: [], definition: { kind: 'stored', contentRevision: 2,
            composeDigest: `sha256:${'c'.repeat(64)}` } });
    };
    const { createUiDeploymentActionDeps } = await import('@/sync/api/deployments/deploymentActions');
    const { resolveActionsSettingsV1FromState } = await import('@/sync/domains/settings/actionsSettings');
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
      resolveEnvironmentApprovalScope: createUiDeploymentActionDeps(account).resolveEnvironmentApprovalScope,
      // Installed host preparation/effects are the system boundary. Protocol policy and confirmation stay real.
      prepareDeploymentTemplateInstantiation: async ({ input }) => {
        const preview = DeploymentTemplateInstantiateResultV1Schema.parse(templateHost({ ...input, mode: 'preview' }));
        if (preview.kind !== 'preview') throw new Error('Expected template preview');
        return { input, preview: projectNativeJsonValueForTransport(preview.review), hostReviewedChildren: {
          children: input.deploy ? [{ action: 'deployments.deploy' as const, role: 'template.deploy' }] : [],
          executeAdmittedAction: async () => {
            const result = templateHost(input);
            return 'errorCode' in result ? result : { ok: true as const, result };
          },
        } };
      },
      deploymentTemplateInstantiate: async input => templateHost(input),
    }));
    const boundary = await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.templates.instantiate',
      machineId: member.machineId, installationId: member.installationId, tokenEpoch: 0,
      failure: result => ActionExecuteFailureSchema.safeParse(result).data ?? null,
      execute: async (input, transport) => {
        if (!('authentication' in transport.authorization.binding) || !account.serverIdentityId)
          throw new Error('Expected Account-authorized Home ingress');
        const result = await receiver.execute('deployments.templates.instantiate', input, {
          surface: transport.invocation.surface,
          authority: transport.invocation.authority === 'present_user' ? resolveInvocationAuthority({
            credential: transport.authorization.binding.authentication.kind, surface: transport.invocation.surface,
            actionId: 'deployments.templates.instantiate' }) : transport.invocation.authority,
          actionCaller: transport.invocation.caller, presentUserConfirmation: transport.invocation.presentUserConfirmation,
          serverId, serverIdentityId: account.serverIdentityId, runtimeAccountId: account.accountId,
          externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
          originalActionEnvelope: transport.envelope, actionRequestId: transport.requestId,
          actionsSettings: resolveActionsSettingsV1FromState(storage.getState()),
          signExternalActionApprovalInput: ({ actionId, input, target, requesterConfirmation, sessionTargetsV1 }) =>
            boundary.signApprovalInput({ authorizationToken: transport.authorization.token, actionId, input, target,
              ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
        });
        if (DeploymentTemplateInstantiateInputV1Schema.parse(input).mode === 'apply') receivedApplyResults.push({
          ok: result.ok, ...(!result.ok ? { errorCode: result.errorCode } : {}) });
        return result.ok ? result.result : result;
      } });
    const opened: string[] = [];
    const review = { ...noReview, request: vi.fn() };
    const screen = await renderScreen(<ModalProvider />);
    try {
      await act(async () => showDeploymentAddSheet({ detail, review, machineName: () => 'vps-2',
        catalogFilters: {}, lifetime: account.accountLifetime, onOpenRecovery: destination => opened.push(destination) }));
      const rowId = `store.kind.app.row.app|${sourceId}|postgresql`;
      await waitForHomeGovernance(() => expect(screen.findByTestId(rowId)).not.toBeNull());
      await screen.pressByTestIdAsync(rowId);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled).toBe(false));
      await screen.pressByTestIdAsync('project-deployments.add.confirm');
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.added')
        ?? screen.findByTestId('project-deployments.add.refused')).not.toBeNull());
      expect(receivedApplyResults).toEqual([outcome === 'applied' ? { ok: true } : { ok: false, errorCode: outcome }]);
      expect(applied).toEqual([expect.objectContaining({ mode: 'apply', environment: { kind: 'existing',
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision },
        templateRef: expect.objectContaining({ sourceId, itemId: 'postgresql' }),
        bindings: [{ purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'DB_PASSWORD' } }],
        generatedSecretAudience: { accountGrants: [], teamGrants: [], groupGrants: [] } })]);
      expect(review.request).not.toHaveBeenCalled();
      expect(homes.artifacts(serverId).list()).toEqual([]);
      if (outcome === 'applied') expect(screen.findByTestId('project-deployments.add.refused')).toBeNull();
      else {
        const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
        expect(screen.getTextContent()).toContain(readDeploymentRefusalRecoveryV1(outcome)!.remedy);
        expect(screen.findByTestId('project-deployments.add.added')).toBeNull();
        await screen.pressByTestIdAsync('project-deployments.add.refused.next');
        expect(opened).toEqual(['source']);
      }
    } finally { await screen.unmount(); account.dispose(); }
  });

  it('says a refused Add once, from the shared recovery owner, beside its one next step', async () => {
    const { DeploymentAddRefusal } = await import('./DeploymentDatabasePage');
    const opened: string[] = [];
    const screen = await renderScreen(
      <DeploymentAddRefusal testID="add.refusal" code="template_domain_required" onOpenRecovery={(destination) => opened.push(destination)} />,
    );
    try {
      const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
      const recovery = readDeploymentRefusalRecoveryV1('template_domain_required')!;
      expect(screen.getTextContent()).toContain(recovery.remedy);
      // One message, no raw code beside it.
      expect(screen.getTextContent()).not.toContain('template_domain_required');
      await screen.pressByTestIdAsync('add.refusal.next');
      expect(opened).toEqual(['domains']);
    } finally { await screen.unmount(); }
  });

  it('chooses from the Store catalog as an embedded picker, filtered to databases, not a Store page inside the sheet', async () => {
    const { showDeploymentAddSheet } = await import('./DeploymentDatabasePage');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, runtimeTargetLink: createDeploymentTargetLinkHeaderV1(), memberVersions: {},
      content: { ...base.content, definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: 'services:\n  app:\n    image: app:1\n', profiles: [], services: ['app'], primaryService: 'app' } } };
    const screen = await renderScreen(<ModalProvider />);
    try {
      await act(async () => {
        showDeploymentAddSheet({ detail, review: noReview, machineName: () => 'vps-2',
          catalogFilters: { category: { include: ['database'], exclude: [] } },
          lifetime: { scope: { serverId: 'home', accountId: 'account-owner' }, isCurrent: () => true } as never });
      });
      const { StoreRegistryItemPicker } = await import('@/components/store/StoreKindPage');
      const picker = screen.root.findAllByType(StoreRegistryItemPicker)[0];
      expect(picker?.props.initialFilters).toEqual({ category: { include: ['database'], exclude: [] } });
      // No second page frame (header, project scope chip, page ⋯) inside the sheet.
      expect(screen.findByTestId('store.kind.app')).toBeNull();
    } finally { await screen.unmount(); }
  });

  it('gives an Environment defined in its repository one real next step: the Store catalog picker on its Machine', async () => {
    const { showDeploymentAddSheet } = await import('./DeploymentDatabasePage');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, runtimeTargetLink: null, memberVersions: {},
      content: { ...base.content, definition: { kind: 'repository' as const, ref: 'main' } } };
    const screen = await renderScreen(<ModalProvider />);
    try {
      await act(async () => {
        showDeploymentAddSheet({ detail, review: noReview, machineName: () => 'vps-2',
          catalogFilters: { category: { include: ['database'], exclude: [] } },
          lifetime: { scope: { serverId: 'home', accountId: 'account-owner' }, isCurrent: () => true } as never });
      });
      expect(screen.findByTestId('project-deployments.add.blocked')).not.toBeNull();
      routerMock.spies.push.mockClear();
      await screen.pressByTestIdAsync('project-deployments.add.openStore');
      const pushed = String(routerMock.spies.push.mock.calls[0]?.[0] ?? '');
      // The canonical Store app catalog picker (the list Add embeds), not a text search for "database".
      expect(pushed).toContain('kind=app');
      expect(pushed).not.toMatch(/[?&]q=/);
      // Filtered to the catalog's database category through the Store's own filter condition.
      expect(JSON.parse(decodeURIComponent(/[?&]filters=([^&]+)/.exec(pushed)?.[1] ?? 'null'))).toEqual({ category: { include: ['database'], exclude: [] } });
    } finally { await screen.unmount(); }
  });
});

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
        machineId: view.machineId, installationId: 'installation-a', targetLinkId: 'target-link', deploymentId: 'deployment-a',
      });
      await view.screen.pressByTestIdAsync(`${page}.controls.run`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(view.effects.find((effect) => effect.actionId === 'deployments.backups.run')?.input).toEqual(history);
    } finally {
      await view.dispose();
    }
  });

  it('connects an app in another Environment through the shared chooser and one bindings.set, the Action an agent uses', async () => {
    const sets: unknown[] = [];
    const view = await renderDatabase({ shared: true, setBindings: async (input) => {
      sets.push(DeploymentActionInputSchemasV1['deployments.bindings.set'].parse({ ...input, serverId: 'home' }));
      return { ok: true };
    } });
    try {
      // Opening reads the backup history; let it settle so no native read outlives this case.
      expect(await view.settle(`${page}.history.empty`)).not.toBeNull();
      expect(await view.settle(`${page}.connect`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.connect`);
      // The source itself is never a destination.
      expect(await view.settle('project-deployments.connect.destination:environment-web')).not.toBeNull();
      expect(view.screen.findByTestId(`project-deployments.connect.destination:${view.environmentId}`)).toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.connect.destination:environment-web');
      await view.screen.pressByTestIdAsync('project-deployments.connect.confirm');
      expect(await view.settle('project-deployments.connect.connected')).not.toBeNull();
      expect(sets).toEqual([{ serverId: 'home', environmentId: 'environment-web', expectedRevision: 4, remove: [], set: [{
        purpose: 'variable', name: 'DATABASE_URL', phase: 'runtime',
        source: { kind: 'reference', environmentId: view.environmentId, export: 'database', via: 'auto' },
      }] }]);
    } finally { await view.dispose(); }
  });

  it('says what Connect needs when the database is not shared with other Environments', async () => {
    const view = await renderDatabase({ setBindings: async () => ({ ok: true }) });
    try {
      // Opening reads the backup history; let it settle so no native read outlives this case.
      expect(await view.settle(`${page}.history.empty`)).not.toBeNull();
      await view.settle(`${page}.connect`);
      await view.screen.pressByTestIdAsync(`${page}.connect`);
      expect(await view.settle('project-deployments.connect.needsShare')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.connect.confirm')).toBeNull();
    } finally { await view.dispose(); }
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
      // Opening reads the backup history; let it settle so no native read outlives this case.
      expect(await view.settle(`${page}.history.empty`)).not.toBeNull();
      expect(await view.settle(`${page}.restore`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.restore`);
      // The sheet lists the inventory: the kept pre-migration capture and a scheduled run's snapshot.
      expect(await view.settle(`project-deployments.restore.choice.${snapshotId}`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`project-deployments.restore.choice.${'f'.repeat(64)}`);
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
      // A scheduled snapshot names its exact run on both steps; the same restore Action an agent calls.
      for (const [input] of restore.mock.calls) {
        expect(DeploymentActionInputSchemasV1['deployments.backups.restore'].parse({ ...input, serverId: 'home' })).toMatchObject({
          deploymentId: 'deployment-a', restoreBackupId: 'f'.repeat(64), backupOperationId: 'nightly',
        });
      }
    } finally {
      releaseConfirm();
      await view.dispose();
    }
  });
});
