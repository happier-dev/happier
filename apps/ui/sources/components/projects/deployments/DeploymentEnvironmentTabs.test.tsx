import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
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

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
// The exact controller RPC is the network boundary; its protocol reader stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: vi.fn(async () => { throw new Error('controller_unavailable'); }),
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
afterEach(standardCleanup);
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
  const catalog = await import('@/components/appShell/rightSidebar/detailNavigationItems');
  const resolve = vi.spyOn(catalog, 'resolveDetailNavigationItems');
  const navigate = vi.fn();
  const deploy = vi.fn();
  const reads = vi.fn(async () => ({ ok: true as const, value: createDeploymentEnvironmentDetailV1() }));
  const { screen, controller, settle } = await renderTab('variables', createDeploymentEnvironmentDetailV1(),
    { readEnvironment: reads }, { onNavigate: navigate, deploy });
  try {
    expect(await settle('project-deployments.environment')).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
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
    expect(resolve).toHaveBeenCalledTimes(1);
  } finally { await screen.unmount(); controller.retire(); resolve.mockRestore(); }
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
async function renderTab(
  tab: string,
  detail: Detail,
  transport: Transport = {},
  extra: Record<string, unknown> = {},
) {
  const receipt = createDeploymentReceiptDetailV1();
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
      ...transport,
    },
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
        destination={{ tab: tab as never, section: null }}
        {...extra}
      />
    </PresentedDetailNavigationProvider>,
  );
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
  return { screen, controller, settle };
}

describe('Environment → Domains', () => {
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
    const detail = createDeploymentEnvironmentDetailV1();
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

  it('backs up and verifies an exact snapshot through the real store and Action front door, showing the destination and result', async () => {
    const { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
      ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
      projectExternalActionDeploymentNativeEnvelopeAdmissionV1 } = await import('@happier-dev/protocol/actions/externalActionApi');
    const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
    const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
    const { default: nacl } = await import('tweetnacl');
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(26));
    await homes.reset();
    const serverIdentityId = 'srv_backups';
    const serverId = await homes.addHome({ name: 'Backups', serverUrl: 'https://backups.test',
      serverIdentityId, accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const machine = { ...createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-owner' }),
      installationId: 'installation-a', installationPublicKey: encodeBase64(installation.publicKey) };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, 'GET /v1/machines/machine-a', { body: { machine } });
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content,
      backup: { ...backup, config: { bucket: 'team-recovery', prefix: 'staging/' } } } });
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, {
      body: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) },
    });
    const snapshot = { snapshotId: 'a'.repeat(64), treeId: 'b'.repeat(64), hostname: 'db-host',
      time: '2026-11-06T10:00:00Z', paths: ['/database.dump'], tags: [] };
    const manifest = { schemaVersion: 1, environmentId: detail.environment.id, sourceId: 'db', kind: 'dump',
      configRevision: 1, repositoryId: 'c'.repeat(64), snapshot, totalBytesProcessed: 123,
      totalFilesProcessed: 1, producerChecksumSha256: 'd'.repeat(64) };
    const effects: Array<{ actionId: string; input: unknown }> = [];
    const { DEPLOYMENT_BACKUP_ACTION_IDS_V1 } = await import('@happier-dev/protocol/deployments/deploymentActionIdsV1');
    for (const actionId of DEPLOYMENT_BACKUP_ACTION_IDS_V1) {
      homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'backup-root', binding: {
          accountId: 'account-owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
          machineId: machine.id, installationId: machine.installationId, custodianAccountId: 'account-owner',
          accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId, target: request.envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), environmentId: detail.environment.id,
          deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope: request.envelope }),
        } }) };
      } });
      // Only the remote transport/native boundary is substituted; the UI's real Action executor runs.
      homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
        const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
        effects.push({ actionId, input: envelope.input });
        const result = actionId === 'deployments.backups.run' ? { kind: 'verified', operationId: 'backup-operation', manifests: [manifest] }
          : actionId === 'deployments.backups.inventory' ? { kind: 'inventory', environmentId: detail.environment.id,
            configRevision: 1, repositoryId: manifest.repositoryId, snapshots: [{ snapshot, source: { sourceId: 'db', kind: 'dump' },
              verification: { kind: 'verified', backupOperationId: 'backup-operation', configRevision: 1 } },
              { snapshot: { ...snapshot, snapshotId: 'e'.repeat(64) }, source: null,
                verification: { kind: 'unknown', reason: 'captureReceiptUnavailable' } }] }
          : { kind: 'verified', operationId: 'verify-operation', backupOperationId: 'backup-operation', environmentId: detail.environment.id,
            configRevision: 1, repositoryId: manifest.repositoryId, snapshotId: snapshot.snapshotId,
            level: Reflect.get(envelope.input as object, 'level'), verified: true };
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
          execution: { ok: true, result } }) };
      } });
    }
    const { screen, controller, settle } = await renderTab('settings', detail, {}, { lifetime: account.accountLifetime });
    const id = 'project-deployments.environment.settings.backups';
    try {
      expect(await settle(`${id}.run`)).not.toBeNull();
      expect(screen.getTextContent()).toContain('team-recovery');
      expect(screen.getTextContent()).toContain('staging/');
      expect(effects).toEqual([]); // Opening Settings performs no native backup read or write.
      await screen.pressByTestIdAsync(`${id}.verify`);
      expect(await settle(`${id}.snapshot.${'e'.repeat(64)}`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.snapshot.${'e'.repeat(64)}.manifestReadBack`)).toBeNull();
      expect(effects[0]).toMatchObject({ actionId: 'deployments.backups.inventory' });
      await screen.pressByTestIdAsync(`${id}.verify`);
      await screen.pressByTestIdAsync(`${id}.run`);
      expect(await settle(`${id}.result`)).not.toBeNull();
      expect(effects.find(effect => effect.actionId === 'deployments.backups.run')).toMatchObject({ actionId: 'deployments.backups.run', input: {
        serverId: serverIdentityId, environmentId: detail.environment.id, expectedRevision: 1, configRevision: 1,
        machineId: 'machine-a', installationId: 'installation-a', targetLinkId: 'target-link', deploymentId: 'deployment-a',
      } });
      await screen.pressByTestIdAsync(`${id}.verify`);
      expect(await settle(`${id}.snapshot.${snapshot.snapshotId}.manifestReadBack`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.snapshot.${snapshot.snapshotId}.manifestReadBack`);
      expect(effects.at(-1)).toMatchObject({ actionId: 'deployments.backups.verify', input: {
        backupOperationId: 'backup-operation', snapshotId: snapshot.snapshotId, level: 'manifestReadBack',
      } });
      await screen.pressByTestIdAsync(`${id}.snapshot.${snapshot.snapshotId}.repositoryCheck`);
      expect(effects.at(-1)).toMatchObject({ actionId: 'deployments.backups.verify', input: { level: 'repositoryCheck' } });
      expect(screen.getTextContent()).toContain('Repository check');
      expect(screen.findByTestId(`${id}.prune`)).toBeNull();
    } finally { await screen.unmount(); controller.retire(); account.dispose(); await homes.reset(); }
  });

  it('uses one data card for a template database and opens the existing Variables and Store flows', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Data', serverUrl: 'https://data-card.test',
      accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, template: {
      templateRef: { sourceId: 'apps', itemId: 'postgres', version: '17', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
      services: ['database'], data: { engine: 'postgres', version: '17', service: 'database', port: 5432 },
    } } });
    let navigate!: (destination: unknown) => void;
    const navigation = new Promise<unknown>(resolve => { navigate = resolve; });
    const { screen, controller, settle } = await renderTab('overview', detail, {}, {
      onNavigate: navigate, serverId, lifetime: account.accountLifetime,
    });
    try {
      expect(await settle('project-deployments.environment.data')).not.toBeNull();
      expect(screen.getTextContent()).toContain('PostgreSQL');
      expect(screen.getTextContent()).toContain('5432');
      await screen.pressByTestIdAsync('project-deployments.environment.data.variables');
      expect(await navigation).toEqual({ tab: 'variables', section: null });
      routerMock.spies.push.mockClear();
      await screen.pressByTestIdAsync('project-deployments.environment.data.add');
      expect(String(routerMock.spies.push.mock.calls[0]?.[0])).toContain('kind=app');
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
    const { screen, controller, settle } = await renderTab(
      'settings',
      createDeploymentEnvironmentDetailV1(),
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
        createDeploymentEnvironmentDetailV1(),
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
