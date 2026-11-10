import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentEnvironmentHeaderV1,
  createDeploymentTargetLinkHeaderV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
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
} from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// Portal measurement and native menu SDKs are browser boundaries; the trigger editor stays real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover'))
  .createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
// The exact controller RPC is the network boundary; its protocol reader stays real.
const machineProjectionReplies = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: vi.fn(async (params: { machineId: string; method: string }) => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    if (params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
      && machineProjectionReplies.has(params.machineId)) return machineProjectionReplies.get(params.machineId);
    throw new Error('controller_unavailable');
  }),
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
afterEach(standardCleanup);
afterEach(async () => {
  machineProjectionReplies.clear();
  (await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs')).clearDaemonMergedProjectionCacheForTests();
});
// Previews read through the Home's real Action transport; the harness owns only its HTTP boundary.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import(
  '@/sync/ops/actions/actionAccountContext'
);

const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
// The app shell's provider owns the column Action; the test mounts the same one around the page.
const { PresentedDetailNavigationProvider } = await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
afterEach(() => actionOperationStore.reset());

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};
const shown = { mounted: true, visible: true, focused: true };
const noReview = { pendingId: null, request: () => {}, open: () => {} };
type Detail = ReturnType<typeof createDeploymentEnvironmentDetailV1>;
type Transport = Partial<DeploymentReadTransportV1>;

it('detail-navigation.T1/T6 Environment exposes its six canonical pages and selects once without acquiring secrets or deploying', async () => {
  const { DEPLOYMENT_ENVIRONMENT_TABS_V1 } = await import('@happier-dev/deployments');
  const navigate = vi.fn();
  const deploy = vi.fn();
  const reads = vi.fn(async () => ({ ok: true as const, value: createDeploymentEnvironmentDetailV1() }));
  const { screen, controller, settle } = await renderTab('variables', createDeploymentEnvironmentDetailV1(),
    { readEnvironment: reads }, { onNavigate: navigate, deploy });
  try {
    expect(await settle('project-deployments.environment')).not.toBeNull();
    const before = reads.mock.calls.length;
    const requestsBefore = homes.requests.length;
    expect(await invokeScopeAction('shell.column.get', { column: 'main' })).toMatchObject({
      activeTab: 'variables', tabs: [...DEPLOYMENT_ENVIRONMENT_TABS_V1],
      items: expect.arrayContaining([{ id: 'variables', label: expect.any(String), available: true, pageKind: 'environment', placement: 'pinned' }]),
    });
    await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'variables' });
    expect(navigate).not.toHaveBeenCalled();
    await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'settings' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ tab: 'settings', section: null });
    expect(reads).toHaveBeenCalledTimes(before);
    expect(homes.requests).toHaveLength(requestsBefore);
    expect(deploy).not.toHaveBeenCalled();
  } finally { await screen.unmount(); controller.retire(); }
});

function domain(
  id: string,
  hostname: string,
  state: 'active' | 'failed' | 'removing' | 'pending',
  target: Record<string, unknown> = {},
) {
  return {
    domain: {
      v: 1 as const,
      id,
      environmentId: 'environment-staging',
      targetLinkId: 'target-a',
      revision: 1,
      state,
      contentArtifactId: `content-${id}`,
      contentHeaderVersion: 1,
      contentBodyVersion: 1,
      createdByAccountId: 'account-owner',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    title: hostname,
    content: {
      hostname,
      target: { service: 'web', containerPort: 3000, ...target },
      healthCheck: { path: '/', expectStatus: 200 },
    },
  };
}

/** The network boundary only; the shared controller, tab hooks and page composition run for real. */
/** An Environment whose stored template runs one PostgreSQL database, the thing Backups copies. */
function withDatabase(detail: ReturnType<typeof createDeploymentEnvironmentDetailV1>) {
  return { ...detail, content: { ...detail.content, template: {
    templateRef: { sourceId: 'apps', itemId: 'postgres', version: '17', ref: { kind: 'content' as const, digest: `sha256:${'a'.repeat(64)}` } },
    definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
    services: ['postgres'], data: [{ engine: 'postgres' as const, version: '17', service: 'postgres', port: 5432 }],
  } } } as ReturnType<typeof createDeploymentEnvironmentDetailV1>;
}

async function renderTab(
  tab: string,
  detail: Detail,
  transport: Transport = {},
  extra: Record<string, unknown> = {},
) {
  const receipt = createDeploymentReceiptDetailV1();
  const controller = createDeploymentReadControllerV1({
    scope: { ...scope, serverId: detail.environment.serverId },
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
      ...transport,
    },
  });
  // A test that needs contributed plugin families (backup destinations) supplies the projection it would read.
  const { pluginUiProjection, ...detailProps } = extra as Record<string, unknown> & Readonly<{
    pluginUiProjection?: Readonly<{ value: object; serverId: string; accountLifetime: unknown }>;
  }>;
  const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
  // Sheets the page opens (Backups setup) render through the canonical modal testkit host.
  const { ModalProvider } = await import('@/modal');
  const page = (selectedTab: string) => (
    <ModalProvider>
    <PresentedDetailNavigationProvider>
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId="account-owner"
        serverId="home"
        phone={false}
        deploy={null}
        review={noReview}
        onOpenReceipt={() => {}}
        destination={{ tab: selectedTab as never, section: null }}
        {...detailProps}
      />
    </PresentedDetailNavigationProvider>
    </ModalProvider>
  );
  const element = (selectedTab: string) => pluginUiProjection ? (
    <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: pluginUiProjection.value as never,
      pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null,
      serverId: pluginUiProjection.serverId, platform: 'web', accountLifetime: pluginUiProjection.accountLifetime as never,
      clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
      reloadConnectedAccountProjection: () => {} }}>
      {page(selectedTab)}
    </AppShellPluginUiProjectionValueProvider>
  ) : page(selectedTab);
  const screen = await renderScreen(element(tab));
  // Bounded, so a row that never renders fails its assertion instead of hanging the file.
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
  return { screen, controller, settle, updateTab: (next: string) => screen.update(element(next)) };
}

describe('Environment → Domains', () => {
  it('shows missing recorded ingress and leaves automatic placement to the Domain owner', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const addDomain = vi.fn(async () => ({ ok: true as const, environmentId: detail.environment.id,
      revision: detail.environment.revision + 1, domain: domain('new', 'docs.happier.dev', 'pending').domain }));
    const { screen, controller, settle } = await renderTab('domains', detail,
      { listDomains: async () => ({ ok: true, value: { items: [], nextCursor: null } }) },
      { domainActions: { addDomain, inspectPlatformTarget: vi.fn(), verifyDomain: vi.fn(), removeDomain: vi.fn() } });
    const id = 'project-deployments.environment.domains.add';
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      // The choice names the place visitors reach (PAGE-ACCEPT-85 D3); no topology paragraph above it.
      expect(screen.findByTestId(`${id}.ingress.notRecorded`)).toBeNull();
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const mode = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${id}.ingress.mode`)!;
      await act(async () => mode.props.onSelect('cloudflare'));
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(addDomain).not.toHaveBeenCalled();
      await act(async () => mode.props.onSelect('environment'));
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: {
        hostname: 'docs.happier.dev', target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/', expectStatus: 200 },
      } }));
    } finally { await screen.unmount(); controller.retire(); }
  });
  it.each((['provider', 'admission'] as const).flatMap(boundary =>
    (['zones', 'tunnels'] as const).map(kind => ({ boundary, kind }))))(
    'shows the $kind owner cause and remedy after a $boundary refusal', async ({ boundary, kind }) => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
    const credentialRef = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' };
    const reason = boundary === 'provider' ? 'network_unavailable' : 'credential_unavailable';
    const recovery = { requiredFact: boundary === 'provider' ? 'cloudflareConnection' : 'connectedAccountCredential',
      remedy: boundary === 'provider'
        ? 'The Cloudflare request could not reach the provider. Restore the connection and find zones again.'
        : 'The selected connection has no usable credential. Reconnect it before finding zones.' };
    const inspectPlatformTarget = vi.fn(async (_action: string, input: Record<string, unknown>) =>
      kind === 'tunnels' && input.zoneId === undefined
      ? { ok: true as const, value: { kind: 'ready', zones: [{ zoneId: 'zone', name: 'happier.dev' }], options: [] } }
      : boundary === 'provider'
      ? { ok: true as const, value: { kind: 'unavailable', options: [], reason, ...recovery } }
      : { ok: false as const, code: reason, details: recovery,
          failureCause: { phase: 'execution_authorization', errorClass: 'Error' as const,
            errorCode: 'credential_unavailable', httpStatus: null } });
    const addDomain = vi.fn();
    const { screen, controller, settle } = await renderTab('domains', detail,
      { listDomains: async () => ({ ok: true, value: { items: [], nextCursor: null } }) },
      { domainActions: { addDomain, inspectPlatformTarget, verifyDomain: vi.fn(), removeDomain: vi.fn() } });
    const id = 'project-deployments.environment.domains.add';
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
        screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account', account: credentialRef }, null);
      });
      expect(inspectPlatformTarget).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
      if (kind === 'tunnels') await screen.pressByTestIdAsync(`${id}.ingress.read`);
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      const failure = screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === `${id}.ingress.${kind}.error`);
      expect(failure?.props).toMatchObject({ title: recovery.remedy, diagnosticCode: reason });
      expect(screen.findByTestId(`${id}.ingress.zoneId`)).toBeNull();
      expect(addDomain).not.toHaveBeenCalled();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each([1, 2, 0, 'unavailable'] as const)('requires the named ingress choice and preserves it in Add (%s eligible)', async count => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
    const link = detail.targetLinks[0]!.targetLink;
    const credentialRef = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' },
      accountId: 'work' };
    const selection = (tunnelId: string, hostname: string) => ({ provider: { kind: 'builtin' as const, id: 'cloudflareNamed' },
      config: { hostname, controller: { accountId: 'cf-account', zoneId: 'cf-zone',
        connector: { imageRef: 'cloudflare/cloudflared:2026.10', version: '2026.10' },
        tunnel: { kind: 'adopt', tunnelId, name: tunnelId }, owned: [], dnsOwnership: [] } },
      credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount' as const, account: credentialRef } }] });
    const existing = domain('existing', 'old.happier.dev', 'active');
    const options = typeof count === 'number' ? Array.from({ length: count }, (_, i) => ({
      label: `Tunnel ${i}`, selection: selection(`tunnel-${i}`, 'docs.happier.dev'),
    })) : [];
    const inspectPlatformTarget = vi.fn(async (_action: string, input: Record<string, unknown>) => ({ ok: true as const,
      value: input.zoneId === undefined
        ? { kind: 'unavailable', options: [], reason: 'zone_list_unavailable', connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' } }
        : count === 'unavailable'
          ? { kind: 'unavailable', options: [], reason: 'denied', connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' } }
          : { kind: 'ready', options, connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' } } }));
    const addDomain = vi.fn(async () => ({ ok: true as const, environmentId: detail.environment.id,
      revision: detail.environment.revision + 1, domain: domain('new', 'docs.happier.dev', 'pending').domain }));
    const { screen, controller, settle } = await renderTab('domains', detail,
      { listDomains: async () => ({ ok: true, value: { items: [existing], nextCursor: null } }) },
      { domainActions: { addDomain, inspectPlatformTarget, verifyDomain: vi.fn(), removeDomain: vi.fn() } });
    const id = 'project-deployments.environment.domains.add';
    try {
      expect(await settle(`${id}`)).not.toBeNull();
      expect(inspectPlatformTarget).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync(id);
      const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
        const chooser = screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0];
        chooser?.props.onChange({ kind: 'account', account: credentialRef }, null);
      });
      await screen.pressByTestIdAsync(`${id}.ingress.advanced.header`);
      await act(async () => {
        for (const [field, value] of Object.entries({ accountId: 'cf-account',
          imageRef: 'cloudflare/cloudflared:2026.10', version: '2026.10' })) {
          const input = screen.findByTestId(`${id}.ingress.${field}`);
          if (input) screen.changeTextByTestId(`${id}.ingress.${field}`, value);
        }
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(addDomain).not.toHaveBeenCalled();
      expect(inspectPlatformTarget).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
      expect(inspectPlatformTarget).toHaveBeenNthCalledWith(1,
        'happier.deploy.cloudflare/actions/cloudflare-named/selections-read',
        { credentialRef, accountId: 'cf-account', hostname: 'docs.happier.dev',
          connector: { imageRef: 'cloudflare/cloudflared:2026.10', version: '2026.10' } }, { signal: expect.any(AbortSignal) });
      expect(screen.findByTestId(`${id}.ingress.zoneId`)).not.toBeNull();
      await act(async () => screen.changeTextByTestId(`${id}.ingress.zoneId`, 'cf-zone'));
      expect(screen.findByTestId(`${id}.ingress.read`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.read`);
      expect(inspectPlatformTarget).toHaveBeenNthCalledWith(2,
        'happier.deploy.cloudflare/actions/cloudflare-named/selections-read',
        { credentialRef, accountId: 'cf-account', zoneId: 'cf-zone', hostname: 'docs.happier.dev',
          connector: { imageRef: 'cloudflare/cloudflared:2026.10', version: '2026.10' } }, { signal: expect.any(AbortSignal) });
      if (count === 2) {
        await screen.pressByTestIdAsync(`${id}.save`);
        expect(addDomain).not.toHaveBeenCalled();
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${id}.ingress.tunnel`)!;
        await act(async () => picker.props.onSelect('1'));
      }
      if (count === 1) {
        await act(async () => screen.changeTextByTestId(`${id}.host`, 'changed.happier.dev'));
        await screen.pressByTestIdAsync(`${id}.save`);
        expect(addDomain).not.toHaveBeenCalled();
        await act(async () => screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev'));
      }
      await screen.pressByTestIdAsync(`${id}.save`);
      if (count === 0 || count === 'unavailable') {
        expect(addDomain).not.toHaveBeenCalled();
        expect(screen.findByTestId(`${id}.host`)?.props.value).toBe('docs.happier.dev');
      } else {
        expect(addDomain).toHaveBeenCalledExactlyOnceWith({ environmentId: detail.environment.id,
          expectedRevision: detail.environment.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
          content: { hostname: 'docs.happier.dev', target: { service: 'web', containerPort: 3000 },
            healthCheck: { path: '/', expectStatus: 200 }, ingress: options[count === 2 ? 1 : 0]!.selection } });
      }
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each([1, 2, 0])('uses listed zones and prefills only a unique zone (%s zones)', async count => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
    const credentialRef = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' };
    const zones = Array.from({ length: count }, (_, index) => ({ zoneId: `zone-${index}`, name: `zone-${index}.dev` }));
    const defaults = { accountId: 'cf-account', connector: { imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0' } };
    const ingress = { provider: { kind: 'builtin', id: 'cloudflareNamed' },
      config: { hostname: 'docs.happier.dev', controller: { accountId: 'cf-account', zoneId: `zone-${count === 2 ? 1 : 0}`,
        connector: defaults.connector,
        tunnel: { kind: 'adopt', tunnelId: 'tunnel-0', name: 'Tunnel' }, owned: [], dnsOwnership: [] } },
      credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: credentialRef } }] };
    const inspectPlatformTarget = vi.fn(async (_action: string, input: Record<string, unknown>) => ({ ok: true as const,
      value: input.zoneId === undefined ? { kind: 'ready', defaults, zones, options: [],
        connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' } }
        : { kind: 'ready', defaults, options: [{ label: 'Tunnel', selection: ingress }],
          connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' } } }));
    const addDomain = vi.fn(async () => ({ ok: true as const, environmentId: detail.environment.id,
      revision: detail.environment.revision + 1, domain: domain('new', 'docs.happier.dev', 'pending').domain }));
    const { screen, controller, settle } = await renderTab('domains', detail,
      { listDomains: async () => ({ ok: true, value: { items: [], nextCursor: null } }) },
      { domainActions: { addDomain, inspectPlatformTarget, verifyDomain: vi.fn(), removeDomain: vi.fn() } });
    const id = 'project-deployments.environment.domains.add';
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
        screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account', account: credentialRef }, null);
      });
      expect(screen.findByTestId(`${id}.ingress.accountId`)).toBeNull();
      expect(screen.findByTestId(`${id}.ingress.imageRef`)).toBeNull();
      expect(screen.findByTestId(`${id}.ingress.version`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
      expect(inspectPlatformTarget).toHaveBeenCalledExactlyOnceWith(
        'happier.deploy.cloudflare/actions/cloudflare-named/selections-read',
        { credentialRef, hostname: 'docs.happier.dev' }, { signal: expect.any(AbortSignal) });
      expect(screen.findByTestId(`${id}.ingress.zoneId`)).toBeNull();
      if (count === 1) {
        await screen.pressByTestIdAsync(`${id}.ingress.advanced.header`);
        expect(screen.findByTestId(`${id}.ingress.accountId`)?.props.value).toBe(defaults.accountId);
        expect(screen.findByTestId(`${id}.ingress.imageRef`)?.props.value).toBe(defaults.connector.imageRef);
        expect(screen.findByTestId(`${id}.ingress.version`)?.props.value).toBe(defaults.connector.version);
        await screen.pressByTestIdAsync(`${id}.ingress.advanced.header`);
      }
      if (count !== 1) {
        expect(screen.findByTestId(`${id}.ingress.read`)).toBeNull();
        await screen.pressByTestIdAsync(`${id}.save`);
        expect(addDomain).not.toHaveBeenCalled();
      }
      if (count === 0) return;
      if (count === 2) {
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const zonePicker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${id}.ingress.zone`)!;
        await act(async () => zonePicker.props.onSelect('zone-1'));
      }
      await screen.pressByTestIdAsync(`${id}.ingress.read`);
      expect(inspectPlatformTarget).toHaveBeenLastCalledWith(
        'happier.deploy.cloudflare/actions/cloudflare-named/selections-read', expect.objectContaining({ zoneId: `zone-${count === 2 ? 1 : 0}` }), { signal: expect.any(AbortSignal) });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: expect.objectContaining({ ingress }) }));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each([true, false])('shows partial Domain coverage with retained rows=%s instead of absence', async populated => {
    const { screen, controller, settle } = await renderTab('domains', createDeploymentEnvironmentDetailV1(), {
      listDomains: async () => ({ ok: true, value: { items: populated ? [domain('d1', 'api.happier.dev', 'active')] : [],
        nextCursor: null, coverage: 'partial' } }),
    });
    const id = 'project-deployments.environment.domains';
    try {
      expect(await settle(`${id}.error`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.empty`)).toBeNull();
      if (populated) expect(screen.findByTestId(`${id}.d1`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.error.retry`)).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each([true, false])('shows incomplete history alongside retained receipts=%s', async populated => {
    const receipt = createDeploymentReceiptDetailV1();
    const { screen, controller, settle } = await renderTab('history', createDeploymentEnvironmentDetailV1(), {
      listHistory: async () => ({ ok: true, value: { ok: true, items: populated ? [receipt.deployment] : [],
        nextCursor: null, coverage: 'partial' } }),
    });
    try {
      expect(await settle('project-deployments.environment.history.error')).not.toBeNull();
      if (populated) expect(screen.findByTestId(`project-deployments.receipt.row.${receipt.deployment.id}`)).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('adds, checks again and removes an address through the same Domain Actions an agent calls', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'edgeCaddy' as const, edgeMachineId: 'controller-machine' } } };
    const link = detail.targetLinks[0]!.targetLink;
    const ok = (revision: number, id: string) => ({ ok: true as const, environmentId: detail.environment.id, revision,
      domain: domain(id, 'x', 'active').domain });
    const addDomain = vi.fn(async (_input: unknown) => ok(detail.environment.revision + 1, 'new'));
    const verifyDomain = vi.fn(async (_input: unknown) => ok(detail.environment.revision, 'd1'));
    const removeDomain = vi.fn(async (_input: unknown) => ok(detail.environment.revision + 1, 'd1'));
    const { screen, controller, settle } = await renderTab('domains', detail, {
      listDomains: async () => ({ ok: true, value: { items: [domain('d1', 'api.happier.dev', 'active')], nextCursor: null } }),
    }, { domainActions: { addDomain, verifyDomain, removeDomain } });
    const id = 'project-deployments.environment.domains';
    try {
      expect(await settle(`${id}.d1`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.add`);
      expect(await settle(`${id}.add.host`)).not.toBeNull();
      await act(async () => {
        screen.changeTextByTestId(`${id}.add.host`, 'Docs.Happier.dev');
        screen.changeTextByTestId(`${id}.add.service`, 'web');
        screen.changeTextByTestId(`${id}.add.port`, '3000');
        screen.changeTextByTestId(`${id}.add.path`, '/docs');
      });
      await screen.pressByTestIdAsync(`${id}.add.save`);
      expect(addDomain).toHaveBeenCalledExactlyOnceWith({
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
        content: { hostname: 'docs.happier.dev', target: { service: 'web', containerPort: 3000, path: '/docs' },
          healthCheck: { path: '/', expectStatus: 200 } },
      });
      // A settled add closes the form and gives the section its Add button back.
      expect(await settle(`${id}.add`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.add.host`)).toBeNull();
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const rowMenu = () => screen.findAllByType(DropdownMenu).find((node) => node.props.popoverAccessibilityLabel === 'api.happier.dev');
      expect(rowMenu()?.props.items.map((item: { id: string }) => item.id)).toEqual(['verify', 'remove']);
      await act(async () => rowMenu()!.props.onSelect('verify'));
      expect(verifyDomain).toHaveBeenCalledExactlyOnceWith({ environmentId: detail.environment.id, domainId: 'd1',
        expectedRevision: detail.environment.revision, expectedDomainRevision: 1 });
      expect(await settle(`${id}.d1.menu`)).not.toBeNull();
      await act(async () => rowMenu()!.props.onSelect('remove'));
      expect(removeDomain).toHaveBeenCalledExactlyOnceWith({ environmentId: detail.environment.id, domainId: 'd1',
        expectedRevision: detail.environment.revision, expectedDomainRevision: 1 });
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it.each(['not_found', 'unavailable'] as const)('settles a lost removal only for typed %s, with recovery and its reason', async outcome => {
    const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
    const rpc = vi.mocked(machineRpcWithServerScope);
    if (outcome === 'not_found') rpc.mockResolvedValueOnce({ kind: 'not_found' });
    else rpc.mockRejectedValueOnce(new Error('controller_unavailable'));
    const detail = createDeploymentEnvironmentDetailV1();
    const address = { serverId: 'home', machineId: 'controller-machine', operationId: 'lost-remove-root' };
    const base = domain('d1', 'api.happier.dev', 'active');
    const item = { ...base, domain: { ...base.domain, state: 'removing' as const, operationAddress: address } };
    const removeDomain = vi.fn(async () => ({ ok: true as const, environmentId: detail.environment.id,
      revision: detail.environment.revision + 1, domain: item.domain }));
    const { screen, controller, settle } = await renderTab('domains', detail,
      { listDomains: async () => ({ ok: true, value: { items: [item], nextCursor: null } }) },
      { domainActions: { addDomain: vi.fn(), verifyDomain: vi.fn(), removeDomain } });
    const id = 'project-deployments.environment.domains.d1';
    try {
      expect(await settle(id)).not.toBeNull();
      await act(async () => {});
      if (outcome === 'unavailable') {
        expect(screen.getTextContent()).toContain('Removing');
        expect(screen.findByTestId(`${id}.menu`)).toBeNull();
        expect(screen.findByTestId('approvals.technical-details')).toBeNull();
      } else {
        expect(screen.findByTestId(`${id}.menu`)).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Removing');
        const disclosure = screen.findAll(node => typeof node.props.onExpandedChange === 'function')[0]!;
        await act(async () => disclosure.props.onExpandedChange(true));
        expect(screen.getTextContent()).toContain('not_found');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.popoverAccessibilityLabel === item.content.hostname)!;
        expect(menu.props.items.map((entry: { id: string }) => entry.id)).toEqual(['remove']);
        await act(async () => menu.props.onSelect('remove'));
        expect(removeDomain).toHaveBeenCalledExactlyOnceWith({ environmentId: detail.environment.id, domainId: 'd1',
          expectedRevision: detail.environment.revision, expectedDomainRevision: item.domain.revision });
      }
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each(['failed', 'cancelled'] as const)('keeps an unresolved removal busy, then shows the exact %s operation and permits a fresh Remove', async state => {
    const detail = createDeploymentEnvironmentDetailV1();
    const address = { serverId: 'home', machineId: 'controller-machine', operationId: 'remove-root' };
    const item = domain('d1', 'api.happier.dev', 'removing');
    const snapshot = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: address.operationId,
      revision: 1, actionId: 'deployments.domains.remove', state: 'running',
      scope: { accountId: scope.accountId, machineId: address.machineId }, title: 'Remove deployment domain',
      createdAt: 1, startedAt: 2, cancellation: 'supported' });
    const reads = vi.fn(async () => ({ ok: true as const, value: {
      items: [{ ...item, domain: { ...item.domain, operationAddress: address } }], nextCursor: null,
    } }));
    const removeDomain = vi.fn(async () => ({ ok: true as const, environmentId: detail.environment.id,
      revision: detail.environment.revision + 1, domain: item.domain }));
    const verifyDomain = vi.fn();
    actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [snapshot] });
    const { screen, controller, settle } = await renderTab('domains', detail, { listDomains: reads },
      { domainActions: { addDomain: vi.fn(), verifyDomain, removeDomain } });
    const id = 'project-deployments.environment.domains.d1';
    try {
      expect(await settle(id)).not.toBeNull();
      expect(screen.getTextContent()).toContain('Removing');
      expect(screen.findByTestId(`${id}.menu`)).toBeNull();
      const before = reads.mock.calls.length;
      // A different newer removal must not unlock this row or trigger collection reads.
      await act(async () => actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [
        ActionOperationSnapshotV1Schema.parse({ ...snapshot, operationId: 'unrelated-removal',
          createdAt: 10, startedAt: 11, settledAt: 12, state: 'cancelled' }),
      ] }));
      expect(screen.findByTestId(`${id}.menu`)).toBeNull();
      expect(reads).toHaveBeenCalledTimes(before);
      await act(async () => actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [
        ActionOperationSnapshotV1Schema.parse({ ...snapshot, revision: 2, state, settledAt: 3,
          ...(state === 'failed' ? { error: { errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable',
            details: { environmentId: detail.environment.id, domainId: 'd1', step: 'native_execution',
              requiredFact: 'publicCaddyListener', remedy: 'Restore the public listener, then retry Remove.', operation: address } } } : {}),
        }),
      ] }));
      expect(await settle(`${id}.menu`)).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('Removing');
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const menu = screen.findAllByType(DropdownMenu).find(node => node.props.popoverAccessibilityLabel === item.content.hostname)!;
      expect(menu.props.items.map((entry: { id: string }) => entry.id)).toEqual(['remove']);
      if (state === 'failed') {
        const disclosure = screen.findAll(node => typeof node.props.onExpandedChange === 'function')[0]!;
        await act(async () => disclosure.props.onExpandedChange(true));
        expect(screen.getTextContent()).toContain('required_fact_unavailable');
        expect(screen.getTextContent()).toContain('publicCaddyListener');
        expect(screen.getTextContent()).toContain('Restore the public listener, then retry Remove.');
      }
      await act(async () => menu.props.onSelect('remove'));
      expect(removeDomain).toHaveBeenCalledExactlyOnceWith({ environmentId: detail.environment.id, domainId: 'd1',
        expectedRevision: detail.environment.revision, expectedDomainRevision: 1 });
      expect(verifyDomain).not.toHaveBeenCalled();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('shows the exact failed Add while its Domain is pending and keeps the normal Domain actions available', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const address = { serverId: 'home', machineId: 'controller-machine', operationId: 'add-root' };
    const item = domain('d1', 'api.happier.dev', 'pending');
    const snapshot = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: address.operationId,
      revision: 2, actionId: 'deployments.domains.add', state: 'failed',
      scope: { accountId: scope.accountId, machineId: address.machineId }, title: 'Add deployment domain',
      createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
      error: { errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable',
        details: { environmentId: detail.environment.id, domainId: 'd1', step: 'native_execution',
          requiredFact: 'publicCaddyListener', remedy: 'Restore the public listener, then retry Add.', operation: address } },
    });
    actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [snapshot] });
    const { screen, controller, settle } = await renderTab('domains', detail, {
      listDomains: async () => ({ ok: true, value: { items: [{ ...item,
        domain: { ...item.domain, operationAddress: address } }], nextCursor: null } }),
    }, { domainActions: { addDomain: vi.fn(), verifyDomain: vi.fn(), removeDomain: vi.fn() } });
    try {
      expect(await settle('project-deployments.environment.domains.d1')).not.toBeNull();
      expect(screen.getTextContent()).toContain('Failed');
      expect(screen.findAllHostsByTestId('approvals.technical-details')).toHaveLength(1);
      const disclosure = screen.findAll(node => typeof node.props.onExpandedChange === 'function')[0]!;
      await act(async () => disclosure.props.onExpandedChange(true));
      expect(screen.getTextContent()).toContain('required_fact_unavailable');
      expect(screen.getTextContent()).toContain('publicCaddyListener');
      expect(screen.getTextContent()).toContain('Restore the public listener, then retry Add.');
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const menu = screen.findAllByType(DropdownMenu).find(node => node.props.popoverAccessibilityLabel === item.content.hostname)!;
      expect(menu.props.items.map((entry: { id: string }) => entry.id)).toEqual(['verify', 'remove']);
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('stays read-only where the page cannot write', async () => {
    const { screen, controller, settle } = await renderTab('domains', createDeploymentEnvironmentDetailV1(), {
      listDomains: async () => ({ ok: true, value: { items: [domain('d1', 'api.happier.dev', 'active')], nextCursor: null } }),
    });
    try {
      expect(await settle('project-deployments.environment.domains.d1')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.domains.add')).toBeNull();
      expect(screen.findByTestId('project-deployments.environment.domains.d1.menu')).toBeNull();
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('lists each address with where it leads, says a failing one failed, and pages only on request', async () => {
    const cursors: (string | undefined)[] = [];
    const { screen, controller, settle } = await renderTab(
      'domains',
      createDeploymentEnvironmentDetailV1(),
      {
        listDomains: async (_scope, _environmentId, query) => {
          cursors.push(query.cursor);
          return query.cursor
            ? {
                ok: true,
                value: {
                  items: [domain('d3', 'status.happier.dev', 'active')],
                  nextCursor: null,
                },
              }
            : {
                ok: true,
                value: {
                  items: [
                    domain('d1', 'api.happier.dev', 'active'),
                    domain('d2', 'www.happier.dev', 'failed', {
                      redirectTo: 'happier.dev',
                    }),
                  ],
                  nextCursor: 'two',
                },
              };
        },
      },
    );
    try {
      expect(
        await settle('project-deployments.environment.domains.d1'),
      ).not.toBeNull();
      const text = screen.getTextContent();
      expect(text).toContain('api.happier.dev');
      expect(text).toContain('web : 3000');
      expect(text).toContain('happier.dev');
      expect(
        screen.findByTestId('project-deployments.environment.domains.empty'),
      ).toBeNull();
      expect(cursors).toEqual([undefined]);
      await screen.pressByTestIdAsync(
        'project-deployments.environment.domains.next',
      );
      expect(
        await settle('project-deployments.environment.domains.d3'),
      ).not.toBeNull();
      expect(cursors).toEqual([undefined, 'two']);
    } finally {
      controller.retire();
    }
  });

  it('says a refused read is refused, and an unavailable one failed with Retry that reads again', async () => {
    let reads = 0;
    const refused = await renderTab(
      'domains',
      createDeploymentEnvironmentDetailV1(),
      {
        listDomains: async () => ({
          ok: false,
          failure: { code: 'deployment_access_denied', retryable: false },
        }),
      },
    );
    try {
      expect(
        await refused.settle('project-deployments.environment.domains.denied'),
      ).not.toBeNull();
      expect(
        refused.screen.findByTestId(
          'project-deployments.environment.domains.empty',
        ),
      ).toBeNull();
    } finally {
      refused.controller.retire();
    }
    const failed = await renderTab(
      'domains',
      createDeploymentEnvironmentDetailV1(),
      {
        listDomains: async () => {
          reads += 1;
          return {
            ok: false,
            failure: { code: 'deployment_unavailable', retryable: true },
          };
        },
      },
    );
    try {
      expect(
        await failed.settle('project-deployments.environment.domains.error'),
      ).not.toBeNull();
      const before = reads;
      const disclosure = failed.screen.findAllByTestId('approvals.technical-details')
        .find(node => typeof node.props.onExpandedChange === 'function');
      expect(disclosure).toBeDefined();
      await act(async () => disclosure!.props.onExpandedChange(true));
      expect(failed.screen.getTextContent()).toContain('deploymentActionResult');
      await failed.screen.pressByTestIdAsync(
        'project-deployments.environment.domains.error.retry',
      );
      expect(reads).toBeGreaterThan(before);
    } finally {
      failed.controller.retire();
    }
  });
});

describe('Environment → Overview before the first deploy', () => {
  it('says the Machine builds the first deploy when a Machine is linked, even without a Compose path', async () => {
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({
      content: { ...base.content, definition: { kind: 'repository', ref: 'main' } } as never,
      targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1({ activeDeploymentId: undefined }),
        content: base.targetLinks[0]!.content }],
    });
    const { screen, controller, settle } = await renderTab('overview', detail);
    try {
      const none = await settle('project-deployments.environment.serving.none');
      expect(none).not.toBeNull();
      const { t } = await import('@/text');
      const text = screen.getTextContent();
      expect(text).not.toContain(t('projects.deployments.platformLink.nothingDeployedBody'));
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Environment → manager edits', () => {
  it.each(['neverDeployed', 'deployed', 'failed'] as const)('offers first-Machine replacement only before deployment history exists (%s)', async state => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'First Machine', serverUrl: 'https://first-machine.test',
      accountId: scope.accountId, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const link = createDeploymentTargetLinkHeaderV1({ state: state === 'deployed' ? 'deployed' : 'configured',
      activeDeploymentId: state === 'deployed' ? 'deployment-a' : undefined });
    const detail = createDeploymentEnvironmentDetailV1({ environment: { ...base.environment, serverId },
      targetLinks: [{ targetLink: link, content: base.targetLinks[0]!.content }] });
    const actions = (await import('./deploymentActions')).createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId);
    const { screen, controller, settle } = await renderTab('settings', detail, {
      listHistory: async () => ({ ok: true, value: { ok: true, items: state === 'failed'
        ? [{ ...createDeploymentReceiptDetailV1().deployment, targetLinkId: link.id, state: 'failed' as const }]
        : [], nextCursor: null } }),
    }, {
      serverId, disposition: actions, lifetime: account.accountLifetime,
    });
    const id = 'project-deployments.environment.settings.servers-build.change';
    try {
      expect(await settle('project-deployments.environment.settings.servers-build')).not.toBeNull();
      if (state !== 'neverDeployed') expect(screen.findByTestId(id)).toBeNull();
      else {
        expect(await settle(id)).not.toBeNull();
        await screen.pressByTestIdAsync(id);
        expect(screen.findByTestId('project-deployments.link')).not.toBeNull();
      }
      expect(homes.requestsFor('/v1/actions/deployments.targets.link')).toHaveLength(0);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); }
  });

  it.each([false, true])('saves fleet ingress through the real Environment Action without saving a suggestion on mount (%s)', async hasEdgeFacts => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Fleet ingress', serverUrl: 'https://fleet-ingress.test',
      serverIdentityId: 'srv_fleet_ingress', accountId: scope.accountId, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const link = createDeploymentTargetLinkHeaderV1({ machines: ['machine-a', 'machine-b'], members: [
      { machineId: 'machine-a', installationId: 'installation-a', state: 'active' },
      { machineId: 'machine-b', installationId: 'installation-b', state: 'active' },
    ] });
    const detail = createDeploymentEnvironmentDetailV1({
      environment: { ...base.environment, serverId },
      targetLinks: [{ targetLink: link, content: base.targetLinks[0]!.content }],
    });
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { MachineReachabilityObservationV1Schema } = await import('@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1');
    const reachability = (edge: boolean) => MachineReachabilityObservationV1Schema.parse({
      revision: 0, management: { daemon: 'ready', providers: [], publicSsh: 'unknown' },
      privateNetworks: [{ provider: { kind: 'builtin', id: 'tailscale' }, networkIdentity: 'fleet-network',
        displayName: null, dnsName: null, addresses: [edge ? '100.64.0.11' : '100.64.0.10'], state: 'ready',
        interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: false }],
      ingress: edge ? [{ revision: 0, provider: { kind: 'builtin', id: 'caddy' }, exposure: 'public',
        inboundPorts: [{ port: 443, protocol: 'tcp', exposure: 'public' }],
        https: { hostname: 'custom', ports: [443], paths: true }, state: 'ready', remedies: [] }] : [],
    });
    await publishMachineInventoryForTest({ serverId, accountId: scope.accountId }, [
      createMachineFixture({ id: 'machine-a', installationId: 'installation-a',
        ...(hasEdgeFacts ? { daemonState: { reachability: reachability(false) } } : {}) }),
      createMachineFixture({ id: 'machine-b', installationId: 'installation-b',
        ...(hasEdgeFacts ? { daemonState: { reachability: reachability(true) } } : {}) }),
    ]);
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
      body: { ok: true, environment: detail.environment, targetLinks: [link] },
    });
    const effects: unknown[] = [];
    await answerExternalActionAccountForHome(homes, serverId, {
      actionId: 'deployments.environments.update', machineId: detail.environment.controllerMachineId,
      installationId: 'installation-a', tokenEpoch: 0,
      execute: input => { effects.push(input); return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 }; },
    });
    const actions = (await import('./deploymentActions')).createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId);
    const { screen, controller, settle } = await renderTab('settings', detail, {}, {
      serverId, environmentActions: actions, lifetime: account.accountLifetime,
    });
    const id = 'project-deployments.environment.settings.servers-build.ingress';
    try {
      expect(await settle('project-deployments.environment.settings.servers-build')).not.toBeNull();
      expect(await settle(id)).not.toBeNull();
      expect(effects).toEqual([]);
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const picker = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === id)!;
      expect(picker().props.selectedId).toBe(hasEdgeFacts ? 'edge:machine-b' : null);
      if (!hasEdgeFacts) {
        await publishMachineInventoryForTest({ serverId, accountId: scope.accountId }, [
          createMachineFixture({ id: 'machine-a', installationId: 'installation-a',
            daemonState: { reachability: reachability(false) } }),
          createMachineFixture({ id: 'machine-b', installationId: 'installation-b',
            daemonState: { reachability: reachability(true) } }),
        ]);
        await vi.waitFor(() => expect(picker().props.selectedId).toBe('edge:machine-b'));
        expect(effects).toEqual([]);
      }
      await act(async () => picker().props.onSelect('edge:machine-b'));
      await vi.waitFor(() => expect(effects).toHaveLength(1));
      expect(effects[0]).toMatchObject({ environmentId: detail.environment.id,
        patch: { ingress: { kind: 'edgeCaddy', edgeMachineId: 'machine-b' } } });
      await act(async () => picker().props.onSelect('tunnel'));
      await vi.waitFor(() => expect(effects).toHaveLength(2));
      expect(effects[1]).toMatchObject({ patch: { ingress: { kind: 'cloudflareTunnel' } } });
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('moves the controller and the build Machine, and changes who may deploy, through the Environment Actions', async () => {
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    await publishMachineInventoryForTest({ serverId: scope.serverId, accountId: scope.accountId }, [
      createMachineFixture({ id: 'machine-a', installationId: 'installation-a' }),
      createMachineFixture({ id: 'machine-b', installationId: 'installation-b' }),
    ]);
    const detail = createDeploymentEnvironmentDetailV1();
    const settled = { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    const setController = vi.fn(async (..._args: unknown[]) => settled);
    const updateEnvironment = vi.fn(async (..._args: unknown[]) => settled);
    const environmentActions = { setController, updateEnvironment };
    const picker = (screen: Awaited<ReturnType<typeof renderTab>>['screen'], testID: string) =>
      screen.findAllByType(DropdownMenu).find((node) => node.props.testID === testID);
    const settings = await renderTab('settings', detail, {}, { environmentActions });
    try {
      expect(await settings.settle('project-deployments.environment.settings.controller')).not.toBeNull();
      const controllerPicker = picker(settings.screen, 'project-deployments.environment.settings.controller.machine');
      expect(controllerPicker?.props.items).toMatchObject([{ id: 'machine-a', checked: true }, { id: 'machine-b' }]);
      await act(async () => controllerPicker!.props.onSelect('machine-b'));
      expect(setController).toHaveBeenCalledExactlyOnceWith(detail.environment, 'machine-b');
      await act(async () => picker(settings.screen, 'project-deployments.environment.settings.servers-build.buildsOn')!
        .props.onSelect('machine-b'));
      expect(updateEnvironment).toHaveBeenCalledExactlyOnceWith(detail.environment, { buildMachineId: 'machine-b' });
      // How it deploys (review/howitdeploys): rollout, restore-on-fail and kept-for-rollback save through the same Action.
      const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
      const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
      const { Switch } = await import('@/components/ui/forms/Switch');
      const rolloutId = 'project-deployments.environment.settings.rollout';
      const rollout = settings.screen.findAllByType(SegmentedChoiceItem).find((node) => node.props.testID === `${rolloutId}.rollout`);
      await act(async () => rollout!.props.onChange('startFirst'));
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment, { ownServer: { rollout: 'startFirst' } });
      const restore = settings.screen.findAllByType(Switch)[0]!;
      await act(async () => restore.props.onValueChange(!restore.props.value));
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment,
        { ownServer: { autoRestorePreviousRelease: !restore.props.value } });
      const kept = settings.screen.findAllByType(FieldValueItem).find((node) => node.props.testID === `${rolloutId}.kept`);
      await act(async () => { kept!.props.onCommit('3'); });
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment, { retainPreviousDeployments: 3 });
      const { DeploymentEnvironmentUpdateInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
      // An agent sends the same patches to the same Action.
      for (const call of updateEnvironment.mock.calls) {
        expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ serverId: 'srv', environmentId: detail.environment.id,
          expectedRevision: 1, contentArtifactId: detail.environment.contentArtifactId,
          contentHeaderVersion: detail.environment.contentHeaderVersion, contentBodyVersion: detail.environment.contentBodyVersion,
          patch: call[1] }).success).toBe(true);
      }
    } finally {
      await settings.screen.unmount();
      settings.controller.retire();
    }
    const permissions = await renderTab('permissions', detail, {}, { environmentActions });
    try {
      expect(await permissions.settle('project-deployments.environment.permissions')).not.toBeNull();
      const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
      const deployers = permissions.screen.findAllByType(SegmentedChoiceItem)
        .find((node) => node.props.testID === 'project-deployments.environment.permissions.deployers');
      expect(deployers?.props.options.map((option: { id: string }) => option.id)).toEqual(['managers', 'members']);
      await act(async () => deployers!.props.onChange('members'));
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment, { deployerMode: 'members' });
    } finally {
      await permissions.screen.unmount();
      permissions.controller.retire();
    }
  });

  it('keeps the settings read-only for a viewer who is not a manager', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, environment: { ...base.environment,
      capabilities: { ...base.environment.capabilities, role: 'deployer' as const } } };
    const environmentActions = { setController: vi.fn(), updateEnvironment: vi.fn() };
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { environmentActions });
    try {
      expect(await settle('project-deployments.environment.settings.controller')).not.toBeNull();
      expect(screen.findAllByType(DropdownMenu).filter((node) =>
        String(node.props.testID ?? '').startsWith('project-deployments.environment.settings'))).toHaveLength(0);
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Environment → Settings: checks, backups, previews', () => {
  const backup = {
    configRevision: 1,
    destinationRef: { pluginId: 'happier.backups-s3', localId: 'open' },
    occurrenceId: 'nightly',
    config: {},
    credentialBindings: [],
    ownership: { environmentId: 'environment-staging', prefix: 'staging/' },
    sources: [
      {
        kind: 'dump' as const,
        sourceId: 'db',
        service: 'postgres',
        consistency: 'logical' as const,
      },
    ],
    retention: { kind: 'keep' as const, last: 7 },
  };

  it('shows unavailable nightly backup schedule discovery instead of a known Off', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Schedule unavailable', serverUrl: 'https://schedule-unavailable.test',
      serverIdentityId: 'srv_schedule_unavailable', accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, backup } });
    homes.answer(serverId, 'POST /v3/automations/query', { status: 503, body: { error: 'storage_unavailable' } });
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      environmentActions: { setController: vi.fn(), updateEnvironment: vi.fn() } });
    const id = 'project-deployments.environment.settings.backups';
    const { t } = await import('@/text');
    try {
      expect(await settle(`${id}.schedule`)).not.toBeNull();
      await vi.waitFor(() => expect(homes.requestsFor('/v3/automations/query')).not.toHaveLength(0));
      await vi.waitFor(() => {
        const subtitle = screen.findAllByProps({ testID: `${id}.schedule` })[0]?.props.subtitle;
        expect(subtitle).toContain(t('common.unavailable'));
        // The unavailable label alone is insufficient: the Action's failure must also be visible.
        expect(subtitle).not.toBe(t('common.unavailable'));
      });
      expect(screen.findByTestId(`${id}.schedule.on`)).toBeNull();
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('shows a refused nightly backup schedule creation without changing the known Off state', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Schedule creation', serverUrl: 'https://schedule-creation.test',
      serverIdentityId: 'srv_schedule_creation', accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, backup } });
    const { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } =
      await import('@/dev/testkit/fixtures/machineFixtures');
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
      body: await createMachineReadBatchResponseFixture(body, id =>
        createPlainMachineRowFixture({ id, accountId: 'account-owner' })).json(),
    }) });
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      environmentActions: { setController: vi.fn(), updateEnvironment: vi.fn() } });
    const id = 'project-deployments.environment.settings.backups';
    const { t } = await import('@/text');
    const { presentActionFailureOutcome } = await import('@/components/tools/shell/approvals/approvalFailureOutcome');
    const subtitle = () => screen.findAllByProps({ testID: `${id}.schedule` })[0]?.props.subtitle;
    try {
      expect(await settle(`${id}.schedule.on`)).not.toBeNull();
      const off = t('projects.deployments.settingsSections.scheduleOff');
      expect(subtitle()).toBe(off);
      // The real Action policy refuses creation without approval, before the Home write.
      await screen.pressByTestIdAsync(`${id}.schedule.on`);
      const failure = presentActionFailureOutcome({ ok: false, errorCode: 'approval_required', error: 'approval_required' }, 'deployment');
      expect(subtitle()).toBe(`${off} · ${failure.reason}`);
      expect(screen.findByTestId(`${id}.schedule.on`)).not.toBeNull();
      expect(homes.requestsFor('/v3/automations')).toHaveLength(0);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('backs up and verifies an exact snapshot through the real store and Action front door, showing the destination and result', async () => {
    await homes.reset();
    const serverIdentityId = 'srv_backups';
    const serverId = await homes.addHome({ name: 'Backups', serverUrl: 'https://backups.test',
      serverIdentityId, accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content,
      backup: { ...backup, config: { bucket: 'team-recovery', prefix: 'staging/', region: 'eu-central-1' } } } });
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
      body: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) },
    });
    const snapshot = { snapshotId: 'a'.repeat(64), treeId: 'b'.repeat(64), hostname: 'db-host',
      time: '2026-11-06T10:00:00Z', paths: ['/database.dump'], tags: [] };
    const manifest = { schemaVersion: 1, environmentId: detail.environment.id, sourceId: 'db', kind: 'dump',
      configRevision: 1, repositoryId: 'c'.repeat(64), snapshot, totalBytesProcessed: 123,
      totalFilesProcessed: 1, producerChecksumSha256: 'd'.repeat(64) };
    const effects: Array<{ actionId: string; input: unknown }> = [];
    let destinationTests = 0;
    const { DEPLOYMENT_BACKUP_ACTION_IDS_V1 } = await import('@happier-dev/protocol/deployments/deploymentActionIdsV1');
    for (const actionId of DEPLOYMENT_BACKUP_ACTION_IDS_V1) {
      // Only the remote transport/native boundary is substituted; the UI's real Action executor runs.
      await answerExternalActionAccountForHome(homes, serverId, { actionId, machineId: 'machine-a',
        installationId: 'installation-a', tokenEpoch: 0,
        failure: result => {
          const code = result && typeof result === 'object' ? Reflect.get(result, 'errorCode') : null;
          return typeof code === 'string' ? { errorCode: code, error: code } : null;
        }, execute: input => {
        effects.push({ actionId, input });
        if (actionId === 'deployments.backups.test' && destinationTests++ > 0) {
          return { errorCode: destinationTests === 2 ? 'backup_required' : 'secret_missing' };
        }
        const result = actionId === 'deployments.backups.run' ? { kind: 'verified', operationId: 'backup-operation', manifests: [manifest] }
          : actionId === 'deployments.backups.test' ? { kind: 'failed', step: 'repository', reason: 'repository_password_incorrect',
            nativeExitCode: 12, remedy: 'review_credentials' }
          : actionId === 'deployments.backups.history' ? { kind: 'history', environmentId: detail.environment.id, configRevision: 1,
            ...(effects.some(effect => effect.actionId === 'deployments.backups.run') ? {
              lastSuccessfulBackup: { operationId: 'backup-operation', completedAt: Date.parse('2026-11-06T10:01:00Z'),
                configRevision: 1, snapshotIds: [snapshot.snapshotId] },
              history: { entries: [{ operationId: 'backup-operation', action: 'backup', state: 'succeeded', configRevision: 1,
                startedAt: Date.parse('2026-11-06T10:00:00Z'), completedAt: Date.parse('2026-11-06T10:01:00Z'),
                snapshotIds: [snapshot.snapshotId] }] },
            } : { history: { entries: [{ operationId: 'nightly-failed', action: 'backup', state: 'failed', configRevision: 1,
              startedAt: Date.parse('2026-11-06T02:00:00Z'), completedAt: Date.parse('2026-11-06T02:01:00Z'), snapshotIds: [],
              code: 'backup_failed', step: 'backup' }] } }) }
          : actionId === 'deployments.backups.prune' ? { kind: 'pruned', environmentId: detail.environment.id, configRevision: 1,
            forgottenSnapshotIds: ['f'.repeat(64), 'e'.repeat(64)] }
          : actionId === 'deployments.backups.inventory' ? { kind: 'inventory', environmentId: detail.environment.id,
            configRevision: 1, repositoryId: manifest.repositoryId, snapshots: [{ snapshot, source: { sourceId: 'db', kind: 'dump' },
              verification: { kind: 'verified', backupOperationId: 'backup-operation', configRevision: 1 } },
              { snapshot: { ...snapshot, snapshotId: 'e'.repeat(64) }, source: null,
                verification: { kind: 'unknown', reason: 'captureReceiptUnavailable' } }] }
          : { kind: 'verified', operationId: 'verify-operation', backupOperationId: 'backup-operation', environmentId: detail.environment.id,
            configRevision: 1, repositoryId: manifest.repositoryId, snapshotId: snapshot.snapshotId,
            level: Reflect.get(input as object, 'level'), verified: true };
        return result;
      } });
    }
    const settled = { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    const updateEnvironment = vi.fn(async (..._args: unknown[]) => settled);
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      environmentActions: { setController: vi.fn(), updateEnvironment } });
    const id = 'project-deployments.environment.settings.backups';
    try {
      expect(await settle(`${id}.run`)).not.toBeNull();
      expect(screen.getTextContent()).toContain('team-recovery');
      expect(screen.getTextContent()).toContain('staging/');
      // Opening Settings reads only the recorded history (the owner's facts); it runs and verifies nothing.
      await vi.waitFor(() => expect(screen.getTextContent()).toContain('Backup failed'));
      expect(effects.map((effect) => effect.actionId)).toEqual(['deployments.backups.history']);
      await screen.pressByTestIdAsync(`${id}.verify`);
      expect(await settle(`${id}.snapshot.${'e'.repeat(64)}`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.snapshot.${'e'.repeat(64)}.manifestReadBack`)).toBeNull();
      expect(effects[1]).toMatchObject({ actionId: 'deployments.backups.inventory' });
      await screen.pressByTestIdAsync(`${id}.verify`);
      await screen.pressByTestIdAsync(`${id}.run`);
      expect(await settle(`${id}.result`)).not.toBeNull();
      expect(effects.find(effect => effect.actionId === 'deployments.backups.run')).toMatchObject({ actionId: 'deployments.backups.run', input: {
        serverId: serverIdentityId, environmentId: detail.environment.id, expectedRevision: 1, configRevision: 1,
        machineId: 'machine-a', installationId: 'installation-a', targetLinkId: 'target-link', deploymentId: 'deployment-a',
      } });
      const { formatAsOfTime } = await import('@/utils/time/formatAsOfTime');
      await vi.waitFor(() => expect(screen.findAllByProps({ testID: `${id}.status`,
        detail: formatAsOfTime(Date.parse('2026-11-06T10:01:00Z')) })).not.toHaveLength(0));
      expect(effects.filter(effect => effect.actionId === 'deployments.backups.history')).toHaveLength(2);
      await screen.pressByTestIdAsync(`${id}.verify`);
      expect(await settle(`${id}.snapshot.${snapshot.snapshotId}.manifestReadBack`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.snapshot.${snapshot.snapshotId}.manifestReadBack`);
      expect(effects.at(-1)).toMatchObject({ actionId: 'deployments.backups.verify', input: {
        backupOperationId: 'backup-operation', snapshotId: snapshot.snapshotId, level: 'manifestReadBack',
      } });
      await screen.pressByTestIdAsync(`${id}.snapshot.${snapshot.snapshotId}.repositoryCheck`);
      expect(effects.at(-1)).toMatchObject({ actionId: 'deployments.backups.verify', input: { level: 'repositoryCheck' } });
      expect(screen.getTextContent()).toContain('Repository check');
      // Test probes the saved destination read-only and names what to check (lab d7d/destfail).
      await screen.pressByTestIdAsync(`${id}.destination.test`);
      expect(effects.at(-1)).toMatchObject({ actionId: 'deployments.backups.test', input: {
        environmentId: detail.environment.id, configRevision: 1, targetLinkId: 'target-link', deploymentId: 'deployment-a' } });
      expect(screen.getTextContent()).toContain("The repository password doesn't match");
      await screen.pressByTestIdAsync(`${id}.destination.test`);
      expect(screen.getTextContent()).toContain('Configure and run a backup');
      await screen.pressByTestIdAsync(`${id}.destination.test`);
      expect(screen.getTextContent()).toContain('A required secret is missing');
      // Remove old backups now forgets what is past the saved counts, through the agent's prune Action.
      await screen.pressByTestIdAsync(`${id}.prune.run`);
      expect(effects.at(-1)).toMatchObject({ actionId: 'deployments.backups.prune', input: {
        retention: { kind: 'keep', last: 7 }, configRevision: 1, machineId: 'machine-a' } });
      expect(screen.getTextContent()).toContain('Removed 2 old backups');
      // Keep counts are edited in place and saved once through environments.update (lab database/keep).
      await screen.pressByTestIdAsync(`${id}.retention.change`);
      await act(async () => {
        screen.changeTextByTestId(`${id}.retention.last.input`, '');
        screen.changeTextByTestId(`${id}.retention.daily.input`, '14');
        screen.changeTextByTestId(`${id}.retention.weekly.input`, '8');
      });
      await screen.pressByTestIdAsync(`${id}.retention.save`);
      expect(updateEnvironment).toHaveBeenCalledExactlyOnceWith(detail.environment, {
        backupRetention: { configRevision: 1, retention: { kind: 'keep', daily: 14, weekly: 8 } } });
      const { DeploymentEnvironmentUpdateInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
      // The agent path sends the same Action and patch.
      expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ serverId: serverIdentityId, environmentId: detail.environment.id,
        expectedRevision: 1, contentArtifactId: detail.environment.contentArtifactId,
        contentHeaderVersion: detail.environment.contentHeaderVersion, contentBodyVersion: detail.environment.contentBodyVersion,
        patch: updateEnvironment.mock.calls[0]![1] }).success).toBe(true);
      // History and missed schedules belong to the Database page (P9), never a second list here.
      expect(screen.findByTestId(`${id}.history`)).toBeNull();
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('opens the health-check trigger editor for this Environment on its controller without creating a trigger', async () => {
    const { TriggerPopover } = await import('@/components/workflows/triggers/TriggerPopover');
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Checks', serverUrl: 'https://checks.test',
      serverIdentityId: 'srv_checks', accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const detail = createDeploymentEnvironmentDetailV1();
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      environmentActions: { setController: vi.fn(), updateEnvironment: vi.fn() } });
    const id = 'project-deployments.environment.settings.checks-alerts';
    try {
      expect(await settle(`${id}.add`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.add`);
      const editor = screen.findByType(TriggerPopover);
      expect(editor.props).toMatchObject({ serverId: account.accountLifetime.scope.serverId, machineId: detail.environment.controllerMachineId,
        initialWhen: { kind: 'pluginEvent', eventRef: { pluginId: 'happier.machine.services', localId: 'health-check-failed' } },
        initialEventSeed: { monitoringMachineId: detail.environment.controllerMachineId,
          setupInput: { v: 1, subject: { kind: 'environment', environmentId: detail.environment.id } } } });
      expect(await settle('automation-plugin-event-cancel')).not.toBeNull();
      expect(homes.requestsFor('/v1/actions/workflow.trigger.add')).toEqual([]);
      await screen.pressByTestIdAsync('automation-plugin-event-cancel');
      expect(await settle(`${editor.props.testID}-cancel`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${editor.props.testID}-cancel`);
      expect(screen.findAllByType(TriggerPopover)).toEqual([]);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('shows the preview template it carries: on, where previews run, their address, data and that forks get none', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const runtimeLinkId = base.environment.runtimeTargetLinkId ?? base.targetLinks[0]!.targetLink.id;
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, previewTemplate: {
      v: 1, enabled: true, forkPreviews: 'off',
      repository: { kind: 'github', deployment: 'https://github.example/enterprise', repository: 'owner/app' },
      runtimeTargetLinkId: runtimeLinkId,
      domain: { domainId: 'wildcard', templateSlug: 'app', hostnamePattern: 'pr-{number}.preview.happier.dev' },
      bindingBlueprints: [],
      data: [{ kind: 'managed', dataTargetLinkId: 'neon-link', ownership: 'providerNative',
        parentBranchRef: { providerProjectId: 'neon-project', branchId: 'main' } }],
    } } });
    const settled = { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    const updateEnvironment = vi.fn(async (..._args: unknown[]) => settled);
    const { screen, controller, settle } = await renderTab('settings', detail, {},
      { environmentActions: { setController: vi.fn(), updateEnvironment } });
    const id = 'project-deployments.environment.settings.previews.template';
    const template = detail.content.previewTemplate!;
    try {
      expect(await settle(`${id}.enabled`)).not.toBeNull();
      const text = screen.getTextContent();
      expect(text).toContain('On for new pull requests');
      expect(text).toContain('A branch of the database');
      // The template runs on this Environment's own runtime link: the production-Machine warning shows.
      expect(text).toContain('Previews share the production Machine');
      expect(screen.findByTestId(`${id}.forks`)).not.toBeNull();
      // A manager edits the template; each change saves the whole template once through environments.update.
      await screen.pressByTestIdAsync(`${id}.enabled`);
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment, { previewTemplate: { ...template, enabled: false } });
      const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
      const address = screen.findAllByType(FieldValueItem).find((node) => node.props.testID === `${id}.address`)!;
      expect(address.props.value).toBe('pr-{number}.preview.happier.dev');
      await act(async () => { address.props.onCommit('pr-{number}.staging.happier.dev'); });
      await screen.pressByTestIdAsync(`${id}.domain.save`);
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment, { previewTemplate: { ...template,
        domain: { ...template.domain!, hostnamePattern: 'pr-{number}.staging.happier.dev' } } });
      const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
      const data = screen.findAllByType(SegmentedChoiceItem).find((node) => node.props.testID === `${id}.data`)!;
      // Its own database needs a catalog data choice this template never had, so it isn't offered as if it could save.
      expect(data.props.options.find((option: { id: string }) => option.id === 'own')).toMatchObject({ disabled: true });
      await act(async () => data.props.onChange('none'));
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment, { previewTemplate: { ...template, data: [] } });
      const { DeploymentEnvironmentUpdateInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
      // An agent sends the same patch to the same Action.
      for (const call of updateEnvironment.mock.calls) {
        expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ serverId: 'srv', environmentId: detail.environment.id,
          expectedRevision: 1, contentArtifactId: detail.environment.contentArtifactId,
          contentHeaderVersion: detail.environment.contentHeaderVersion, contentBodyVersion: detail.environment.contentBodyVersion,
          patch: call[1] }).success).toBe(true);
      }
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('offers a managed branch for an unseeded template with a linked database, without reading provider branches before selection', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Preview database', serverUrl: 'https://preview-database.test', accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, previewTemplate: {
      v: 1, enabled: true, forkPreviews: 'off', repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/shop' },
      runtimeTargetLinkId: base.environment.runtimeTargetLinkId!, domain: null, bindingBlueprints: [], data: [],
    } }, targetLinks: [...base.targetLinks, { targetLink: createDeploymentTargetLinkHeaderV1({ id: 'managed-data', role: 'data',
      targetKind: 'managed', machines: [], members: [], source: { kind: 'plugin', contribution: { pluginId: 'com.example.database', localId: 'database' } } }),
      content: { providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'main' },
        providerEnvironment: { kind: 'custom', id: 'main' }, credentialPrincipal: { kind: 'account', accountId: 'account-owner',
          purpose: { consumer: { pluginId: 'com.example.database', localId: 'link' }, purpose: 'database.manage' },
          target: { kind: 'account', account: { service: { pluginId: 'com.example.database', localId: 'database' }, accountId: 'token' } } } } }] });
    const actions = (await import('./deploymentActions')).createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId);
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { environmentActions: actions, lifetime: account.accountLifetime });
    const id = 'project-deployments.environment.settings.previews.template';
    try {
      expect(await settle(`${id}.data`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.branch.parent`)).toBeNull();
      // The rendered segment is pressable: choosing it opens the parent picker.
      await screen.pressByTestIdAsync(`${id}.data:branch`);
      expect(await settle(`${id}.branch.parent`)).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('opens Configure Previews runtime and first-address choices beyond four links', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const links = Array.from({ length: 5 }, (_, index) => ({ ...base.targetLinks[0]!, targetLink:
      createDeploymentTargetLinkHeaderV1({ id: `runtime-${index}`, machines: [`machine-${index}`],
        members: [{ machineId: `machine-${index}`, installationId: `installation-${index}`, state: 'active' }] }) }));
    const template = { v: 1 as const, enabled: true, forkPreviews: 'off' as const,
      repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/shop' },
      runtimeTargetLinkId: 'runtime-0', domain: null, bindingBlueprints: [], data: [] };
    const detail = createDeploymentEnvironmentDetailV1({ targetLinks: links,
      environment: { ...base.environment, runtimeTargetLinkId: 'runtime-0' },
      content: { ...base.content, previewTemplate: template } });
    const updateEnvironment = vi.fn(async (..._args: unknown[]) => ({ ok: true as const,
      environmentId: detail.environment.id, revision: detail.environment.revision + 1 }));
    const { screen, controller, settle } = await renderTab('settings', detail,
      { listDomains: async () => ({ ok: true, value: { items: [domain('wildcard', '*.preview.example', 'active')], nextCursor: null } }) },
      { environmentActions: { setController: vi.fn(), updateEnvironment } });
    const id = 'project-deployments.environment.settings.previews.template';
    try {
      expect(await settle(`${id}.enabled`)).not.toBeNull();
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu).some(node => node.props.testID === `${id}.runsOn`)).toBe(true));
      const runtime = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${id}.runsOn`);
      expect(runtime).toBeDefined();
      await act(async () => runtime!.props.onSelect('runtime-4'));
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment, { previewTemplate: { ...template, runtimeTargetLinkId: 'runtime-4' } });
      await settle(`${id}.domain`);
      const chooseDomain = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${id}.domain`)!;
      await act(async () => chooseDomain.props.onSelect('wildcard'));
      const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
      const slug = screen.findAllByType(FieldValueItem).find(node => node.props.testID === `${id}.slug`)!;
      await act(async () => slug.props.onCommit('shop'));
      await screen.pressByTestIdAsync(`${id}.domain.save`);
      expect(updateEnvironment).toHaveBeenLastCalledWith(detail.environment, { previewTemplate: { ...template,
        domain: { domainId: 'wildcard', templateSlug: 'shop', hostnamePattern: 'pr-{number}-{template-slug}' } } });
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each(['permissions', 'overview'])('opens Configure Previews from %s at the canonical Settings section', async tab => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Preview navigation', serverUrl: 'https://preview-navigation.test',
      accountId: 'account-owner', currentAccount: true });
    const onNavigate = vi.fn();
    const { screen, controller, settle } = await renderTab(tab, createDeploymentEnvironmentDetailV1(), {}, { serverId, onNavigate });
    try {
      const id = `project-deployments.environment.${tab}.previews`;
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith({ tab: 'settings', section: 'previews' }));
    } finally { await screen.unmount(); controller.retire(); await homes.reset(); }
  });

  it.each(['none', 'own'] as const)('opens Configure Previews defaults once and saves the reviewed explicit choices (%s)', async previewDatabase => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Previews setup', serverUrl: 'https://previews-setup.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const detail = createDeploymentEnvironmentDetailV1();
    homes.answer(serverId, `GET /v1/projects/sources/${detail.environment.projectSourceId}`, { body: { ok: true, canManage: true,
      source: { id: detail.environment.projectSourceId, revision: 1, name: 'shop', audience: [], createdByAccountId: 'account-owner',
        repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'acme/shop' }, protocol: 'https' } } } });
    const settled = { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    const prepareConfigurationDefaults = vi.fn(async () => ({ values: { retainPreviousDeployments: 1, previewDatabase },
      sources: { retainPreviousDeployments: 'builtin' as const, previewDatabase: 'account' as const } }));
    const updateEnvironment = vi.fn(async (..._args: unknown[]) => settled);
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      environmentActions: { setController: vi.fn(), updateEnvironment, prepareConfigurationDefaults } });
    const id = 'project-deployments.environment.settings.previews.template';
    try {
      expect(await settle(`${id}.setup`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.setup`);
      await vi.waitFor(() => expect(prepareConfigurationDefaults).toHaveBeenCalledWith(detail.environment, 'previews'));
      expect(updateEnvironment).not.toHaveBeenCalled();
      await settle(`${id}.setup.save`);
      if (previewDatabase === 'own') {
        expect(await settle(`${id}.data.default`)).not.toBeNull();
        await screen.pressByTestIdAsync(`${id}.setup.save`);
        expect(updateEnvironment).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync(`${id}.data:none`);
      }
      await screen.pressByTestIdAsync(`${id}.setup.save`);
      expect(prepareConfigurationDefaults).toHaveBeenCalledTimes(1);
      expect(updateEnvironment).toHaveBeenCalledExactlyOnceWith(detail.environment, { previewTemplate: expect.objectContaining({
        v: 1, enabled: true, forkPreviews: 'off', runtimeTargetLinkId: detail.environment.runtimeTargetLinkId,
        repository: expect.objectContaining({ kind: 'github', repository: 'acme/shop' }), domain: null, data: [] }) });
      const { DeploymentEnvironmentUpdateInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
      expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ serverId: 'srv', environmentId: detail.environment.id,
        expectedRevision: 1, contentArtifactId: detail.environment.contentArtifactId,
        contentHeaderVersion: detail.environment.contentHeaderVersion, contentBodyVersion: detail.environment.contentBodyVersion,
        patch: updateEnvironment.mock.calls[0]![1] }).success).toBe(true);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('shows missing preview enrollment again after the Settings page remounts', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Preview enrollment', serverUrl: 'https://preview-enrollment.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ environment: { ...base.environment, serverId },
      content: { ...base.content, previewTemplate: {
        v: 1, enabled: true, forkPreviews: 'off',
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/app' },
        runtimeTargetLinkId: base.environment.runtimeTargetLinkId!, domain: null, bindingBlueprints: [], data: [],
      } } });
    // Only the persisted Account collection is synthetic; the real Workflow Action and subscribed read hook run.
    homes.answer(serverId, 'GET /v3/automations', { body: { automations: [], nextCursor: null } });
    const { screen, controller, settle, updateTab } = await renderTab('settings', detail, {},
      { serverId, lifetime: account.accountLifetime });
    const warning = 'project-deployments.environment.settings.preview-enrollment';
    try {
      expect(await settle(warning)).not.toBeNull();
      expect(homes.requestsFor('/v3/automations/query').length).toBeGreaterThan(0);
      await updateTab('overview');
      await updateTab('settings');
      expect(await settle(warning)).not.toBeNull();
      expect(homes.requestsFor('/v1/actions/deployments.environments.update')).toHaveLength(0);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('keeps unsaved preview blueprints when switching Environment pages', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Preview draft', serverUrl: 'https://preview-draft.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, previewTemplate: {
      v: 1, enabled: true, forkPreviews: 'off',
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/app' },
      runtimeTargetLinkId: base.environment.runtimeTargetLinkId!, domain: null, bindingBlueprints: [], data: [],
    } } });
    const { createDeploymentActions } = await import('./deploymentActions');
    const actions = createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId);
    const { screen, controller, settle, updateTab } = await renderTab('settings', detail, {},
      { serverId, lifetime: account.accountLifetime, environmentActions: actions });
    try {
      const id = 'project-deployments.environment.variables';
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.add`);
      await vi.waitFor(() => expect(screen.findHostByTestId(`${id}.add.plain`)).not.toBeNull());
      await screen.pressByTestIdAsync(`${id}.add.plain`);
      await act(async () => {
        screen.changeTextByTestId(`${id}.add.name`, 'PREVIEW_MODE');
        screen.changeTextByTestId(`${id}.add.value`, 'true');
      });
      await screen.pressByTestIdAsync(`${id}.add.save`);
      await updateTab('overview');
      await updateTab('settings');
      const { measureMountedCollections } = await import('@/dev/testkit/render/renderInCollectionLayout');
      await measureMountedCollections(screen);
      expect(await settle('project-deployments.environment.variable.PREVIEW_MODE')).not.toBeNull();
      expect(homes.requestsFor('/v1/actions/deployments.environments.update')).toHaveLength(0);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('says a stored definition needs a repository before previews, instead of an empty section', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Stored previews', serverUrl: 'https://stored-previews.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content,
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: 'services:\n  web:\n    image: nginx\n', profiles: [], services: ['web'] } } });
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      environmentActions: { setController: vi.fn(), updateEnvironment: vi.fn() } });
    const id = 'project-deployments.environment.settings.previews.template';
    try {
      expect(await settle(`${id}.needsRepository`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.setup`)).toBeNull();
      // One message: no empty preview list under the reason.
      for (const state of ['empty', 'error', 'loading', 'denied']) {
        expect(screen.findByTestId(`project-deployments.environment.settings.previews.${state}`)).toBeNull();
      }
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('sets up backups from the Environment controller even when the Account-selected old origin has no destinations', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Backup setup', serverUrl: 'https://backup-setup.test',
      serverIdentityId: 'srv_backup_setup', accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const detail = withDatabase(createDeploymentEnvironmentDetailV1());
    const settled = { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    const updateEnvironment = vi.fn(async (..._args: unknown[]) => settled);
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    // The descriptor the backup-destinations family publishes; its identity and roles must reach the patch unchanged.
    const destination = { id: 'example.storage/bucket-store', pluginId: 'example.storage', pluginVersion: '1.0.0',
      definition: { id: 'bucket-store', title: 'Bucket store', resticTransport: 's3', locality: 'unknown',
        credentialRoles: [{ role: 'repositoryPassword' }, { role: 'accessKeyId' }, { role: 'secretAccessKey' },
          { role: 'sessionToken', optional: true }],
        configSchema: { type: 'object', additionalProperties: false, required: ['endpoint', 'bucket', 'prefix'],
          properties: { endpoint: { type: 'string', minLength: 1 }, bucket: { type: 'string', minLength: 1 },
            prefix: { type: 'string' }, region: { type: 'string', minLength: 1 },
            // Recorded bundled S3 shape: the composable union has no top-level type.
            addressing: { anyOf: [{ const: 'auto', type: 'string' }, { const: 'dns', type: 'string' }, { const: 'path', type: 'string' }] },
            enabled: { type: 'boolean' }, attempts: { type: 'integer' },
            advanced: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } } } } },
        actions: { test: { kind: 'hostAction', actionId: 'deployments.backups.test' },
          open: { pluginId: 'example.storage', localId: 'bucket-store/open' } } } };
    const { DaemonContributionRegistryProjectionDescribeResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const machineId = detail.environment.controllerMachineId;
    const sourceCustody = { kind: 'development', registeredRootId: '/plugins/backup-destinations' };
    const executionOrigin = { serverIdentityId: getServerProfileById(serverId)!.serverIdentityId,
      sourceRef: { machineId, pluginId: destination.pluginId, sourceCustody } };
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projection: { v: 2, generation: 1, installedPackagesById: { [destination.pluginId]: {
        id: destination.pluginId, displayName: 'Backup destinations', version: '1.0.0', enabled: true,
        source: { kind: 'path', locator: '/plugins/backup-destinations' }, sourceCustody, executionOrigin,
        occurrenceId: 'backup-destinations:22' } }, familiesById: { backupDestinations: {
        family: 'backupDestinations', entriesById: { [destination.id]: { ...destination, executionOrigin,
          occurrenceId: 'backup-destinations:22' } } } } } });
    machineProjectionReplies.set(machineId, response);
    storage.setState({ endpointStatus: 'online' });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: machineId,
      active: true, activeAt: Date.now(), daemonStateVersion: 1 })]);
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      environmentActions: { setController: vi.fn(), updateEnvironment },
      // #99: the Account selected an older bundled Machine with no destination family.
      serverId,
      pluginUiProjection: { value: EMPTY_PLUGIN_UI_PROJECTION,
        serverId, accountLifetime: account.accountLifetime } });
    const id = 'project-deployments.environment.settings.backups.setup';
    try {
      expect(await settle(id)).not.toBeNull();
      await vi.waitFor(() => expect(screen.findByTestId(`${id}.start`)).not.toBeNull());
      expect(screen.findByTestId(`${id}.store`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.start`);
      // The optional transport settings open from More options inside the one setup sheet.
      expect(await settle(`${id}.more`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.more`);
      const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
      const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
      const field = (name: string) => screen.findAllByType(HappierInputField).find((node) => node.props.field.path === name)!;
      expect(field('addressing')?.props.options.map((option: { value: string }) => option.value)).toEqual(['auto', 'dns', 'path']);
      await act(async () => {
        field('endpoint').props.onChange('http://minio.internal:9000');
      });
      await act(async () => { field('bucket').props.onChange('acme-backups'); });
      await act(async () => { field('prefix').props.onChange('shop/'); });
      await act(async () => { field('region').props.onChange('eu-central-1'); });
      await act(async () => { field('addressing').props.onChange('path'); });
      await act(async () => { field('enabled').props.onChange(false); });
      await act(async () => { field('attempts').props.onChange(3); });
      await act(async () => { field('advanced').props.onChange({ label: 'QA' }); });
      // The descriptor marks the session token optional: it is labeled so and left out of the required bindings.
      expect(screen.findByTestId(`${id}.role.sessionToken`)).not.toBeNull();
      expect(screen.getTextContent()).toContain('Optional');
      await act(async () => { field('attempts').props.onChange('invalid integer'); });
      expect(screen.findAllByType(RoundButton).find(node => node.props.testID === `${id}.save`)?.props.disabled).toBe(true);
      expect(updateEnvironment).not.toHaveBeenCalled();
      await act(async () => { field('attempts').props.onChange(3); });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(updateEnvironment).toHaveBeenCalledExactlyOnceWith(detail.environment, { backup: expect.objectContaining({
        destinationRef: { pluginId: 'example.storage', localId: 'bucket-store' },
        config: { endpoint: 'http://minio.internal:9000', bucket: 'acme-backups', prefix: 'shop/', region: 'eu-central-1',
          addressing: 'path', enabled: false, attempts: 3, advanced: { label: 'QA' } },
        credentialBindings: [
          { purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' },
          { purpose: 'backupDestination', configKey: 'destination', role: 'accessKeyId' },
          { purpose: 'backupDestination', configKey: 'destination', role: 'secretAccessKey' }],
        sources: [{ kind: 'dump', sourceId: 'postgres', service: 'postgres', consistency: 'logical' }],
        ownership: { environmentId: detail.environment.id, prefix: 'shop/' },
        retention: { kind: 'keep', daily: 7, weekly: 4 } }) });
      const { DeploymentEnvironmentUpdateInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
      // An agent sends the same Action and patch.
      expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ serverId: 'srv', environmentId: detail.environment.id,
        expectedRevision: 1, contentArtifactId: detail.environment.contentArtifactId,
        contentHeaderVersion: detail.environment.contentHeaderVersion, contentBodyVersion: detail.environment.contentBodyVersion,
        patch: updateEnvironment.mock.calls[0]![1] }).success).toBe(true);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('offers no backup setup for an Environment that runs no database and leads to Add a database instead', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'No database', serverUrl: 'https://no-database.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const detail = createDeploymentEnvironmentDetailV1();
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      serverId, environmentActions: { setController: vi.fn(), updateEnvironment: vi.fn() } });
    const id = 'project-deployments.environment.settings.backups.setup';
    try {
      expect(await settle(`${id}.noDatabase`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.start`)).toBeNull();
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.show).mockClear();
      await screen.pressByTestIdAsync(`${id}.addDatabase`);
      expect(vi.mocked(Modal.show).mock.calls.map(([config]) => config.chrome?.testID)).toEqual(['project-deployments.add.modal']);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('leads to the Store for backup storage when no destination is available, in plain words', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'No destination', serverUrl: 'https://no-destination.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const detail = withDatabase(createDeploymentEnvironmentDetailV1());
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { DaemonContributionRegistryProjectionDescribeResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    machineProjectionReplies.set(detail.environment.controllerMachineId,
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
        projection: { v: 2, generation: 1 } }));
    storage.setState({ endpointStatus: 'online' });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({
      id: detail.environment.controllerMachineId, active: true, activeAt: Date.now(), daemonStateVersion: 1 })]);
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      serverId, environmentActions: { setController: vi.fn(), updateEnvironment: vi.fn() } });
    const id = 'project-deployments.environment.settings.backups.setup';
    try {
      expect(await settle(`${id}.store`)).not.toBeNull();
      routerMock.spies.push.mockClear();
      await screen.pressByTestIdAsync(`${id}.store`);
      expect(String(JSON.stringify(routerMock.spies.push.mock.calls[0]?.[0]))).toContain('view=search');
      expect(screen.findByTestId(`${id}.start`)).toBeNull();
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('names the credentials a saved S3 destination still needs and offers its nightly schedule', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Backup credentials', serverUrl: 'https://backup-credentials.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, backup: { ...backup,
      destinationRef: { pluginId: 'happier.backup.destinations', localId: 's3' },
      config: { endpoint: 'https://s3.example.com', bucket: 'acme-backups', prefix: 'shop/' },
      credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'accessKeyId' },
        { purpose: 'backupDestination', configKey: 'destination', role: 'secretAccessKey' },
        { purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }] } } });
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime,
      environmentActions: { setController: vi.fn(), updateEnvironment: vi.fn() } });
    const id = 'project-deployments.environment.settings.backups';
    try {
      expect(await settle(`${id}.credential.accessKeyId`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.credential.secretAccessKey`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.credential.repositoryPassword`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.schedule`)).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('keeps both template databases addressable and opens the in-place Add sheet', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Data', serverUrl: 'https://data-card.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, template: {
      templateRef: { sourceId: 'apps', itemId: 'postgres', version: '17', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
      services: ['database', 'mysql'], data: [
        { engine: 'postgres', version: '17', service: 'database', port: 5432 },
        { engine: 'mysql', version: '8.4', service: 'mysql', port: 3306 },
      ],
    } } });
    const openDatabase = vi.fn();
    const { screen, controller, settle } = await renderTab('overview', detail, {}, {
      serverId, lifetime: account.accountLifetime, onOpenDatabase: openDatabase,
    });
    try {
      expect(await settle('project-deployments.environment.data')).not.toBeNull();
      expect(screen.getTextContent()).toContain('PostgreSQL');
      expect(screen.getTextContent()).toContain('5432');
      expect(screen.getTextContent()).toContain('MySQL');
      expect(screen.findByTestId('project-deployments.environment.data.database.database')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.data.database.mysql')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.environment.data.database.database');
      await screen.pressByTestIdAsync('project-deployments.environment.data.database.mysql');
      expect(openDatabase.mock.calls).toEqual([['database'], ['mysql']]);
      routerMock.spies.push.mockClear();
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.show).mockClear();
      await screen.pressByTestIdAsync('project-deployments.environment.data.add');
      // P10: Add opens its sheet over the Environment, in place; it never leaves for Store.
      expect(routerMock.spies.push).not.toHaveBeenCalled();
      expect(vi.mocked(Modal.show).mock.calls.map(([config]) => config.chrome?.testID)).toEqual(['project-deployments.add.modal']);
      expect(screen.getTextContent()).toContain('Variables');
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('shows the services the Machine reports, the saved backup configuration and that its status is not read', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({
      content: { ...base.content, backup },
    });
    const { screen, controller, settle } = await renderTab('settings', detail, {
      observeEnvironmentHealth: (_scope, observed, publish) => {
        publish({
          environmentId: observed.environment.id,
          status: 'ready',
          members: [
            {
              machineId: 'machine-a',
              installationId: 'installation-a',
              status: 'ready',
              services: [
                {
                  serviceId: 'web',
                  name: 'web',
                  state: 'down',
                  observedAt: 1,
                  reason: null,
                },
                {
                  serviceId: 'worker',
                  name: 'worker',
                  state: 'up',
                  observedAt: 1,
                  reason: null,
                },
              ],
            },
          ],
        });
        return () => {};
      },
    });
    try {
      expect(
        await settle(
          'project-deployments.environment.settings.checks-alerts.member.machine-a',
        ),
      ).not.toBeNull();
      expect(screen.getTextContent()).toContain('web not passing');
      // The checks are set up on that Machine's Services page (P50 health setup lives there).
      routerMock.spies.push.mockClear();
      await screen.pressByTestIdAsync('project-deployments.environment.settings.checks-alerts.member.machine-a');
      expect(JSON.stringify(routerMock.spies.push.mock.calls[0]?.[0])).toContain('/machines/machine-a');
      expect(
        screen.findByTestId(
          'project-deployments.environment.settings.backups.sources',
        ),
      ).not.toBeNull();
      expect(
        screen.findByTestId(
          'project-deployments.environment.settings.backups.status',
        ),
      ).not.toBeNull();
      expect(
        screen.findByTestId(
          'project-deployments.environment.settings.backups.empty',
        ),
      ).toBeNull();
    } finally {
      controller.retire();
    }
  });

  it('says nothing is set up for an unconfigured backup, and names the pull request and template of a preview', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({
      environment: createDeploymentEnvironmentHeaderV1({
        purpose: 'preview',
        previewTemplateEnvironmentId: 'environment-production',
        previewRepositoryId: 'source-app',
        previewPullRequestId: '142',
        previewTargetLinkId: 'target-a',
      }),
      content: base.content,
    });
    const { screen, controller, settle } = await renderTab(
      'settings',
      detail,
      {},
      {
        environmentTitle: (id: string) =>
          id === 'environment-production' ? 'Production API' : null,
      },
    );
    try {
      expect(
        await settle('project-deployments.environment.settings.backups.empty'),
      ).not.toBeNull();
      expect(
        screen.findByTestId(
          'project-deployments.environment.settings.backups.status',
        ),
      ).toBeNull();
      expect(
        screen.findByTestId(
          'project-deployments.environment.settings.previews.of',
        ),
      ).not.toBeNull();
      const text = screen.getTextContent();
      expect(text).toContain('142');
      expect(text).toContain('Production API');
    } finally {
      controller.retire();
    }
  });

  it('lists the previews made from a template Environment, pages them on request and settles empty, refused and unavailable', async () => {
    await homes.reset();
    const serverId = await homes.addHome({
      name: 'Previews',
      serverUrl: 'https://settings-previews.test',
      accountId: 'account-owner',
    });
    const account = await captureLazyActionAccountContext(serverId);
    const preview = (pullRequest: string) =>
      createDeploymentEnvironmentHeaderV1({
        id: `environment-preview-${pullRequest}`,
        contentArtifactId: `content-preview-${pullRequest}`,
        serverId,
        purpose: 'preview',
        previewRepositoryId: 'source-app',
        previewTemplateEnvironmentId: 'environment-staging',
        previewPullRequestId: pullRequest,
        previewTargetLinkId: 'target-a',
      });
    const first = preview('142');
    const second = preview('145');
    for (const [header, title] of [
      [first, 'pr-142 · Keep the cart after sign-in'],
      [second, 'pr-145 · Faster project search'],
    ] as const) {
      await account.createArtifactDocument({
        artifactId: header.contentArtifactId,
        header: { kind: 'deployment-environment.v1', title },
        body: '{}',
      });
    }
    const path = '/v1/deployments/environments';
    let response: unknown = {
      ok: true,
      items: [first],
      nextCursor: 'previews-two',
    };
    homes.answer(serverId, path, { select: () => ({ body: response }) });
    const selections = () =>
      homes.requests
        .filter((request) => request.path.split('?')[0] === path)
        .map((request) => new URLSearchParams(request.path.split('?')[1]));
    const templateBase = createDeploymentEnvironmentDetailV1();
    const templateDetail = createDeploymentEnvironmentDetailV1({ content: { ...templateBase.content, previewTemplate: {
      v: 1, enabled: true, forkPreviews: 'off',
      repository: { kind: 'github', deployment: 'https://github.example/enterprise', repository: 'owner/app' },
      runtimeTargetLinkId: templateBase.environment.runtimeTargetLinkId ?? 'target-link', domain: null, bindingBlueprints: [], data: [],
    } } });
    const { screen, controller, settle } = await renderTab(
      'settings',
      templateDetail,
      {},
      { lifetime: account.accountLifetime },
    );
    const rows = 'project-deployments.environment.settings.previews';
    try {
      expect(await settle(`${rows}.${first.id}`)).not.toBeNull();
      expect(screen.getTextContent()).toContain('Keep the cart after sign-in');
      expect(screen.findByTestId(`${rows}.notListed`)).toBeNull();
      expect(selections()[0]?.get('previewTemplateEnvironmentId')).toBe(
        'environment-staging',
      );
      response = { ok: true, items: [second], nextCursor: null };
      await screen.pressByTestIdAsync(`${rows}.next`);
      expect(await settle(`${rows}.${second.id}`)).not.toBeNull();
      expect(selections().at(-1)?.get('cursor')).toBe('previews-two');
      expect(screen.findByTestId(`${rows}.previous`)).not.toBeNull();
    } finally {
      controller.retire();
    }

    account.dispose();
    // Each settled state reads under its own Home, so no earlier page stands in for it.
    for (const [answer, state] of [
      [{ ok: true, items: [], nextCursor: null }, 'empty'],
      [{ ok: false, error: 'deployment_access_denied' }, 'denied'],
      [{ ok: false, error: 'deployment_unavailable' }, 'error'],
    ] as const) {
      const stateHome = await homes.addHome({
        name: `Previews ${state}`,
        serverUrl: `https://settings-previews-${state}.test`,
        accountId: 'account-owner',
      });
      const stateAccount = await captureLazyActionAccountContext(stateHome);
      homes.answer(stateHome, path, { select: () => ({ body: answer }) });
      const settled = await renderTab(
        'settings',
        templateDetail,
        {},
        { lifetime: stateAccount.accountLifetime },
      );
      try {
        expect(await settled.settle(`${rows}.${state}`)).not.toBeNull();
      } finally {
        settled.controller.retire();
        stateAccount.dispose();
      }
    }
    await homes.reset();
  });
});

describe('Environment → Variables: Saved Secret names', () => {
  it('names a Saved Secret row by the secret it binds', async () => {
    const { seedSavedSecretCatalogForTest } = await import('@/dev/testkit/harness/savedSecretEditorHttpHarness');
    const ref = formatSharedSavedSecretRefV1('stripe-live');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, bindings: [{ purpose: 'variable',
      name: 'STRIPE_SECRET_KEY', phase: 'runtime', source: { kind: 'secret', ref, resourceRevision: 2 } }] } });
    const lifetime = { scope: { serverId: 'home', accountId: 'account-owner' }, isCurrent: () => true,
      onRetire: () => ({ dispose: () => {} }) };
    await seedSavedSecretCatalogForTest(lifetime.scope, [{ ref, name: 'Stripe live key', revision: 2 }]);
    const { screen, controller, settle } = await renderTab('variables', detail, {}, { lifetime });
    try {
      expect(await settle('project-deployments.environment.variables.sealed')).not.toBeNull();
      expect(screen.getTextContent()).toContain('Stripe live key');
    } finally {
      controller.retire();
    }
  });
});

describe('Environment → Variables: secrets linked into a Team Environment', () => {
  const secret = {
    purpose: 'variable' as const,
    name: 'STRIPE_SECRET_KEY',
    phase: 'runtime' as const,
    source: {
      kind: 'secret' as const,
      ref: formatSharedSavedSecretRefV1('stripe-live'),
      resourceRevision: 2,
    },
  };

  it.each([
    ['team', { kind: 'team' as const, teamId: 'team-acme' }, true],
    [
      'account',
      { kind: 'account' as const, accountId: 'account-owner' },
      false,
    ],
  ])(
    'says who can read linked secrets only for a Team Environment (%s)',
    async (_name, owner, team) => {
      const base = createDeploymentEnvironmentDetailV1();
      const detail = createDeploymentEnvironmentDetailV1({
        environment: createDeploymentEnvironmentHeaderV1({ owner }),
        content: { ...base.content, bindings: [secret] },
      });
      const lifetime = {
        scope: { serverId: 'home', accountId: 'account-owner' },
        isCurrent: () => true,
        onRetire: () => ({ dispose: () => {} }),
      };
      const { screen, controller, settle } = await renderTab(
        'variables',
        detail,
        {},
        { lifetime },
      );
      try {
        const line = await settle(
          'project-deployments.environment.variables.sealed',
        );
        expect(line).not.toBeNull();
        const text = screen.getTextContent();
        expect(text.includes('Team environment')).toBe(team);
      } finally {
        controller.retire();
      }
    },
  );
});
