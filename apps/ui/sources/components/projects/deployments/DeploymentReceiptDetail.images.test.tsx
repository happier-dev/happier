import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentReceiptDetailV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import { t } from '@/text';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';

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
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
// The exact controller RPC is the network boundary; its protocol reader stays real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: vi.fn(async () => {
      throw new Error('controller_unavailable');
    }),
  }),
);
afterEach(standardCleanup);

const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
const { EnvironmentLogsCompanion } = await import('./EnvironmentLogsCompanion');
const { AccountNoticeInvestigationBoundary } =
  await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
const { AgentActionButton } = await import('@happier-dev/plugin-ui/components');
const { readDeploymentFailureRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};
const digest = (char: string) => `sha256:${char.repeat(64)}`;

describe('Receipt → Images', () => {
  it('names each exact image the release ran, by service and platform, with its reference', async () => {
    const base = createDeploymentReceiptDetailV1();
    const content = DeploymentOwnServerContentV1Schema.parse({
      ...base.content,
      images: [
        {
          service: 'web',
          platform: 'linux/amd64',
          configDigest: digest('a'),
          manifestDigest: digest('b'),
          registryReference:
            'registry.example/app/web@sha256:' + 'b'.repeat(64),
        },
        {
          service: 'worker',
          platform: 'linux/amd64',
          configDigest: digest('c'),
          manifestDigest: digest('d'),
        },
      ],
    });
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ state: 'succeeded' }),
      content,
    });
    const detail = createDeploymentEnvironmentDetailV1();
    const controller = createDeploymentReadControllerV1({
      scope,
      transport: {
        listEnvironments: async () => ({
          ok: true,
          value: { items: [], nextCursor: null },
        }),
        readEnvironment: async () => ({ ok: true, value: detail }),
        listHistory: async () => ({
          ok: true,
          value: { ok: true, items: [], nextCursor: null },
        }),
        readReceipt: async () => ({ ok: true, value: receipt }),
      },
    });
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail
          controller={controller}
          environmentId={detail.environment.id}
          deploymentId={receipt.deployment.id}
          environmentName="Staging"
          demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId}
          serverId={scope.serverId}
          readLogs={null}
          onBack={() => {}}
          rollback={null}
          cancel={null}
          deploy={null}
          phone={false}
          linkPath={null}
          review={{ pendingId: null, request() {}, open() {} }}
          onOpenReceipt={() => {}}
        />
      </AccountNoticeInvestigationBoundary>,
    );
    try {
      await act(async () => {
        await Promise.race([
          waitForTestEvent(
            screen.subscribe,
            () => screen.findByTestId('project-deployments.receipt.images'),
            (node) => node !== null,
          ),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      });
      // The Item row itself, which carries the subtitle it draws.
      const row = (id: string) => screen.findAll(node => node.props.testID === id && node.props.subtitle !== undefined)[0];
      const web = row('project-deployments.receipt.image.web.linux/amd64');
      const worker = row('project-deployments.receipt.image.worker.linux/amd64');
      expect(web?.props.subtitle).toBe(
        'registry.example/app/web@sha256:' + 'b'.repeat(64),
      );
      // Without a registry reference the config digest is the image's identity.
      expect(worker?.props.subtitle).toBe(digest('c'));
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Receipt → failed', () => {
  it.each([
    { phase: 'restore', health: 'unverified', consequence: 'failed' },
    { phase: 'activate', health: 'unhealthy', consequence: 'failed' },
    { phase: 'activate', health: 'unverified', consequence: 'unverified' },
    { phase: 'activate', health: 'healthy', consequence: 'healthy' },
  ] as const)('shows the projected restoration consequence for $phase / $health', async ({ phase, health, consequence }) => {
    const base = createDeploymentReceiptDetailV1();
    const revision = { kind: 'repository' as const, sha: 'b'.repeat(40) };
    const content = DeploymentOwnServerContentV1Schema.parse({ ...base.content,
      failure: { code: 'deployment_failed_unclassified', phase },
      machineResults: base.content.machines.map(machineId => ({ machineId, installationId: 'installation-a',
        steps: [], activation: 'failed', restoration: 'succeeded', health })),
      ownServer: { approvedInputBasis: {
        v: 1, environmentId: base.deployment.environmentId, environmentRevision: 1,
        targetLinkId: base.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: base.content.sourceIntent,
        manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
        services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [], images: [],
      }, rollbackTarget: { deploymentId: 'incumbent', revision } },
    });
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }), content });
    const detail = createDeploymentEnvironmentDetailV1();
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
          deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId} serverId={scope.serverId} readLogs={null} onBack={() => {}} rollback={null}
          cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }}
          onOpenReceipt={() => {}} />
      </AccountNoticeInvestigationBoundary>,
    );
    try {
      await act(async () => {
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.receipt.outcome.failed'), node => node !== null);
      });
      const banner = screen.findAll(node => node.props.testID === 'project-deployments.receipt.outcome.failed'
        && node.props.description !== undefined)[0]!;
      const description = String(banner.props.description);
      if (consequence === 'failed') expect(description).toContain(t('projects.deployments.failureRestoreFailed', { sha: 'bbbbbbb' }));
      else if (consequence === 'unverified') expect(description).toContain(t('projects.deployments.stateUnverified'));
      else expect(description).toContain(t('projects.deployments.failureRestored', { sha: 'bbbbbbb' }));
      if (consequence !== 'healthy') expect(description).not.toContain(t('projects.deployments.failureRestored', { sha: 'bbbbbbb' }));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each([
    { phone: false, code: 'deployment_failed_unclassified' },
    { phone: true, code: 'deployment_failed_unclassified' },
    { phone: false, code: 'invalid_request' },
  ])('shows the retry outcome as the only attention condition (phone=$phone, recorded=$code)', async ({ phone, code }) => {
    const detail = createDeploymentEnvironmentDetailV1();
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
      content: DeploymentOwnServerContentV1Schema.parse({ ...base.content,
        failure: { code, phase: 'build' } }),
    });
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    const deploy = vi.fn(async () => ({ ok: false as const, error: 'approval_stale' }));
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
          deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId} serverId={scope.serverId} readLogs={null} onBack={() => {}} rollback={null}
          cancel={null} deploy={deploy} phone={phone} linkPath={null} review={{ pendingId: null, request() {}, open() {} }}
          onOpenReceipt={() => {}} />
      </AccountNoticeInvestigationBoundary>,
    );
    const failed = 'project-deployments.receipt.outcome.failed';
    const refused = 'project-deployments.outcome.refused.other';
    try {
      await act(async () => {
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId(failed), node => node !== null);
      });
      const banner = screen.findAll(node => node.props.testID === failed && node.props.title !== undefined)[0]!;
      expect(banner.props.title).toBe(t('projects.deployments.failureBuild'));
      if (code === 'invalid_request') expect(banner.props.description ?? '').not.toContain(readDeploymentFailureRecoveryV1(code).remedy);
      const retry = [`${failed}.action`, `${failed}.deployAgain`, 'project-deployments.receipt.deployAgain']
        .find(id => screen.findByTestId(id) !== null);
      expect(retry).toBeDefined();
      await screen.pressByTestIdAsync(retry!);
      await vi.waitFor(() => expect(screen.findByTestId(refused)).not.toBeNull());
      expect(screen.findByTestId(failed)).toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each(['deployment_image_unavailable', 'build_platform_unsupported', 'stateful_service_multi_machine'])('offers the canonical remedy for the recorded cause (%s)', async code => {
    const base = createDeploymentReceiptDetailV1();
    const failure = { code, phase: 'build' as const };
    const content = DeploymentOwnServerContentV1Schema.parse({ ...base.content, buildMachineId: 'builder-c', failure });
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }), content });
    const detail = createDeploymentEnvironmentDetailV1();
    const opened: unknown[][] = [];
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
          deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId} serverId={scope.serverId} readLogs={null} onBack={() => {}} rollback={null}
          cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }}
          onOpenRecoveryDestination={(...destination) => { opened.push(destination); }}
          onOpenReceipt={() => {}} />
      </AccountNoticeInvestigationBoundary>,
    );
    try {
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.receipt.outcome.failed'), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      // The banner component itself, which carries the description it draws.
      const banner = screen.findAll(node => node.props.testID === 'project-deployments.receipt.outcome.failed'
        && node.props.description !== undefined)[0];
      expect(banner).not.toBeNull();
      expect(screen.findAllByType(AgentActionButton)).toHaveLength(1);
      expect(String(banner?.props.description)).toContain(readDeploymentFailureRecoveryV1(failure.code, failure).remedy);
      // The canonical next action opens where the cause is fixed.
      await screen.pressByTestIdAsync('project-deployments.receipt.outcome.failed.recovery');
      expect(opened).toEqual([code === 'stateful_service_multi_machine' ? ['settings']
        : [readDeploymentFailureRecoveryV1(failure.code, failure).nextAction.destination,
          // A failed step's logs open on this receipt itself.
          code === 'build_platform_unsupported' ? { machineId: 'builder-c' } : { deploymentId: receipt.deployment.id }]]);
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Receipt → release cleaned up', () => {
  it('offers to deploy that commit again, never a rollback, once complete history says it was not kept', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    // Nothing is kept for rollback; another release serves now.
    const detail = { ...base, content: { ...base.content, retainPreviousDeployments: 0 },
      targetLinks: base.targetLinks.map(link => ({ ...link, targetLink: { ...link.targetLink, activeDeploymentId: 'serving' } })) };
    const old = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'old', state: 'succeeded' }),
      content: { ...createDeploymentReceiptDetailV1().content, sourceMethod: 'upload' } });
    if (old.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'serving', state: 'succeeded',
      requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002 }),
      content: { ...old.content, sourceIntent: { ...old.content.sourceIntent, sha: 'b'.repeat(40) } } });
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [serving, old]
        .map(row => ({ ...row.deployment, source: projectDeploymentReceiptFactsV1(row).source })), nextCursor: null } }),
      readReceipt: async (_scope, _environmentId, id) => ({ ok: true, value: id === 'serving' ? serving : old }),
    } });
    const deploy = vi.fn(async () => ({ ok: true as const, deploymentId: 'fresh' }));
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
          deploymentId="old" environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId} serverId={scope.serverId} readLogs={null} onBack={() => {}} rollback={vi.fn() as never}
          cancel={null} deploy={deploy as never} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }}
          onOpenReceipt={() => {}} />
      </AccountNoticeInvestigationBoundary>,
    );
    try {
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.receipt.pruned'), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      expect(screen.findByTestId('project-deployments.receipt.rollback')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.receipt.pruned.deployAgain');
      expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ sha: old.content.sourceIntent.sha, sourceMethod: 'upload' }));
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Receipt → failed rollback (PAGE-ACCEPT-85 D11)', () => {
  it('leads with Roll back again to the same release and says no generic remedy when the cause has none', async () => {
    const base = createDeploymentReceiptDetailV1();
    const failure = { code: 'deployment_failed_unclassified', phase: 'activate' as const };
    const content = DeploymentOwnServerContentV1Schema.parse({ ...base.content, failure });
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
      id: 'failed-rollback', state: 'failed', operation: 'rollback', rollbackOfDeploymentId: 'retained',
      predecessorDeploymentId: 'retained', requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002 }), content });
    const detail = createDeploymentEnvironmentDetailV1();
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    // The Action owner's rollback is the boundary.
    const rollback = vi.fn(async () => ({ ok: true as const, deploymentId: 'again' }));
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
          deploymentId="failed-rollback" environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId} serverId={scope.serverId} readLogs={null} onBack={() => {}} rollback={rollback as never}
          cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }}
          onOpenReceipt={() => {}} />
      </AccountNoticeInvestigationBoundary>,
    );
    try {
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.receipt.outcome.failed'), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      const banner = screen.findAll(node => node.props.testID === 'project-deployments.receipt.outcome.failed'
        && node.props.title !== undefined)[0]!;
      // The owner has no recovery for this cause, so its generic fallback is not shown as if it were one.
      expect(String(banner.props.description ?? '')).not.toContain(readDeploymentFailureRecoveryV1('unknown_code').remedy);
      await screen.pressByTestIdAsync('project-deployments.receipt.outcome.failed.action');
      expect(rollback).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: 'retained' }));
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Receipt → upload provenance', () => {
  it.each(['provider', 'controller'] as const)('shows the recorded source and actual %s build evidence', async location => {
    const base = createDeploymentReceiptDetailV1();
    const provenance = { sourceManifestFingerprint: 'approved-source-manifest', build: location === 'provider'
      ? { location } : { location, image: 'container@sha256:recorded-pin',
        toolchain: { name: 'wrangler', version: 'recorded-version' }, outputManifestFingerprint: 'recorded-output-manifest' } };
    const receipt = createDeploymentReceiptDetailV1({ content: { sourceIntent: base.content.sourceIntent, sourceMethod: 'upload',
      machines: [], images: [], machineResults: [], steps: [],
      platform: { targetLinkRevision: 1, credentialPrincipal: { kind: 'account', accountId: 'owner',
        purpose: { consumer: { pluginId: 'acme.platform', localId: 'inspect' }, purpose: 'deploy' },
        target: { kind: 'account', account: { service: { pluginId: 'acme.platform', localId: 'account' }, accountId: 'profile' } } },
        providerIdentity: { providerAccountId: 'account', providerResourceId: 'project', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' }, observation: { v: 1, state: 'succeeded', observedAtMs: 1,
          providerDeploymentId: 'native-deployment', urls: [], uploadProvenance: provenance } } } });
    const baseEnvironment = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ targetLinks: baseEnvironment.targetLinks.map(row => ({ ...row,
      targetLink: { ...row.targetLink, activeDeploymentId: location === 'controller' ? receipt.deployment.id : 'newer' } })) });
    const navigate = vi.fn();
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    const screen = await renderScreen(<AccountNoticeInvestigationBoundary><DeploymentReceiptDetail controller={controller}
      environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName="Staging"
      demand={{ mounted: true, visible: true, focused: true }} accountId={scope.accountId} serverId={scope.serverId}
      readLogs={null} onBack={() => {}} rollback={null} cancel={null} deploy={null} phone={false} linkPath={null}
      review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} onOpenRecoveryDestination={navigate} />
      <EnvironmentLogsCompanion open onClose={() => {}} services={[]} service={null} serverId={scope.serverId}
        environmentId={detail.environment.id} machineId={null} machineName="Controller" machineNames={{}}
        controller={controller} deploymentId={receipt.deployment.id}
        demand={{ mounted: true, visible: true, focused: true }} readLogs={null} />
    </AccountNoticeInvestigationBoundary>);
    try {
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt'), node => node !== null); });
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('environment-logs.build'), node => node !== null); });
      const row = (id: string) => screen.findAll(node => node.props.testID === id && node.props.subtitle !== undefined)[0];
      for (const prefix of ['project-deployments.receipt.upload', 'environment-logs.build.upload']) {
        expect(screen.findByTestId(prefix)).not.toBeNull();
        expect(row(`${prefix}.source`)?.props.subtitle).toBe('approved-source-manifest');
        if (location === 'controller') {
          expect(row(`${prefix}.image`)?.props.subtitle).toBe('container@sha256:recorded-pin');
          expect(row(`${prefix}.toolchain`)?.props.subtitle).toBe('wrangler recorded-version');
          expect(row(`${prefix}.output`)?.props.subtitle).toBe('recorded-output-manifest');
        } else expect(screen.findByTestId(`${prefix}.image`)).toBeNull();
      }
      const outcome = screen.findAll(node => node.props.testID === 'project-deployments.receipt.outcome.succeeded.row'
        && node.props.title !== undefined)[0];
      if (location === 'controller') {
        expect(outcome?.props.subtitle).toBe(t('projects.deployments.receipt.platformDomainRequired'));
        await screen.pressByTestIdAsync('project-deployments.receipt.outcome.succeeded.row');
        expect(navigate).toHaveBeenCalledWith('domains');
      } else expect(outcome?.props.onPress).toBeUndefined();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Receipt → running, not verified', () => {
  it.each([
    { definition: 'stored', opens: true },
    { definition: 'repository', opens: false },
  ] as const)('a $definition definition offers its Compose file as the next action: $opens', async ({ definition, opens }) => {
    const base = createDeploymentEnvironmentDetailV1();
    // A stored Compose file is edited in the Environment's Settings; a repository's lives in its repository.
    const detail = definition === 'stored' ? { ...base, content: { ...base.content, definition: {
      kind: 'stored' as const, document: 'services: {app: {image: app:1}}', profiles: [], services: ['app'],
      contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` as const } } } : base;
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'running_unverified' }) });
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    const opened: unknown[] = [];
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
          deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId} serverId={scope.serverId} readLogs={null} onBack={() => {}}
          onOpenEnvironmentTab={next => { opened.push(next); }}
          rollback={null} cancel={null} deploy={null} phone={false} linkPath={null}
          review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} />
      </AccountNoticeInvestigationBoundary>,
    );
    const notice = 'project-deployments.receipt.notice.running_unverified';
    try {
      await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId(notice), node => node !== null); });
      // The Environment read settles after the receipt; wait for the definition it names before judging the action.
      await act(async () => { await controller.refreshDemanded(); });
      const action = screen.findByTestId(`${notice}.action`);
      if (!opens) { expect(action).toBeNull(); return; }
      expect(action).not.toBeNull();
      await screen.pressByTestIdAsync(`${notice}.action`);
      expect(opened).toEqual([{ tab: 'settings', section: null }]);
    } finally { await screen.unmount(); controller.retire(); }
  });
});
