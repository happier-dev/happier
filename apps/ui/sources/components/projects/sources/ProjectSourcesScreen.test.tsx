import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Install the external Socket boundary before the screen loads Sync for Account restoration.
await vi.hoisted(async () => {
  const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
  installDisconnectedServerSocketBoundary();
});

import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainProjectAccountRowListFixture, createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, WidgetAreaLayoutV1Schema } from '@happier-dev/protocol/widgets';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Source host ports stand in for Home storage/membership and Machine SCM transport. The canonical
 * Action executor/front door, screen, controller, address parser and editor remain real.
 */
const shared = vi.hoisted(() => ({
  calls: [] as Array<{ actionId: string; input: any }>,
  sources: [] as unknown[],
  listedSources: null as unknown[] | null,
  routes: { params: {} as Record<string, string> },
  navigation: [] as unknown[],
  createOutcomes: [] as Array<'unknown'>,
  artifacts: {} as Record<string, unknown>,
  confirm: vi.fn(async () => false),
  /** Holds `projects.sources.read` so a test can look at the loading Source detail. */
  readGate: null as null | Promise<void>,
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
  const { normalizeActionsSettingsV1, setActionApprovalOverride } = await import('@happier-dev/protocol/actions/actionSettings');
  const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  const schemas = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
  // Host fixtures receive protocol-validated inputs from the real executor.
  const respond = async (actionId: string, input: any): Promise<unknown> => {
    shared.calls.push({ actionId, input });
    if (actionId === 'projects.sources.list')
      return {
          ok: true,
          sources: shared.listedSources ?? shared.sources,
          coverage: { complete: true, nextCursor: null },
      };
    if (actionId === 'projects.sources.read') {
      await shared.readGate;
      const source = shared.sources.find(
        (row: any) => row.id === input.sourceId,
      );
      return source
          ? { ok: true, source, canManage: true }
          : { ok: false, error: 'source_unavailable' };
    }
    if (actionId === 'scm.hostingRepository.resolveAddress')
      return {
          success: true,
          kind: 'resolved',
          selector: {
            provider: {
              id: 'happier.scm.forge.github/github',
              kind: 'github',
              displayName: 'GitHub',
              baseUrl: 'https://github.com',
            },
            repository: { nameWithOwner: 'acme/billing' },
            protocol: 'https',
          },
      };
    if (actionId === 'projects.sources.create') {
      // The real create answers the canonical Source row, never the request's idempotency key.
      const { serverId: _serverId, requestKey: _requestKey, ...fields } = input;
      const source = {
        id: 'created',
        revision: 1,
        audience: [],
        createdByAccountId: 'account-1',
        ...fields,
      };
      shared.sources = [...shared.sources, source];
      return { ok: true, source, canManage: true };
    }
    if (actionId === 'projects.sources.delete') {
      shared.sources = shared.sources.filter((row: any) => row.id !== input.sourceId);
      return { ok: true, sourceId: input.sourceId, revision: input.expectedRevision + 1 };
    }
    throw new Error(`Unexpected Source host request: ${actionId}`);
  };
  const executor = createActionExecutor(createActionExecutorBoundaryFixture({

    projectSourcesList: async input => schemas.ProjectSourcesListOutputV1Schema.parse(await respond('projects.sources.list', input)),
    projectSourcesRead: async input => schemas.ProjectSourcesReadOutputV1Schema.parse(await respond('projects.sources.read', input)),
    projectSourcesCreate: async input => {
      if (shared.createOutcomes.shift() === 'unknown') {
        shared.calls.push({ actionId: 'projects.sources.create', input });
        return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
      }
      return schemas.ProjectSourcesCreateOutputV1Schema.parse(await respond('projects.sources.create', input));
    },
    linkCreatedProjectSource: async ({ checkout }) => {
      shared.calls.push({ actionId: 'link-checkout', input: checkout });
      return { status: 'linked', workspaceId: checkout.workspaceId };
    },
    projectSourcesDelete: async input => schemas.ProjectSourcesDeleteOutputV1Schema.parse(await respond('projects.sources.delete', input)),
    scmActionExecute: ({ actionId, input }) => respond(actionId, input),
  }));
  const directSourceWrites = (['projects.sources.create', 'projects.sources.delete'] as const)
    .reduce((settings, actionId) => setActionApprovalOverride({
      settings, actionId, surface: 'ui', approvalRequired: false,
    }), normalizeActionsSettingsV1({ v: 1 }));
  // The fixture host represents the signed-in person whose Account allows these Source writes on this surface.
  const hostExecutor = {
    ...executor,
    execute: (...[actionId, input, context, ...rest]: Parameters<typeof executor.execute>) =>
      executor.execute(actionId, input, actionId === 'projects.sources.create' || actionId === 'projects.sources.delete' ? {
        ...context, authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account-1',
        actionsSettings: directSourceWrites,
      } : context, ...rest),
  };
  const frontDoor = createFrontDoorActionExecuteForVitest(original);
  // Substitute the external host ports even when the hook supplies its default host executor.
  // Both public factories still run their real front-door implementation.
  return { ...original,
    createFrontDoorActionExecute: () => frontDoor(hostExecutor),
    createFrontDoorUiActionExecutor: (_injected?: Parameters<typeof original.createFrontDoorUiActionExecutor>[0],
      scope?: Parameters<typeof original.createFrontDoorUiActionExecutor>[1]) => original.createFrontDoorUiActionExecutor(hostExecutor, scope),
  };
});

const routerSpies = vi.hoisted(() => ({ back: undefined as undefined | { mockClear(): void; mock: { calls: unknown[][] } } }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock({
    params: () => shared.routes.params,
    router: {
      push: (value: unknown) => {
        shared.navigation.push(value);
      },
      replace: (value: unknown) => {
        shared.navigation.push(value);
      },
    },
  });
  routerSpies.back = mock.spies.back;
  return mock.module;
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { confirm: shared.confirm } }).module;
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

// Window size is an environment adapter; the page, its header and its Back are production code.
const viewport = vi.hoisted(() => ({ compact: false }));
vi.mock('@/utils/platform/useViewportClass', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/useViewportClass')>();
  return {
    ...actual,
    useViewportClass: (...args: Parameters<typeof actual.useViewportClass>) =>
      viewport.compact ? 'compact' : actual.useViewportClass(...args),
  };
});

const { ProjectSourcesScreen } = await import('./ProjectSourcesScreen');
const { storage } = await import('@/sync/domains/state/storageStore');
const previous = storage.getState();
const previousAppliedServer = getAppliedActiveServerSnapshot();
const previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();

afterEach(() => {
  standardCleanup();
  storage.setState(previous);
  publishAppliedActiveServerSnapshot(previousAppliedServer, previousRuntimeAvailable);
  shared.calls = [];
  shared.sources = [];
  shared.listedSources = null;
  shared.navigation = [];
  shared.routes.params = {};
  shared.createOutcomes = [];
  shared.readGate = null;
  shared.confirm.mockClear();
  viewport.compact = false;
});

function signIn() {
  storage.setState({
    profileScope: { serverId: 'server-1', accountId: 'account-1' },
    // A Machine on this Home answers the address check (the resolver runs where Git runs); the inventory
    // is this Home's settled list, never another Home's.
    machineListByServerId: {
      'server-1': [{ id: 'm1', active: true, activeAt: Date.now(), createdAt: 1, metadata: { host: 'devbox', displayName: 'devbox' } }],
    } as never,
    machineListStatusByServerId: { 'server-1': 'idle' },
  });
  publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://home.test', generation: previousAppliedServer.generation + 1 });
}

function publishAddressMachine() {
  return publishMachineInventoryForTest({ serverId: 'server-1', accountId: 'account-1' },
    [createMachineFixture({ id: 'm1', activeAt: Date.now() })]);
}

describe('Projects › Sources', () => {
  it('keeps a selected Source visible when the ordinary catalog is empty', async () => {
    const homes = await serveAccountHomes({ homes: [
      { key: 'home', serverUrl: 'https://selected-source-empty.test', accountId: 'account-1' },
    ], route: request => { throw new Error(`Unexpected Home request: ${request.path}`); } });
    try {
      shared.listedSources = [];
      shared.sources = [{ id: 'selected-source', revision: 1, name: 'Selected outside the catalog',
        owner: { kind: 'team', teamId: 'source-team' }, audience: [], createdByAccountId: 'account-1' }];
      const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!lifetime) throw new Error('Served Home Account did not bind');
      const { readProjectSourcesCatalog } = await import('./projectSourcesCatalog');
      const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
      const owner = readProjectSourcesCatalog(lifetime, createFrontDoorActionExecute());
      const catalog = owner.read('', undefined);
      await catalog.load();
      expect(catalog.getSnapshot()).toMatchObject({ status: 'ready', rows: [] });
      const detail = owner.readSource('selected-source').controller;
      await detail.select('selected-source');
      expect(detail.getSnapshot()).toMatchObject({ detailStatus: 'ready', current: { id: 'selected-source' } });

      shared.routes.params = { source: 'selected-source' };
      const screen = await renderScreen(<ProjectSourcesScreen />);
      try {
        await vi.waitFor(() => expect(screen.findByTestId('projects.sources.detail.header')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Selected outside the catalog');
        expect(screen.findByTestId('projects.sources.empty')).toBeNull();
        expect(catalog.getSnapshot()).toMatchObject({ status: 'ready', rows: [] });
      } finally { await screen.unmount(); }
    } finally { await homes.dispose(); }
  });

  it('shows an explicitly linked Source when its Home retains an empty catalog', async () => {
    const homes = await serveAccountHomes({ homes: [
      { key: 'linked', serverUrl: 'https://empty-source-catalog.test', accountId: 'account-1', serverIdentityId: 'srv_empty_source_catalog' },
    ], route: request => { throw new Error(`Unexpected Home request: ${request.path}`); } });
    try {
      const { resolveServerCredentialAccountScope, captureServerCredentialAccountScopeLifetime } = await import('@/sync/domains/scope/serverCredentialAccountScope');
      const resolution = await resolveServerCredentialAccountScope(homes.homes.linked!.id);
      if (resolution.kind !== 'bound') throw new Error('Linked Home credentials did not bind');
      const { readProjectSourcesCatalog } = await import('./projectSourcesCatalog');
      const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
      const catalog = readProjectSourcesCatalog(captureServerCredentialAccountScopeLifetime(resolution), createFrontDoorActionExecute()).read('', undefined);
      await catalog.load();
      expect(catalog.getSnapshot()).toMatchObject({ status: 'ready', rows: [] });
      expect(shared.calls.filter(call => call.actionId === 'projects.sources.list')).toHaveLength(1);
      shared.sources = [{ id: 'linked-source', revision: 1, name: 'Explicitly linked setup',
        audience: [], createdByAccountId: 'account-1' }];
      shared.routes.params = { source: 'linked-source', target: 'srv_empty_source_catalog' };
      const screen = await renderScreen(<ProjectSourcesScreen setupLink />);
      try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Explicitly linked setup'));
        expect(screen.findByTestId('projects.sources.empty')).toBeNull();
        expect(screen.findByTestId('projects.sources.detail.header')).not.toBeNull();
        expect(shared.calls.filter(call => call.actionId === 'projects.sources.list')).toHaveLength(1);
        expect(shared.calls.filter(call => call.actionId === 'projects.sources.read').map(call => call.input)).toEqual([
          { serverId: homes.homes.linked!.id, sourceId: 'linked-source' },
        ]);
      } finally { await screen.unmount(); }
    } finally { await homes.dispose(); }
  });

  it('reads only the linked Home Source and retains its Open draft while another Home stays focused', async () => {
    const homes = await serveAccountHomes({ homes: [
      { key: 'linked', serverUrl: 'https://source-setup-link.test', accountId: 'account-1', serverIdentityId: 'srv_source_setup_link' },
    ], route: request => { throw new Error(`Unexpected Home request: ${request.path}`); } });
    try {
      signIn();
      shared.routes.params = { source: 'stored-source', target: 'srv_source_setup_link' };
      shared.sources = [{ id: 'stored-source', revision: 1, name: 'Linked Source', audience: [], createdByAccountId: 'account-1',
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'acme/linked' }, protocol: 'https' } }];
      const { WorkspaceRouteBody } = await import('@/app/(app)/projects/setup');
      const screen = await renderScreen(<WorkspaceRouteBody />);
      try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Linked Source'));
        expect(shared.calls.map(call => ({ actionId: call.actionId, serverId: call.input.serverId }))).toEqual([
          { actionId: 'projects.sources.read', serverId: homes.homes.linked!.id },
        ]);
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        await act(async () => screen.pressByTestId('projects.sources.detail.open'));
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledOnce());
        const shown = vi.mocked(Modal.show).mock.calls[0]![0];
        expect(shown.chrome?.testID).toBe('projects.open.dialog');
        const routeParams = (shown.props as { routeParams: Record<string, string> }).routeParams;
        expect(routeParams).toMatchObject({ serverId: homes.homes.linked!.id, draftId: expect.any(String) });
        const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        expect(getSessionDraftSnapshot({ serverId: homes.homes.linked!.id, accountId: 'account-1' },
          { kind: 'projectOpen', draftId: routeParams.draftId! })?.document).toMatchObject({
          selection: { value: { source: { kind: 'source', id: 'stored-source' } } },
        });
        expect(storage.getState().profileScope?.serverId).toBe('server-1');
        expect(shared.calls.some(call => call.actionId === 'projects.open')).toBe(false);
      } finally { await screen.unmount(); }
    } finally { await homes.dispose(); }
  });
  it('never reads a same-id Source on the focused Home when a setup link names an unknown Home', async () => {
    signIn();
    shared.routes.params = { source: 'stored-source', target: 'srv_unadopted_home' };
    shared.sources = [{ id: 'stored-source', revision: 1, name: 'Wrong Home Source', audience: [], createdByAccountId: 'account-1' }];
    const screen = await renderScreen(<ProjectSourcesScreen setupLink />);
    await flushHookEffects();
    expect(shared.calls).toEqual([]);
    expect(screen.getTextContent()).toContain('teams.join.unknownHomeTitle');
    expect(screen.getTextContent()).toContain('projects.sources.setupAddHomeToOpenLink');
    expect(screen.getTextContent()).toContain('server.addServerTitle');
    expect(screen.getTextContent()).not.toContain('Wrong Home Source');
    await screen.unmount();
  });
  it('returns through the link Home sign-in without reading the Source while signed out there', async () => {
    const homes = await serveAccountHomes({ homes: [
      { key: 'signedOut', serverUrl: 'https://source-setup-signed-out.test', accountId: 'account-1', serverIdentityId: 'srv_source_setup_signed_out' },
    ], route: request => { throw new Error(`Unexpected Home request: ${request.path}`); } });
    try {
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      await TokenStorage.removeCredentialsForServerUrl('https://source-setup-signed-out.test');
      signIn();
      shared.routes.params = { source: 'stored-source', target: 'srv_source_setup_signed_out' };
      const { resolveServerProfileForPortableIdentity } = await import('@/sync/domains/server/serverProfiles');
      const linkedHome = resolveServerProfileForPortableIdentity('srv_source_setup_signed_out');
      if (linkedHome.kind !== 'resolved') throw new Error('Linked Home identity did not resolve');
      const screen = await renderScreen(<ProjectSourcesScreen setupLink />);
      try {
        await vi.waitFor(() => expect(shared.navigation).toContainEqual({
          pathname: '/server', params: {
            recoveryProfile: linkedHome.profile.id,
            recoveryReturnTo: '/projects/setup?source=stored-source&target=srv_source_setup_signed_out',
          },
        }));
        expect(shared.calls).toEqual([]);
      } finally { await screen.unmount(); }
    } finally { await homes.dispose(); }
  });
  it('keeps Project chrome on the standalone Deployments entry without inventing a checkout', async () => {
    const homes = await serveAccountHomes({ homes: [
      { key: 'source', serverUrl: 'https://standalone-deployments.example', accountId: 'account-1' },
    ], route: request => { throw new Error(`Unexpected Home request: ${request.path}`); } });
    try {
      shared.routes.params = { serverId: homes.homes.source!.id, projectSourceId: 'stored-source' };
      shared.sources = [{ id: 'stored-source', revision: 1, name: 'Production', audience: [], createdByAccountId: 'account-1' }];
      const { WorkspaceRouteBody } = await import('@/app/(app)/deployments/[projectSourceId]');
      const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
      const { AccountNoticeInvestigationBoundary } = await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
      const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
      const navigation = { push: () => {}, replace: () => {}, back: () => {} };
      const route = (visible: boolean) => <AppPaneProvider><AccountNoticeInvestigationBoundary><DestinationInstanceContext.Provider value={{
        tabId: 'deployments', pathname: '/deployments/stored-source', focused: false, visible, isFocused: () => false,
        navigation,
        ref: { kind: 'route', params: shared.routes.params },
      }}><WorkspaceRouteBody /></DestinationInstanceContext.Provider></AccountNoticeInvestigationBoundary></AppPaneProvider>;
      const screen = await renderScreen(route(false));
      try {
        expect(screen.findByTestId('project-shell-header')).not.toBeNull();
        expect(shared.calls.filter(call => call.actionId === 'projects.sources.read')).toEqual([]);
        await screen.update(route(true));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Production'));
        expect(screen.findByTestId('project-shell-header.checkout')).toBeNull();
        expect(shared.calls.filter(call => call.actionId === 'projects.sources.list')).toEqual([]);
        await screen.update(route(false));
        const readsBefore = shared.calls.filter(call => call.actionId === 'projects.sources.read').length;
        shared.sources = [];
        await act(async () => publishHomeAccountChange(homes.homes.source!.id, undefined, { changeKinds: ['account'] }));
        expect(shared.calls.filter(call => call.actionId === 'projects.sources.read')).toHaveLength(readsBefore);
        await screen.update(route(true));
        await vi.waitFor(() => expect(shared.calls.filter(call => call.actionId === 'projects.sources.read')).toHaveLength(readsBefore + 1));
        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Production'));
      } finally { await screen.unmount(); }
    } finally { await homes.dispose(); }
  });

  it('displays a repository-less Source and omits its repository Open action', async () => {
    signIn();
    shared.routes.params = { source: 'stored-source' };
    shared.sources = [{ id: 'stored-source', revision: 1, name: 'Production', audience: [], createdByAccountId: 'account-1' }];
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('projects.sources.detail.header')).not.toBeNull());
    expect(screen.getTextContent()).toContain('Production');
    expect(screen.findByTestId('projects.sources.detail.open')).toBeNull();
    expect(shared.navigation).toEqual([]);
  });

  it('draws Back in the Source page header only where the detail stands alone, and Back leaves it', async () => {
    signIn();
    shared.routes.params = { source: 'stored-source' };
    shared.sources = [{ id: 'stored-source', revision: 1, name: 'Production', audience: [], createdByAccountId: 'account-1' }];
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('projects.sources.detail.header')).not.toBeNull());
    const layout = screen.findHostByTestId('projects.sources.layout')!;
    // Beside the list the rail is the way out.
    await act(async () => layout.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } }));
    expect(screen.findByTestId('projects.sources.detail.back')).toBeNull();
    // Alone (a phone), the page header's own Back returns to the list; the hosted web page has no native header.
    await act(async () => layout.props.onLayout({ nativeEvent: { layout: { width: 390, height: 800 } } }));
    routerSpies.back!.mockClear();
    await act(async () => screen.pressByTestId('projects.sources.detail.back'));
    expect(routerSpies.back!.mock.calls).toHaveLength(1);
  });

  it.each(['loading', 'unavailable'] as const)('gives the stacked %s Source detail the same Back, and Back leaves it', async (state) => {
    signIn();
    shared.routes.params = { source: 'gone' };
    shared.sources = [{ id: 'stored-source', revision: 1, name: 'Production', audience: [], createdByAccountId: 'account-1' }];
    let release = () => {};
    if (state === 'loading') shared.readGate = new Promise<void>((resolve) => { release = resolve; });
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findHostByTestId('projects.sources.layout')).not.toBeNull());
    const layout = screen.findHostByTestId('projects.sources.layout')!;
    await act(async () => layout.props.onLayout({ nativeEvent: { layout: { width: 390, height: 800 } } }));
    await vi.waitFor(() => expect(screen.findByTestId(`projects.sources.detail.${state}`)).not.toBeNull());
    routerSpies.back!.mockClear();
    await act(async () => screen.pressByTestId('projects.sources.detail.back'));
    expect(routerSpies.back!.mock.calls).toHaveLength(1);
    // Beside the list the rail is the way out, so no Back is added to the state.
    await act(async () => layout.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } }));
    expect(screen.findByTestId('projects.sources.detail.back')).toBeNull();
    release();
  });

  it('restores the device-local Sources rail width without changing another collection', async () => {
    signIn();
    shared.routes.params = { source: 'new' };
    storage.getState().applyLocalSettings({ collectionRailWidthsV1: { 'project-sources': 365, inbox: 410 } });
    const screen = await renderScreen(<ProjectSourcesScreen />);
    const layout = screen.findHostByTestId('projects.sources.layout');
    expect(layout).not.toBeNull();
    await act(async () => layout!.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } }));
    const divider = screen.findHostByTestId('projects.sources.layout-resize-handle');
    expect(divider?.props.accessibilityValue.now).toBeCloseTo(365);
    expect(storage.getState().localSettings.collectionRailWidthsV1.inbox).toBe(410);
  });

  it('renews the mounted catalog exactly once when the same Account lifetime retires', async () => {
    signIn();
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(shared.calls.filter((call) => call.actionId === 'projects.sources.list')).toHaveLength(1));

    await act(async () => {
      retireActiveServerAccountScopeLifetime();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(shared.calls.filter((call) => call.actionId === 'projects.sources.list')).toHaveLength(2));
    expect(screen.findByTestId('projects.sources.empty')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(shared.calls.filter((call) => call.actionId === 'projects.sources.list')).toHaveLength(2);
  });

  it('routes Delete directly to Action admission without a caller-owned confirmation floor', async () => {
    signIn();
    shared.sources = [{ id: 'source-1', revision: 1, name: 'happier', audience: [], createdByAccountId: 'account-1',
      repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'happier-dev/happier' }, protocol: 'https' } }];
    shared.routes.params = { source: 'source-1' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('projects.sources.detail.delete')).toBeTruthy());
    await act(async () => screen.pressByTestId('projects.sources.detail.delete'));
    await vi.waitFor(() => expect(shared.calls.filter((call) => call.actionId === 'projects.sources.delete')).toEqual([
      { actionId: 'projects.sources.delete', input: { serverId: 'server-1', sourceId: 'source-1', expectedRevision: 1 } },
    ]));
    expect(shared.confirm).not.toHaveBeenCalled();
  });
  it('invites the first Source when the authenticated catalog is empty, and Add opens the draft', async () => {
    signIn();
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.empty')).toBeTruthy(),
    );
    await act(async () => {
      screen.pressByTestId('projects.sources.empty.add');
    });
    expect(shared.navigation).toContainEqual('/projects/sources?source=new');
  });

  it('gives the empty catalog the Sources page header and Back on a phone', async () => {
    signIn();
    viewport.compact = true;
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('projects.sources.empty')).toBeTruthy());
    expect(screen.findByTestId('projects.sources.header')).not.toBeNull();
    routerSpies.back!.mockClear();
    await act(async () => screen.pressByTestId('projects.sources.back'));
    expect(routerSpies.back!.mock.calls).toHaveLength(1);
  });

  it('leaves the empty catalog headerless beside the app shell', async () => {
    signIn();
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('projects.sources.empty')).toBeTruthy());
    expect(screen.findByTestId('projects.sources.header')).toBeNull();
    expect(screen.findByTestId('projects.sources.back')).toBeNull();
  });

  it('saves a new Source from a typed address through the one create Action and selects it', async () => {
    signIn();
    storage.setState({ machineListStatusByServerId: { 'server-1': 'loading' } });
    shared.sources = [
      {
        id: 'existing',
        revision: 1,
        name: 'website',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: {
            id: 'happier.scm.forge.github/github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
          },
          repository: { nameWithOwner: 'happier-dev/website' },
          protocol: 'https',
        },
      },
    ];
    shared.routes.params = { source: 'new' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('projects.sources.detail.address.field'),
      ).toBeTruthy(),
    );
    const field = screen.findByTestId('projects.sources.detail.address.field')!;
    expect(field.props.autoComplete).toBe('off');
    await act(async () => {
      field.props.onChangeText?.('github.com/acme/billing');
    });
    await act(async () => {
      field.props.onBlur?.();
      field.props.onSubmitEditing?.();
    });
    expect(shared.calls.some((call) => call.actionId === 'scm.hostingRepository.resolveAddress')).toBe(false);
    await act(publishAddressMachine);
    await vi.waitFor(() =>
      expect(
        shared.calls.some((call) => call.actionId === 'scm.hostingRepository.resolveAddress'),
      ).toBe(true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.save');
    });
    const create = shared.calls.find(
      (call) => call.actionId === 'projects.sources.create',
    );
    expect(create?.input).toMatchObject({
      serverId: 'server-1',
      name: 'billing',
      audience: [],
      repository: {
        repository: { nameWithOwner: 'acme/billing' },
        protocol: 'https',
      },
    });
    expect(shared.navigation).toContainEqual(
      '/projects/sources?source=created',
    );
  });

  it('links the exact managed checkout through the Source creation Action', async () => {
    signIn();
    const checkout = {
      v: 2, kind: 'managed', id: 'guest-checkout', serverId: 'server-1', rootPath: '/repo', createdAtMs: 1,
      managedId: 'guest', controller: { machineId: 'm1', installationId: 'controller-installation' },
    } as const;
    const { useProjectsSourcesComposition } = await import('../useProjectsSourcesComposition');
    const openedSourceIds = new Set<string>();
    const composition = await renderHook(() => useProjectsSourcesComposition(openedSourceIds));
    try {
      await act(async () => {
        const outcome = await composition.getCurrent().saveAsSource(checkout, {
          name: 'billing', audience: [], repository: {
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'acme/billing' },
            protocol: 'https',
          },
        });
        expect(outcome).toMatchObject({ kind: 'saved', source: { id: 'created' } });
      });
      expect(shared.calls.filter(({ actionId }) => actionId === 'link-checkout')).toEqual([{
        actionId: 'link-checkout', input: {
          v: 2, kind: 'managed', workspaceId: 'guest-checkout', serverId: 'server-1', rootPath: '/repo',
          managedId: 'guest', controller: { machineId: 'm1', installationId: 'controller-installation' },
        },
      }]);
    } finally {
      await composition.unmount();
    }
  });

  it('recovers an unconfirmed create only after a complete inspection, retrying the same request', async () => {
    signIn();
    await publishAddressMachine();
    shared.createOutcomes = ['unknown'];
    shared.routes.params = { source: 'new' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.address.field')).toBeTruthy(),
    );
    const field = screen.findByTestId('projects.sources.detail.address.field')!;
    await act(async () => {
      field.props.onChangeText?.('github.com/acme/billing');
    });
    await act(async () => {
      field.props.onBlur?.();
      field.props.onSubmitEditing?.();
    });
    await vi.waitFor(() =>
      expect(shared.calls.some((call) => call.actionId === 'scm.hostingRepository.resolveAddress')).toBe(true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.save');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.outcomeUnknown')).toBeTruthy(),
    );
    // Save cannot repeat it yet; the banner's only way forward is to check every Source.
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.outcomeUnknown.action');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.outcomeUnknown.action')).toBeTruthy(),
    );
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.outcomeUnknown.action');
    });
    await vi.waitFor(() => expect(shared.calls.filter((call) => call.actionId === 'projects.sources.create')).toHaveLength(2));
    const [first, second] = shared.calls.filter((call) => call.actionId === 'projects.sources.create');
    expect(second!.input.requestKey).toBe(first!.input.requestKey);
    expect(shared.navigation).toContainEqual('/projects/sources?source=created');
  });

  it('never shows a same-id local document for a dashboard attached on another Home', async () => {
    signIn();
    storage.setState({
      projectAccountRows: createProjectAccountRowsFixture({ serverId: 'server-1', accountId: 'account-1' }, {
        workspaceRefs: [{ id: 'checkout-1', serverId: 'server-1', machineId: 'm1', rootPath: '/repo',
          projectKey: 'viewer-project', source: { sourceId: 'source-1', revision: 1 }, createdAtMs: 1 }],
      }),
      artifacts: {
        dash: { id: 'dash', title: 'Local release', isDecrypted: true, access: 'edit' },
      } as never,
    });
    shared.sources = [
      {
        id: 'source-1',
        revision: 1,
        name: 'happier',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'happier-dev/happier' },
          protocol: 'https',
        },
        attachments: [
          { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dash' } },
          { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dash', serverId: 'server-2' } },
        ],
      },
    ];
    shared.routes.params = { source: 'source-1' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.dashboard.server-2:dash')).toBeTruthy(),
    );
    // The outermost match is the row itself (its title/subtitle props); findByTestId prefers the pressable host.
    const local = screen.findAllByTestId('projects.sources.dashboard.server-1:dash')[0]!;
    const foreign = screen.findAllByTestId('projects.sources.dashboard.server-2:dash')[0]!;
    await vi.waitFor(() => expect(screen.findAllByTestId('projects.sources.dashboard.server-1:dash')[0]!.props.title)
      .toBe('projects.sources.dashboardUnavailableTitle'));
    expect(foreign.props.title).not.toBe('Local release');
    expect(foreign.props.subtitle).toBe('projects.sources.dashboardOtherHome');
    expect(local.props.onPress).toBeUndefined();
    expect(foreign.props.onPress).toBeUndefined();
  });
  it('names each checkout\'s Machine through the machine-name owner, never its raw id', async () => {
    signIn();
    const devbox = storage.getState().machineListByServerId['server-1']![0]!;
    storage.setState({
      machines: { m1: devbox } as never,
      projectAccountRows: createProjectAccountRowsFixture({ serverId: 'server-1', accountId: 'account-1' }, {
        workspaceRefs: [
          { id: 'here', serverId: 'server-1', machineId: 'm1', rootPath: '/repo', projectKey: 'p',
            source: { sourceId: 'source-1', revision: 1 }, createdAtMs: 1 },
          { id: 'gone', serverId: 'server-1', machineId: 'retired-machine-id', rootPath: '/old', projectKey: 'p',
            source: { sourceId: 'source-1', revision: 1 }, createdAtMs: 2 },
        ],
      }),
    });
    shared.sources = [{ id: 'source-1', revision: 1, name: 'happier', audience: [], createdByAccountId: 'account-1',
      repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'happier-dev/happier' }, protocol: 'https' } }];
    shared.routes.params = { source: 'source-1' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('projects.sources.checkout.m1')).toBeTruthy());
    const title = (id: string) => screen.findAllByTestId(id)[0]!.props.title;
    expect(title('projects.sources.checkout.m1')).toBe('devbox');
    expect(title('projects.sources.checkout.retired-machine-id')).toBe('machine.unlistedMachine');
  });

  it('edits the default branch through a field select whose Other entry asks for any ref', async () => {
    signIn();
    shared.sources = [
      {
        id: 'source-1',
        revision: 1,
        name: 'happier',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'happier-dev/happier' },
          protocol: 'https',
        },
        defaultRef: 'v0.3',
      },
    ];
    shared.routes.params = { source: 'source-1' };
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { Modal } = await import('@/modal');
    const screen = await renderScreen(<ProjectSourcesScreen />);
    const select = () => screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'projects.sources.detail.defaultRef');
    await vi.waitFor(() => expect(select()).toBeDefined());
    // The stored ref is the selection; the repository default and Other stay one step away (T1-F8).
    expect(select()!.props.items.map((item: { id: string }) => item.id)).toEqual(['ref:@default', 'ref:v0.3', 'ref:@other']);
    expect(select()!.props.selectedId).toBe('ref:v0.3');
    expect(screen.findByTestId('projects.sources.detail.save')).toBeFalsy();
    vi.mocked(Modal.prompt).mockResolvedValueOnce('develop');
    await act(async () => {
      select()!.props.onSelect('ref:@other');
    });
    await vi.waitFor(() => expect(select()!.props.selectedId).toBe('ref:develop'));
    expect(screen.findByTestId('projects.sources.detail.save')).toBeTruthy();
  });
  it.each([{ foreign: true, bound: true, managed: false }, { foreign: false, bound: true, managed: false },
    { foreign: true, bound: false, managed: false }, { foreign: true, bound: true, managed: true }])
  ('opens an independently admitted dashboard directly or through retained Source Open (%j)', async ({ foreign, bound, managed }) => {
    const releaseFirstRead = createDeferred<void>();
    const documentReads: AbortSignal[] = [];
    const checkout = { id: 'foreign-checkout', serverId: 'srv_source_dashboards', rootPath: '/repo', createdAtMs: 1,
      projectKey: 'personal-project', ...(bound ? { source: { sourceId: 'foreign-source', revision: 1 } } : {}),
      ...(managed ? { kind: 'managed' as const, v: 2 as const, managedId: 'guest', controller: { machineId: 'machine', installationId: 'install' } }
        : { machineId: 'machine' }) };
    const projectRows = createPlainProjectAccountRowListFixture({ workspaceRefs: [checkout] });
    const homes = await serveAccountHomes({ homes: [
      { key: 'foreign', serverUrl: 'https://rf10-source-foreign.example', accountId: 'foreign-viewer' },
      { key: 'source', serverUrl: 'https://rf10-source-local.example', accountId: 'source-viewer', serverIdentityId: 'srv_source_dashboards' },
    ], route: async request => {
      if (request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(projectRows);
      if (request.home !== (foreign ? 'foreign' : 'source')) return undefined;
      const response = await document.request(request.url, { method: request.method, headers: request.headers });
      if (request.path === `/v1/artifacts/${encodeURIComponent(artifactId)}`) {
        if (!request.signal) throw new Error('Expected cancellable dashboard read');
        documentReads.push(request.signal);
        if (documentReads.length === 1) await releaseFirstRead.promise;
      }
      return response;
    } });
    const serverId = homes.homes.source!.id;
    const foreignHome = foreign ? homes.homes.foreign!.id : serverId;
    const surface = { accountId: 'dashboard-owner', serverId: foreignHome, owner: { kind: 'project' as const, projectId: 'owners-project' } };
    const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, name: 'Foreign release', items: [] });
    const document = createLayoutArtifactHttpBoundary('dashboard-owner', { artifactId, kind: 'widget-area-layout.v1', defaultLayout: layout,
      parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
    document.seed(layout);
    document.setCallerAccess('view');
    document.setGrants([{ principal: { kind: 'team', teamId: 'studio' }, accessLevel: 'view',
      createdByAccountId: 'dashboard-owner', createdAt: 1, display: { name: 'Studio' } }]);
    storage.setState({ projectAccountRows: createProjectAccountRowsFixture({ serverId, accountId: 'source-viewer' }, {
      workspaceRefs: [{ ...checkout, serverId }],
    }), artifacts: { [artifactId]: { id: artifactId, title: 'Local release', isDecrypted: true, access: 'edit',
      headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
    shared.sources = [{ id: 'foreign-source', revision: 1, name: 'Repository', audience: [], createdByAccountId: 'source-owner',
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' },
      attachments: [{ purpose: 'dashboard', ref: { kind: 'doc', artifactId, serverId: foreignHome } }] }];
    shared.routes.params = { source: 'foreign-source' };
    try {
      const screen = await renderScreen(<ProjectSourcesScreen />);
      const rowId = `projects.sources.dashboard.${foreignHome}:${artifactId}`;
      await vi.waitFor(() => expect(documentReads).toHaveLength(1));
      for (let index = 0; index < 3; index++) {
        await act(async () => publishHomeAccountChange(foreignHome, [`unrelated-pending-${index}`], {
          changeKinds: ['artifact'], feedPageConsumed: true,
        }));
        await flushHookEffects();
        expect(documentReads[0]!.aborted).toBe(false);
        expect(documentReads).toHaveLength(1);
      }
      releaseFirstRead.resolve();
      await vi.waitFor(() => expect(screen.findAllByTestId(rowId)[0]?.props.title).toBe('Foreign release'));
      // Both Homes render the Artifact's admitted audience, independently of this Home's people cache.
      await vi.waitFor(() => expect(String(screen.findAllByTestId(rowId)[0]?.props.subtitle))
        .toMatch(foreign ? /^Studio shareSheet\.documents\.levels\.canRead$/
          : /\S+ · Studio shareSheet\.documents\.levels\.canRead$/));
      await vi.waitFor(() => expect(screen.findAllByTestId(rowId)[0]?.props.onPress).toBeTypeOf('function'));
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.show).mockClear();
      await act(async () => screen.pressByTestId(rowId));
      if (!bound) {
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledOnce());
        const shown = vi.mocked(Modal.show).mock.calls[0]![0];
        expect(shown.chrome?.testID).toBe('projects.open.dialog');
        const routeParams = (shown.props as { routeParams: Record<string, string> }).routeParams;
        expect(routeParams).toMatchObject({ serverId, draftId: expect.any(String), dashboardSourceId: 'foreign-source',
          dashboardArtifactId: artifactId, dashboardServerId: foreignHome });
        const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        expect(getSessionDraftSnapshot({ serverId, accountId: 'source-viewer' }, { kind: 'projectOpen', draftId: routeParams.draftId! })?.document)
          .toMatchObject({ selection: { value: { source: { kind: 'source', id: 'foreign-source' } } } });
        expect(shared.navigation).toEqual([]);
        expect(shared.calls.some(call => call.actionId === 'projects.open')).toBe(false);
        expect(storage.getState().projectAccountRows?.workspaceRefs[0]?.source).toBeUndefined();
      } else {
        const url = new URL(String(shared.navigation.at(-1)), 'https://happier.test');
        expect(url.pathname).toBe('/projects/foreign-checkout/overview');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ serverId, dashboardSourceId: 'foreign-source',
          dashboardArtifactId: artifactId, dashboardServerId: foreignHome });
        expect(Modal.show).not.toHaveBeenCalled();
      }
      for (let index = 0; index < 3; index++) {
        await act(async () => publishHomeAccountChange(foreignHome, [`unrelated-settled-${index}`], {
          changeKinds: ['artifact'], feedPageConsumed: true,
        }));
        await flushHookEffects();
        expect(documentReads).toHaveLength(1);
      }
      const wakes = [
        () => publishHomeAccountChange(foreignHome, [artifactId], { changeKinds: ['artifact'], feedPageConsumed: true }),
        () => publishHomeAccountChange(foreignHome),
        () => publishHomeAccountChange(foreignHome, undefined, { source: 'connected' }),
        // Admission widens unknown domain facts; supplied unrelated IDs cannot narrow this wake.
        () => publishHomeAccountChange(foreignHome, ['unknown-resource'], { source: 'socket', changeKinds: [] }),
        () => publishHomeAccountChange(foreignHome, ['mixed-resource'], { changeKinds: ['artifact', 'account'], feedPageConsumed: true }),
      ];
      for (const [index, wake] of wakes.entries()) {
        await act(async () => wake());
        await vi.waitFor(() => expect(documentReads).toHaveLength(index + 2));
        await flushHookEffects();
        expect(screen.findAllByTestId(rowId)[0]?.props.onPress).toBeTypeOf('function');
      }
      if (foreign) {
        await act(async () => homes.switchAccount('foreign', 'replacement-dashboard-viewer'));
        await vi.waitFor(() => expect(documentReads).toHaveLength(7));
        await vi.waitFor(() => expect(screen.findAllByTestId(rowId)[0]?.props.onPress).toBeTypeOf('function'));
      }
      document.setCallerAccess(null);
      await act(async () => publishHomeAccountChange(foreignHome, [artifactId], { changeKinds: ['artifact'] }));
      await vi.waitFor(() => expect(screen.findAllByTestId(rowId)[0]?.props.onPress).toBeUndefined());
      expect(storage.getState().artifacts[artifactId]?.title).toBe('Local release');
      expect(document.writes).toEqual([]);
      const reads = homes.requests.filter(request => request.home === (foreign ? 'foreign' : 'source') && request.path.startsWith('/v1/artifacts'));
      expect(reads.length).toBeGreaterThan(0);
      const documentPath = `/v1/artifacts/${encodeURIComponent(artifactId)}`;
      const contentReads = reads.filter(request => request.path === documentPath);
      const grantReads = reads.filter(request => request.path === `${documentPath}/access/grants`);
      expect(contentReads).toHaveLength(foreign ? 8 : 7);
      expect(grantReads).toHaveLength(foreign ? 7 : 6);
      expect(contentReads.slice(0, 6).every(request => request.accountId === (foreign ? 'foreign-viewer' : 'source-viewer'))).toBe(true);
      expect(contentReads.slice(6).every(request => request.accountId === (foreign ? 'replacement-dashboard-viewer' : 'source-viewer'))).toBe(true);
      expect(grantReads.slice(0, 6).every(request => request.accountId === (foreign ? 'foreign-viewer' : 'source-viewer'))).toBe(true);
      expect(grantReads.slice(6).every(request => request.accountId === (foreign ? 'replacement-dashboard-viewer' : 'source-viewer'))).toBe(true);
      expect(contentReads.length + grantReads.length).toBe(reads.length);
    } finally { releaseFirstRead.resolve(); await homes.dispose(); }
  });
});
