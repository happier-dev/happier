import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { OwnServerDeploymentInputBasisV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import {
  act,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';
import { t } from '@/text';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import type { DomainIngressInspection } from './DeploymentDomainIngressFields';

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
// The exact controller RPC is the network boundary; its protocol reader stays real.
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
// The person's choice in the shared Saved Secret picker sheet, and the signed-in Account it is chosen under, are the
// boundaries here; the Domain page, its Environment read and the bindings Action input stay real.
const picked = vi.hoisted(() => ({ ref: '', resourceRevision: 4 }));
vi.mock(
  '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker',
  () => ({
    presentSavedSecretReferencePicker: vi.fn(async () => ({
      ref: picked.ref,
      resourceRevision: picked.resourceRevision,
    })),
  }),
);
vi.mock('@/sync/ops/actions/actionAccountContext', () => ({
  captureLazyActionAccountContext: vi.fn(async () => ({
    accountLifetime: {
      scope: { serverId: 'home', accountId: 'account-owner' },
      isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    },
    dispose() {},
  })),
}));
afterEach(standardCleanup);

const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { PresentedDetailNavigationProvider } =
  await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};
const shown = { mounted: true, visible: true, focused: true };
const noReview = { pendingId: null, request: () => {}, open: () => {} };
const id = 'project-deployments.environment.domains.add';
type Detail = ReturnType<typeof createDeploymentEnvironmentDetailV1>;

function domain(
  domainId: string,
  hostname: string,
  extra: Record<string, unknown> = {},
) {
  return {
    domain: {
      v: 1 as const,
      id: domainId,
      environmentId: 'environment-staging',
      targetLinkId: 'target-link',
      revision: 1,
      state: 'active' as const,
      contentArtifactId: `content-${domainId}`,
      contentHeaderVersion: 1,
      contentBodyVersion: 1,
      createdByAccountId: 'account-owner',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    title: hostname,
    content: {
      hostname,
      target: { service: 'web', containerPort: 3000 },
      healthCheck: { path: '/', expectStatus: 200 },
      ...extra,
    },
  };
}

async function renderDomains(
  detail: Detail,
  items: readonly unknown[],
  domainActions: Record<string, unknown>,
  healthSetup = false,
  receipt = createDeploymentReceiptDetailV1(),
  phone = false,
  review: Record<string, unknown> = noReview,
) {
  const transport: Partial<DeploymentReadTransportV1> = {
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
    listDomains: async () => ({
      ok: true,
      value: { items: items as never, nextCursor: null },
    }),
  };
  const controller = createDeploymentReadControllerV1({
    scope,
    transport: transport as DeploymentReadTransportV1,
  });
  const screen = await renderScreen(
    <PresentedDetailNavigationProvider>
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId="account-owner"
        serverId="home"
        phone={phone}
        deploy={null}
        review={review as typeof noReview}
        onOpenReceipt={() => {}}
        destination={{ tab: 'domains', section: null }}
        domainActions={domainActions as never}
        lifetime={healthSetup ? { scope: { serverId: 'home', accountId: 'account-owner' },
          isCurrent: () => true, onRetire: () => ({ dispose() {} }) } : undefined}
      />
    </PresentedDetailNavigationProvider>,
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
  return { screen, controller, settle };
}

it('offers the shared investigation beside a failed Domain only; one that needs a look says so and stays quiet (G5)', async () => {
  const detail = createDeploymentEnvironmentDetailV1();
  const healthy = domain('healthy-domain', 'healthy.example.test');
  const warning = domain('attention-domain', 'attention.example.test');
  const failing = domain('failed-domain', 'failed.example.test');
  const attention = { ...warning, domain: { ...warning.domain, state: 'warning' as const } };
  const failed = { ...failing, domain: { ...failing.domain, state: 'failed' as const } };
  const { screen, controller, settle } = await renderDomains(detail, [healthy, attention, failed], domainActions(detail));
  try {
    await settle('project-deployments.environment.domains.failed-domain');
    expect(screen.findByTestId('project-deployments.environment.domains.failed-domain.investigate')).not.toBeNull();
    expect(screen.findByTestId('project-deployments.environment.domains.attention-domain.investigate')).toBeNull();
    expect(screen.findByTestId('project-deployments.environment.domains.healthy-domain.investigate')).toBeNull();
  } finally { await screen.unmount(); controller.retire(); }
});

function domainActions(detail: Detail) {
  return {
    addDomain: vi.fn(async (..._args: unknown[]) => ({
      ok: true as const,
      environmentId: detail.environment.id,
      revision: detail.environment.revision + 1,
      domain: domain('new', 'docs.happier.dev').domain,
    })),
    setBindings: vi.fn(async (..._args: unknown[]) => ({
      ok: true as const,
      environmentId: detail.environment.id,
      revision: detail.environment.revision + 1,
    })),
    verifyDomain: vi.fn(),
    removeDomain: vi.fn(),
  };
}

it.each([false, true])('keeps retained Domains visible as unattached after runtime replacement or removal (no current link: %s)', async noCurrentLink => {
  const base = createDeploymentEnvironmentDetailV1();
  const detail = { ...base, environment: { ...base.environment,
    runtimeTargetLinkId: noCurrentLink ? undefined : base.environment.runtimeTargetLinkId } };
  const known = domain('current-domain', 'current.example.test');
  const current = { ...known, domain: { ...known.domain, targetLinkId: base.environment.runtimeTargetLinkId! } };
  const predecessor = { ...domain('predecessor-domain', 'old.example.test'),
    domain: { ...known.domain, id: 'predecessor-domain', targetLinkId: 'previous-target-link' } };
  const { screen, controller, settle } = await renderDomains(detail, [predecessor, current], domainActions(detail));
  try {
    await settle('project-deployments.environment.domains.current-domain');
    const { Status } = await import('@happier-dev/plugin-ui');
    const state = (domainId: string) => screen.findAllByType(Status)
      .find(node => node.props.testID === `project-deployments.environment.domains.${domainId}.state`)?.props.label;
    expect(state('predecessor-domain')).toBe('Unattached');
    expect(state('current-domain')).toBe(noCurrentLink ? 'Unattached' : 'Serving');
    expect(screen.getTextContent()).toContain('old.example.test');
  } finally { await screen.unmount(); controller.retire(); }
});

it('keeps a failed retained Domain recovery available', async () => {
  const detail = createDeploymentEnvironmentDetailV1();
  const known = domain('failed-retained', 'old.example.test');
  const failed = { ...known, domain: { ...known.domain, targetLinkId: 'previous-target-link', state: 'failed' as const } };
  const { screen, controller, settle } = await renderDomains(detail, [failed], domainActions(detail));
  try {
    await settle('project-deployments.environment.domains.failed-retained');
    const { Status } = await import('@happier-dev/plugin-ui');
    const { t } = await import('@/text');
    expect.soft(screen.findAllByType(Status).find(node =>
      node.props.testID === 'project-deployments.environment.domains.failed-retained.state')?.props.label)
      .toBe(t('projects.deployments.domainStateFailed'));
    expect.soft(screen.findByTestId('project-deployments.environment.domains.failed-retained.checkAgain')).not.toBeNull();
  } finally { await screen.unmount(); controller.retire(); }
});

function platformDetail(targetKind = 'vercel', content: Record<string, unknown> = {}) {
  return createDeploymentEnvironmentDetailV1({ targetLinks: [{ content,
    targetLink: createDeploymentTargetLinkHeaderV1({ source: { kind: 'plugin',
      contribution: { pluginId: `happier.deploy.${targetKind === 'workers' ? 'cloudflare' : 'vercel'}`, localId: 'runtime' } },
      targetKind, machines: [], members: [], machineId: 'machine-a', installationId: 'installation-a' }),
  }] });
}

describe('Environment → Domains: add form (P6)', () => {
  it('names where the recorded routed replicas run, inside the row and without raw ids (DEPLOY-ACCEPT-143 A3)', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const known = domain('recorded', 'shop.example.com');
    const item = { ...known, domain: { ...known.domain, routedReplicas: {
      source: 'recordedTopology' as const, count: 2, replicas: [
        { machineId: 'machine-a', installationId: 'installation-a', containerName: 'shop-web-1' },
        { machineId: 'machine-b', installationId: 'installation-b', containerName: 'shop-web-2' },
      ],
    } } };
    const { screen, controller, settle } = await renderDomains(detail, [item, domain('unknown', 'old.example.com')], domainActions(detail));
    try {
      await settle('project-deployments.environment.domains.recorded');
      const text = screen.getTextContent();
      // Machine and container ids stay out of the page.
      expect(text).not.toContain('shop-web-1');
      expect(text).not.toContain('machine-a ·');
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('opens the exact saved Domain check setup before enrolling a cadence', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const actions = domainActions(detail);
    const item = domain('public-domain', 'shop.example.com');
    const { screen, controller, settle } = await renderDomains(detail, [item], actions, true);
    await settle('project-deployments.environment.domains.public-domain');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const menu = screen.findAllByType(DropdownMenu).find(node => node.props.popoverAccessibilityLabel === 'shop.example.com');
    expect(menu).toBeDefined();
    expect(menu!.props.items).toContainEqual(expect.objectContaining({ id: 'configure-checks' }));
    await act(async () => { menu!.props.onSelect('configure-checks'); });
    const { NewAccountTriggerPopover } = await import('@/components/workflows/triggers/AccountTriggersSection');
    const setup = screen.findAllByType(NewAccountTriggerPopover)[0]!;
    expect(setup.props.eventSeed).toMatchObject({ sourceInstanceId: expect.stringMatching(/^health:/),
      setupInput: { v: 1, subject: { kind: 'environment', environmentId: detail.environment.id },
        domain: { domainId: 'public-domain', targetLinkId: 'target-link' } } });
    expect(setup.props.eventSeed.setupInput).not.toHaveProperty('checks');
    expect(actions.addDomain).not.toHaveBeenCalled();
    await screen.unmount(); controller.retire();
  });
  it('adds a platform address with provider routing and no native service or port', async () => {
    const detail = platformDetail();
    const actions = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      expect(screen.findByTestId(`${id}.service`)).toBeNull();
      expect(screen.findByTestId(`${id}.port`)).toBeNull();
      await act(async () => { screen.changeTextByTestId(`${id}.host`, 'app.example.test'); });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        content: { hostname: 'app.example.test', target: { kind: 'provider' } },
      }));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('uses the linked Workers credential and waits for an explicit zone choice before adding', async () => {
    const account = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'linked' };
    const detail = platformDetail('workers', { credentialPrincipal: { kind: 'account', accountId: 'account-owner',
      purpose: { consumer: { pluginId: 'happier.deploy.cloudflare', localId: 'workers-inspect' }, purpose: 'deploy.manage' },
      target: { kind: 'account', account } }, providerIdentity: { providerAccountId: 'cloudflare-account',
        providerResourceId: 'worker-exact', providerEnvironment: 'production' }, providerEnvironment: { kind: 'script', scriptName: 'worker-exact' } });
    const inspectPlatformTarget = vi.fn<DomainIngressInspection>(async () => ({ ok: true, value: { kind: 'ready',
      zones: [{ zoneId: 'zone-other', name: 'other.test' }, { zoneId: 'zone-exact', name: 'example.test' }], options: [],
      defaults: { connector: { imageRef: 'unused', version: 'unused' } }, connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' } } }));
    const actions = { ...domainActions(detail), inspectPlatformTarget };
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => { screen.changeTextByTestId(`${id}.host`, 'app.example.test'); });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).not.toHaveBeenCalled();
      expect(screen.findByTestId(`${id}.ingress.account`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
      expect(inspectPlatformTarget).toHaveBeenCalledExactlyOnceWith('happier.deploy.cloudflare/actions/workers-domain-zones-read',
        { credentialRef: account, accountId: 'cloudflare-account', hostname: 'app.example.test' }, { signal: expect.any(AbortSignal) });
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const choice = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${id}.ingress.zone`);
      expect(choice).toBeDefined();
      await act(async () => { choice!.props.onSelect('zone-exact'); });
      expect(screen.findByTestId(`${id}.ingress.read`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: {
        hostname: 'app.example.test', target: { kind: 'provider', zone: { zoneId: 'zone-exact', name: 'example.test' } },
      } }));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('renders the retained provider DNS instructions after a fresh Domain read', async () => {
    const detail = platformDetail();
    const item = domain('provider-domain', 'app.example.test', { target: { kind: 'provider' }, healthCheck: undefined,
      providerObservation: { v: 1, hostname: 'app.example.test', state: 'pending',
        dns: [{ type: 'TXT', name: '_validation.app.example.test', value: 'retained-provider-value' }] } });
    const { screen, controller, settle } = await renderDomains(detail, [item], domainActions(detail));
    try {
      expect(await settle('project-deployments.environment.domains.provider-domain')).not.toBeNull();
      const { Text } = await import('@/components/ui/text/Text');
      // The record to add is the row's selectable second line ("Add TXT … → value").
      expect(screen.findAllByType(Text).some(node => node.props.selectable === true
        && String(node.props.children).includes('TXT _validation.app.example.test → retained-provider-value'))).toBe(true);
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('says why a provider could not set an address up, through the failure details presenter', async () => {
    const detail = platformDetail();
    const item = domain('provider-failed', 'app.example.test', { target: { kind: 'provider' }, healthCheck: undefined,
      providerObservation: { v: 1, hostname: 'app.example.test', state: 'pending', dns: [],
        failureCause: { phase: 'deployment.domain.provider', errorClass: 'ProviderError', errorCode: 'domain_taken', httpStatus: 409 } } });
    const { screen, controller, settle } = await renderDomains(detail, [item], domainActions(detail));
    try {
      await settle('project-deployments.environment.domains.provider-failed');
      expect(screen.findByTestId('approvals.technical-details')).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('opens the Cloudflare record picker beside pending provider records, and only where the page can write it', async () => {
    const detail = platformDetail();
    const pending = domain('provider-domain', 'app.example.test', { target: { kind: 'provider' }, healthCheck: undefined,
      providerObservation: { v: 1, hostname: 'app.example.test', state: 'pending',
        dns: [{ type: 'CNAME', name: 'app.example.test', value: 'cname.vercel-dns.com' }] } });
    const plain = domain('plain', 'shop.example.com');
    const rowId = 'project-deployments.environment.domains';
    const writable = { ...domainActions(detail), createDomainDns: vi.fn(), inspectPlatformTarget: vi.fn<DomainIngressInspection>() };
    for (const [actions, offered] of [[writable, true], [domainActions(detail), false]] as const) {
      const { screen, controller, settle } = await renderDomains(detail, [pending, plain], actions);
      try {
        await settle(`${rowId}.provider-domain`);
        expect(screen.findByTestId(`${rowId}.plain.dnsProvider`)).toBeNull();
        expect(screen.findByTestId(`${rowId}.provider-domain.dnsProvider`) !== null).toBe(offered);
        if (offered) {
          await screen.pressByTestIdAsync(`${rowId}.provider-domain.dnsProvider`);
          expect(await settle(`${rowId}.dns.form`)).not.toBeNull();
          // The provider-owned zone picker; nothing is written before its own review.
          expect(screen.findByTestId(`${rowId}.add.ingress.zones.read`)).not.toBeNull();
          expect(writable.createDomainDns).not.toHaveBeenCalled();
        }
      } finally { await screen.unmount(); controller.retire(); }
    }
  });

  it.each(['docs.happier.dev', '*.happier.dev'])('adds redirect, certificate and basic-auth references for %s in one Domain Add', async hostname => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = {
      ...base,
      content: { ...base.content, ingress: undefined },
    };
    const actions = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(
      detail,
      [],
      actions,
    );
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, hostname);
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
        screen.changeTextByTestId(`${id}.redirect`, 'www.happier.dev');
        screen.changeTextByTestId(`${id}.basicAuth`, 'preview');
      });
      await screen.pressByTestIdAsync(`${id}.certificate:custom`);
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          content: {
            hostname,
            target: {
              service: 'web',
              containerPort: 3000,
              redirectTo: 'www.happier.dev',
            },
            tls: { kind: 'custom' },
            basicAuth: { username: 'preview' },
          },
        }),
      );
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('adds without a check (the Domain owner defaults it) and keeps an authored path from Advanced', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const actions = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      expect(screen.findByTestId(`${id}.needs`), 'no check field is required').toBeNull();
      await screen.pressByTestIdAsync(`${id}.advanced.header`);
      await act(async () => screen.changeTextByTestId(`${id}.checkStatus`, 'abc'));
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain, 'a status that is not a number cannot be added').not.toHaveBeenCalled();
      await act(async () => {
        screen.changeTextByTestId(`${id}.check`, '/ready');
        screen.changeTextByTestId(`${id}.checkStatus`, '');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        content: expect.objectContaining({ healthCheck: { path: '/ready' } }),
      }));
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('shows Docker Desktop Domain unavailability from the serving generation before Add', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const receipt = createDeploymentReceiptDetailV1();
    detail.targetLinks[0]!.targetLink.activeDeploymentId = receipt.deployment.id;
    const projection = { machineId: 'machine-a', installationId: 'installation-a', platform: 'linux/amd64',
      manifestFingerprint: 'manifest-a', configInputDigests: [], physicalProjectName: 'shop',
      toolVersion: '2.0', services: ['app'], profiles: [], engineKind: 'dockerDesktop' as const };
    receipt.content.ownServer = { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({
      v: 1, environmentId: detail.environment.id, environmentRevision: detail.environment.revision,
      targetLinkId: detail.targetLinks[0]!.targetLink.id, targetLinkRevision: detail.targetLinks[0]!.targetLink.revision,
      sourceIntent: receipt.content.sourceIntent, manifestFingerprint: projection.manifestFingerprint,
      configInputDigests: projection.configInputDigests, physicalProjectName: projection.physicalProjectName,
      toolVersion: projection.toolVersion, services: projection.services, profiles: projection.profiles, members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
      bindings: [], images: receipt.content.images, runtimeProjections: [projection],
    }) };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail), false, receipt);
    try {
      expect(await settle('project-deployments.environment.domains.unavailableDockerDesktop')).not.toBeNull();
      expect(screen.findByTestId(id)).toBeNull();
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('keeps basic auth and your certificate off where the page cannot bind their credentials', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = {
      ...base,
      content: { ...base.content, ingress: undefined },
    };
    const { setBindings: _unused, ...withoutBindings } = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(
      detail,
      [],
      withoutBindings,
    );
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      expect(screen.findByTestId(`${id}.redirect`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.basicAuth`)).toBeNull();
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it("picks Service from the definition and Port from that service's declared export", async () => {
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const base = createDeploymentEnvironmentDetailV1();
    const definition = {
      kind: 'repository' as const,
      ref: 'main',
      compose: {
        path: 'compose.yaml',
        profiles: [],
        services: ['web', 'worker'],
        primaryService: 'web',
      },
    };
    const detail = {
      ...base,
      content: {
        ...base.content,
        ingress: undefined,
        definition,
        ownServer: {
          rollout: 'recreate' as const,
          autoRestorePreviousRelease: false,
          serviceExports: [
            {
              key: 'http',
              service: 'web',
              containerPort: 8080,
              scheme: 'http',
              exposure: 'public' as const,
            },
          ],
        },
      },
    };
    const actions = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(
      detail,
      [],
      actions,
    );
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () =>
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev'),
      );
      const select = (testID: string) =>
        screen
          .findAllByType(DropdownMenu)
          .find((node) => node.props.testID === testID);
      expect(
        select(`${id}.service`)?.props.items.map(
          (item: { id: string }) => item.id,
        ),
      ).toEqual(['web', 'worker']);
      await act(async () => {
        select(`${id}.service`)!.props.onSelect('web');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          content: expect.objectContaining({
            target: { service: 'web', containerPort: 8080 },
          }),
        }),
      );
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Environment → Domains: Service defaults for saved Compose and apps (PAGE-ACCEPT-100 D7, R2-D16)', () => {
  const withDatabase = (definition: Detail['content']['definition']) => {
    const base = createDeploymentEnvironmentDetailV1();
    // A real default PostgreSQL template's provenance: the database is the template's data service.
    const template = { templateRef: { sourceId: 'store', itemId: 'postgres', version: '17.0.0',
      ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } }, services: ['database'],
      definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
      data: [{ service: 'database', engine: 'postgres' as const, port: 5432 }] };
    return { ...base, content: { ...base.content, ingress: undefined, definition, template } };
  };

  it('starts a typed Service on the app that runs when Compose\'s primary service is the database', async () => {
    const detail = withDatabase({ kind: 'repository', ref: 'main',
      compose: { path: 'compose.yaml', profiles: [], services: [], primaryService: 'database' } });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      // The fixture's serving receipt runs `app`.
      expect(screen.findByTestId(`${id}.service`)?.props.value).toBe('app');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('starts Service on the only app the definition selects, and prefills its one port', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const base = withDatabase({ kind: 'repository', ref: 'main',
      compose: { path: 'compose.yaml', profiles: [], services: ['database', 'web'], primaryService: 'database' } });
    const detail = { ...base, content: { ...base.content, ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: false,
      serviceExports: [{ key: 'http', service: 'web', containerPort: 8080, scheme: 'http', exposure: 'public' as const }] } } };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const select = (testID: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === testID);
      expect(select(`${id}.service`)?.props.selectedId).toBe('web');
      // One declared port is a prefilled, still editable field: a one-option menu offers no choice (DEPLOY-REACCEPT-1113 D6).
      expect(select(`${id}.port`)).toBeUndefined();
      expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('8080');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('offers a Port choice only when the service declares more than one port (DEPLOY-REACCEPT-1113 D6)', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const detail = withDatabase({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  app:\n    image: nginx:alpine\n    expose:\n      - "80"\n      - "443"\n',
      profiles: [], services: ['app'], primaryService: 'app' });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const select = (testID: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === testID);
      await act(async () => {
        await vi.waitFor(() => expect(select(`${id}.port`)?.props.items.map((item: { id: string }) => item.id)).toEqual(['80', '443']));
      });
      // Nothing is chosen yet, so the field shows the choose placeholder, never the first port as if picked (D9).
      const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
      const port = screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === `${id}.port`);
      expect(port?.props.selectedId).toBeNull();
      expect(port?.props.placeholder).toBe(t('common.choose'));
      await act(async () => { select(`${id}.port`)!.props.onSelect('443'); });
      expect(screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === `${id}.port`)?.props.selectedId).toBe('443');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('offers the stored Compose services as Service choices before the first deploy (DEPLOY-REACCEPT-1113E P1)', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const detail = withDatabase({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  app:\n    image: nginx:alpine\n    expose:\n      - "80"\n', profiles: [], services: [] });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const select = (testID: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === testID);
      await act(async () => {
        await vi.waitFor(() => expect(select(`${id}.service`)?.props.selectedId).toBe('app'));
      });
      expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('80');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('prefills the Compose port when Add domain opens with the only service already selected', async () => {
    const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
    const detail = withDatabase({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  database:\n    image: postgres:17\n    ports:\n      - target: 5432\n        host_ip: 127.0.0.1\n        protocol: tcp\n',
      profiles: [], services: ['database'], primaryService: 'database' });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      expect(screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === `${id}.service`)?.props.selectedId)
        .toBe('database');
      await act(async () => {
        await vi.waitFor(() => expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('5432'));
      });
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('prefills the database container port from stored PostgreSQL Compose and never carries it to another service (R2-D16)', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const detail = withDatabase({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  database:\n    image: postgres:17\n    ports:\n      - target: 5432\n        published: "15432"\n        host_ip: 127.0.0.1\n        protocol: tcp\n  worker:\n    image: alpine\n',
      profiles: [], services: ['database', 'worker'], primaryService: 'database' });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const select = (testID: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === testID);
      expect(select(`${id}.service`)?.props.selectedId).toBe('worker');
      await act(async () => { select(`${id}.service`)!.props.onSelect('database'); });
      await act(async () => {
        await vi.waitFor(() => expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('5432'));
      });
      expect(select(`${id}.port`)).toBeUndefined();
      expect(select(`${id}.service`)?.props.selectedId).toBe('database');
      await act(async () => { select(`${id}.service`)!.props.onSelect('worker'); });
      expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('');
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: credentials an address needs', () => {
  it('says a basic-auth address needs its password and binds the chosen Saved Secret through deployments.bindings.set', async () => {
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    picked.ref = formatSharedSavedSecretRefV1('resource-password');
    const detail = createDeploymentEnvironmentDetailV1();
    const actions = domainActions(detail);
    const guarded = domain('guarded', 'preview.happier.dev', {
      basicAuth: { username: 'preview' },
    });
    const { screen, controller, settle } = await renderDomains(
      detail,
      [guarded],
      actions,
    );
    const menu = 'project-deployments.environment.domains.guarded.menu';
    try {
      expect(await settle(menu)).not.toBeNull();
      const dropdown = screen
        .findAllByType(DropdownMenu)
        .find(
          (node) =>
            node.props.testID === undefined &&
            node.props.popoverAccessibilityLabel === 'preview.happier.dev',
        )!;
      expect(
        dropdown.props.items.map((item: { id: string }) => item.id),
      ).toContain('credential:basicAuth');
      await act(async () => dropdown.props.onSelect('credential:basicAuth'));
      await vi.waitFor(() =>
        expect(actions.setBindings).toHaveBeenCalledTimes(1),
      );
      expect(actions.setBindings).toHaveBeenCalledWith({
        environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision,
        remove: [],
        set: [
          {
            purpose: 'domainCredential',
            domainId: 'guarded',
            role: 'basicAuth',
            source: { kind: 'secret', ref: picked.ref, resourceRevision: 4 },
          },
        ],
      });
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('stays quiet once the password is bound', async () => {
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = {
      ...base,
      content: {
        ...base.content,
        bindings: [
          {
            purpose: 'domainCredential' as const,
            domainId: 'guarded',
            role: 'basicAuth' as const,
            source: {
              kind: 'secret' as const,
              ref: formatSharedSavedSecretRefV1('resource-password'),
              resourceRevision: 4,
            },
          },
        ],
      },
    };
    const guarded = domain('guarded', 'preview.happier.dev', {
      basicAuth: { username: 'preview' },
    });
    const { screen, controller, settle } = await renderDomains(
      detail,
      [guarded],
      domainActions(detail),
    );
    try {
      expect(
        await settle('project-deployments.environment.domains.guarded.menu'),
      ).not.toBeNull();
      const dropdown = screen
        .findAllByType(DropdownMenu)
        .find(
          (node) =>
            node.props.popoverAccessibilityLabel === 'preview.happier.dev',
        )!;
      expect(
        dropdown.props.items.map((item: { id: string }) => item.id),
      ).not.toContain('credential:basicAuth');
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Environment → Domains: add form reads as a place, once (PAGE-ACCEPT-85 D3)', () => {
  it('names where visitors reach it instead of the topology paragraph, and prefills Compose\'s primary service', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      expect(screen.findByTestId(`${id}.ingress.notRecorded`)).toBeNull();
      // Where visitors reach it is named as a place (a tile per choice), not the topology paragraph.
      expect(screen.findByTestId(`${id}.ingress.mode:environment`)).not.toBeNull();
      // The fixture's compose.yaml names `app` as its primary service.
      expect(screen.findByTestId(`${id}.service`)?.props.value).toBe('app');
      // An empty Domains list says so once: not again under the open form.
      expect(screen.findByTestId('project-deployments.environment.domains.empty')).toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: Find zones can be stopped (O-DEPLOY F2)', () => {
  function pendingInspect() {
    const signals: AbortSignal[] = [];
    // The provider read never answers by itself; only its caller's cancellation settles it.
    const inspectPlatformTarget = vi.fn<DomainIngressInspection>((_action, _input, operation) => {
      const signal = operation?.signal;
      if (signal) signals.push(signal);
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    return { signals, inspectPlatformTarget };
  }
  async function openAndFind(detail: Detail, inspectPlatformTarget: unknown) {
    const rendered = await renderDomains(detail, [], { ...domainActions(detail), inspectPlatformTarget });
    expect(await rendered.settle(id)).not.toBeNull();
    await rendered.screen.pressByTestIdAsync(id);
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    await act(async () => {
      rendered.screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
      rendered.screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account',
        account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' } }, null);
    });
    await rendered.screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
    return rendered;
  }
  const tunnelDetail = () => {
    const base = createDeploymentEnvironmentDetailV1();
    return { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
  };

  it('Cancel stops the read through its signal and offers Retry', async () => {
    const { signals, inspectPlatformTarget } = pendingInspect();
    const { screen, controller } = await openAndFind(tunnelDetail(), inspectPlatformTarget);
    try {
      expect(signals).toHaveLength(1);
      expect(screen.findByTestId(`${id}.ingress.zones.cancel`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.cancel`);
      expect(signals[0]!.aborted).toBe(true);
      await vi.waitFor(() => expect(screen.findByTestId(`${id}.ingress.zones.retry`)).not.toBeNull());
      await screen.pressByTestIdAsync(`${id}.ingress.zones.retry`);
      expect(inspectPlatformTarget).toHaveBeenCalledTimes(2);
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each(['zones', 'tunnels'] as const)('clears the old %s error when Retry is cancelled and retains the form choice', async kind => {
    const { signals, inspectPlatformTarget } = pendingInspect();
    const failure = { ok: false as const, code: 'denied',
      details: { requiredFact: 'cloudflarePermissions', remedy: 'Reconnect the selected Cloudflare account.' } };
    inspectPlatformTarget.mockResolvedValueOnce(kind === 'zones' ? failure : { ok: true,
      value: { kind: 'ready', zones: [{ zoneId: 'chosen-zone', name: 'happier.dev' }], options: [] } });
    const { screen, controller } = await openAndFind(tunnelDetail(), inspectPlatformTarget);
    try {
      if (kind === 'tunnels') {
        inspectPlatformTarget.mockResolvedValueOnce(failure);
        await screen.pressByTestIdAsync(`${id}.ingress.read`);
      }
      expect(screen.findByTestId(`${id}.ingress.${kind}.error`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.${kind}.retry`);
      await screen.pressByTestIdAsync(`${id}.ingress.${kind}.cancel`);
      expect(signals[0]?.aborted).toBe(true);
      expect(screen.findByTestId(`${id}.ingress.${kind}.stopped`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.ingress.${kind}.error`)).toBeNull();
      expect(screen.findByTestId(`${id}.host`)?.props.value).toBe('docs.happier.dev');
      if (kind === 'tunnels') expect(screen.findByTestId(`${id}.ingress.zone`)).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('closing the form cancels a read still in flight', async () => {
    const { signals, inspectPlatformTarget } = pendingInspect();
    const { screen, controller } = await openAndFind(tunnelDetail(), inspectPlatformTarget);
    try {
      await screen.pressByTestIdAsync(`${id}.cancel`);
      expect(signals[0]!.aborted).toBe(true);
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: a Find zones refusal names its own cause (PAGE-ACCEPT-88 N13)', () => {
  it.each(['provider-output', 'action-failure'] as const)('displays provider-authored recovery with Retry from %s', async source => {
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
    const reason = 'denied';
    const details = { requiredFact: 'cloudflarePermissions', remedy: 'Ask the Cloudflare account owner to restore zone access.' };
    const inspectPlatformTarget = vi.fn(async () => source === 'provider-output'
      ? { ok: true as const, value: { kind: 'unavailable', options: [], reason, ...details } }
      : { ok: false as const, code: reason, details });
    const { screen, controller, settle } = await renderDomains(detail, [], { ...domainActions(detail), inspectPlatformTarget });
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
        screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account',
          account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' } }, null);
      });
      await screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
      const card = screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === `${id}.ingress.zones.error`);
      expect(card?.props.diagnosticCode).toBe(reason);
      expect(card?.props.title).toBe(details.remedy);
      expect(screen.findByTestId(`${id}.ingress.zones.retry`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.retry`);
      expect(inspectPlatformTarget).toHaveBeenCalledTimes(2);
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: Find zones says what it needs (JOURNEY-OPUS-88 F2)', () => {
  it('names the missing domain under a disabled Find zones instead of a lone greyed button', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
    const inspectPlatformTarget = vi.fn();
    const { screen, controller, settle } = await renderDomains(detail, [], { ...domainActions(detail), inspectPlatformTarget });
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
      await act(async () => {
        screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account',
          account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' } }, null);
      });
      // The account is chosen but the Domain is empty: no read is running, so there is no Cancel; the row says why.
      expect(screen.findByTestId(`${id}.ingress.zones.cancel`)).toBeNull();
      expect(screen.findByTestId(`${id}.ingress.zones.needs`)).not.toBeNull();
      await act(async () => screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev'));
      expect(screen.findByTestId(`${id}.ingress.zones.needs`)).toBeNull();
      expect(inspectPlatformTarget).not.toHaveBeenCalled();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: Add domain never looks dead (UI-DOMAIN-VIEWER-1113)', () => {
  it('shows a refused add at the form the person pressed, not above it out of view', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const actions = { ...domainActions(detail), addDomain: vi.fn(async () => ({ ok: false as const, error: 'deployment_target_not_running' })) };
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).toHaveBeenCalledOnce();
      const atForm = await settle(`${id}.outcome`);
      expect(atForm, 'the refusal renders inside the open form, beside Add domain').not.toBeNull();
      const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
      const banner = screen.findAllByType(AttentionBanner)
        .find(node => String(node.props.testID).startsWith('project-deployments.outcome.refused'));
      // An add that failed says so (DEPLOY-ACCEPT-143 B1), and sits in the form's own gutter like the fields (B2).
      expect(banner?.props.title).toBe(t('projects.deployments.editors.domainAddFailedTitle'));
      expect(banner?.props.placement).toBe('inline');
      expect(screen.findByTestId(`${id}.host`), 'the form stays open with what was typed').not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('says a refused add needs a deploy without a second, different recovery button (DEPLOY-REACCEPT-1113 D7)', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    // An older daemon still authors its own sentence beside the fact; the recovery owner's one remedy wins.
    const actions = { ...domainActions(detail), addDomain: vi.fn(async () => ({ ok: false as const, error: 'required_fact_unavailable',
      details: { requiredFact: 'activeDomainMembers', step: 'native_execution',
        remedy: 'Deploy the app so it is running on this Machine, then add the domain' } })) };
    const openRecovery = vi.fn();
    const { screen, controller, settle } = await renderDomains(detail, [], actions, false, undefined, false, { ...noReview, openRecovery });
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(await settle(`${id}.outcome`)).not.toBeNull();
      const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
      const banner = screen.findAllByType(AttentionBanner)
        .find(node => String(node.props.testID).startsWith('project-deployments.outcome.refused'));
      const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
      // The cure is the Environment's own Deploy, already on the page: the sentence names it and no other route is offered.
      expect(banner?.props.description).toBe(readDeploymentRefusalRecoveryV1('required_fact_unavailable', { requiredFact: 'activeDomainMembers' })?.remedy);
      expect(banner?.props.action).toBeUndefined();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('names the field a disabled Add domain still needs', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      expect(screen.findByTestId(`${id}.needs`), 'nothing left to name once Add domain can work').toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: whether the address reaches this Machine (#2)', () => {
  const dnsHealth = (status: 'up' | 'down' | 'unknown', reason: string) => ({ status,
    cause: { kind: 'dns' as const, reason, observerMachineId: 'controller', vantage: 'sameMachine' as const },
    evidence: { v: 1 as const,
    items: [{ source: { kind: 'alert' as const, label: 'DNS' }, author: { kind: 'process' as const },
      text: 'DNS finite observation' }] } });

  it('checks a complete draft only when asked, says what the native check found, and forgets it when the address changes', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    // The verify Action (preview mode) is the boundary: first no record, then the Machine's own challenge.
    const previewDomainDns = vi.fn()
      .mockResolvedValueOnce({ ok: true, environmentId: detail.environment.id, dnsHealth: dnsHealth('down', 'dns_missing') })
      .mockResolvedValueOnce({ ok: true, environmentId: detail.environment.id, dnsHealth: dnsHealth('up', 'dns_ready') });
    const actions = { ...domainActions(detail), previewDomainDns };
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      // Typing asks nothing of the Machine.
      expect(previewDomainDns).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync(`${id}.dns.action`);
      expect(previewDomainDns).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        environmentId: detail.environment.id, content: expect.objectContaining({ hostname: 'app.example.test' }),
      }));
      expect(await settle(`${id}.dns.missing`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.dns.action`);
      expect(previewDomainDns).toHaveBeenCalledTimes(2);
      expect(await settle(`${id}.dns.ready`)).not.toBeNull();
      // A different address is a different question: the old answer is not shown for it.
      await act(async () => screen.changeTextByTestId(`${id}.host`, 'www.example.test'));
      expect(screen.findByTestId(`${id}.dns.ready`)).toBeNull();
      expect(screen.findByTestId(`${id}.dns.unchecked`)).not.toBeNull();
      expect(previewDomainDns).toHaveBeenCalledTimes(2);
      // Advisory: Add domain does not wait on DNS.
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('says on the row when the saved address does not reach this Machine yet', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const known = domain('elsewhere', 'shop.example.com');
    const item = { ...known, domain: { ...known.domain, dnsHealth: dnsHealth('down', 'dns_not_this_machine') } };
    const { screen, controller, settle } = await renderDomains(detail, [item], domainActions(detail));
    try {
      const row = await settle('project-deployments.environment.domains.elsewhere');
      expect(row).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.domains.elsewhere.checkAgain')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('Needs a look');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('shows a telemetry address without inventing a workload service route', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const known = domain('collector', 'collector.example.com');
    const item = { ...known, content: DeploymentDomainContentV1Schema.parse({ ...known.content, target: { kind: 'telemetry' } }) };
    const { screen, controller, settle } = await renderDomains(detail, [item], domainActions(detail));
    try {
      expect(await settle('project-deployments.environment.domains.collector')).not.toBeNull();
      expect(screen.getTextContent()).toContain('collector.example.com');
      expect(screen.getTextContent()).not.toContain('undefined:undefined');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('draws each address with where it reaches, its certificate and its state (lab envDom)', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const expiresAt = Date.UTC(2027, 0, 8);
    const serving = { ...domain('serving', 'billing.example.com'), health: { availability: 'observed' as const, unavailableReason: null,
      observedAt: 1, vantage: 'outside' as const, certificate: { state: 'valid' as const, expiresAt }, needsYou: null } };
    const waiting = { ...domain('waiting', 'pay.example.com'), domain: { ...domain('waiting', 'pay.example.com').domain,
      dnsHealth: dnsHealth('down', 'dns_missing') } };
    const { screen, controller, settle } = await renderDomains(detail, [serving, waiting], domainActions(detail));
    try {
      await settle('project-deployments.environment.domains.waiting');
      const text = screen.getTextContent();
      expect(text).toContain('2 domains');
      expect(text).toContain('web:3000 /');
      expect(text).toContain(`Automatic · expires ${new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
      expect(screen.findByTestId('project-deployments.environment.domains.serving.state')).not.toBeNull();
      expect(text).toContain('Serving');
      // A waiting address says what it needs and carries the record to add, with Check again beside it.
      expect(text).toContain('No DNS record yet');
      expect(screen.findByTestId('project-deployments.environment.domains.waiting.line')).not.toBeNull();
      expect(text).toContain('Add an A or AAAA record');
      expect(screen.findByTestId('project-deployments.environment.domains.waiting.checkAgain')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.domains.serving.checkAgain')).toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: where an address leads (DEPLOY-REACCEPT-1113 D2)', () => {
  it('names replica Machines only when they are not just the Environment\'s own Machine', async () => {
    const { domainRouteMachineIds } = await import('./DeploymentDomainRow');
    const replica = (machineId: string) => ({ machineId, installationId: `i-${machineId}`, containerName: `c-${machineId}` });
    expect(domainRouteMachineIds([replica('own'), replica('own')], 'own')).toEqual([]);
    expect(domainRouteMachineIds([replica('other')], 'own')).toEqual(['other']);
    expect(domainRouteMachineIds([replica('own'), replica('other'), replica('other')], 'own')).toEqual(['own', 'other']);
    expect(domainRouteMachineIds(undefined, 'own')).toEqual([]);
    expect(domainRouteMachineIds([replica('own')], null)).toEqual(['own']);
  });
});

describe('Environment → Domains: the platform\'s built-in address', () => {
  // A Vercel or Workers Environment keeps its stable *.vercel.app / *.workers.dev address: it leads the list, read-only.
  async function renderPanel(items: readonly unknown[], builtInUrls: readonly string[]) {
    const { DeploymentDomainsPanel } = await import('./DeploymentDomainsPanel');
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listDomains: async () => ({ ok: true, value: { items: items as never, nextCursor: null } }),
    } as Partial<DeploymentReadTransportV1> as DeploymentReadTransportV1 });
    const screen = await renderScreen(
      <DeploymentDomainsPanel controller={controller} environmentId="environment-staging"
        environment={{ runtimeTargetLinkId: 'target-link' }} demand={shown} builtInUrls={builtInUrls} />,
    );
    return { screen, controller };
  }

  it('lists the built-in address first and says what it is', async () => {
    const { screen, controller } = await renderPanel([domain('custom', 'shop.example.com')], ['https://acme-site.vercel.app']);
    try {
      const builtIn = 'project-deployments.environment.domains.builtIn.acme-site.vercel.app';
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId(builtIn), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      expect(screen.findByTestId(builtIn)).not.toBeNull();
      expect(screen.findByTestId(`${builtIn}.state`)).not.toBeNull();
      const texts = screen.findAllByType('Text' as never).map(node => String(node.props.children));
      expect(texts).toContain(t('projects.deployments.editors.domainBuiltIn'));
      // Rows in document order: the built-in address leads the Environment's own addresses.
      const custom = 'project-deployments.environment.domains.custom';
      const order = screen.findAll(node => typeof node.type === 'string'
        && (node.props.testID === builtIn || node.props.testID === custom)).map(node => node.props.testID);
      expect(order[0]).toBe(builtIn);
      expect(order).toContain(custom);
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('does not say there are no domains when only the built-in address exists', async () => {
    const { screen, controller } = await renderPanel([], ['https://edge-site.workers.dev']);
    try {
      const builtIn = 'project-deployments.environment.domains.builtIn.edge-site.workers.dev';
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId(builtIn), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      expect(screen.findByTestId(builtIn)).not.toBeNull();
      const texts = screen.findAllByType('Text' as never).map(node => String(node.props.children));
      expect(texts).not.toContain(t('projects.deployments.domainsEmpty'));
    } finally { await screen.unmount(); controller.retire(); }
  });
});
