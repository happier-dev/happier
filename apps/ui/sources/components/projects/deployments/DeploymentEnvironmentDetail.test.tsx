// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  projectDeploymentReceiptFactsV1,
  projectDeploymentReceiptHistoryEntryV1,
  type DeploymentEnvironmentTabV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1,
  createDeploymentReceiptHeaderV1,
  createDeploymentSecretVariableBindingV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { act, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// Test Renderer keeps the real menus while substituting browser portal and focus primitives.
vi.mock('@/utils/web/reactDomCjs', async () =>
  (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
const device = vi.hoisted(() => ({ current: null as 'phone' | 'tablet' | null }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...actual, useDeviceType: () => device.current ?? actual.useDeviceType() };
});
afterEach(() => { device.current = null; });
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
afterEach(() => { routerMock.resetParams(); routerMock.spies.setParams.mockClear(); });
afterEach(async () => {
  const { Modal } = await import('@/modal');
  await act(async () => { Modal.hideAll(); });
  await standardCleanup();
});

// Navigation now uses the real mounted Action front door and its captured Home binding.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
async function waitForContent(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  await waitForHomeGovernance(async () => {
    await act(async () => {});
    const visibleIds = [...new Set(screen.root.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string')
      .map(node => node.props.testID))];
    expect(screen.findByTestId(testID), visibleIds.join(', ')).not.toBeNull();
  });
}
async function selectEnvironmentTab(screen: Awaited<ReturnType<typeof renderScreen>>, tab: DeploymentEnvironmentTabV1) {
  await act(async () => {});
  const testID = `project-deployments.environment.tab:${tab}`;
  await screen.pressByTestIdAsync(testID);
  await waitForHomeGovernance(async () => {
    await act(async () => {});
    expect(screen.findHostByTestId(testID)?.props.accessibilityState?.selected).toBe(true);
  });
}

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};
// The HTTP fixtures belong to the same Home as the real captured Action credential.
function environmentHeaderForHome(overrides: Parameters<typeof createDeploymentEnvironmentHeaderV1>[0] = {}) {
  return createDeploymentEnvironmentHeaderV1({ ...overrides, serverId: scope.serverId });
}
function environmentDetailForHome(overrides: Parameters<typeof createDeploymentEnvironmentDetailV1>[0] = {}) {
  const detail = createDeploymentEnvironmentDetailV1(overrides);
  return { ...detail, environment: environmentHeaderForHome(detail.environment) };
}
type TeardownControllerBoundary = Extract<Parameters<typeof import('@/dev/testkit/harness/externalActionAccountHttpBoundary').createExternalActionAccountHttpBoundary>[0],
  { requesterInvocation?: 'required' }>;

/** Home's HTTP boundary keeps requester custody, authorization and crypto real. */
async function answerTeardownController(machineId: string, execute: TeardownControllerBoundary['execute'],
  failure?: TeardownControllerBoundary['failure']) {
  const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
  return answerExternalActionAccountForHome(homes, scope.serverId, { machineId, actionId: 'deployments.teardown',
    tokenEpoch: 0, requesterInvocation: 'required', ...(failure ? { failure } : {}), execute });
}

const shown = { mounted: true, visible: true, focused: true };
const noReview = { pendingId: null, request: () => {}, open: () => {} };
beforeEach(async () => {
  installHomeGovernanceBoundaries(homes);
  scope.serverId = await homes.addHome({ name: 'Environment navigation', serverUrl: 'https://environment-navigation.test', accountId: scope.accountId });
  const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
  const resolution = await resolveServerCredentialAccountScope(scope.serverId);
  expect(resolution.kind).toBe('bound');
});

/** The network boundary only; the shared controller, projections and page composition run for real. */
function controllerFor(
  input: Readonly<{
    detail?: ReturnType<typeof createDeploymentEnvironmentDetailV1>;
    receipt?: ReturnType<typeof createDeploymentReceiptDetailV1>;
    history?: readonly ReturnType<typeof createDeploymentReceiptDetailV1>[];
    destinations?: readonly ReturnType<typeof createDeploymentEnvironmentHeaderV1>[];
    onListEnvironments?: () => void;
    listEnvironments?: DeploymentReadTransportV1['listEnvironments'];
    listDomains?: DeploymentReadTransportV1['listDomains'];
  }>,
) {
  const detail = input.detail ?? environmentDetailForHome();
  const receipt = input.receipt ?? createDeploymentReceiptDetailV1();
  const retained = input.history ?? [receipt];
  const servingId = detail.targetLinks.find(row => row.targetLink.id === detail.environment.runtimeTargetLinkId)?.targetLink.activeDeploymentId;
  const servingBase = createDeploymentReceiptDetailV1();
  if (servingBase.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
  const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId ?? 'not-serving' }),
    content: { ...servingBase.content, sourceIntent: { ...servingBase.content.sourceIntent, sha: 'f'.repeat(40) } } });
  const transport: DeploymentReadTransportV1 = {
    listDomains: input.listDomains ?? (async () => ({ ok: true, value: { items: [], nextCursor: null } })),
    listEnvironments: input.listEnvironments ?? (async () => { input.onListEnvironments?.(); return ({
      ok: true,
      value: {
        items: [
          { environment: detail.environment, title: detail.content.name },
          ...(input.destinations ?? []).map(environment => ({ environment, title: environment.id })),
        ],
        nextCursor: null,
      },
    }); }),
    readEnvironment: async () => ({ ok: true, value: detail }),
    listHistory: async () => ({
      ok: true,
      value: { ok: true, items: [...retained, ...(servingId && !retained.some(row => row.deployment.id === servingId) ? [serving] : [])]
        .map(row => {
          // The real transport's per-row projection: revision title, source and the recorded failure fact.
          const entry = projectDeploymentReceiptHistoryEntryV1(row);
          return { ...row.deployment, source: entry.source, failure: entry.failure,
            ...(entry.historyTitle ? { title: entry.historyTitle } : {}) };
        }), nextCursor: null },
    }),
    readReceipt: async (_scope, _environmentId, id) => ({ ok: true,
      value: retained.find(row => row.deployment.id === id) ?? (id === receipt.deployment.id ? receipt : serving) }),
  };
  return {
    controller: createDeploymentReadControllerV1({ scope, transport }),
    detail,
    receipt,
  };
}

describe('Project deployments page', () => {
  it('draws no setup control and opens no prompt-only authoring until the person has a record for Environments', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, content: { ...base.content, definition: { kind: 'repository' as const, ref: 'main' } },
      targetLinks: base.targetLinks.map(row => ({ ...row, targetLink: { ...row.targetLink, activeDeploymentId: undefined } })) };
    const { controller } = controllerFor({ detail });
    try {
      // Setup runs only through a configured record ("Set it up", declared by its subject owner) and
      // sessions/run-configured-v1; this Home's catalog has none, so nothing stands in for it.
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} />);
      await waitForContent(screen, 'project-deployments.environment.menu');
      const { AgentActionButton } = await import('@happier-dev/plugin-ui/components');
      expect(screen.findAllByType(AgentActionButton)).toHaveLength(0);
      expect(screen.findByTestId('project-deployments.environment.prepare')).toBeNull();
      await screen.unmount();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('does not offer missing-compose preparation when the Environment already declares compose', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(row => ({ ...row,
      targetLink: { ...row.targetLink, activeDeploymentId: undefined } })) };
    const { controller } = controllerFor({ detail });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} />);
      await waitForContent(screen, 'project-deployments.environment.menu');
      expect(screen.findByTestId('project-deployments.environment.prepare')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('offers Duplicate from the loaded Environment without opening another editor owner', async () => {
    const { ModalProvider } = await import('@/modal');
    const { controller, detail } = controllerFor({});
    let selected: typeof detail | undefined;
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} onDuplicate={value => { selected = value; }} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.duplicate');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.duplicate');
      await waitForHomeGovernance(() => expect(selected).toMatchObject(detail));
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each(['review', 'refusal', 'receipt', 'retained'] as const)(
    'opens promotion from the native stored receipt and preserves the destination controller’s %s', async response => {
    // Designed confirmation binds the real current Account and stable Home identity.
    scope.serverId = await homes.addHome({ name: 'Promotion', serverUrl: 'https://promotion-navigation.test',
      accountId: scope.accountId, currentAccount: true, serverIdentityId: `srv_${'8'.repeat(32)}` });
    const previousPromotionRequests = homes.requestsFor('/v1/actions/deployments.promote').length;
    const { Modal, ModalProvider } = await import('@/modal');
    const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const { createDeploymentActions } = await import('./deploymentActions');
    const base = environmentDetailForHome();
    const definition = { kind: 'stored' as const, document: 'services:\n  app:\n    image: app:tested\n',
      contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] };
    const detail = environmentDetailForHome({ content: { ...base.content, definition },
      ...(response === 'retained' ? { targetLinks: [] } : {}) });
    const baseReceipt = createDeploymentReceiptDetailV1();
    const sourceReceipt = createDeploymentReceiptDetailV1({ content: { ...baseReceipt.content, sourceIntent: definition } });
    const destination = environmentHeaderForHome({ id: 'production' });
    const viewOnly = environmentHeaderForHome({ id: 'view-only', capabilities: { ...destination.capabilities,
      role: 'reader', deploy: false, manage: false } });
    const list = vi.fn();
    const { controller, receipt } = controllerFor({ detail, receipt: sourceReceipt, destinations: [destination, viewOnly], onListEnvironments: list });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const actions = createDeploymentActions(lifetime, scope.projectSourceId);
    homes.answer(scope.serverId, 'GET /v1/deployments/environments/production', { body: { ok: true,
      environment: destination, targetLinks: [] } });
    await answerExternalActionAccountForHome(homes, scope.serverId, { actionId: 'deployments.promote', machineId: 'machine-a',
      tokenEpoch: 0, deploymentSource: { id: scope.projectSourceId, revision: 1 }, execute: input => {
      expect(input).toEqual({ serverId: scope.serverId, environmentId: 'production',
        sourceEnvironmentId: detail.environment.id, sourceDeploymentId: receipt.deployment.id, artifact: 'image' });
      return response === 'review'
        ? { kind: 'approval_request_created', actionId: 'deployments.promote', artifactId: 'promotion-review' }
        : response === 'refusal' ? { ok: false, error: 'deployment_access_denied' }
        : { ok: true, environmentId: 'production', deploymentId: 'promoted-receipt', revision: 2,
            deploymentRevision: 1, state: 'succeeded' };
    } });
    const request = vi.fn();
    const openPromoted = vi.fn();
    const review = { ...noReview, request };
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id} deploymentId={receipt.deployment.id}
            environmentName="Staging" demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false}
            rollback={null} cancel={null} deploy={null} promote={actions.promote} readLogs={null} linkPath={null}
            onBack={() => {}} review={review} onOpenReceipt={() => {}} onOpenPromotionReceipt={openPromoted} /></ModalProvider>);
      await waitForContent(screen, 'project-deployments.receipt.header');
      expect(list, 'closed promotion loads no destination inventory').not.toHaveBeenCalled();
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.receipt.menu'); });
      await waitForContent(screen, 'project-deployments.receipt.promote');
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.receipt.promote'); });
      await waitForContent(screen, 'project-deployments.promote.destination:production');
      expect(screen.findByTestId(`project-deployments.promote.destination:${detail.environment.id}`)).toBeNull();
      expect(screen.findByTestId('project-deployments.promote.destination:view-only')).toBeNull();
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.promote.destination:production'); });
      expect(screen.findByTestId('project-deployments.promote.artifact:rebuild')).toBeNull();
      expect(screen.findByTestId('project-deployments.promote.destination:production')?.props['aria-checked']).toBe(true);
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.promote.confirm'); });
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/actions/deployments.promote'),
        screen.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode).filter(Boolean).join(', ')).toHaveLength(previousPromotionRequests + 1));
      if (response === 'review') {
        await waitForHomeGovernance(() => expect(request).toHaveBeenCalledWith('promotion-review'));
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(screen.findByTestId('project-deployments.promote')).toBeNull();
        });
      } else if (response === 'refusal') {
        await waitForContent(screen, 'project-deployments.promote.refused');
        expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'project-deployments.promote.refused')?.props.diagnosticCode)
          .toBe('deployment_access_denied');
        expect(screen.findByTestId('project-deployments.promote.destination:production')?.props['aria-checked']).toBe(true);
        expect(request).not.toHaveBeenCalled();
      } else {
        await waitForHomeGovernance(() => expect(openPromoted).toHaveBeenCalledWith('production', 'promoted-receipt'));
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(screen.findByTestId('project-deployments.promote')).toBeNull();
        });
      }
      expect(homes.requestsFor('/v1/actions/deployments.promote')).toHaveLength(previousPromotionRequests + 1);
    } finally { await act(async () => { Modal.hideAll(); controller.retire(); }); }
  });

  it.each(['repository', 'platform'] as const)('hides promotion for an unsupported %s receipt and platform header', async kind => {
    const previousPromotionRequests = homes.requestsFor('/v1/actions/deployments.promote').length;
    const base = environmentDetailForHome();
    const detail = kind === 'platform' ? environmentDetailForHome({ targetLinks: base.targetLinks.map(row => ({ ...row,
      targetLink: { ...row.targetLink, source: { kind: 'plugin', contribution: { pluginId: 'vercel', localId: 'project' } },
        targetKind: 'vercel', machines: [], members: [] } })) }) : base;
    const baseReceipt = createDeploymentReceiptDetailV1();
    const sourceReceipt = kind === 'platform' ? createDeploymentReceiptDetailV1({ content: {
      sourceIntent: { kind: 'stored', document: 'services:\n  app:\n    image: app:tested\n', contentRevision: 1,
        composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] },
      sourceMethod: 'upload', machines: [], images: [], machineResults: [], steps: [],
      platform: { credentialPrincipal: { kind: 'account', accountId: scope.accountId, purpose: {
        consumer: { pluginId: 'happier.deployment-vercel', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
        target: { kind: 'account', account: { service: { pluginId: 'happier.machine-vercel', localId: 'vercel' }, accountId: 'connected' } } },
        providerIdentity: { providerAccountId: 'team', providerResourceId: 'project', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' }, targetLinkRevision: 1, observation: { v: 1, state: 'queued', observedAtMs: 1000 } },
    } }) : baseReceipt;
    const { controller, receipt } = controllerFor({ detail, receipt: sourceReceipt });
    const { createDeploymentActions } = await import('./deploymentActions');
    const promote = createDeploymentActions({ scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }, scope.projectSourceId).promote;
    try {
      const screen = await renderScreen(<>
        <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
          accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
          review={noReview} onOpenReceipt={() => {}} />
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id} deploymentId={receipt.deployment.id}
          environmentName="Staging" demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false}
          rollback={null} cancel={null} deploy={null} promote={promote} readLogs={null} linkPath={null}
          onBack={() => {}} review={noReview} onOpenReceipt={() => {}} />
      </>);
      await waitForContent(screen, 'project-deployments.environment.serving.receipt');
      await waitForContent(screen, 'project-deployments.receipt.header');
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.receipt.menu'); });
      await waitForContent(screen, 'project-deployments.receipt.menu.environment');
      expect(screen.findByTestId('project-deployments.receipt.promote')).toBeNull();
      expect(screen.findByTestId('project-deployments.environment.promote')).toBeNull();
      expect(homes.requestsFor('/v1/actions/deployments.promote')).toHaveLength(previousPromotionRequests);
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('offers removal when the target has never deployed', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(item => ({ ...item,
      targetLink: { ...item.targetLink, activeDeploymentId: undefined } })) };
    const { controller } = controllerFor({ detail, history: [] });
    const { ModalProvider } = await import('@/modal');
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { createDeploymentActions } = await import('./deploymentActions');
    const actions = createDeploymentActions(lifetime, scope.projectSourceId);
    try {
      const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} disposition={actions} />
      </ModalProvider>);
      await selectEnvironmentTab(screen, 'settings');
      await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
      expect(screen.findByTestId('project-deployments.disposition.choice:detach')).toBeNull();
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
      await screen.pressByTestIdAsync('project-deployments.disposition.cancel');
    } finally { await act(async () => { controller.retire(); }); }
  });

  it.each([
    { removed: false, neverDeployed: false, inventoryFailure: null },
    { removed: true, neverDeployed: false, inventoryFailure: null },
    { removed: true, neverDeployed: true, inventoryFailure: null },
    { removed: true, neverDeployed: false, inventoryFailure: 'transport' },
    { removed: true, neverDeployed: false, inventoryFailure: 'read' },
    { removed: true, neverDeployed: false, inventoryFailure: 'envelope' },
    { removed: true, neverDeployed: false, inventoryFailure: 'detach' },
  ])('consumes the root Environment-removal result from Stop and remove (removed $removed, never deployed $neverDeployed, inventory failure $inventoryFailure)', async ({ removed, neverDeployed, inventoryFailure }) => {
    const detach = inventoryFailure === 'detach';
    const homeIdentity = `srv_${'d'.repeat(32)}`;
    scope.serverId = await homes.addHome({ name: 'Idle removal', serverUrl: 'https://idle-removal.test',
      serverIdentityId: homeIdentity, accountId: scope.accountId, currentAccount: true });
    const base = environmentDetailForHome();
    const detail = removed && !neverDeployed && !inventoryFailure ? base : { ...base, targetLinks: base.targetLinks.map(item => ({ ...item,
      targetLink: { ...item.targetLink, activeDeploymentId: undefined } })) };
    let deleted = false;
    let finishRefresh: (() => void) | undefined;
    const { controller } = controllerFor({ detail, ...(neverDeployed ? { history: [] } : {}),
      ...(detach ? { listEnvironments: async (_scope, _query, { signal }) => {
        if (!deleted) return { ok: true as const, value: { items: [{ environment: detail.environment, title: detail.content.name }], nextCursor: null } };
        // Keep the pre-delete rail visible while Home's collection refresh is in flight.
        return new Promise<Awaited<ReturnType<DeploymentReadTransportV1['listEnvironments']>>>(resolve => {
          finishRefresh = () => resolve({ ok: true, value: { items: [], nextCursor: null } });
          signal.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'cancelled', retryable: false } }), { once: true });
        });
      } } : {}) });
    const { ModalProvider } = await import('@/modal');
    const { DeploymentTeardownActionInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const { ActionExecuteFailureSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: { ...detail.environment, serverId: homeIdentity },
      targetLinks: detail.targetLinks.map(item => item.targetLink),
    } });
    const deletionPath = `/v1/deployments/environments/${detail.environment.id}/delete`;
    if (neverDeployed || detach) homes.answer(scope.serverId, `POST ${deletionPath}`, { select: body => {
      expect(body).toMatchObject({ environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision,
        ...(detach ? { detachKeepRunning: true } : { teardownDeploymentIds: [] }) });
      if (!detach) expect(body).not.toHaveProperty('detachKeepRunning', true);
      deleted = true;
      return { body: { ok: true, environmentId: detail.environment.id,
        revision: detail.environment.revision + 1, detached: detach } };
    } });
    const machineId = detail.environment.controllerMachineId!;
    let inventoryReads = 0;
    await answerTeardownController(machineId, raw => {
      const input = DeploymentTeardownActionInputV1Schema.parse(raw);
      if ('mode' in input && input.mode === 'preview') {
        inventoryReads += 1;
        if (neverDeployed) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        if (inventoryFailure && inventoryReads === 1) return inventoryFailure === 'transport'
          ? { ok: false, errorCode: 'machine_rpc_unavailable', error: 'machine_rpc_unavailable',
              failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null } }
          : inventoryFailure === 'read' ? { ok: false, error: 'deployment_content_unavailable' }
            : { ok: false, errorCode: 'invalid_encrypted_envelope', error: 'invalid_encrypted_envelope', effectAttempted: false };
        if (inventoryFailure) return { ok: true, kind: 'preview', volumes: [] };
        return { ok: true, kind: 'preview', volumes: [{ name: 'app_data', machineId }, { name: 'app_logs', machineId }] };
      }
      if (neverDeployed) return { ok: false, error: 'target_unavailable' };
      if (removed && !neverDeployed && !inventoryFailure) expect(input).toMatchObject({ volumes: [
        { name: 'app_data', disposition: 'delete', confirmation: 'app_data' },
        { name: 'app_logs', disposition: 'keep' },
      ] });
      return removed ? { ok: true, environmentId: detail.environment.id,
        revision: detail.environment.revision + 2, deploymentId: 'teardown-removed', deploymentRevision: 2, state: 'succeeded', environmentRemoved: true }
        : { ok: false, errorCode: 'deployment_domain_native_unavailable', error: 'deployment_domain_native_unavailable' };
    }, result => {
      const failure = ActionExecuteFailureSchema.safeParse(result);
      return failure.success ? failure.data : null;
    });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { createDeploymentActions } = await import('./deploymentActions');
    const done = vi.fn();
    try {
      if (detach) routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id });
      const screen = await renderScreen(<ModalProvider>{detach ? <ProjectDeploymentsView controller={controller}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} lifetime={lifetime}
        sourceId={scope.projectSourceId} actions={createDeploymentActions(lifetime, scope.projectSourceId)} /> : <DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId={scope.accountId} serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} lifetime={lifetime}
        destination={removed && !neverDeployed && !inventoryFailure ? { tab: 'settings', section: null } : undefined}
        disposition={createDeploymentActions(lifetime, scope.projectSourceId)} onDeleted={done} />}
      </ModalProvider>);
      if (detach) await act(async () => {
        screen.findByTestId('project-deployments.layout')?.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } });
      });
      if (removed && !neverDeployed && !inventoryFailure) {
        await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
        await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.disposition.volume.app_data:delete')).not.toBeNull());
        await screen.pressByTestIdAsync('project-deployments.disposition.volume.app_data:delete');
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
        await act(async () => {
          screen.findByTestId('project-deployments.disposition.volume.app_data.confirmation')?.props.onChangeText('app');
        });
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
        await act(async () => {
          screen.findByTestId('project-deployments.disposition.volume.app_data.confirmation')?.props.onChangeText('app_data');
        });
      } else {
        await waitForContent(screen, 'project-deployments.environment.menu');
        await screen.pressByTestIdAsync('project-deployments.environment.menu');
        await waitForContent(screen, 'project-deployments.environment.menu.delete');
        await screen.pressByTestIdAsync('project-deployments.environment.menu.delete');
      }
      if (inventoryFailure) {
        const errorId = 'project-deployments.disposition.volumes.error';
        await waitForContent(screen, errorId);
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync(`${errorId}-details-toggle`);
        expect(screen.getTextContent()).toContain(inventoryFailure === 'transport' ? 'machine_rpc_unavailable'
          : inventoryFailure === 'read' ? 'deployment_content_unavailable' : 'invalid_encrypted_envelope');
        if (inventoryFailure === 'transport') expect(screen.getTextContent()).toContain('ECONNREFUSED');
        expect(inventoryReads).toBe(1);
        if (detach) {
          await screen.pressByTestIdAsync('project-deployments.disposition.choice:detach');
        } else {
          await screen.pressByTestIdAsync('project-deployments.disposition.volumes.retry');
          await waitForContent(screen, 'project-deployments.disposition.volumes.empty');
          expect(inventoryReads).toBe(2);
        }
      }
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
      });
      if (neverDeployed) await waitForContent(screen, 'project-deployments.disposition.volumes.empty');
      const previousTeardowns = homes.requestsFor('/v1/actions/deployments.teardown').length;
      const previousDeletions = homes.requestsFor(deletionPath).length;
      await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
      await waitForHomeGovernance(() => {
        if (detach) expect(screen.findByTestId('project-deployments.environment') === null,
          'Deleted Environment detail closes while the collection refresh is pending').toBe(true);
        else if (removed) expect(done, screen.getTextContent()).toHaveBeenCalledOnce();
        else expect(screen.findByTestId('project-deployments.disposition.refused')).not.toBeNull();
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(previousTeardowns + (neverDeployed || detach ? 0 : 1));
      });
      expect(homes.requestsFor(deletionPath)).toHaveLength(previousDeletions + (neverDeployed || detach ? 1 : 0));
      expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/targets/target-link/unlink`)).toHaveLength(0);
      if (removed) expect(screen.findByTestId('project-deployments.disposition')).toBeNull();
      else {
        expect(done).not.toHaveBeenCalled();
        expect(screen.findByTestId('project-deployments.disposition')).not.toBeNull();
      }
      if (detach) {
        await waitForHomeGovernance(() => expect(finishRefresh).toBeTypeOf('function'));
        await act(async () => { finishRefresh?.(); });
        await waitForContent(screen, 'project-deployments.empty');
        expect(screen.findByTestId('project-deployments.environment')).toBeNull();
      }
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('keeps an unsaved Variables edit across Settings and counts a renamed Saved-secret reference as an added secret', async () => {
    const base = environmentDetailForHome();
    const binding = createDeploymentSecretVariableBindingV1({ name: 'ORIGINAL', phase: 'runtime', resourceId: 'saved', resourceRevision: 1 });
    const detail = { ...base, content: { ...base.content, bindings: [binding] } };
    const { controller } = controllerFor({ detail });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
        demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={null}
        review={noReview} onOpenReceipt={() => {}} lifetime={lifetime} />);
      await selectEnvironmentTab(screen, 'variables');
      await waitForContent(screen, 'project-deployments.environment.variables.mode:bulk');
      await screen.pressByTestIdAsync('project-deployments.environment.variables.mode:bulk');
      const field = screen.findByTestId('project-deployments.environment.variables.bulk.text');
      await act(async () => { field?.props.onChangeText(field.props.value.replace('ORIGINAL', 'RENAMED')); });
      const { t } = await import('@/text');
      const summary = screen.findByTestId('project-deployments.environment.variables.bulk.diff');
      expect(summary?.findAll(node => node.children.includes(t('projects.deployments.bulkAddedSecrets', { count: 1 }))).length).toBeGreaterThan(0);
      expect(summary?.findAll(node => node.children.includes(t('projects.deployments.bulkAddedPlain', { count: 1 }))).length).toBe(0);
      await selectEnvironmentTab(screen, 'settings');
      await waitForContent(screen, 'project-deployments.environment.settings.lead');
      await selectEnvironmentTab(screen, 'variables');
      await waitForContent(screen, 'project-deployments.environment.variables.mode:bulk');
      await screen.pressByTestIdAsync('project-deployments.environment.variables.mode:bulk');
      expect(screen.findByTestId('project-deployments.environment.variables.bulk.text')?.props.value).toContain('RENAMED');
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('shows the running Secret revision in Variables and sends its Deploy through the page approval continuation', async () => {
    const base = environmentDetailForHome();
    const binding = createDeploymentSecretVariableBindingV1({ name: 'TOKEN', phase: 'runtime', resourceId: 'credential', resourceRevision: 2 });
    const detail = { ...base, content: { ...base.content, bindings: [binding] },
      savedSecretRevisions: [{ resourceId: 'credential', revision: 2 }] };
    const original = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({ content: { ...original.content, ownServer: { approvedInputBasis: {
      v: 1, environmentId: detail.environment.id, environmentRevision: 1,
      targetLinkId: original.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: original.content.sourceIntent,
      manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
      services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }], images: [],
      bindings: [{ ...binding, source: { ...binding.source, resourceRevision: 1 } }],
    } } } });
    const { controller } = controllerFor({ detail, receipt });
    const { HappyError } = await import('@/utils/errors/errors');
    const deploy = vi.fn(async () => {
      throw new HappyError('approval_request_created', false, { code: 'approval_request_created',
        details: { kind: 'approval_request_created', artifactId: 'secret-approval', actionId: 'deployments.deploy' } });
    });
    const requested = vi.fn();
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
      demand={shown} accountId={scope.accountId} serverId={scope.serverId} phone={false} deploy={deploy}
      review={{ pendingId: 'secret-approval', request: requested, open: () => {} }} onOpenReceipt={() => {}} lifetime={lifetime} />);
    try {
      await selectEnvironmentTab(screen, 'variables');
      const notice = 'project-deployments.environment.variables.rotated';
      await waitForContent(screen, notice);
      expect(deploy).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync(`${notice}.action`);
      expect(deploy).toHaveBeenCalledExactlyOnceWith({ environmentId: detail.environment.id, targetLinkId: 'target-link' });
      expect(requested).toHaveBeenCalledExactlyOnceWith('secret-approval');
      expect(screen.findByTestId('project-deployments.outcome.approval')).not.toBeNull();
      expect(screen.findByTestId(`${notice}.action`)).toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each(['empty', 'pending', 'failed'] as const)('opens an exact Environment even when it is absent from the current collection page (%s)', async rail => {
    const detail = environmentDetailForHome();
    let detailReads = 0;
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async (_scope, _query, options) => rail === 'pending'
        ? new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ ok: false,
            failure: { code: 'cancelled', retryable: false } }), { once: true }))
        : rail === 'failed' ? { ok: false, failure: { code: 'offline', retryable: true } }
        : { ok: true, value: { items: [], nextCursor: null } },
      readEnvironment: async () => { detailReads++; return { ok: true, value: detail }; },
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: false, failure: { code: 'not_found', retryable: false } }),
    } });
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id,
      deploymentTab: 'settings', deploymentSection: 'controller' });
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={controller} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.environment.settings.controller'), node => node !== null); });
      expect(screen.findByTestId('project-deployments.environment.settings.controller')).not.toBeNull();
      expect(detailReads).toBe(1);
      expect(screen.findByTestId('project-deployments.empty')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('gives a phone a way back to the list on the standalone deployments route, where no Project bar hosts Back', async () => {
    device.current = 'phone';
    const { controller, detail } = controllerFor({});
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id });
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={controller} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      await waitForContent(screen, 'project-deployments.environment.back');
      await screen.pressByTestIdAsync('project-deployments.environment.back');
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen.findByTestId('project-deployments.environment.back')).toBeNull();
      });
    } finally { controller.retire(); }
  });

  it('opens the Environment, tab and Settings section a link names, and keeps the URL on each tab change', async () => {
    const { controller, detail } = controllerFor({});
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id,
      deploymentTab: 'settings', deploymentSection: 'controller' });
    routerMock.spies.setParams.mockClear();
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={controller} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      await waitForContent(screen, 'project-deployments.environment.settings.controller');
      await selectEnvironmentTab(screen, 'history');
      await waitForContent(screen, 'project-deployments.environment.history');
      expect(routerMock.spies.setParams).toHaveBeenLastCalledWith(expect.objectContaining({
        deploymentTab: 'history', deploymentSection: undefined }));
      expect(screen.findByTestId('project-deployments.environment.history')).not.toBeNull();
    } finally { controller.retire(); }
  });

  it('says a failed deploy in the rail without naming a Machine this Home does not know', async () => {
    const { controller, detail } = controllerFor({});
    const failed = createDeploymentReceiptHeaderV1({ id: 'failed-release', state: 'failed' });
    const transport: DeploymentReadTransportV1 = {
      listEnvironments: async () => ({ ok: true, value: { items: [
        { environment: detail.environment, title: detail.content.name, currentDeployment: failed }], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [failed], nextCursor: null } }),
      readReceipt: async () => ({ ok: false, errorCode: 'not_found' }) as never,
    };
    controller.retire();
    const railController = createDeploymentReadControllerV1({ scope, transport });
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={railController} demand={shown}
        accountId="account-owner" serverId={scope.serverId} lifetime={null} sourceId="source-app" />);
      const row = screen.findHostByTestId(`project-deployments.rail.row.${detail.environment.id}`);
      expect(row).not.toBeNull();
      const text = screen.getTextContent();
      expect(text).toContain('Failed');
      // Landing still opens the first Environment when this split page has no route selection.
      await act(async () => {
        screen.findByTestId('project-deployments.layout')?.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } });
      });
      await waitForContent(screen, 'project-deployments.environment');
      expect(text).not.toContain('null');
    } finally { railController.retire(); }
  });

  it.each([
    ['succeeded', true],
    ['running_unverified', true],
    ['queued', false],
    ['running', false],
    ['failed', false],
    ['cancelled', false],
    ['outcome_unknown', false],
  ] as const)('offers rollback for a retained %s receipt: %s', async (state, eligible) => {
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'retained-release', state,
        ...(['queued', 'running', 'outcome_unknown'].includes(state) ? { settledAtMs: undefined } : {}),
      }),
      content: base.content,
    });
    const { controller, detail } = controllerFor({ receipt });
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null} controller={controller}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName="Staging"
        demand={shown} accountId="account-owner" onBack={() => {}} rollback={async () => ({ ok: true,
          environmentId: detail.environment.id, revision: 1, deploymentId: 'rollback-result', deploymentRevision: 1, state: 'queued' })}
        review={noReview} onOpenReceipt={() => {}} />);
      expect(screen.findByTestId('project-deployments.receipt.rollback') !== null).toBe(eligible);
    } finally { controller.retire(); }
  });

  it('says how several servers are doing in the facts, and opens History from Recent deployments', async () => {
    const base = environmentDetailForHome();
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)?.targetLink.activeDeploymentId;
    if (!servingId) throw new Error('Expected a serving receipt in the fixture');
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'succeeded' }) });
    const earlier = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'earlier-attempt', state: 'succeeded' }) });
    const { controller, detail } = controllerFor({ receipt: serving, history: [serving, earlier], detail: { ...base, healthAggregate: {
      v: 1, environmentId: base.environment.id, targetLinkId: base.environment.runtimeTargetLinkId!,
      protection: base.environment.protection, status: 'degraded', n: 3, down: 1, degraded: 0, unknown: 0,
      members: [], affectedMachineIds: [], edgeUnreachable: false, authoritativeRecovery: false,
    } } });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId="account-owner" serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />);
      expect(screen.findByTestId('project-deployments.environment.facts.health')).not.toBeNull();
      expect(screen.getTextContent()).toContain('2 of 3 servers healthy');
      // The version that serves leads the page, so Recent lists what came before it and never the same row again.
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.receipt.row.earlier-attempt')).not.toBeNull());
      expect(screen.findByTestId(`project-deployments.receipt.row.${servingId}`)).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.environment.recent.history');
      expect(screen.findByTestId('project-deployments.environment.history')).not.toBeNull();
      // History is the whole record, the serving version included.
      await waitForHomeGovernance(() => expect(screen.findByTestId(`project-deployments.receipt.row.${servingId}`)).not.toBeNull());
    } finally { controller.retire(); }
  });

  it('says a failed attempt\'s cause in words, names the serving version once, and one no-health-check claim', async () => {
    const detail = environmentDetailForHome();
    const servingId = detail.targetLinks.find(row => row.targetLink.id === detail.environment.runtimeTargetLinkId)?.targetLink.activeDeploymentId;
    if (!servingId) throw new Error('Expected a serving receipt in the fixture');
    const base = createDeploymentReceiptDetailV1();
    const { commitSubject: _subject, ...withoutSubject } = base.content;
    const serving = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'running_unverified' }), content: withoutSubject });
    const failed = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'failed-attempt', state: 'failed' }),
      content: { ...withoutSubject, failure: { code: 'machine_target_not_current', phase: 'admission' } } });
    const { controller } = controllerFor({ detail, receipt: serving, history: [serving, failed] });
    try {
      const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller}
        environmentId={detail.environment.id} demand={shown} accountId="account-owner" serverId={scope.serverId}
        phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.receipt.row.failed-attempt')).not.toBeNull());
      const text = screen.getTextContent();
      expect(text).not.toContain('machine_target_not_current');
      expect(text).toContain('The deploy couldn’t start');
      const servingRow = screen.findByTestId('project-deployments.environment.serving.receipt');
      const servingText = JSON.stringify(servingRow?.findAll(node => typeof node.type === 'string' && typeof node.props.children === 'string')
        .map(node => node.props.children));
      expect(servingText.split('aaaaaaa').length - 1).toBe(1);
      expect(JSON.stringify(screen.findByTestId('project-deployments.environment.facts')?.findAll(node =>
        typeof node.props.children === 'string').map(node => node.props.children))).toContain('No health check');
      // The Overview carries the receipt's own notice for a version running without a health check.
      expect(screen.findByTestId('project-deployments.environment.serving.notice.running_unverified')).not.toBeNull();
    } finally { controller.retire(); }
  });

  it('shows the version the runtime link serves and opens its receipt', async () => {
    const base = environmentDetailForHome();
    const current = base.targetLinks[0]!;
    const { controller, detail, receipt } = controllerFor({ detail: {
      ...base, targetLinks: [{ ...current, targetLink: { ...current.targetLink,
        id: 'retained-predecessor', activeDeploymentId: undefined } }, current],
    } });
    const open = vi.fn();
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId="account-owner"
        serverId={scope.serverId}
        phone={false}
        deploy={null}
        review={noReview}
        onOpenReceipt={open}
      />,
    );
    expect(screen.getTextContent()).toContain(detail.content.name);
    // The serving row names the exact commit the receipt deployed, not the latest history row.
    expect(screen.getTextContent()).toContain('a'.repeat(7));
    expect(
      screen.findByTestId('project-deployments.environment.serving.none'),
    ).toBeNull();
    await screen.pressByTestIdAsync(
      'project-deployments.environment.serving.receipt',
    );
    expect(open).toHaveBeenCalledWith(receipt.deployment.id);
    controller.retire();
  });

  it('says nothing is deployed when the runtime link has no active receipt, and who can deploy for a reader', async () => {
    const base = environmentDetailForHome();
    const detail = environmentDetailForHome({
      environment: environmentHeaderForHome({
        capabilities: {
          ...base.environment.capabilities,
          role: 'reader',
          deploy: false,
        },
      }),
      targetLinks: base.targetLinks.map((link) => ({
        ...link,
        targetLink: { ...link.targetLink, activeDeploymentId: undefined },
      })),
    });
    const { controller } = controllerFor({ detail });
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId="account-owner"
        serverId={scope.serverId}
        phone={false}
        deploy={null}
        review={noReview}
        onOpenReceipt={() => {}}
      />,
    );
    expect(
      screen.findByTestId('project-deployments.environment.serving.none'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('project-deployments.environment.serving.receipt'),
    ).toBeNull();
    expect(screen.getTextContent()).toContain(
      'Only managers of this environment can deploy here.',
    );
    controller.retire();
  });

  it('keeps an unknown outcome nonterminal: one notice and no retry on the receipt', async () => {
    const settled = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({
        state: 'outcome_unknown',
        settledAtMs: undefined,
      }),
      content: {
        ...settled.content,
        machineResults: settled.content.machineResults.map((result) => ({
          ...result,
          activation: 'outcome_unknown',
          health: 'unknown',
        })),
      },
    });
    const { controller, detail } = controllerFor({ receipt });
    const screen = await renderScreen(
      <DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null}
        controller={controller}
        environmentId={detail.environment.id}
        deploymentId={receipt.deployment.id}
        environmentName="Staging"
        demand={shown}
        accountId="account-owner"
        onBack={() => {}}
        rollback={null}
        review={noReview}
        onOpenReceipt={() => {}}
      />,
    );
    expect(
      screen.findByTestId(
        'project-deployments.receipt.notice.outcome_unknown',
      ),
    ).not.toBeNull();
    expect(
      screen.findByTestId('project-deployments.receipt.notice.succeeded'),
    ).toBeNull();
    expect(screen.getTextContent()).not.toContain('Deploy again');
    // Its next action: look at what runs on the one Machine it deployed to.
    routerMock.spies.push.mockClear();
    await screen.pressByTestIdAsync('project-deployments.receipt.notice.outcome_unknown.action');
    expect(routerMock.spies.push).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(routerMock.spies.push.mock.calls[0]![0])).toContain(`/machines/${receipt.content.machines[0]}`);
    controller.retire();
  });
  it('explains a failed deploy from its recorded facts: cause, what it left, the masked log tail and a rollback to the incumbent', async () => {
    const base = createDeploymentReceiptDetailV1();
    const environment = environmentDetailForHome();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
      content: {
        ...base.content,
        failure: { code: 'native_activate_failed', phase: 'activate' },
        commitSubject: 'Repair worker startup',
        machineResults: base.content.machineResults.map((result) => ({
          ...result, activation: 'failed' as const, health: 'unhealthy' as const, restoration: 'failed' as const,
        })),
        ownServer: {
          approvedInputBasis: {
            v: 1, environmentId: environment.environment.id, environmentRevision: 1,
            targetLinkId: base.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: base.content.sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
            services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            bindings: [], images: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true },
          },
          rollbackTarget: { deploymentId: 'last-good', revision: { kind: 'repository', sha: 'b'.repeat(40) } },
          stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a', relativePath: '.happier/deploy.log',
            excerpt: { text: 'Error: connect ECONNREFUSED [REDACTED]', truncated: true } }],
        },
      } as never,
    });
    if (base.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
    const incumbent = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'last-good',
      requestedAtMs: 900, startedAtMs: 901, settledAtMs: 902 }),
      content: { ...base.content, sourceIntent: { ...base.content.sourceIntent, sha: 'b'.repeat(40) } } });
    const { controller, detail } = controllerFor({ receipt, detail: environment, history: [receipt, incumbent] });
    const rollback = vi.fn(async () => ({ ok: false as const, error: 'deployment_conflict' }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null} controller={controller}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName="Staging"
        demand={shown} accountId="account-owner" onBack={() => {}} rollback={rollback as never}
        review={noReview} onOpenReceipt={() => {}} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.outcome.failed.action'), node => node !== null); });
      const text = screen.getTextContent();
      expect(screen.findByTestId('project-deployments.receipt.outcome.failed')).not.toBeNull();
      expect(text).toContain('Repair worker startup');
      expect(text).toContain('ECONNREFUSED');
      // The incumbent is named by its own identity; there is no #N ordinal to invent.
      expect(text).toContain('b'.repeat(7));
      await screen.pressByTestIdAsync('project-deployments.receipt.outcome.failed.action');
      expect(rollback).toHaveBeenCalledWith({ environmentId: detail.environment.id, deploymentId: 'last-good' });
    } finally { controller.retire(); }
  });

  it('does not invent a cause, log tail or rollback target for a failed receipt that recorded none', async () => {
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
      content: base.content,
    });
    const { controller, detail } = controllerFor({ receipt });
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null} controller={controller}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} environmentName="Staging"
        demand={shown} accountId="account-owner" onBack={() => {}} rollback={async () => ({ ok: false, error: 'deployment_conflict' })}
        review={noReview} onOpenReceipt={() => {}} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.outcome.failed'), node => node !== null); });
      expect(screen.findByTestId('project-deployments.receipt.rollback')).toBeNull();
      expect(screen.getTextContent()).toContain('Investigate');
      expect(screen.findByTestId('project-deployments.receipt.log')).toBeNull();
    } finally { controller.retire(); }
  });

  it('offers rollback of the retained serving predecessor rather than treating it as the current runtime', async () => {
    const base = environmentDetailForHome();
    const current = base.targetLinks[0]!;
    const old = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'old-deployment' }) });
    const { controller, detail } = controllerFor({ receipt: old, detail: {
      ...base, targetLinks: [{ ...current, targetLink: { ...current.targetLink,
        id: 'retained-predecessor', activeDeploymentId: old.deployment.id } }, current],
    } });
    const screen = await renderScreen(
      <DeploymentReceiptDetail cancel={null} deploy={null} phone={false} linkPath={null} serverId={scope.serverId} readLogs={null} controller={controller} environmentId={detail.environment.id}
        deploymentId={old.deployment.id} environmentName="Staging" demand={shown} accountId="account-owner"
        onBack={() => {}} rollback={async () => ({ ok: false, error: 'deployment_unavailable' })}
        review={noReview} onOpenReceipt={() => {}} />,
    );
    expect(screen.findByTestId('project-deployments.receipt.rollback')).not.toBeNull();
    controller.retire();
  });
  it('deploys the runtime link by ids and hands a held review to the page\'s approval continuation', async () => {
    const { controller, detail } = controllerFor({});
    const { HappyError } = await import('@/utils/errors/errors');
    const deploy = vi.fn(async () => {
      throw new HappyError('approval_request_created', false, {
        code: 'approval_request_created',
        details: { kind: 'approval_request_created', artifactId: 'approval-a', actionId: 'deployments.deploy' },
      });
    });
    const requested: string[] = [];
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId="account-owner"
        serverId={scope.serverId}
        phone={false}
        deploy={deploy}
        review={{ pendingId: 'approval-a', request: (id) => requested.push(id), open: () => {} }}
        onOpenReceipt={() => {}}
      />,
    );
    await screen.pressByTestIdAsync('project-deployments.environment.deploy');
    expect(deploy).toHaveBeenCalledWith({ environmentId: detail.environment.id, targetLinkId: 'target-link' });
    expect(requested).toEqual(['approval-a']);
    // While that review is open, the page says so and offers it again instead of a second Deploy.
    expect(screen.findByTestId('project-deployments.outcome.approval')).not.toBeNull();
    controller.retire();
  });

  it('offers a running target Detach first, and Stop and remove as one teardown of the link it shows', async () => {
    const { controller, detail } = controllerFor({});
    const { ModalProvider } = await import('@/modal');
    const lifetime = { scope: { serverId: scope.serverId, accountId: scope.accountId }, isCurrent: () => true,
      onRetire: () => ({ dispose: () => {} }) };
    const unlink = vi.fn(async (input: Readonly<{ targetLinkId: string }>) =>
      ({ ok: true as const, environmentId: detail.environment.id, revision: 2, targetLinkId: input.targetLinkId, detached: true }));
    const teardown = vi.fn(async (input: Readonly<{ mode?: string }>) => input.mode === 'preview'
      ? { ok: true as const, kind: 'preview' as const, volumes: [] }
      : { ok: true as const, environmentId: detail.environment.id, revision: 3,
        deploymentId: 'teardown-1', deploymentRevision: 1, state: 'running' as const });
    const disposition = { deleteEnvironment: vi.fn(), unlink, teardown };
    const render = () => renderScreen(
      <ModalProvider>
        <DeploymentEnvironmentDetail
          controller={controller}
          environmentId={detail.environment.id}
          demand={shown}
          accountId="account-owner"
          serverId={scope.serverId}
          phone={false}
          deploy={null}
          review={noReview}
          lifetime={lifetime as never}
          disposition={disposition as never}
          onOpenReceipt={() => {}}
        />
      </ModalProvider>,
    );
    const screen = await render();
    await selectEnvironmentTab(screen, 'settings');
    await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
    // Opening runs nothing; the choice that stops nothing leads, and Stop and remove can be chosen.
    expect(screen.findByTestId('project-deployments.disposition')).not.toBeNull();
    expect(unlink).not.toHaveBeenCalled();
    expect(screen.findByTestId('project-deployments.disposition.choice:remove')?.props.accessibilityState)
      .toMatchObject({ disabled: false, selected: false });
    expect(screen.findByTestId('project-deployments.disposition.choice:detach')?.props.accessibilityState)
      .toMatchObject({ disabled: false, selected: true });
    await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
    // The review is the confirmation of this exact Action: the front door must not ask a second time.
    expect(unlink).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: detail.environment.id, targetLinkId: 'target-link', detachKeepRunning: true,
    }), expect.objectContaining({ confirmed: true }));
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.disposition'), screen.getTextContent()).toBeNull();
    });
    // Stop and remove: one teardown request for the link the sheet showed; the UI builds no candidate.
    await screen.pressByTestIdAsync('project-deployments.environment.settings.servers-build.unlink');
    await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
    await waitForHomeGovernance(() => {
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
    });
    await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
    expect(teardown).toHaveBeenCalledWith(expect.objectContaining({ environmentId: detail.environment.id,
      targetLinkId: 'target-link', reason: 'manual' }), expect.anything());
    // Still running: nothing is removed yet and the sheet hands over to the receipt.
    expect(unlink).toHaveBeenCalledTimes(1);
    controller.retire();
  });

  it('says health checks start after a deploy instead of reading health where nothing is deployed', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: base.targetLinks.map(item => ({ ...item,
      targetLink: { ...item.targetLink, activeDeploymentId: undefined } })) };
    const { controller } = controllerFor({ detail });
    const screen = await renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
      demand={shown} accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview}
      onOpenReceipt={() => {}} />);
    try {
      await selectEnvironmentTab(screen, 'settings');
      expect(screen.findByTestId('project-deployments.environment.settings.checks-alerts.notDeployed')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.settings.checks-alerts.error')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('links a Machine from where Deploy says it needs one, in a sheet that makes the link', async () => {
    const base = environmentDetailForHome();
    const detail = { ...base, targetLinks: [] };
    const { controller } = controllerFor({ detail });
    const { ModalProvider } = await import('@/modal');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit');
    storage.setState({ profileScope: { serverId: scope.serverId, accountId: scope.accountId } });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-b', installationId: 'installation-b' })], true,
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const lifetime = { scope: { serverId: scope.serverId, accountId: scope.accountId }, isCurrent: () => true,
      onRetire: () => ({ dispose: () => {} }) };
    const link = vi.fn(async () => ({ ok: true as const, environmentId: detail.environment.id, revision: 2,
      targetLinkId: 'new-link', targetLinkRevision: 1 }));
    const disposition = { deleteEnvironment: vi.fn(), unlink: vi.fn(), teardown: vi.fn(), link };
    const screen = await renderScreen(
      <ModalProvider>
        <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
          accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview}
          lifetime={lifetime as never} disposition={disposition as never} onOpenReceipt={() => {}} />
      </ModalProvider>,
    );
    try {
      await screen.pressByTestIdAsync('project-deployments.environment.unavailable.noTarget.action');
      expect(screen.findByTestId('project-deployments.link')).not.toBeNull();
      expect(link).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync('project-deployments.link.confirm');
      expect(link).toHaveBeenCalledWith(expect.objectContaining({
        environmentId: detail.environment.id, targetId: 'own-server', role: 'runtime',
        machines: [{ machineId: 'machine-b', installationId: 'installation-b' }],
      }), expect.objectContaining({ confirmed: true }));
      expect(screen.findByTestId('project-deployments.link')).toBeNull();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('deploys a linked platform target through the same Action input, and shows the target\'s typed refusal', async () => {
    const base = environmentDetailForHome();
    const plugin = environmentDetailForHome({
      targetLinks: base.targetLinks.map((link) => ({ ...link, targetLink: { ...link.targetLink,
        source: { kind: 'plugin' as const, contribution: { pluginId: 'vercel', localId: 'project' } },
        targetKind: 'vercel', machines: [], members: [], machineId: 'machine-a', installationId: 'installation-a' } })),
    });
    const first = controllerFor({ detail: plugin });
    const deploy = vi.fn(async () => { throw Object.assign(new Error('unsupported'), { code: 'unsupported' }); });
    const pluginScreen = await renderScreen(
      <DeploymentEnvironmentDetail controller={first.controller} environmentId={plugin.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={deploy} review={noReview} onOpenReceipt={() => {}} />,
    );
    expect(pluginScreen.findByTestId('project-deployments.environment.unavailable.noTarget')).toBeNull();
    await pluginScreen.pressByTestIdAsync('project-deployments.environment.deploy');
    expect(deploy).toHaveBeenCalledWith({ environmentId: plugin.environment.id, targetLinkId: plugin.environment.runtimeTargetLinkId });
    expect(pluginScreen.findByTestId('project-deployments.outcome.refused.unsupported')).not.toBeNull();
    first.controller.retire();

    const second = controllerFor({});
    const ownServer = await renderScreen(
      <DeploymentEnvironmentDetail controller={second.controller} environmentId={second.detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={deploy} review={noReview} onOpenReceipt={() => {}} />,
    );
    await ownServer.pressByTestIdAsync('project-deployments.environment.deploy');
    expect(ownServer.findByTestId('project-deployments.outcome.refused.unsupported')).not.toBeNull();
    second.controller.retire();
  });

  it('says a failed read failed and offers Retry: the serving receipt and the first History page', async () => {
    const { controller: base, detail } = controllerFor({});
    base.retire();
    let receiptReads = 0;
    let historyReads = 0;
    const transport: DeploymentReadTransportV1 = {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => { historyReads += 1; return { ok: false, failure: { code: 'deployment_unavailable', retryable: true } }; },
      readReceipt: async () => { receiptReads += 1; return { ok: false, failure: { code: 'deployment_unavailable', retryable: true } }; },
    };
    const controller = createDeploymentReadControllerV1({ scope, transport });
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />,
    );
    expect(screen.findByTestId('project-deployments.environment.serving.error')).not.toBeNull();
    const before = receiptReads;
    await screen.pressByTestIdAsync('project-deployments.environment.serving.error.retry');
    expect(receiptReads).toBeGreaterThan(before);
    await selectEnvironmentTab(screen, 'history');
    expect(screen.findByTestId('project-deployments.environment.history.error')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('No deployments yet');
    expect(historyReads).toBeGreaterThan(0);
    controller.retire();
  });

  it('pages History on request only: one read per page, Older reads the next cursor, Newer returns', async () => {
    const { controller: base, detail, receipt } = controllerFor({});
    base.retire();
    const cursors: (string | undefined)[] = [];
    const transport: DeploymentReadTransportV1 = {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async (_scope, _id, query) => {
        cursors.push(query.cursor);
        return { ok: true, value: { ok: true, items: [receipt.deployment], nextCursor: query.cursor ? null : 'page-2' } };
      },
      readReceipt: async () => ({ ok: true, value: receipt }),
    };
    const controller = createDeploymentReadControllerV1({ scope, transport });
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}} />,
    );
    await selectEnvironmentTab(screen, 'history');
    expect(cursors).toEqual([undefined]);
    expect(screen.findByTestId('project-deployments.environment.history.newer')).toBeNull();
    await screen.pressByTestIdAsync('project-deployments.environment.history.older');
    expect(cursors).toEqual([undefined, 'page-2']);
    expect(screen.findByTestId('project-deployments.environment.history.older')).toBeNull();
    expect(screen.findByTestId('project-deployments.environment.history.newer')).not.toBeNull();
    controller.retire();
  });

  // Skipped (UI8A round 2): the row menu's popover rows are not reachable under renderScreen yet; round 3 drives
  // this through the menu harness. K1's own editor test covers the Both pair; this proves the page's one write.
  it.skip('changes a variable to Both and saves the pair in one bindings write', async () => {
    const base = environmentDetailForHome();
    const runtime = { purpose: 'variable' as const, name: 'LOG_LEVEL', phase: 'runtime' as const,
      source: { kind: 'value' as const, value: 'info' } };
    const detail = environmentDetailForHome({
      environment: environmentHeaderForHome({
        capabilities: { ...base.environment.capabilities, manageBindings: true },
      }),
      content: { ...base.content, bindings: [runtime] },
    });
    const { controller } = controllerFor({ detail });
    const lifetime = { scope: { serverId: scope.serverId, accountId: scope.accountId }, isCurrent: () => true,
      onRetire: () => ({ dispose: () => {} }) };
    const setBindings = vi.fn(async (input: { environmentId: string; expectedRevision: number; content: { bindings: readonly unknown[] } }) =>
      ({ ok: true as const, environmentId: input.environmentId, revision: input.expectedRevision + 1 }));
    const screen = await renderScreen(
      <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
        accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={() => {}}
        lifetime={lifetime as never} setBindings={setBindings as never} />,
    );
    await selectEnvironmentTab(screen, 'variables');
    expect(screen.findByTestId('project-deployments.environment.variables.save')).toBeNull();
    // The test renders before measurement, so the Collection rests as the list: its ⋯ holds "Used at".
    await screen.pressByTestIdAsync('project-deployments.environment.variable.LOG_LEVEL.menu');
    await screen.pressByTestIdAsync('project-deployments.environment.variable.LOG_LEVEL.menu.phase.both');
    await screen.pressByTestIdAsync('project-deployments.environment.variables.save');
    expect(setBindings).toHaveBeenCalledTimes(1);
    const written = setBindings.mock.calls[0]![0];
    expect(written.expectedRevision).toBe(detail.environment.revision);
    expect(written.content.bindings).toEqual(expect.arrayContaining([
      { ...runtime, phase: 'build' }, runtime,
    ]));
    expect(written.content.bindings).toHaveLength(2);
    controller.retire();
  });
});

describe('Deployment receipt header actions', () => {
  const running = (cancellable: boolean | undefined) => {
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'running-release', state: 'running', revision: 4, settledAtMs: undefined }),
      content: base.content,
    });
    return cancellable === undefined ? receipt : { ...receipt, cancellable };
  };
  const receiptProps = {
    environmentName: 'Staging', demand: shown, accountId: 'account-owner', onBack: () => {},
    rollback: null, review: noReview, onOpenReceipt: () => {}, phone: false, linkPath: null,
    serverId: scope.serverId, readLogs: null,
  } as const;

  it.each([[true, true], [false, false], [undefined, false]] as const)(
    'offers Cancel on a running receipt only when the receipt read says it is cancellable (%s)', async (cancellable, offered) => {
      const { controller, detail, receipt } = controllerFor({ receipt: running(cancellable) as never });
      try {
        const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
          environmentId={detail.environment.id} deploymentId={receipt.deployment.id}
          cancel={async () => ({ ok: false as const, error: 'deployment_conflict' }) as never} deploy={null} />);
        await act(async () => { await waitForTestEvent(screen.subscribe,
          () => screen.findByTestId('project-deployments.receipt.header'), node => node !== null); });
        expect(screen.findByTestId('project-deployments.receipt.cancel') !== null).toBe(offered);
      } finally { controller.retire(); }
    });

  it('cancels with the receipt revision it showed, and says a refusal where Cancel was pressed', async () => {
    const { controller, detail, receipt } = controllerFor({ receipt: running(true) as never });
    const cancel = vi.fn(async () => ({ ok: false as const, error: 'deployment_conflict' }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} cancel={cancel as never} deploy={null} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.cancel'), node => node !== null); });
      await screen.pressByTestIdAsync('project-deployments.receipt.cancel');
      expect(cancel).toHaveBeenCalledWith({ environmentId: detail.environment.id, deploymentId: 'running-release',
        expectedReceiptRevision: 4 });
      expect(screen.findByTestId('project-deployments.outcome.refused.other')).not.toBeNull();
    } finally { controller.retire(); }
  });

  it('keeps a refused rollback\'s typed code out of its sentence and behind Details', async () => {
    const base = environmentDetailForHome();
    const current = base.targetLinks[0]!;
    const old = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'old-deployment' }) });
    const { controller, detail } = controllerFor({ receipt: old, detail: {
      ...base, targetLinks: [{ ...current, targetLink: { ...current.targetLink,
        id: 'retained-predecessor', activeDeploymentId: old.deployment.id } }, current],
    } });
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={old.deployment.id} cancel={null} deploy={null}
        rollback={async () => ({ ok: false as const, error: 'machine_target_not_current' }) as never} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.rollback'), node => node !== null); });
      await screen.pressByTestIdAsync('project-deployments.receipt.rollback');
      const banner = 'project-deployments.outcome.refused.other';
      expect(screen.findByTestId(banner)).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('machine_target_not_current');
      await screen.pressByTestIdAsync(`${banner}.details`);
      expect(screen.getTextContent()).toContain('machine_target_not_current');
    } finally { controller.retire(); }
  });

  it.each(['failed', 'outcome_unknown'] as const)('retries a failed teardown through the teardown Action instead of deploying its source again (%s)', async state => {
    const homeIdentity = `srv_${'e'.repeat(32)}`;
    scope.serverId = await homes.addHome({ name: 'Teardown retry', serverUrl: 'https://teardown-retry.test',
      serverIdentityId: homeIdentity, accountId: scope.accountId, currentAccount: true });
    const detail = environmentDetailForHome();
    const link = detail.targetLinks[0]!.targetLink;
    const { machineId, installationId } = link.members[0]!;
    const member = { machineId, installationId };
    const base = createDeploymentReceiptDetailV1();
    const storedIntent = { kind: 'stored' as const, document: 'services:\n  app:\n    image: app:tested\n',
      contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app'] };
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'failed-teardown', operation: 'teardown', state,
        requestKey: 'teardown-retry-original' }),
      content: { ...base.content, sourceIntent: state === 'outcome_unknown' ? storedIntent : base.content.sourceIntent,
        teardown: { reason: 'decommission', targetLinkRevision: link.revision,
        machines: [member], resources: [{ id: 'retained-workload', kind: 'workload', machineId: member.machineId,
          ownership: 'owned', disposition: 'remove' }], proofs: [{ ...member, step: 'removeTarget',
          state, reason: state === 'outcome_unknown' ? 'removal_unproved' : 'native_route_unavailable', resources: [] }] } },
    });
    const { controller } = controllerFor({ detail, receipt });
    const { createDeploymentActions } = await import('./deploymentActions');
    homes.answer(scope.serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: { ...detail.environment, serverId: homeIdentity },
      targetLinks: detail.targetLinks.map(row => row.targetLink),
    } });
    const beforeTeardowns = homes.requestsFor('/v1/actions/deployments.teardown').length;
    const beforeDeploys = homes.requestsFor('/v1/actions/deployments.deploy').length;
    await answerTeardownController(detail.environment.controllerMachineId, input => {
      expect(input).toMatchObject({ environmentId: detail.environment.id,
        targetLinkId: receipt.deployment.targetLinkId, requestKey: receipt.deployment.requestKey, reason: receipt.content.teardown!.reason });
      return { ok: true, environmentId: detail.environment.id, revision: 4,
        deploymentId: receipt.deployment.id, deploymentRevision: 1, state: 'running' };
    });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    routerMock.module.router.setParams({ deploymentEnvironment: detail.environment.id, deployment: receipt.deployment.id });
    try {
      const screen = await renderScreen(<ProjectDeploymentsView controller={controller} demand={shown} lifetime={lifetime}
        serverId={scope.serverId} accountId={scope.accountId} sourceId={scope.projectSourceId}
        actions={createDeploymentActions(lifetime, scope.projectSourceId)} />);
      await waitForContent(screen, 'project-deployments.receipt.deployAgain');
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.confirm).mockClear();
      await screen.pressByTestIdAsync('project-deployments.receipt.deployAgain');
      await waitForHomeGovernance(() => {
        const requests = homes.requestsFor('/v1/actions/deployments.teardown').length - beforeTeardowns
          + homes.requestsFor('/v1/actions/deployments.deploy').length - beforeDeploys;
        expect(requests > 0 || screen.findByTestId('project-deployments.outcome.refused.other') !== null).toBe(true);
      });
      if (screen.findByTestId('project-deployments.outcome.refused.other.details')) {
        await screen.pressByTestIdAsync('project-deployments.outcome.refused.other.details');
      }
      await waitForHomeGovernance(() => {
        const teardowns = homes.requestsFor('/v1/actions/deployments.teardown').length - beforeTeardowns;
        const deploys = homes.requestsFor('/v1/actions/deployments.deploy').length - beforeDeploys;
        expect(teardowns + deploys, screen.getTextContent()).toBeGreaterThan(0);
        expect({ teardowns, deploys }).toEqual({ teardowns: 1, deploys: 0 });
      });
      expect(Modal.confirm).not.toHaveBeenCalled();
    } finally { await act(async () => { controller.retire(); }); }
  });

  it('deploys a failed receipt\'s own commit again through the Environment\'s runtime link', async () => {
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: 'failed-release', state: 'failed' }),
      content: base.content,
    });
    const { controller, detail } = controllerFor({ receipt });
    const deploy = vi.fn(async () => ({ ok: false as const, error: 'deployment_conflict' }));
    const sha = base.content.sourceIntent.kind === 'repository' ? base.content.sourceIntent.sha : null;
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} cancel={null} deploy={deploy as never} />);
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.outcome.failed.action'), node => node !== null); });
      await screen.pressByTestIdAsync('project-deployments.receipt.outcome.failed.action');
      expect(sha).not.toBeNull();
      expect(deploy).toHaveBeenCalledWith({ environmentId: detail.environment.id, targetLinkId: 'target-link', sha });
    } finally { controller.retire(); }
  });
});

describe('Deployment receipt step logs', () => {
  const receiptProps = {
    environmentName: 'Staging', demand: shown, accountId: 'account-owner', onBack: () => {},
    rollback: null, cancel: null, deploy: null, review: noReview, onOpenReceipt: () => {}, phone: false, linkPath: null,
    serverId: 'home',
  } as const;
  const page = (text: string) => ({ kind: 'page' as const, page: { sourceRevision: 'source-a', text,
    nextCursor: { sourceRevision: 'source-a', token: String(text.length) }, truncated: false } });
  /** A native receipt whose sink recorded each step's range in the one masked operation file (DEP-43). */
  const withStepLogs = (state: 'failed' | 'running') => {
    const base = createDeploymentReceiptDetailV1();
    const steps = state === 'failed'
      ? [{ id: 'source', label: 'Sync', state: 'succeeded' as const, durationMs: 4_000 },
        { id: 'activate', label: 'Roll out', state: 'failed' as const, durationMs: 14_000 },
        { id: 'route', label: 'Route', state: 'skipped' as const }]
      : [{ id: 'source', label: 'Sync', state: 'succeeded' as const, durationMs: 4_000 },
        { id: 'build', label: 'Build', state: 'running' as const },
        { id: 'activate', label: 'Roll out', state: 'pending' as const }];
    return createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ id: `${state}-release`, state,
        ...(state === 'running' ? { settledAtMs: undefined } : {}) }),
      content: { ...base.content, steps, machineResults: [], ownServer: {
        approvedInputBasis: {
          v: 1, environmentId: 'environment-a', environmentRevision: 1, targetLinkId: 'target-link', targetLinkRevision: 1,
          sourceIntent: base.content.sourceIntent, manifestFingerprint: 'manifest', configInputDigests: [],
          physicalProjectName: 'app', toolVersion: '2.40.1', services: ['web'], profiles: [],
          members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [], images: [],
        },
        stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a', relativePath: '.happier/deploy.log',
          excerpt: { text: 'operation tail', truncated: true },
          steps: [{ ref: 'source', range: { start: 0, end: 40 } },
            { ref: state === 'failed' ? 'activate' : 'build', range: { start: 40, end: null } }] }],
      } } as never,
    });
  };
  const settle = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) => act(async () => {
    await waitForTestEvent(screen.subscribe, () => screen.findByTestId(testID), node => node !== null);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('stops retained step activity when the receipt is %s', async (state) => {
    const base = withStepLogs('running');
    const receipt = createDeploymentReceiptDetailV1({ ...base,
      deployment: createDeploymentReceiptHeaderV1({ ...base.deployment, state, settledAtMs: 2_000 }),
    });
    for (const readable of [true, false]) {
      const { controller, detail } = controllerFor({ receipt });
      const readLogs = readable ? async () => ({ ok: true as const, logs: page('retained log') }) : null;
      try {
        const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
          environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs} />);
        await settle(screen, 'project-deployments.receipt.step-row-build-status-slot');
        expect(screen.findByTestId('project-deployments.receipt.step-row-build-status-slot')!
          .findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findByTestId('project-deployments.receipt.steps.follow')).toBeNull();
        await screen.unmount();
      } finally { controller.retire(); }
    }
  });

  it.each([true, false])('uses operation log availability when retained receipt steps are empty (logs=%s)', async (available) => {
    const base = withStepLogs('failed');
    const receipt = createDeploymentReceiptDetailV1({
      deployment: { ...base.deployment, state: 'running_unverified' },
      content: { ...base.content, steps: [], machineResults: [{ machineId: 'machine-a',
        installationId: 'installation-a', activation: 'succeeded', health: 'unverified', steps: [] }],
        ownServer: { ...base.content.ownServer!, stageLogs: available ? base.content.ownServer!.stageLogs : [] } },
    });
    const { controller, detail } = controllerFor({ receipt });
    // The Action transport boundary returns the same masked operation page as the live read.
    const readLogs = vi.fn(async () => ({ ok: true as const, logs: page('retained masked build lines') }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, available ? 'project-deployments.receipt.steps' : 'project-deployments.receipt.header');
      // The receipt's only log is the page's content: it opens on arrival, with no disclosure row to press.
      expect(screen.findByTestId('project-deployments.receipt.step-row-build-log.machine-a.installation-a')).toBeNull();
      if (available) {
        await settle(screen, 'project-deployments.receipt.steps.log.lines');
        expect(screen.getTextContent()).toContain('retained masked build lines');
        expect(readLogs.mock.calls[0]).toEqual([{ kind: 'build', environmentId: receipt.deployment.environmentId,
          deploymentId: receipt.deployment.id, targetLinkId: receipt.deployment.targetLinkId,
          machineId: 'machine-a', installationId: 'installation-a', tail: true }]);
      } else {
        // No steps and no log: the block is left out rather than drawn empty (lab d3).
        const block = screen.findByTestId('project-deployments.receipt.steps');
        expect(block?.findAll((node) => typeof node.type === 'string') ?? []).toHaveLength(0);
        expect(screen.findByTestId('project-deployments.receipt.steps.toolbar')).toBeNull();
      }
    } finally { controller.retire(); }
  });

  it('opens the first of several logs on arrival when the receipt recorded no steps', async () => {
    const base = withStepLogs('failed');
    const stageLog = base.content.ownServer!.stageLogs![0]!;
    const receipt = createDeploymentReceiptDetailV1({
      deployment: { ...base.deployment, state: 'running_unverified' },
      content: { ...base.content, steps: [], machineResults: [], ownServer: { ...base.content.ownServer!,
        stageLogs: [stageLog, { ...stageLog, machineId: 'machine-b', installationId: 'installation-b' }] } },
    });
    const { controller, detail } = controllerFor({ receipt });
    const readLogs = vi.fn(async (_input: Readonly<Record<string, unknown>>) => ({ ok: true as const, logs: page('first machine lines') }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, 'project-deployments.receipt.steps.log.lines');
      expect(readLogs).toHaveBeenCalledTimes(1);
      expect(readLogs.mock.calls[0]![0]).toMatchObject({ machineId: 'machine-a', installationId: 'installation-a' });
      expect(screen.findByTestId('project-deployments.receipt.step-row-build-log.machine-b.installation-b')).not.toBeNull();
    } finally { controller.retire(); }
  });

  it('opens the failed step\'s own masked log by its ref, and another step reads only its own', async () => {
    const { controller, detail, receipt } = controllerFor({ receipt: withStepLogs('failed') });
    const readLogs = vi.fn(async (input: { ref?: string }) => ({ ok: true as const, logs: page(`lines of ${input.ref}`) }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, 'project-deployments.receipt.steps.log.lines');
      expect(readLogs).toHaveBeenCalledTimes(1);
      expect(readLogs.mock.calls[0]![0]).toMatchObject({ kind: 'build', ref: 'activate', tail: true,
        machineId: 'machine-a', installationId: 'installation-a', deploymentId: 'failed-release' });
      expect(screen.getTextContent()).toContain('lines of activate');
      // The step refs supersede the operation tail; the operation log is never shown in their place.
      expect(screen.findByTestId('project-deployments.receipt.log')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.receipt.step-row-source');
      await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.getTextContent(),
        text => text.includes('lines of source')); });
      expect(readLogs.mock.calls.map(([input]) => input.ref)).toEqual(['activate', 'source']);
      // A step without a ref of its own is a plain row: nothing to open, nothing read.
      const route = screen.findByTestId('project-deployments.receipt.step-row-route')!;
      expect(route.props.onPress ?? route.props.onClick).toBeUndefined();
      expect(readLogs).toHaveBeenCalledTimes(2);
    } finally { controller.retire(); }
  });

  it('narrows to the failed steps from the receipt\'s own step states', async () => {
    const { controller, detail, receipt } = controllerFor({ receipt: withStepLogs('failed') });
    const readLogs = vi.fn(async () => ({ ok: true as const, logs: page('masked') }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, 'project-deployments.receipt.steps.filter:failed');
      expect(screen.findByTestId('project-deployments.receipt.step-row-source')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.receipt.steps.filter:failed');
      expect(screen.findByTestId('project-deployments.receipt.step-row-source')).toBeNull();
      expect(screen.findByTestId('project-deployments.receipt.step-row-route')).toBeNull();
      expect(screen.findByTestId('project-deployments.receipt.step-row-activate')).not.toBeNull();
      // Nothing to follow once the deploy settled.
      expect(screen.findByTestId('project-deployments.receipt.steps.follow')).toBeNull();
    } finally { controller.retire(); }
  });

  it.each([
    ['unavailable', { kind: 'unavailable' as const, reason: 'unavailable' as const }, 'project-deployments.receipt.steps.log.unavailable'],
    ['source-changed', { kind: 'source-changed' as const, sourceRevision: 'source-b' }, 'project-deployments.receipt.steps.log.sourceChanged'],
  ] as const)('says when the step log is %s and reads it again on request', async (_kind, answer, testID) => {
    const { controller, detail, receipt } = controllerFor({ receipt: withStepLogs('failed') });
    let next: unknown = answer;
    const readLogs = vi.fn(async () => ({ ok: true as const, logs: next }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, testID);
      next = page('read again');
      await screen.pressByTestIdAsync(`${testID}-action`);
      await settle(screen, 'project-deployments.receipt.steps.log.lines');
      expect(readLogs).toHaveBeenCalledTimes(2);
      expect(screen.getTextContent()).toContain('read again');
    } finally { controller.retire(); }
  });

  it('follows only a running step, and Follow turns off and on', async () => {
    const { controller, detail, receipt } = controllerFor({ receipt: withStepLogs('running') });
    const readLogs = vi.fn(async (input: { ref?: string }) => ({ ok: true as const, logs: page(`lines of ${input.ref}`) }));
    try {
      const screen = await renderScreen(<DeploymentReceiptDetail controller={controller} {...receiptProps}
        environmentId={detail.environment.id} deploymentId={receipt.deployment.id} readLogs={readLogs as never} />);
      await settle(screen, 'project-deployments.receipt.steps.follow');
      expect(screen.findByTestId('project-deployments.receipt.step-row-build-status-slot')!
        .findAllByType(ActivitySpinner)).toHaveLength(1);
      expect(readLogs.mock.calls[0]![0]).toMatchObject({ ref: 'build', tail: true });
      const follow = () => screen.findByTestId('project-deployments.receipt.steps.follow')!;
      const following = follow().props.accessibilityLabel;
      await screen.pressByTestIdAsync('project-deployments.receipt.steps.follow');
      expect(follow().props.accessibilityLabel).not.toBe(following);
      await screen.pressByTestIdAsync('project-deployments.receipt.steps.follow');
      expect(follow().props.accessibilityLabel).toBe(following);
      // A finished step's log cannot grow: opening it offers no Follow.
      await screen.pressByTestIdAsync('project-deployments.receipt.step-row-source');
      await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.getTextContent(),
        text => text.includes('lines of source')); });
      expect(screen.findByTestId('project-deployments.receipt.steps.follow')).toBeNull();
    } finally { controller.retire(); }
  });
});

describe('Environment Overview attention and status (L-A, DEPLOY-COMPOSE P1)', () => {
  const render = (controller: ReturnType<typeof createDeploymentReadControllerV1>, detail: { environment: { id: string } }, onOpenReceipt = (_id: string) => {}) =>
    renderScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id} demand={shown}
      accountId="account-owner" serverId={scope.serverId} phone={false} deploy={null} review={noReview} onOpenReceipt={onOpenReceipt} />);
  const healthOf = (base: ReturnType<typeof environmentDetailForHome>, status: 'down' | 'degraded') => ({
    v: 1 as const, environmentId: base.environment.id, targetLinkId: base.environment.runtimeTargetLinkId!,
    protection: base.environment.protection, status, n: 1, down: status === 'down' ? 1 : 0, degraded: status === 'degraded' ? 1 : 0,
    unknown: 0, members: [], affectedMachineIds: [], edgeUnreachable: false, authoritativeRecovery: false,
  });

  it('shows one notice when several things are wrong: the failed latest deploy, which opens its receipt', async () => {
    const base = environmentDetailForHome();
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)!.targetLink.activeDeploymentId!;
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'running_unverified' }) });
    const failed = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'latest-failed', state: 'failed' }),
      content: { ...serving.content, failure: { code: 'machine_target_not_current', phase: 'admission' } } });
    const { controller, detail } = controllerFor({ receipt: serving, history: [failed, serving],
      detail: { ...base, healthAggregate: healthOf(base, 'degraded') } });
    const opened: string[] = [];
    try {
      const screen = await render(controller, detail, id => { opened.push(id); });
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.attention.latestFailed')).not.toBeNull());
      expect(screen.findByTestId('project-deployments.environment.attention.unhealthy')).toBeNull();
      expect(screen.findByTestId('project-deployments.environment.serving.notice.running_unverified')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.environment.attention.latestFailed.action');
      expect(opened).toEqual(['latest-failed']);
    } finally { controller.retire(); }
  });

  it('says jobs and alerts are paused while the controller is offline, and nothing when its presence is unknown', async () => {
    const base = environmentDetailForHome();
    for (const [state, shownNotice] of [['paused', true], ['unknown', false]] as const) {
      const { controller, detail } = controllerFor({ detail: { ...base,
        controller: { machineId: base.environment.controllerMachineId, state } } });
      try {
        const screen = await render(controller, detail);
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.serving')).not.toBeNull());
        expect(screen.findByTestId('project-deployments.environment.attention.controllerPaused') !== null).toBe(shownNotice);
      } finally { controller.retire(); }
    }
  });

  it('offers Roll back… only when an earlier version served (D11)', async () => {
    const base = environmentDetailForHome();
    const undeployed = environmentDetailForHome({ targetLinks: base.targetLinks.map(link => ({ ...link,
      targetLink: { ...link.targetLink, activeDeploymentId: undefined } })) });
    const { controller: empty } = controllerFor({ detail: undeployed, history: [] });
    try {
      const screen = await render(empty, undeployed);
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.settings');
      expect(screen.findByTestId('project-deployments.environment.menu.history')).toBeNull();
    } finally { empty.retire(); }
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)!.targetLink.activeDeploymentId!;
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'succeeded' }) });
    const earlier = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'earlier-good', state: 'succeeded' }) });
    const { controller, detail } = controllerFor({ detail: base, receipt: serving, history: [serving, earlier] });
    try {
      const screen = await render(controller, detail);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.receipt.row.earlier-good')).not.toBeNull());
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.history');
    } finally { controller.retire(); }
  });

  it('opens and closes the Logs companion from the header ⋯ only while Logs is offered (ruling 11-08 option a)', async () => {
    const base = environmentDetailForHome();
    const unlinked = { ...base, environment: { ...base.environment, runtimeTargetLinkId: undefined }, targetLinks: [] };
    const { controller: none } = controllerFor({ detail: unlinked, history: [] });
    try {
      const screen = await render(none, unlinked);
      await waitForContent(screen, 'project-deployments.environment.menu');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.settings');
      expect(screen.findByTestId('project-deployments.environment.menu.logs')).toBeNull();
    } finally { none.retire(); }
    const servingId = base.targetLinks.find(row => row.targetLink.id === base.environment.runtimeTargetLinkId)!.targetLink.activeDeploymentId!;
    const serving = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: servingId, state: 'succeeded' }) });
    const { controller, detail } = controllerFor({ detail: base, receipt: serving, history: [serving] });
    try {
      const screen = await render(controller, detail);
      await waitForContent(screen, 'project-deployments.environment.menu');
      expect(screen.findByTestId('environment-logs.header')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.logs');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.logs');
      await waitForContent(screen, 'environment-logs.header');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitForContent(screen, 'project-deployments.environment.menu.logs');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.logs');
      await waitForHomeGovernance(() => expect(screen.findByTestId('environment-logs.header')).toBeNull());
    } finally { controller.retire(); }
  });

  it('lists several servers with a sentence only for the one down and the one joining (Lab 1 A)', async () => {
    const base = environmentDetailForHome();
    const runtimeId = base.environment.runtimeTargetLinkId!;
    const members = [
      { machineId: 'srv-a', installationId: 'inst-a', state: 'active' as const },
      { machineId: 'srv-b', installationId: 'inst-b', state: 'active' as const },
      { machineId: 'srv-c', installationId: 'inst-c', state: 'joining' as const },
    ];
    const detail = { ...base, targetLinks: base.targetLinks.map(link => link.targetLink.id === runtimeId ? { ...link,
      targetLink: { ...link.targetLink, machines: members.map(m => m.machineId), members } } : link),
      healthAggregate: { ...healthOf(base, 'down'), n: 3, down: 1, members: [
        { machineId: 'srv-a', roles: ['runtime' as const], status: 'up' as const, evidence: [{ role: 'runtime' as const, status: 'up' as const, source: 'native' as const }] },
        { machineId: 'srv-b', roles: ['runtime' as const], status: 'down' as const, evidence: [{ role: 'runtime' as const, status: 'down' as const, source: 'native' as const }] },
      ] } };
    const { controller } = controllerFor({ detail });
    try {
      const screen = await render(controller, detail);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.servers')).not.toBeNull());
      const rowText = (id: string) => JSON.stringify(screen.findByTestId(`project-deployments.environment.servers.${id}`)
        ?.findAll(node => typeof node.props.children === 'string').map(node => node.props.children));
      expect(rowText('srv-a')).not.toContain('Down');
      expect(rowText('srv-b')).toContain('Down');
      expect(rowText('srv-c')).toContain('not counted as down');
      expect(screen.getTextContent()).toContain('1 of 3 down');
    } finally { controller.retire(); }
  });

  it('keeps a single-server Environment free of a Servers section', async () => {
    const { controller, detail } = controllerFor({});
    try {
      const screen = await render(controller, detail);
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.environment.serving')).not.toBeNull());
      expect(screen.findByTestId('project-deployments.environment.servers')).toBeNull();
    } finally { controller.retire(); }
  });
});
