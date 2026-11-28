import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

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
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
afterEach(standardCleanup);

const { showDeploymentTelemetrySheet } =
  await import('./DeploymentTelemetrySheet');
const { Modal, ModalProvider } = await import('@/modal');
const { View } = await import('react-native');

const lifetime = {
  scope: { serverId: 'home', accountId: 'owner' },
  isCurrent: () => true,
  onRetire: () => ({ dispose() {} }),
};

function setUpDetail() {
  const base = createDeploymentEnvironmentDetailV1({
    environment: createDeploymentEnvironmentHeaderV1({ id: 'production' }),
  });
  return {
    ...base,
    environment: { ...base.environment, telemetryMachineId: 'collector-old' },
    content: {
      ...base.content,
      telemetry: { metrics: false, appLlmCost: true, exceptions: true },
    },
  };
}

async function open(
  setTelemetry: Parameters<
    typeof showDeploymentTelemetrySheet
  >[0]['setTelemetry'],
  onSaved = vi.fn(),
  status: Pick<Parameters<typeof showDeploymentTelemetrySheet>[0], 'readCaptureStatus' | 'onApproval'> = {},
) {
  const screen = await renderScreen(
    <ModalProvider>
      <View testID="host" />
    </ModalProvider>,
  );
  await act(async () => {
    showDeploymentTelemetrySheet({
      detail: setUpDetail() as never,
      lifetime,
      environmentName: 'Production',
      setTelemetry,
      setBindings: vi.fn(),
      onSaved,
      ...status,
    });
  });
  await act(async () => {
    await Promise.race([
      waitForTestEvent(
        screen.subscribe,
        () => screen.findByTestId('project-deployments.telemetry.save'),
        (node) => node !== null,
      ),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  });
  return screen;
}

describe('Environment Telemetry tab', () => {
  it('shows an enabled capability’s retained sample separately from one still waiting', async () => {
    const screen = await open(vi.fn(), vi.fn(), {
      readCaptureStatus: async () => ({
        ok: true,
        source: { kind: 'environment', serverId: 'home', environmentId: 'production' },
        coverage: { lostObservations: 0, reason: null },
        enabled: true,
        capabilityLastSampleAt: { metrics: null, appLlmCost: 1700000030000, exceptions: null },
      }),
    });
    try {
      expect(screen.findByTestId('project-deployments.telemetry.llm')?.findAll(node => typeof node.type === 'string' && typeof node.props.children === 'string' && node.props.children.toLowerCase().includes('last sample'))).toHaveLength(1);
      expect(screen.findByTestId('project-deployments.telemetry.exceptions')?.findAll(node => typeof node.type === 'string' && typeof node.props.children === 'string' && node.props.children.includes('Not receiving yet'))).toHaveLength(1);
      expect(screen.findByTestId('project-deployments.telemetry.metrics')?.findAll(node => typeof node.type === 'string' && typeof node.props.children === 'string' && node.props.children.includes('Not receiving yet'))).toHaveLength(0);
      await screen.pressByTestIdAsync('project-deployments.telemetry.cancel');
    } finally { await screen.unmount(); }
  });

  it('opens the one setup sheet from the not-set-up scene, and names each recorded choice once set up', async () => {
    const { DeploymentTelemetryPanel } = await import('./DeploymentTelemetryPanel');
    const off = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ id: 'production' }) });
    const screen = await renderScreen(<ModalProvider><DeploymentTelemetryPanel detail={off as never} lifetime={lifetime}
      environmentName="Production" onChanged={() => {}} /></ModalProvider>);
    try {
      expect(screen.findByTestId('project-deployments.telemetry.off')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.recording')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.setup');
      await act(async () => {
        await Promise.race([waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.telemetry.save'),
          node => node !== null), new Promise(resolve => setTimeout(resolve, 5_000))]);
      });
      expect(screen.findByTestId('project-deployments.telemetry.save')).not.toBeNull();
      // The modal host outlives a screen: close the sheet so the next test owns the only one.
      await screen.pressByTestIdAsync('project-deployments.telemetry.cancel');
    } finally { await screen.unmount(); }
    const on = await renderScreen(<ModalProvider><DeploymentTelemetryPanel detail={setUpDetail() as never} lifetime={lifetime}
      environmentName="Production" onChanged={() => {}} /></ModalProvider>);
    try {
      expect(on.findByTestId('project-deployments.telemetry.off')).toBeNull();
      expect(on.findByTestId('project-deployments.telemetry.recording')).not.toBeNull();
    } finally { await on.unmount(); }
  });
});

describe('Environment telemetry sheet', () => {
  it('writes the explicit trace sampler through the current Environment bindings revision', async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.prompt).mockResolvedValueOnce('25');
    const detail = setUpDetail();
    const setBindings = vi.fn(async () => ({ ok: true as const, environmentId: 'production', revision: 8 }));
    const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
    try {
      await act(async () => {
        showDeploymentTelemetrySheet({ detail, lifetime, environmentName: 'Production',
          setTelemetry: vi.fn(), setBindings, onSaved: vi.fn() });
      });
      await screen.pressByTestIdAsync('project-deployments.telemetry.sampling');
      expect(setBindings).toHaveBeenCalledExactlyOnceWith({
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision, remove: [],
        set: [
          { purpose: 'variable', phase: 'runtime', managedBy: 'telemetry',
            name: 'OTEL_TRACES_SAMPLER', source: { kind: 'value', value: 'parentbased_traceidratio' } },
          { purpose: 'variable', phase: 'runtime', managedBy: 'telemetry',
            name: 'OTEL_TRACES_SAMPLER_ARG', source: { kind: 'value', value: '0.25' } },
        ],
      });
    } finally {
      await act(async () => { Modal.hideAll(); });
      await screen.unmount();
    }
  });

  it('offers the collector App for a Team without a collector and keeps its Project and destination explicit', async () => {
    const { Modal } = await import('@/modal');
    const detail = createDeploymentEnvironmentDetailV1({
      environment: createDeploymentEnvironmentHeaderV1({
        id: 'production', projectSourceId: 'team-project', owner: { kind: 'team', teamId: 'team' },
      }),
    });
    const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
    try {
      await act(async () => {
        showDeploymentTelemetrySheet({ detail, lifetime, environmentName: 'Production',
          setTelemetry: vi.fn(), setBindings: vi.fn(), onSaved: vi.fn() });
      });
      await screen.pressByTestIdAsync('project-deployments.telemetry.deploy-collector');
      expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
        props: expect.objectContaining({ projectSourceId: 'team-project', lifetime,
          selection: { sourceId: 'happier.deployment.templates/data-services', itemId: 'telemetry-collector' } }),
      }));
    } finally {
      await act(async () => { Modal.hideAll(); });
      await screen.unmount();
    }
  });

  it('uses the Machine role Action for a manageable role-off collector and keeps the sheet on refusal', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const { t } = await import('@/text');
    const { Modal } = await import('@/modal');
    const account = await createSecretSettingsTestHarness({ settings: settingsParse({
      actionsSettingsV1: { v: 1, actions: { 'machines.roles.set': { enabled: false } } },
    }) });
    const context = await captureLazyActionAccountContext(account.scope.serverId);
    const [pluginId, roleId] = DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1.split('/');
    const machine = createHydratedPlainMachineFixture({ id: 'collector-old', accountId: account.scope.accountId,
      machine: { activeAt: Date.now(), daemonState: { machineRoles: { plugins: [{
        pluginId: pluginId!, declaration: { id: roleId!, title: 'Telemetry', description: 'Collect telemetry' },
      }] } } },
    });
    await publishMachineInventoryForTest(account.scope, [machine]);
    const detail = setUpDetail();
    const setTelemetry = vi.fn(async () => ({
      ok: false as const, error: 'telemetry_role_inactive' as const, details: { machineId: machine.id },
    }));
    const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
    try {
      await act(async () => {
        showDeploymentTelemetrySheet({ detail, lifetime: context.accountLifetime, environmentName: 'Production',
          setTelemetry, setBindings: vi.fn(), onSaved: vi.fn() });
      });
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      await screen.pressByTestIdAsync('project-deployments.telemetry.enable-role');
      await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(
        t('machineDetailPage.roles.saveFailed'), t('actionConfirmations.turnedOffUnnamedMessage'),
      ));
      expect(screen.findByTestId('project-deployments.telemetry.save')).not.toBeNull();
      expect(setTelemetry).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { Modal.hideAll(); });
      await screen.unmount();
      context.dispose();
      await account.dispose();
    }
  });

  it('uses the Project collector default without opting into absent capabilities on first setup', async () => {
    const account = await createSecretSettingsTestHarness({ handleRequest: async path => {
      if (path.startsWith('/v1/projects/sources/source-app')) return Response.json({ ok: true, canManage: true,
        source: { id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'account-a' },
          audience: [], createdByAccountId: 'account-a', defaultRef: 'main' } });
      if (path.startsWith('/v1/projects/source-app/deployment-defaults')) return Response.json({ ok: true,
        projectSourceId: 'source-app', sourceRevision: 1, revision: 1,
        content: { contentArtifactId: 'project-defaults', contentHeaderVersion: 1, contentBodyVersion: 1 } });
      return null;
    } });
    account.artifacts.replaceStoredRow(createPlainArtifactHttpFixture({ id: 'project-defaults', title: 'App', isDecrypted: true,
      header: { kind: 'project-deployment-defaults.v1', title: 'App' },
      body: JSON.stringify({ projectSourceId: 'source-app', deploymentDefaults: { telemetryMachineId: 'collector-default' } }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, account.scope.accountId));
    const context = await captureLazyActionAccountContext(account.scope.serverId);
    const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
    const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: 'production' });
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'production', projectSourceId: 'source-app',
      owner: { kind: 'account', accountId: account.scope.accountId }, runtimeTargetLinkId: targetLink.id });
    const detail = createDeploymentEnvironmentDetailV1({ environment, targetLinks: [{ targetLink, content: {} }] });
    const setTelemetry = vi.fn(async () => ({ ok: true as const, environmentId: 'production', revision: 2, state: 'redeploy_required' as const }));
    const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
    try {
      await act(async () => { showDeploymentTelemetrySheet({ detail, lifetime: context.accountLifetime,
        environmentName: 'Production', setTelemetry, setBindings: vi.fn(), onSaved: () => {} }); });
      const picker = () => screen.findAllByType(SessionMachineField).find(row => row.props.testID === 'project-deployments.telemetry.collector');
      await vi.waitFor(() => expect(picker()?.props.machineId).toBe('collector-default'));
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(setTelemetry).toHaveBeenCalledWith({
        collector: { machineId: 'collector-default' },
        capabilities: { metrics: false, appLlmCost: false, exceptions: false },
      });
    } finally {
      await screen.unmount();
      context.dispose();
      await account.dispose();
    }
  });

  it('submits only the public HTTPS Domain the person chose for the selected collector App', async () => {
    const { Modal } = await import('@/modal');
    const app = { environmentId: 'collector-environment', targetLinkId: 'collector-target', deploymentId: 'collector-deployment',
      controller: { machineId: 'collector-host', installationId: 'collector-installation' } };
    const collectorId = 'collector-old';
    let machineReads = 0;
    const domainReads: string[] = [];
    const domains = [
      { id: 'private-domain', hostname: 'private.example.test', public: false },
      { id: 'primary-domain', hostname: 'primary.example.test', public: true },
      { id: 'backup-domain', hostname: 'backup.example.test', public: true },
    ];
    const account = await createSecretSettingsTestHarness({ handleRequest: async (path, init): Promise<Response | null> => {
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
        machineReads++;
        return createMachineReadBatchResponseFixture(init.body, id => id === collectorId
          ? { ...createPlainMachineRowFixture({ id, accountId: 'account-a' }), deploymentApp: app } : null);
      }
      if (!path.startsWith(`/v1/deployments/environments/${app.environmentId}/domains`)) return null;
      domainReads.push(path);
      return Response.json({ ok: true, environmentId: app.environmentId, revision: 1, nextCursor: null,
        domains: domains.map(({ id, public: servesPublicly }) => {
          const placement = { serverId: account.scope.serverId, accountId: account.scope.accountId,
            environmentId: app.environmentId, targetLinkId: app.targetLinkId, domainId: id,
            ...app.controller, actionOperationId: 'domain-operation', requestId: 'domain-request', nativeServer: 'private' };
          const content = { contentArtifactId: `${id}-artifact`, contentHeaderVersion: 1, contentBodyVersion: 1 };
          const origin = { placement, content, desired: true, listener: 'privateOrigin',
            telemetryCollector: { machineId: collectorId, deploymentId: app.deploymentId } };
          return { v: 1, id, environmentId: app.environmentId, targetLinkId: app.targetLinkId,
            revision: 1, state: 'active', ...content, createdByAccountId: account.scope.accountId, createdAtMs: 1, updatedAtMs: 1,
            placements: servesPublicly ? [origin, { placement: { ...placement, nativeServer: 'public' },
              content, desired: true, listener: 'public' }] : [origin] };
        }) });
    } });
    for (const { id, hostname } of domains) {
      account.artifacts.replaceStoredRow(createPlainArtifactHttpFixture({ id: `${id}-artifact`, title: hostname, isDecrypted: true,
        header: { kind: 'deployment-domain.v1', title: hostname }, body: JSON.stringify({ hostname, target: { kind: 'telemetry' } }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, account.scope.accountId));
    }
    const context = await captureLazyActionAccountContext(account.scope.serverId);
    const setTelemetry = vi.fn<Parameters<typeof showDeploymentTelemetrySheet>[0]['setTelemetry']>()
      .mockResolvedValueOnce({ ok: false, error: 'collector_public_domain_required' })
      .mockResolvedValueOnce({ ok: true, environmentId: 'production', revision: 2, state: 'redeploy_required' });
    const screen = await renderScreen(<ModalProvider><View testID="host" /></ModalProvider>);
    try {
      const base = setUpDetail();
      const detail = { ...base, environment: { ...base.environment, serverId: account.scope.serverId } };
      await act(async () => { showDeploymentTelemetrySheet({ detail, lifetime: context.accountLifetime,
        environmentName: 'Production', setTelemetry, setBindings: vi.fn(), onSaved: vi.fn() }); });
      expect(domainReads).toHaveLength(0);
      const before = machineReads;
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      await vi.waitFor(() => expect(screen.findByTestId('project-deployments.telemetry.public-domain.backup-domain')).not.toBeNull());
      expect(machineReads).toBe(before + 1);
      expect(domainReads).toHaveLength(1);
      expect(screen.findByTestId('project-deployments.telemetry.public-domain.private-domain')).toBeNull();
      expect(setTelemetry).toHaveBeenCalledTimes(1);
      expect(setTelemetry.mock.calls[0]?.[0]).not.toHaveProperty('publicCollectorDomain');
      await screen.pressByTestIdAsync('project-deployments.telemetry.public-domain.backup-domain');
      expect(setTelemetry).toHaveBeenCalledTimes(1);
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(setTelemetry.mock.calls[1]?.[0]).toMatchObject({ collector: { machineId: collectorId },
        publicCollectorDomain: { environmentId: app.environmentId, targetLinkId: app.targetLinkId, domainId: 'backup-domain' } });
    } finally {
      await act(async () => { Modal.hideAll(); });
      await screen.unmount();
      context.dispose();
      await account.dispose();
    }
  });

  it('saves the collector with the three capability choices, then the next deploy applies them', async () => {
    const setTelemetry = vi.fn(async () => ({
      ok: true as const,
      environmentId: 'production',
      revision: 8,
      state: 'redeploy_required' as const,
    }));
    const onSaved = vi.fn();
    const screen = await open(setTelemetry, onSaved);
    try {
      // The D30 footer follows Exceptions: raw telemetry stays on the collector, issue metadata goes to the Account.
      expect(
        screen.findByTestId('project-deployments.telemetry.kept'),
      ).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(setTelemetry).toHaveBeenCalledWith({
        collector: { machineId: 'collector-old' },
        capabilities: { metrics: false, appLlmCost: true, exceptions: true },
      });
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, state: 'redeploy_required' }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it('shows the Cloudflare destination names the person needs in Wrangler after saving', async () => {
    const result = { ok: true as const, environmentId: 'production', revision: 8,
      state: 'wrangler_required' as const, destinations: [
        { type: 'traces' as const, name: 'Production Trace Destination', slug: 'trace-api-slug' },
        { type: 'logs' as const, name: 'Production Log Destination', slug: 'log-api-slug' },
      ] };
    const setTelemetry = vi.fn(async () => result);
    const onSaved = vi.fn();
    const screen = await open(setTelemetry, onSaved);
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(onSaved).toHaveBeenCalledExactlyOnceWith(result);
      const message = vi.mocked(Modal.alert).mock.lastCall?.[1];
      expect(message).toContain('Production Trace Destination');
      expect(message).toContain('Production Log Destination');
      expect(message).not.toContain('trace-api-slug');
      expect(message).not.toContain('log-api-slug');
      expect(setTelemetry).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it('asks once before the previous collector deletes what it kept, then confirms that exact turn-off', async () => {
    const setTelemetry = vi.fn(async (input: { confirmDelete?: true }) =>
      input.confirmDelete
        ? {
            ok: true as const,
            environmentId: 'production',
            revision: 8,
            state: 'redeploy_required' as const,
          }
        : {
            ok: false as const,
            error: 'telemetry_deletion_confirmation_required' as const,
            details: { machineId: 'collector-old' },
          },
    );
    const onSaved = vi.fn();
    const screen = await open(setTelemetry as never, onSaved);
    try {
      // Turning Requests and queries off clears the collector and withdraws the capability choices.
      // The row owns its switch: pressing Requests and queries turns it off, as a person does.
      await screen.pressByTestIdAsync('project-deployments.telemetry.requests');
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(setTelemetry).toHaveBeenNthCalledWith(1, { collector: null });
      expect(onSaved).not.toHaveBeenCalled();
      expect(
        screen.findByTestId('project-deployments.telemetry.confirm-delete'),
      ).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(setTelemetry).toHaveBeenNthCalledWith(2, {
        collector: null,
        confirmDelete: true,
      });
      expect(onSaved).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it('rotates the bound collector credential without saving the pending capability choices', async () => {
    const setTelemetry = vi.fn(async () => ({
      ok: true as const,
      environmentId: 'production',
      revision: 8,
      state: 'redeploy_required' as const,
    }));
    const onSaved = vi.fn();
    const screen = await open(setTelemetry, onSaved);
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.rotate');
      expect(setTelemetry).toHaveBeenCalledExactlyOnceWith({ rotate: true });
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ state: 'redeploy_required' }));
    } finally {
      await screen.unmount();
    }
  });

  it('hands a telemetry save held for approval to Review', async () => {
    const { HappyError } = await import('@/utils/errors/errors');
    const onApproval = vi.fn();
    const onSaved = vi.fn();
    const screen = await open(async () => {
      throw new HappyError('approval_request_created', false, { code: 'approval_request_created',
        details: { kind: 'approval_request_created', artifactId: 'telemetry-approval', actionId: 'deployments.environments.telemetry.set' } });
    }, onSaved, { onApproval });
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(onApproval).toHaveBeenCalledWith('telemetry-approval');
      expect(onSaved).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
  });

  it('keeps the choices and names the recovery when the Action refuses the collector', async () => {
    const setTelemetry = vi.fn(async () => ({
      ok: false as const,
      error: 'telemetry_role_inactive' as const,
    }));
    const onSaved = vi.fn();
    const screen = await open(setTelemetry, onSaved);
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.save');
      expect(
        screen.findByTestId('project-deployments.telemetry.refused'),
      ).not.toBeNull();
      expect(
        screen.findByTestId('project-deployments.telemetry.save'),
      ).not.toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
