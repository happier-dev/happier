import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';
import { t } from '@/text';
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
      targetLinkId: 'target-a',
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
) {
  const receipt = createDeploymentReceiptDetailV1();
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
        phone={false}
        deploy={null}
        review={noReview}
        onOpenReceipt={() => {}}
        destination={{ tab: 'domains', section: null }}
        domainActions={domainActions as never}
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

describe('Environment → Domains: add form (P6)', () => {
  it('adds a redirect alias, your own certificate and a basic-auth user in one Domain Add', async () => {
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
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
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
            hostname: 'docs.happier.dev',
            target: {
              service: 'web',
              containerPort: 3000,
              redirectTo: 'www.happier.dev',
            },
            healthCheck: { path: '/', expectStatus: 200 },
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
      await act(async () => select(`${id}.service`)!.props.onSelect('web'));
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

describe('Environment → Domains: Service never starts on the database (PAGE-ACCEPT-100 D7)', () => {
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
      expect(select(`${id}.port`)?.props.selectedId).toBe('8080');
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
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      expect(screen.findByTestId(`${id}.ingress.notRecorded`)).toBeNull();
      const mode = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${id}.ingress.mode`)!;
      const environment = mode.props.items.find((item: { id: string }) => item.id === 'environment');
      expect(environment.title).not.toBe(t('projects.deployments.domainIngressEnvironment'));
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
