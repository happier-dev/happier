import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The disconnected socket boundary must exist before `storage` (imported below) loads the sync graph.
await vi.hoisted(async () => {
  const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
  installDisconnectedServerSocketBoundary();
});
import { act } from 'react-test-renderer';
import {
  buildWidgetSurfaceArtifactHeaderV1,
  buildWidgetSurfaceArtifactIdV1,
  WidgetAreaLayoutV1Schema,
  WidgetSurfaceRefV1Schema,
  type WidgetAreaLayoutV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import * as React from 'react';
import {
  renderHook,
  renderScreen,
  flushHookEffects,
  standardCleanup,
} from '@/dev/testkit';
import {
  createHomeHubArtifactHttpBoundary,
  createLayoutArtifactHttpBoundary,
} from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import {
  flattenWidgetLayoutWidgetsV1,
  resolveWidgetBindingsV1,
} from '@happier-dev/protocol/widgets';
import {
  PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
  type ProjectSourceV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { useWidgetAreaLayout } from './useWidgetAreaLayout';

const windowSize = vi.hoisted(() => ({ width: 1024, height: 800 }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    // The testkit keeps Dimensions and its hook on the same platform viewport.
    useWindowDimensions: () => ({ ...windowSize, scale: 1, fontScale: 1 }),
  }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
// Popover placement is a browser layout boundary absent from the host renderer.
vi.mock('@/components/ui/popover', async importOriginal =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, {
    maxHeight: 624, maxWidth: 960, placement: 'bottom',
  }));
afterEach(standardCleanup);
beforeEach(() => {
  windowSize.width = 1024;
  windowSize.height = 800;
});
// App-entry composition belongs to collection, before timing the Account-bound journey.
await import('@/sync/syncEngine');
await import('./useProjectWidgetAreaBinding');
await import('@/sync/ops/actions/defaultActionExecutor');
// Load the rendered Project corridor during collection, outside the timed Account journey.
await import('@/components/projects/detail/ProjectOverviewWidgets');
await import('@/components/appShell/plugins/AppShellPluginUiProjection');
await import('@/components/ui/treeDragDrop/ui/EntityReleasePreview');

it('mounts following Usage widgets with the Project scope without requiring a Source or an online checkout', async () => {
  const fallback = createHomeHubArtifactHttpBoundary('viewer');
  let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://project-usage-mount.test', accountId: 'viewer',
    request: (input, init) => new URL(String(input)).pathname.startsWith('/v1/artifacts') && area
      ? area.request(input, init) : fallback.request(input, init),
  });
  const restoreLoader = await installRealActionExecutorModuleLoader();
  try {
    const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'viewer',
      owner: { kind: 'project', projectId: 'mounted-project' } };
    const { normalizeUsageQuery } = await import('@happier-dev/protocol/inputs/usageQuery');
    const { readBuiltinWidgetDescriptorV1 } = await import('@happier-dev/protocol/widgets');
    const paths = new Set(readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_daily' })!.inputs!.fields.map(field => field.path));
    const query = normalizeUsageQuery({ period: { startMs: 1000 } });
    const instance = (id: string) => ({ v: 1 as const, id,
      definition: { kind: 'builtin' as const, id: 'usage_daily' },
      bindings: { ...Object.fromEntries(Object.entries(query).filter(([path, value]) => value !== undefined && paths.has(path)).map(([path, value]) =>
        [path, { kind: 'value' as const, value }])), projects: { kind: 'context' as const, slot: 'projects' } },
    });
    const saved = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [
      { kind: 'widget', instance: instance('single'), area: 'main' },
      { kind: 'group', id: 'group', width: 'full', area: 'main', children: [
        { kind: 'widget', instance: instance('group-child') },
        { kind: 'widget', instance: { v: 1, id: 'private-group-child-id', definition: { kind: 'artifact', artifactId: 'missing-private-definition' }, bindings: {} } },
      ] },
    ] });
    area = createLayoutArtifactHttpBoundary('viewer', {
      artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: 'widget-area-layout.v1',
      defaultLayout: saved, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
      buildHeader: buildWidgetSurfaceArtifactHeaderV1,
    });
    area.seed(saved);
    const { ProjectWidgetArea, useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
    const { UsageWidgetBody } = await import('@/components/settings/usage/widgets/UsageWidgetBody');
    const { ConfiguredWidgetRefusal } = await import('@/components/widgets/InstalledWidgetSurface');
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    function MountedProject() {
      const binding = useProjectWidgetAreaBinding({ serverId: connection.home.id, projectName: 'Project',
        projectRef: { id: 'offline-checkout', serverId: connection.home.id, machineId: 'offline-machine',
          rootPath: '/repo', projectKey: 'mounted-project', createdAtMs: 1 } });
      return <ProjectWidgetArea {...binding} projectName="Project" testID="project-usage" />;
    }
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{
      pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
      machineId: null, serverId: connection.home.id, platform: 'web',
      accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
      reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
    }}><InjectedAuthProvider credentials={connection.credentials}><MountedProject /></InjectedAuthProvider></AppShellPluginUiProjectionValueProvider>);
    await vi.waitFor(() => {
      const bodies = screen.findAllByType(UsageWidgetBody);
      expect(bodies.map(body => ({ id: body.props.testID, projects: body.props.input.projects })),
        JSON.stringify(screen.findAllByType(ConfiguredWidgetRefusal).map(node => node.props.resolution)))
        .toEqual([
          { id: 'project-usage.widget.single.body', projects: ['mounted-project'] },
          { id: 'project-usage.widget.group-child.body', projects: ['mounted-project'] },
        ]);
    });
    expect(area.writes).toEqual([]);
    const { WidgetGroupFrame } = await import('@/components/widgets/group/WidgetGroupFrame');
    const groupLabel = screen.findAllByType(WidgetGroupFrame)[0]!.props.accessibilityLabel;
    const { t } = await import('@/text');
    expect(groupLabel).toContain(t('composerReferences.kindWidget'));
    expect(groupLabel).not.toContain('private-group-child-id');
    await screen.unmount();
  } finally { restoreLoader(); await connection.dispose(); }
});

it('opens a foreign-Home Source dashboard as that Home viewer and refuses its revoked access without touching personal layouts', async () => {
  let document: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
  let artifactId = '';
  let documentHome = '';
  const source = (): ProjectSourceV1 => ({ id: 'foreign-source', revision: 1, name: 'Repository', audience: [],
    createdByAccountId: 'source-owner', repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' },
    attachments: [{ purpose: 'dashboard', ref: { kind: 'doc', artifactId, serverId: documentHome } }] });
  const homes = await serveActionHomes({ homes: [
    { key: 'document', serverUrl: 'https://rf10-document.example', accountId: 'foreign-viewer', settings: { actionsSettingsV1: {
      v: 1, approvalWaivedSurfaces: { 'widgets.item.rename': ['ui'] } } } },
    { key: 'source', serverUrl: 'https://rf10-source.example', accountId: 'source-viewer' },
  ], route: request => {
    if (request.home === 'source' && request.path === '/v1/projects/sources/foreign-source') return Response.json({ ok: true, source: source(), canManage: false });
    if (request.home === 'document') return document?.request(request.url, { method: request.method, headers: request.headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
    return undefined;
  } });
  const disconnect = await homes.restoreActiveConnection();
  expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: homes.homes.source!.id, accountId: 'source-viewer' });
  try {
    documentHome = homes.homes.document!.id;
    const surface: WidgetSurfaceRefV1 = { serverId: documentHome, accountId: 'document-owner', owner: { kind: 'project', projectId: 'owners-anchor' } };
    artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    document = createLayoutArtifactHttpBoundary('document-owner', { artifactId, kind: 'widget-area-layout.v1',
      defaultLayout: { v: 1, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
    const instance = { v: 1 as const, id: 'foreign-about', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {}, displayName: 'Foreign About' };
    document.seed({ v: 1, surface, name: 'Foreign release', items: [{ kind: 'widget', instance, area: 'main' }] });
    document.setCallerAccess('view');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const documentAccount = await captureLazyActionAccountContext(documentHome);
    try {
      expect(await documentAccount.homeHubArtifactTransport.read(artifactId)).toMatchObject({ artifactId, ownerAccountId: 'document-owner', access: 'view' });
    } finally { documentAccount.dispose(); }
    const checkout = { id: 'rf10-checkout', serverId: homes.homes.source!.id, machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
      projectKey: 'personal-anchor', source: { sourceId: 'foreign-source', revision: 1 } };
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
    // A same-id active-Home cache publication is never this foreign document's title or authority.
    storage.setState({ artifacts: { [artifactId]: { id: artifactId, title: 'Local impostor', isDecrypted: true, access: 'edit',
      headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
    const { useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
    const hook = await renderHook(() => useProjectWidgetAreaBinding({ serverId: checkout.serverId, projectName: 'Project', activeCheckout: checkout,
      attachedDashboard: { sourceId: 'foreign-source', artifactId, serverId: documentHome } }));
    await vi.waitFor(() => expect(hook.getCurrent().unavailableReasonCode).toBeUndefined());
    expect(hook.getCurrent().sharedDashboard).toMatchObject({ name: 'Foreign release', access: 'view', surface: { ...surface, artifactId } });
    const priorPort = hook.getCurrent().port!;
    expect(await priorPort.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true, result: { canEdit: false } });
    expect(await priorPort.execute({ actionId: 'widgets.item.rename', instanceId: instance.id, displayName: 'Refused' })).toMatchObject({ ok: false });
    expect(document.writes).toEqual([]);
    document.setCallerAccess('edit');
    await act(async () => publishHomeAccountChange(documentHome, [artifactId], { changeKinds: ['artifact'] }));
    await vi.waitFor(() => expect(hook.getCurrent().sharedDashboard?.access).toBe('edit'));
    expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.rename', instanceId: instance.id, displayName: 'Edited foreign About' })).toMatchObject({ ok: true });
    expect(document.layout()?.items).toMatchObject([{ instance: { displayName: 'Edited foreign About' } }]);
    const writes = document.writes.length;
    document.setCallerAccess(null);
    await act(async () => publishHomeAccountChange(documentHome, [artifactId], { changeKinds: ['artifact'] }));
    await vi.waitFor(() => expect(hook.getCurrent().port).toBeNull());
    expect(await priorPort.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: false });
    expect(document.writes).toHaveLength(writes);
    expect(homes.requests.filter(request => request.home === 'document' && request.path.startsWith('/v1/artifacts')).every(request => request.accountId === 'foreign-viewer')).toBe(true);
    expect(homes.requests.filter(request => request.home === 'source' && request.path === `/v1/artifacts/${artifactId}`)).toEqual([]);
  } finally { await disconnect(); await homes.dispose(); }
});

it.each([false, true])(
  'agent selection changes the mounted Project document with route ownership=%s',
  async (routeOwned) => {
    const previous = storage.getState();
    const artifactReads: string[] = [];
    const artifacts = createArtifactStoreBoundary({
      ownerAccountId: () => 'viewer',
      encryptionMode: 'plain',
    });
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({
      serverUrl: `https://project-layout-select-${routeOwned}.test`,
      accountId: 'viewer',
      request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (/^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET') artifactReads.push(path);
        if (path === '/v2/account/settings') {
          // This selection scenario needs an acknowledged document, not a
          // pending Create approval. Persist the user's waiver at the Home boundary.
          return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'widgets.area.layout.create': ['ui'] },
          }) } }, version: 1 });
        }
        const response = new URL(String(input)).pathname.startsWith(
          '/v1/artifacts',
        )
          ? await artifacts.handle(`${new URL(String(input)).pathname}${new URL(String(input)).search}`, init)
          : await fallback.request(input, init);
        if (!response) throw new Error('Unexpected Project layout request');
        return response;
      },
    });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
      const { createDefaultActionExecutor } =
        await import('@/sync/ops/actions/defaultActionExecutor');
      const { useProjectWidgetAreaBinding } =
        await import('./useProjectWidgetAreaBinding');
      const executor = createDefaultActionExecutor();
      const surface: WidgetSurfaceRefV1 = {
        serverId: connection.home.id,
        accountId: 'viewer',
        owner: { kind: 'project', projectId: 'anchor' },
      };
      const context = {
        surface: 'mcp' as const,
        serverId: surface.serverId,
        expectedAccountId: surface.accountId,
      };
      expect(
        await executor.execute(
          'widgets.area.layout.create',
          { surface, layoutId: 'empty', name: 'Empty' },
          { ...context, surface: 'ui' },
        ),
      ).toMatchObject({ ok: true, result: { surface: { owner: { layoutId: 'empty' } } } });
      const checkout: WorkspaceRefV1 = {
        id: 'checkout',
        serverId: connection.home.id,
        machineId: 'machine',
        rootPath: '/repo',
        projectKey: 'anchor',
        createdAtMs: 1,
      };
      const hook = await renderHook(() => {
        const [routeSelection, setRouteSelection] = React.useState<
          string | null
        >(null);
        const binding = useProjectWidgetAreaBinding({
          serverId: connection.home.id,
          projectName: 'Project',
          activeCheckout: checkout,
          ...(routeOwned
            ? {
                layoutId: routeSelection ?? undefined,
                onSelectLayout: setRouteSelection,
              }
            : {}),
        });
        return {
          routeSelection,
          layout: useWidgetAreaLayout(binding.port!, binding.context),
        };
      });
      await vi.waitFor(() =>
        expect(hook.getCurrent().layout.state).toMatchObject({
          status: 'ready',
        }),
      );
      artifactReads.length = 0;
      await act(async () => {
        const selected = await executor.execute(
          'widgets.area.layout.select',
          {
            surface: {
              ...surface,
              owner: { ...surface.owner, layoutId: 'empty' },
            },
          },
          context,
        );
        expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true });
      });
      await vi.waitFor(() =>
        expect(hook.getCurrent().layout.state).toMatchObject({
          status: 'ready',
          surface: { owner: { layoutId: 'empty' } },
          placements: [],
        }),
      );
      const selectedSurface: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'anchor', layoutId: 'empty' } };
      expect(artifactReads.filter(path => path === `/v1/artifacts/${buildWidgetSurfaceArtifactIdV1(selectedSurface)}`)).toHaveLength(1);
      expect(hook.getCurrent().routeSelection).toBe(
        routeOwned ? 'empty' : null,
      );
      await hook.unmount();
      expect(
        await executor.execute(
          'widgets.area.layout.select',
          { surface },
          context,
        ),
      ).toMatchObject({
        ok: false,
        errorCode: 'widget_area_layout_owner_unavailable',
      });
    } finally {
      restoreLoader();
      await connection.dispose();
      storage.setState(previous);
    }
  },
);

it('admits a pending layout read across equivalent checkout object refreshes', async () => {
  const previous = storage.getState();
  const fallback = createHomeHubArtifactHttpBoundary('viewer');
  let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
  let release: (() => void) | undefined;
  let artifactId = '';
  const connection = await restoreServerAccountForTest({ serverUrl: 'https://project-stable-read.test', accountId: 'viewer',
    request: async (input, init) => {
      if (new URL(String(input)).pathname === `/v1/artifacts/${artifactId}` && release === undefined) {
        await new Promise<void>(resolve => { release = resolve; });
      }
      return area?.request(input, init) ?? fallback.request(input, init);
    } });
  const restoreLoader = await installRealActionExecutorModuleLoader();
  try {
    const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'project', projectId: 'anchor' } };
    artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    area = createLayoutArtifactHttpBoundary('viewer', { artifactId, kind: 'widget-area-layout.v1', defaultLayout: { v: 1, surface, items: [] },
      parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
    area.seed({ v: 1, surface, items: [] });
    const checkout: WorkspaceRefV1 = { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
    const { useProjectWidgetAreaBinding } = await import('./useProjectWidgetAreaBinding');
    const hook = await renderHook((activeCheckout: WorkspaceRefV1) => useProjectWidgetAreaBinding({ serverId: connection.home.id,
      projectName: 'Project', activeCheckout }), { initialProps: checkout });
    const read = hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await hook.rerender({ ...checkout });
    release!();
    await expect(read).resolves.toMatchObject({ ok: true, result: { surface } });
    await hook.unmount();
  } finally {
    release?.();
    restoreLoader();
    await connection.dispose();
    storage.setState(previous);
  }
});

it('binds the authorized portable Source reactively without losing a Source-free or revoked personal checkout layout', async () => {
  const previous = storage.getState();
  const fallback = createHomeHubArtifactHttpBoundary('viewer');
  const source = {
    id: 'source',
    revision: 7,
    name: 'Repository',
    audience: [
      { principal: { kind: 'account', accountId: 'viewer' }, level: 'view' },
    ],
    createdByAccountId: 'owner',
    repository: {
      provider: {
        id: 'github',
        kind: 'github',
        displayName: 'GitHub',
        baseUrl: 'https://github.com',
      },
      repository: { nameWithOwner: 'owner/repo' },
      protocol: 'https',
    },
  } satisfies ProjectSourceV1;
  let revoked = false;
  let holdSourceRead = false;
  let finishSourceRead: ((response: Response) => void) | undefined;
  const reads: URL[] = [];
  const readAuthority: (string | null)[] = [];
  let area:
    | ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>>
    | undefined;
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://project-widget-source.test',
    accountId: 'viewer',
    request: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/v1/projects/sources')) {
        reads.push(url);
        readAuthority.push(new Headers(init?.headers).get('Authorization'));
        if (holdSourceRead)
          return new Promise<Response>((resolve) => {
            finishSourceRead = resolve;
          });
        return Promise.resolve(
          new Response(
            JSON.stringify(
              revoked
                ? { ok: false, error: 'source_unavailable' }
                : { ok: true, source, canManage: false },
            ),
            { status: revoked ? 404 : 200 },
          ),
        );
      }
      return area?.request(input, init) ?? fallback.request(input, init);
    },
  });
  const restoreLoader = await installRealActionExecutorModuleLoader();
  try {
    const surface: WidgetSurfaceRefV1 = {
      serverId: connection.home.id,
      accountId: 'viewer',
      owner: { kind: 'project', projectId: 'anchor' },
    };
    area = createLayoutArtifactHttpBoundary('viewer', {
      artifactId: buildWidgetSurfaceArtifactIdV1(surface),
      kind: 'widget-area-layout.v1',
      defaultLayout: { v: 1, surface, items: [] },
      parseLayout: (value) => WidgetAreaLayoutV1Schema.parse(value),
      buildHeader: buildWidgetSurfaceArtifactHeaderV1,
    });
    area.seed({ v: 1, surface, items: [] });
    let checkout: WorkspaceRefV1 = {
      id: 'checkout',
      serverId: connection.home.id,
      machineId: 'machine',
      rootPath: '/repo',
      projectKey: 'anchor',
      createdAtMs: 1,
    };
    const { useProjectWidgetAreaBinding } =
      await import('./useProjectWidgetAreaBinding');
    const hook = await renderHook(() =>
      useProjectWidgetAreaBinding({
        serverId: connection.home.id,
        projectName: 'Project',
        activeCheckout: checkout,
      }),
    );
    const resolve = (slot: 'project' | 'checkout') =>
      resolveWidgetBindingsV1({
        instance: {
          v: 1,
          id: 'following',
          definition: { kind: 'builtin', id: 'project_about' },
          bindings: { target: { kind: 'context', slot } },
        },
        fields: [
          { path: 'target', title: 'Target', widget: 'text', required: true },
        ],
        context: widgetProvidedContext(hook.getCurrent().context),
        viewerValues: {},
        validateValue: () => ({ status: 'valid' }),
      });
    await flushHookEffects({ cycles: 4 });
    expect(reads).toEqual([]);
    expect(resolve('project').status).toBe('selection_required');
    expect(resolve('checkout')).toEqual({
      status: 'ready',
      input: { target: checkout },
    });
    const sourceFreeLayout = await hook
      .getCurrent()
      .port!.execute({ actionId: 'widgets.item.list' });
    expect(
      sourceFreeLayout,
      sourceFreeLayout.ok ? undefined : sourceFreeLayout.errorCode,
    ).toMatchObject({ ok: true, result: { surface, canEdit: true } });

    checkout = { ...checkout, source: { sourceId: source.id, revision: 1 } };
    await hook.rerender();
    await flushHookEffects({ cycles: 12 });
    expect(resolve('project')).toEqual({
      status: 'ready',
      input: {
        target: {
          serverId: connection.home.id,
          ...source,
          repository: {
            ...source.repository,
            provider: { ...source.repository.provider, id: 'happier.scm.forge.github/github' },
          },
        },
      },
    });
    expect(
      reads.every(
        (url) =>
          url.pathname === '/v1/projects/sources/source' &&
          url.searchParams.get('serverId') === connection.home.id,
      ),
    ).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    expect(
      readAuthority.every(
        (value) => value === `Bearer ${connection.credentials.token}`,
      ),
    ).toBe(true);

    // These are relevant, freshly admitted Source responses, not unrelated store arrivals.
    // Equal facts must preserve the real widget binding and its in-flight read authority.
    const stableBinding = hook.getCurrent();
    const sourceReadsBeforeRefresh = reads.length;
    for (let index = 0; index < 3; index += 1) {
      await act(async () => publishHomeAccountChange(connection.home.id, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]));
      await flushHookEffects({ cycles: 12 });
      expect(hook.getCurrent().port).toBe(stableBinding.port);
      expect(hook.getCurrent().context).toBe(stableBinding.context);
    }
    expect(reads.length - sourceReadsBeforeRefresh).toBe(3);

    revoked = true;
    holdSourceRead = true;
    await act(async () =>
      publishHomeAccountChange(connection.home.id, [
        PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
      ]),
    );
    await flushHookEffects({ cycles: 12 });
    expect(resolve('project').status).toBe('ready');
    expect(finishSourceRead).toBeDefined();
    holdSourceRead = false;
    await act(async () =>
      finishSourceRead!(
        Response.json(
          { ok: false, error: 'source_unavailable' },
          { status: 404 },
        ),
      ),
    );
    await flushHookEffects({ cycles: 12 });
    expect(resolve('project').status).toBe('selection_required');
    expect(resolve('checkout')).toEqual({
      status: 'ready',
      input: { target: checkout },
    });
    expect(
      await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' }),
    ).toMatchObject({ ok: true, result: { surface, canEdit: true } });
    expect(area.writes).toEqual([]);
    revoked = false;
    await act(async () =>
      publishHomeAccountChange(connection.home.id, [
        PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
      ]),
    );
    await flushHookEffects({ cycles: 12 });
    expect(resolve('project').status).toBe('ready');
    const capturedPort = hook.getCurrent().port!;
    await act(async () =>
      storage.setState({
        profileScope: {
          serverId: connection.home.id,
          accountId: 'another-viewer',
        },
      }),
    );
    expect(resolve('project').status).toBe('selection_required');
    expect(
      await capturedPort.execute({ actionId: 'widgets.item.list' }),
    ).toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
    await hook.unmount();
  } finally {
    // This scenario deliberately invalidates the Profile without switching the
    // fixture's transport. End that owned connection before restoring store bytes.
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    restoreLoader();
    await connection.dispose();
    storage.setState(previous);
  }
});

it.each(['owner', 'view'] as const)(
  'keeps README disclosure local and Code aside area-qualified for %s',
  async (access) => {
    await import('@/sync/syncEngine');
    const previous = storage.getState();
    let area:
      | ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>>
      | undefined;
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({
      serverUrl: `https://project-disclosure-${access}.test`,
      accountId: 'viewer',
      request: (input, init) => new URL(String(input)).pathname.startsWith('/v1/artifacts') && area
        ? area.request(input, init) : fallback.request(input, init),
    });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
      const surface: WidgetSurfaceRefV1 = {
        serverId: connection.home.id,
        accountId: 'viewer',
        owner: { kind: 'project', projectId: 'anchor', layoutId: 'reading' },
      };
      const saved: WidgetAreaLayoutV1 = {
        v: 1,
        surface,
        name: 'Reading',
        items: [
          {
            kind: 'widget',
            area: 'main',
            instance: {
              v: 1,
              id: 'readme',
              definition: { kind: 'builtin', id: 'project_readme' },
              bindings: {},
            },
          },
          {
            kind: 'widget',
            area: 'aside',
            instance: {
              v: 1,
              id: 'about',
              definition: { kind: 'builtin', id: 'project_about' },
              bindings: {},
            },
          },
        ],
      };
      area = createLayoutArtifactHttpBoundary('viewer', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface),
        kind: 'widget-area-layout.v1',
        defaultLayout: saved,
        parseLayout: (value) => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: buildWidgetSurfaceArtifactHeaderV1,
      });
      area.seed(saved);
      area.setCallerAccess(access);
      const { useProjectWidgetAreaBinding, ProjectWidgetArea } =
        await import('./ProjectWidgetArea');
      const { ProjectOverviewDocument } =
        await import('@/components/projects/detail/ProjectOverviewWidgets');
      const { WidgetFrame } =
        await import('@/components/widgets/frame/WidgetFrame');
      const { AppShellPluginUiProjectionValueProvider } =
        await import('@/components/appShell/plugins/AppShellPluginUiProjection');
      const hook = await renderHook(() =>
        useProjectWidgetAreaBinding({
          serverId: connection.home.id,
          projectName: 'Project',
          layoutId: 'reading',
          activeCheckout: {
            id: 'checkout',
            serverId: connection.home.id,
            machineId: 'machine',
            rootPath: '/repo',
            projectKey: 'anchor',
            createdAtMs: 1,
          },
        }),
      );
      const binding = hook.getCurrent();
      const port = binding.port!;
      const { CurrentUiContextProvider } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
      const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
      const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
      const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
      const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
      const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
      const { CurrentUiContextSnapshotV1Schema } = await import('@happier-dev/protocol/plugins/ui');
      const executor = createDefaultActionExecutor();
      const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
      const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
      const tabNavigation = { push: () => {}, replace: () => {}, back: () => {} };
      // The Project page lives in a retained workspace tab, hidden and shown the way the shell does it.
      const wrap = (content: React.ReactNode, shown = true) => (
        <AppShellPluginUiProjectionValueProvider
          value={{
            pluginUiProjection: null,
            pluginBrowserProjection: null,
            phase: 'current',
            interactionEnabled: true,
            machineId: null,
            serverId: null,
            platform: 'web',
            accountLifetime: captureActiveServerAccountScopeLifetime(),
            clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
            reloadConnectedAccountProjection: () => {},
          }}
        >
          <InjectedAuthProvider credentials={connection.credentials}><MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
            <CurrentUiContextActionHost />
            <RetainedPanelSurface isActive={shown}>
              <DestinationInstanceHost tabId="project-tab" ref={{ kind: 'project', params: {} }} pathname="/projects/project"
                focused={shown} visible={shown} navigation={tabNavigation}>{content}</DestinationInstanceHost>
            </RetainedPanelSurface>
          </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider></InjectedAuthProvider>
        </AppShellPluginUiProjectionValueProvider>
      );
      // DOM geometry is the boundary: README sits inside the near-viewport window, so only its disclosure decides.
      const contentNode = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) };
      const screen = await renderScreen(
        wrap(
          <ProjectOverviewDocument
            port={port}
            context={binding.context}
            projectName="Project"
          />,
        ),
        { createNodeMock: (element) => element.type === 'ScrollView' ? { getInnerViewNode: () => contentNode }
          : element.props.testID === 'project-overview-main.widget.readme'
            ? { getBoundingClientRect: () => ({ left: 0, top: 100, width: 600, height: 220 }) } : null },
      );
      await flushHookEffects({ cycles: 4 });
      await vi.waitFor(() => expect(screen.findHostByTestId('project-overview-main.widget.readme')).not.toBeNull());
      await act(async () => { screen.findHostByTestId('project-overview-main.widget.readme')!.props.onLayout(); });
      await flushHookEffects({ cycles: 2 });
      const frame = () =>
        screen
          .findAllByType(WidgetFrame)
          .find((node) => node.props.testID.endsWith('.widget.readme.frame'))!;
      await vi.waitFor(() => expect(frame(), JSON.stringify({ text: screen.getTextContent(),
        frames: screen.findAllByType(WidgetFrame).map(node => node.props.testID),
        scope: storage.getState().settingsScope,
      })).toBeDefined());
      expect(frame().props.disclosure.collapsed).toBe(true);
      // Collapsed at rest, README builds no body and holds no read (demand follows what is shown).
      const readmeBody = () => screen.findAllHostsByTestId('project-overview-main.widget.readme.bodyHeight');
      expect(readmeBody()).toHaveLength(0);
      const readCommands = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
      expect(readCommands.ok).toBe(true);
      if (!readCommands.ok) throw new Error('Mounted commands unavailable');
      const { t } = await import('@/text');
      const expand = CurrentUiContextSnapshotV1Schema.parse(readCommands.result).commands
        .find(command => command.title === `${t('projects.widgets.expand')}: ${frame().props.title}`);
      expect(expand).toBeDefined();
      await act(async () => {
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: expand!.id }, { surface: 'agent' }))
          .toMatchObject({ ok: true });
      });
      expect(await executor.execute('ui.current_context.command.invoke', { commandId: expand!.id }, { surface: 'agent' }))
        .toMatchObject({ ok: false });
      expect(frame().props.disclosure.collapsed).toBe(false);
      // The first expand builds it; collapsing again keeps that content (no live demand) for the next expand.
      await flushHookEffects({ cycles: 2 });
      expect(readmeBody()).toHaveLength(1);
      const shown = readmeBody()[0];
      const presentation = () => screen.findAllByType(PluginSurfaceFocusEligibilityProvider)
        .filter(node => node.findAll(child => child.props?.testID === 'project-overview-main.widget.readme.bodyHeight').length > 0)
        .map(node => node.props.presentationActive)
        // The widget's own provider is the innermost one around its body (the tab's providers enclose it).
        .slice(-1);
      expect(presentation()).toEqual([true]);
      await act(async () => { frame().props.disclosure.onCollapsedChange(true); });
      expect(frame().props.disclosure.collapsed).toBe(true);
      expect(readmeBody()).toEqual([shown]);
      expect(presentation()).toEqual([false]);
      await act(async () => { frame().props.disclosure.onCollapsedChange(false); });
      expect(readmeBody()).toEqual([shown]);
      expect(presentation()).toEqual([true]);
      // Hiding the tab keeps that body and its ⋯ (their demand withdraws with presentation), so showing
      // the tab again rebuilds neither.
      const readmeMenu = () => screen.findAllHostsByTestId('project-overview-main.widget.readme.menu');
      const shownMenu = readmeMenu();
      expect(shownMenu).toHaveLength(1);
      const overview = (tabShown: boolean) => wrap(<ProjectOverviewDocument port={port} context={binding.context} projectName="Project" />, tabShown);
      for (let cycle = 0; cycle < 2; cycle++) {
        await screen.update(overview(false));
        expect({ body: readmeBody(), menu: readmeMenu() }).toEqual({ body: [shown], menu: shownMenu });
        await screen.update(overview(true));
        expect({ body: readmeBody(), menu: readmeMenu() }).toEqual({ body: [shown], menu: shownMenu });
      }
      await act(async () =>
        screen.findByTestId('project-overview')!.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 800 } },
        }),
      );
      expect(frame().props.disclosure.collapsed).toBe(false);
      // Stacked (aside first), an area's Add line never sits between the two areas as a gap in the
      // dashboard (F4 D-23): both Adds follow the last widget, each naming its area.
      const hostOrder = () =>
        screen.root
          .findAll(
            (node) =>
              typeof node.type === 'string' &&
              typeof node.props.testID === 'string',
          )
          .map((node) => node.props.testID as string);
      const order = hostOrder();
      expect(order).toContain('project-overview-main.widget.readme');
      expect(
        order.slice(0, order.indexOf('project-overview-main.widget.readme')),
      ).not.toContain('project-overview-aside.add');
      await act(async () =>
        screen.findByTestId('project-overview')!.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 800 } },
        }),
      );
      expect(frame().props.disclosure.collapsed).toBe(false);
      windowSize.width = 390;
      await screen.update(
        wrap(
          <ProjectOverviewDocument
            port={port}
            context={binding.context}
            projectName="Project"
          />,
        ),
      );
      expect(frame().props.disclosure.collapsed).toBe(false);
      windowSize.width = 1024;
      await screen.update(
        wrap(
          <ProjectOverviewDocument
            port={port}
            context={binding.context}
            projectName="Project"
          />,
        ),
      );
      expect(frame().props.disclosure.collapsed).toBe(false);
      await act(async () => frame().props.disclosure.onCollapsedChange(true));
      // Only README carries its caret at rest (lab p-overview): another expanded widget collapses from
      // its ⋯ ("Collapse widget"), and only then shows the caret that brings it back. A viewer's ⋯ holds
      // About and Mention, no collapse, so they keep the caret and collapse stays theirs either way.
      const about = () =>
        screen
          .findAllByType(WidgetFrame)
          .find((node) => node.props.testID.endsWith('.widget.about.frame'))!;
      const { ItemRowActions } =
        await import('@/components/ui/lists/ItemRowActions');
      const aboutMenu = () =>
        screen
          .findAllByType(ItemRowActions)
          .find((node) =>
            node.props.overflowTriggerTestID?.includes('.widget.about.'),
          );
      if (access === 'owner') {
        expect(about().props.disclosure).toBeUndefined();
        const collapse = aboutMenu()!.props.actions.find(
          (action: { id: string }) => action.id === 'collapse',
        );
        expect(collapse).toBeDefined();
        await act(async () => collapse.onPress());
        expect(about().props.disclosure.collapsed).toBe(true);
        expect(
          aboutMenu()!.props.actions.find(
            (action: { id: string }) => action.id === 'expand',
          ),
        ).toBeDefined();
        await act(async () =>
          about().props.disclosure.onCollapsedChange(false),
        );
        expect(about().props.disclosure).toBeUndefined();
      } else {
        // Plan 12: authorized About stays reachable for a viewer. Their ⋯ offers it (and Mention) but no
        // edit entry, and the caret keeps collapse theirs.
        const viewerActionIds = aboutMenu()!.props.actions.map((action: { id: string }) => action.id);
        expect(viewerActionIds).toContain('about');
        expect(viewerActionIds).not.toContain('rename');
        expect(viewerActionIds).not.toContain('editInputs');
        expect(about().props.disclosure.collapsed).toBe(false);
      }
      expect(area.layout()).toEqual(saved);
      expect(area.writes).toEqual([]);
      await screen.update(
        wrap(
          <ProjectWidgetArea
            port={port}
            context={binding.context}
            projectName="Project"
            area="aside"
            testID="code-aside"
          />,
        ),
      );
      await flushHookEffects({ cycles: 4 });
      expect(screen.findByTestId('code-aside.widget.about')).not.toBeNull();
      expect(screen.findByTestId('code-aside.widget.readme')).toBeNull();
      expect(area.writes).toEqual([]);
      await hook.unmount();
    } finally {
      restoreLoader();
      await connection.dispose();
      storage.setState(previous);
    }
  },
);

it.each(['stacked', 'phone'] as const)(
  'shares Project Organize with rendered grips and keyboard staging in %s composition',
  async (composition) => {
    const previous = storage.getState();
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    let area:
      | ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>>
      | undefined;
    const connection = await restoreServerAccountForTest({
      serverUrl: `https://project-organize-${composition}.test`,
      accountId: 'viewer',
      request: (input, init) =>
        area?.request(input, init) ?? fallback.request(input, init),
    });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
      const surface: WidgetSurfaceRefV1 = {
        serverId: connection.home.id,
        accountId: 'viewer',
        owner: { kind: 'project', projectId: 'anchor' },
      };
      const saved: WidgetAreaLayoutV1 = {
        v: 1,
        surface,
        items: (['main', 'aside'] as const).map((column) => ({
          kind: 'group',
          id: `${column}-group`,
          area: column,
          width: 'full',
          frameStyle: 'card',
          dividers: 'hairline',
          children: [
            {
              kind: 'widget',
              instance: {
                v: 1,
                id: `${column}-about`,
                definition: { kind: 'builtin', id: 'project_about' },
                bindings: {},
              },
            },
          ],
        })),
      };
      area = createLayoutArtifactHttpBoundary('viewer', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface),
        kind: 'widget-area-layout.v1',
        defaultLayout: saved,
        parseLayout: (value) => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: buildWidgetSurfaceArtifactHeaderV1,
      });
      area.seed(saved);
      // Adding a checkout-bound widget admits the checkout against the Account's Project rows.
      const activeCheckout = {
        id: 'checkout',
        serverId: connection.home.id,
        machineId: 'machine',
        rootPath: '/repo',
        projectKey: 'anchor',
        createdAtMs: 1,
      };
      area.setWorkspaceRefs([activeCheckout]);
      const { useProjectWidgetAreaBinding } =
        await import('./ProjectWidgetArea');
      const { ProjectOverviewDocument } =
        await import('@/components/projects/detail/ProjectOverviewWidgets');
      const { AppShellPluginUiProjectionValueProvider } =
        await import('@/components/appShell/plugins/AppShellPluginUiProjection');
      const { EntityDragGripTrigger } =
        await import('@/components/ui/treeDragDrop/ui/EntityReleasePreview');
      const hook = await renderHook(() =>
        useProjectWidgetAreaBinding({
          serverId: connection.home.id,
          projectName: 'Project',
          activeCheckout,
        }),
      );
      if (composition === 'phone') windowSize.width = 390;
      const binding = hook.getCurrent();
      const screen = await renderScreen(
        <AppShellPluginUiProjectionValueProvider
          value={{
            pluginUiProjection: null,
            pluginBrowserProjection: null,
            phase: 'current',
            interactionEnabled: true,
            machineId: null,
            serverId: null,
            platform: 'web',
            accountLifetime: captureActiveServerAccountScopeLifetime(),
            clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
            reloadConnectedAccountProjection: () => {},
          }}
        >
          <ProjectOverviewDocument
            port={binding.port!}
            context={binding.context}
            projectName="Project"
          />
        </AppShellPluginUiProjectionValueProvider>,
        {
          // The real Popover stays inert until its browser anchor can be measured.
          // Supply DOM geometry at the renderer boundary, as a mounted Add control does.
          createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 40, top: 80, width: 560, height: 40 }) }),
        },
      );
      await flushHookEffects({ cycles: 4 });
      if (composition === 'stacked')
        await act(async () =>
          screen.findByTestId('project-overview')!.props.onLayout({
            // Under two aside widths (584): one column, the side area first.
            nativeEvent: { layout: { x: 0, y: 0, width: 560, height: 800 } },
          }),
        );
      expect(screen.findAllByType(EntityDragGripTrigger)).toHaveLength(0);
      await act(async () =>
        screen.findByTestId('project-overview-main.organize')!.props.onPress(),
      );
      const mainPrefix =
        composition === 'phone'
          ? 'project-overview-merged'
          : 'project-overview-main';
      const asidePrefix =
        composition === 'phone'
          ? 'project-overview-merged'
          : 'project-overview-aside';
      const grip = () =>
        screen
          .findAllByType(EntityDragGripTrigger)
          .find(
            (node) =>
              node.props.testID === `${mainPrefix}.group.main-group.move`,
          )!;
      expect(grip()).toBeDefined();
      expect(
        screen
          .findAllByType(EntityDragGripTrigger)
          .find(
            (node) =>
              node.props.testID === `${asidePrefix}.group.aside-group.move`,
          ),
      ).toBeDefined();
      const key = (value: string) => ({
        key: value,
        preventDefault() {},
        stopPropagation() {},
      });
      await act(async () => grip().props.onKeyDown(key(' ')));
      expect(grip().props.active).toBe(true);
      await act(async () => grip().props.onKeyDown(key('Escape')));
      expect(grip().props.active).toBe(false);
      // One column ends with one quiet "Add widget" (lab HOMEp), never a stacked Add per area; its
      // Organize serves both areas, which share one organizing state.
      const { EmptySlot } = await import('@/components/ui/empty/EmptySlot');
      const adds = screen.findAllByType(EmptySlot).filter((node) => String(node.props.testID ?? '').endsWith('.add'));
      expect(adds.map((node) => node.props.label)).toEqual(['projects.widgets.add']);
      expect(screen.findByTestId('project-overview-aside.organize')).toBeNull();
      await act(async () =>
        screen.findByTestId('project-overview-main.organize')!.props.onPress(),
      );
      expect(screen.findAllByType(EntityDragGripTrigger)).toHaveLength(0);
      expect(area.layout()).toEqual(saved);
      expect(area.writes).toEqual([]);
      // The one Add still reaches either area directly (plan 12 §§2,5): its gallery says where the
      // widget goes and lets the side area be chosen before adding. The phone gallery is a DOM sheet
      // (a dismissable layer on the document) this renderer cannot host; it is the same Add surface.
      if (composition === 'phone') { await hook.unmount(); return; }
      // The gallery is a web popover here; give it the browser window it listens to.
      vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, {
        addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1024, innerHeight: 768,
        setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      }));
      await screen.pressByTestIdAsync('project-overview-main.add');
      await flushHookEffects({ cycles: 3 });
      const { WidgetAddPanel, WIDGET_ADD_SURFACE_PX } = await import('@/components/widgets/add/WidgetAddSurface');
      let content = screen.root.findByType(WidgetAddPanel).parent;
      while (content && typeof content.props.onLayout !== 'function') content = content.parent;
      expect(content).not.toBeNull();
      // A browser emits the portal content's layout before it becomes visible.
      // react-test-renderer emits no layout events, so report that host fact explicitly.
      await act(async () => content!.props.onLayout({ nativeEvent: { layout: {
        x: 0, y: 0, width: WIDGET_ADD_SURFACE_PX.width, height: WIDGET_ADD_SURFACE_PX.height,
      } } }));
      await screen.pressByTestIdAsync('project-overview-main.addPopover.area:aside');
      const readmeEntry = screen.root.findAll((node) => typeof node.props.testID === 'string'
        && /addPopover\.entry\.[^.]*project_readme$/.test(node.props.testID) && typeof node.props.onPress === 'function')[0];
      expect(readmeEntry).toBeDefined();
      await screen.pressByTestIdAsync(readmeEntry!.props.testID);
      await flushHookEffects({ cycles: 4 });
      const { WidgetSetupStep } = await import('@/components/widgets/add/WidgetSetupStep');
      const step = screen.root.findAllByType(WidgetSetupStep)[0];
      if (step) await screen.pressByTestIdAsync(`${step.props.testID}.submit`);
      // The button starts an asynchronous Action; wait for its acknowledged
      // Artifact write rather than a fixed number of React microtasks.
      const layoutArtifact = area;
      await vi.waitFor(() => {
        const asideItems = (layoutArtifact.layout() as WidgetAreaLayoutV1).items.filter((item) => item.area === 'aside');
        expect(JSON.stringify(asideItems), screen.getTextContent()).toContain('project_readme');
      });
      vi.unstubAllGlobals();
      await hook.unmount();
    } finally {
      restoreLoader();
      await connection.dispose();
      storage.setState(previous);
    }
  },
);

it('binds a Source-free personal Project dashboard through the real Action and Artifact path and retires its captured port', async () => {
  await import('@/sync/syncEngine');
  const previous = storage.getState();
  const fallback = createHomeHubArtifactHttpBoundary('viewer');
  let area:
    | ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>>
    | undefined;
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://project-widget-binding.test',
    accountId: 'viewer',
    request: (input, init) =>
      area?.request(input, init) ?? fallback.request(input, init),
  });
  const restoreLoader = await installRealActionExecutorModuleLoader();
  try {
    const surface = WidgetSurfaceRefV1Schema.parse({
      serverId: connection.home.id,
      accountId: 'viewer',
      owner: { kind: 'project', projectId: 'anchor', layoutId: 'overview' },
    });
    const instance = {
      v: 1 as const,
      id: 'summary',
      definition: { kind: 'builtin' as const, id: 'session_summary' },
      bindings: {},
    };
    area = createLayoutArtifactHttpBoundary('viewer', {
      artifactId: buildWidgetSurfaceArtifactIdV1(surface),
      kind: 'widget-area-layout.v1',
      defaultLayout: { v: 1, surface, items: [{ kind: 'widget', instance }] },
      parseLayout: (value) => WidgetAreaLayoutV1Schema.parse(value),
      buildHeader: buildWidgetSurfaceArtifactHeaderV1,
    });
    area.seed({ v: 1, surface, items: [{ kind: 'widget', instance }] });
    const checkout = {
      id: 'checkout',
      serverId: connection.home.id,
      machineId: 'machine',
      rootPath: '/repo/feature',
      createdAtMs: 1,
      projectKey: 'anchor',
    };
    let activeCheckout: typeof checkout | undefined = checkout;
    const { useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
    const hook = await renderHook(() =>
      useProjectWidgetAreaBinding({
        serverId: connection.home.id,
        projectName: 'Project',
        projectRef: checkout,
        activeCheckout,
        layoutId: 'overview',
      }),
    );
    const port = hook.getCurrent().port;
    expect(port).not.toBeNull();
    expect(hook.getCurrent().context.slots?.project?.value).toBeNull();
    expect(
      hook.getCurrent().context.slots?.checkout?.value?.value,
    ).toMatchObject({ id: 'checkout', rootPath: '/repo/feature' });
    expect(
      await port!.execute({ actionId: 'widgets.item.list' }),
    ).toMatchObject({ ok: true, result: { surface, canEdit: true } });
    expect(
      await port!.movement!.readAdmission(
        { surface, instanceId: 'summary' },
        surface,
      ),
    ).toMatchObject({ status: 'ready', destination: surface });
    expect(
      await port!.execute({
        actionId: 'widgets.item.rename',
        instanceId: 'summary',
        displayName: 'My Project',
      }),
    ).toMatchObject({ ok: true });
    expect(
      flattenWidgetLayoutWidgetsV1(area.layout().items)[0]?.instance
        .displayName,
    ).toBe('My Project');
    activeCheckout = undefined;
    await hook.rerender();
    expect(hook.getCurrent().context.slots?.checkout?.value).toBeNull();
    expect(
      await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' }),
    ).toMatchObject({ ok: true, result: { surface, canEdit: true } });
    const writes = area.writes.length;
    await act(async () =>
      storage.setState({
        profileScope: {
          serverId: connection.home.id,
          accountId: 'another-viewer',
        },
      }),
    );
    expect(
      await port!.execute({
        actionId: 'widgets.item.rename',
        instanceId: 'summary',
        displayName: 'Wrong viewer',
      }),
    ).toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
    expect(area.writes).toHaveLength(writes);
    await hook.unmount();
  } finally {
    // A synthetic Profile withdrawal retires the captured content lifetime but
    // leaves this test's same Home transport alive; close it explicitly.
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    restoreLoader();
    await connection.dispose();
    storage.setState(previous);
  }
});

it('keeps an attached shared Project dashboard owner distinct from its viewer under the Account UI move waiver and refuses a different Home', async () => {
  const { sync } = await import('@/sync/syncEngine');
  const previous = storage.getState();
  const fallback = createHomeHubArtifactHttpBoundary('viewer');
  let area:
    | ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>>
    | undefined;
  let sourceRevoked = false;
  let attachedArtifactId = '';
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://project-widget-shared.test',
    accountId: 'viewer',
    request: async (input, init) => {
      if (
        new URL(String(input)).pathname === '/v1/projects/sources/team-source'
      )
        return sourceRevoked
          ? Response.json(
              { ok: false, error: 'source_unavailable' },
              { status: 404 },
            )
          : Response.json({
              ok: true,
              canManage: false,
              source: {
                id: 'team-source',
                revision: 1,
                name: 'Team repository',
                createdByAccountId: 'owner',
                audience: [
                  {
                    principal: { kind: 'account', accountId: 'viewer' },
                    level: 'view',
                  },
                ],
                repository: {
                  provider: {
                    id: 'github',
                    kind: 'github',
                    displayName: 'GitHub',
                    baseUrl: 'https://github.com',
                  },
                  repository: { nameWithOwner: 'owner/repo' },
                  protocol: 'https',
                },
                attachments: [
                  {
                    purpose: 'dashboard',
                    ref: { kind: 'doc', artifactId: attachedArtifactId },
                  },
                ],
              },
            });
      if (new URL(String(input)).pathname === '/v2/account/settings')
        return Response.json({
          content: {
            t: 'plain',
            v: {
              actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1,
                approvalWaivedSurfaces: { 'widgets.item.move': ['ui'] },
              }),
            },
          },
          version: 2,
        });
      return new URL(String(input)).pathname.startsWith('/v1/artifacts') && area
        ? area.request(input, init) : fallback.request(input, init);
    },
  });
  const restoreLoader = await installRealActionExecutorModuleLoader();
  try {
    // The routing scenario's immediate move is admitted by persisted Account policy, never an executor bypass.
    expect(storage.getState().settingsScope, JSON.stringify({ profile: storage.getState().profileScope,
      settings: storage.getState().settingsScope, home: connection.home.id })).toEqual({ serverId: connection.home.id, accountId: 'viewer' });
    await sync.refreshAccountSettingsFromServer(2, {
      serverId: connection.home.id,
      accountId: 'viewer',
    });
    expect(storage.getState().settings.actionsSettingsV1).toMatchObject({
      approvalWaivedSurfaces: { 'widgets.item.move': ['ui'] },
    });
    const storedSurface: WidgetSurfaceRefV1 = {
      serverId: connection.home.id,
      accountId: 'owner',
      owner: {
        kind: 'project',
        projectId: 'owners-private-project',
        layoutId: 'shared',
      },
    };
    const artifactId = buildWidgetSurfaceArtifactIdV1(storedSurface);
    attachedArtifactId = artifactId;
    const instance = {
      v: 1 as const,
      id: 'shared-summary',
      definition: { kind: 'builtin' as const, id: 'project_about' },
      displayName: 'Owner dashboard About',
      bindings: { checkout: { kind: 'context' as const, slot: 'checkout' } },
    };
    area = createLayoutArtifactHttpBoundary('owner', {
      artifactId,
      kind: 'widget-area-layout.v1',
      defaultLayout: {
        v: 1,
        surface: storedSurface,
        items: [{ kind: 'widget', instance, area: 'main' }],
      },
      parseLayout: (value) => WidgetAreaLayoutV1Schema.parse(value),
      buildHeader: buildWidgetSurfaceArtifactHeaderV1,
    });
    area.seed({
      v: 1,
      surface: storedSurface,
      name: 'Owner release dashboard',
      items: [{ kind: 'widget', instance, area: 'main' }],
    });
    area.setCallerAccess('view');
    const { useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
    let serverId = connection.home.id;
    const checkout = {
      id: 'checkout',
      serverId,
      machineId: 'machine',
      rootPath: '/repo',
      createdAtMs: 1,
      projectKey: 'anchor',
      source: { sourceId: 'team-source', revision: 1 },
    };
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
    const selectedLayouts: (string | null)[] = [];
    const hook = await renderHook(() =>
      useProjectWidgetAreaBinding({
        serverId,
        projectName: 'Project',
        activeCheckout: checkout,
        attachedDashboard: { sourceId: 'team-source', artifactId },
        onSelectLayout: layoutId => { selectedLayouts.push(layoutId); },
      }),
    );
    await vi.waitFor(() => expect(hook.getCurrent().port).not.toBeNull());
    // The read publishes its Artifact into the real store. Commit that publication
    // and the mounted owner's effects before reverse-dispatching the next Action.
    await act(async () => {
      expect(
        await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' }),
      ).toMatchObject({
        ok: true,
        result: {
          surface: { ...storedSurface, artifactId },
          canEdit: false,
          isShared: true,
        },
      });
    });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const sharedRef = { surface: { ...storedSurface, artifactId }, instanceId: instance.id };
    // Publication retires the previous captured document until its fresh read
    // admits the displayed owner again, as it does before a mounted interaction.
    await vi.waitFor(() => expect(hook.getCurrent().port).not.toBeNull());
    // Reverse dispatch carries the displayed owner's address, not the recipient's Project address.
    await act(async () => {
      expect(await createDefaultActionExecutor().execute('widgets.item.refresh', { ref: sharedRef }, {
        surface: 'ui', serverId: connection.home.id, expectedAccountId: 'viewer',
      })).toMatchObject({ ok: false, errorCode: 'widget_refresh_unavailable' });
    });
    expect(await createDefaultActionExecutor().execute('widgets.item.refresh', {
      ref: { ...sharedRef, surface: { ...sharedRef.surface, artifactId: 'another-dashboard' } },
    }, { surface: 'ui', serverId: connection.home.id, expectedAccountId: 'viewer' }))
      .toMatchObject({ ok: false, errorCode: 'widget_area_owner_mismatch' });
    await vi.waitFor(() => expect(hook.getCurrent().port).not.toBeNull());
    await act(async () => {
      expect(await createDefaultActionExecutor().execute('widgets.area.layout.select', { surface: sharedRef.surface }, {
        surface: 'ui', serverId: connection.home.id, expectedAccountId: 'viewer',
      })).toMatchObject({ ok: true });
    });
    expect(selectedLayouts).toEqual([]);
    const { ProjectOverviewWidgets } =
      await import('@/components/projects/detail/ProjectOverviewWidgets');
    const { ProjectBuiltinWidgetBody } =
      await import('@/components/projects/widgets/ProjectBuiltinWidgetBody');
    const { ConfiguredWidgetRefusal, UnavailableInstalledWidget } =
      await import('@/components/widgets/InstalledWidgetSurface');
    const { AppShellPluginUiProjectionValueProvider } =
      await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const wrap = (content: React.ReactNode) => (
      <AppShellPluginUiProjectionValueProvider
        value={{
          pluginUiProjection: null,
          pluginBrowserProjection: null,
          phase: 'current',
          interactionEnabled: true,
          machineId: null,
          serverId: null,
          platform: 'web',
          accountLifetime: captureActiveServerAccountScopeLifetime(),
          clientExecutableActivation: { status: 'ready' },
          reloadClientExecutables: () => {},
          reloadConnectedAccountProjection: () => {},
        }}
      >
        {content}
      </AppShellPluginUiProjectionValueProvider>
    );
    const contentNode = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 1000,
        height: 800,
      }),
    };
    const screen = await renderScreen(
      wrap(
        <ProjectOverviewWidgets
          workspaceRef={checkout}
          activeRootPath={checkout.rootPath}
          attachedDashboard={{ sourceId: 'team-source', artifactId }}
          onSelectDashboard={() => {}}
        />,
      ),
      {
        createNodeMock: (element) => {
          // DOM geometry is the boundary; the real near-viewport policy must admit this visible body.
          if (element.type === 'ScrollView')
            return { getInnerViewNode: () => contentNode };
          const id = element.props.testID;
          if (
            id === 'project-overview-main.widget.shared-summary' ||
            id === 'project-overview-aside.widget.shared-summary'
          ) {
            return {
              getBoundingClientRect: () => ({
                left: 0,
                top: 100,
                width: 600,
                height: 220,
              }),
            };
          }
          return null;
        },
      },
    );
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-overview-main.widget.shared-summary'),
        screen.getTextContent(),
      ).not.toBeNull(),
    );
    // The host renderer supplies geometry but does not dispatch the browser's layout event.
    await act(async () => {
      screen.findHostByTestId('project-overview-main.widget.shared-summary')!.props.onLayout();
    });
    await vi.waitFor(() => {
      const bodyId = 'project-overview-main.widget.shared-summary.body';
      const native = screen
        .findAllByType(ProjectBuiltinWidgetBody)
        .find((node) => node.props.testID === bodyId);
      const refusal = screen
        .findAllByType(ConfiguredWidgetRefusal)
        .find((node) => node.props.testID === bodyId);
      const unavailable = screen
        .findAllByType(UnavailableInstalledWidget)
        .find((node) => node.props.testID === bodyId);
      expect({
        builtin: native?.props.id ?? null,
        deferred:
          screen.findHostByTestId(
            'project-overview-main.widget.shared-summary.deferred',
          ) !== null,
        refusal:
          refusal?.props.resolution ?? unavailable?.props.unresolved ?? null,
      }).toEqual({ builtin: 'project_about', deferred: false, refusal: null });
    });
    await vi.waitFor(() =>
      expect(
        screen.findByTestId(
          'project-overview-main.widget.shared-summary.body.repository',
        ),
      ).not.toBeNull(),
    );
    expect(screen.findByTestId('project-overview-main.widget.code')).toBeNull();
    const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
    const { WidgetAboutPanel } = await import('@/components/widgets/definitions/WidgetAboutPanel');
    const menu = screen.findAllByType(ItemRowActions).find(node =>
      node.props.overflowTriggerTestID === 'project-overview-main.widget.shared-summary.menuTrigger');
    const about = menu?.props.actions.find((entry: { id: string }) => entry.id === 'about');
    expect(about?.onPress).toBeTypeOf('function');
    await act(async () => { about.onPress(); });
    const panels = screen.findAllByType(WidgetAboutPanel);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.props.descriptor.definition).toEqual({ kind: 'builtin', id: 'project_about' });
    expect(panels[0]!.props.inputs.onEdit).toBeUndefined();
    expect(screen.findByTestId('project-overview-main.widget.shared-summary.about.refreshNow')).toBeNull();
    await act(async () => { panels[0]!.props.onClose(); });
    expect(area.writes).toEqual([]);
    const { captureLazyActionAccountContext } =
      await import('@/sync/ops/actions/actionAccountContext');
    const priorPublicationPort = hook.getCurrent().port!;
    area.setCallerAccess(null);
    await act(async () => {
      storage.getState().deleteArtifact(artifactId);
    });
    await vi.waitFor(() => expect(hook.getCurrent().port).toBeNull());
    expect(hook.getCurrent().sharedDashboard).toBeUndefined();
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-overview-main.widget.shared-summary'),
      ).toBeNull(),
    );
    expect(
      await priorPublicationPort.execute({
        actionId: 'widgets.item.rename',
        instanceId: instance.id,
        displayName: 'Revoked Artifact',
      }),
    ).toMatchObject({ ok: false });
    expect(area.writes).toEqual([]);
    area.setCallerAccess('edit');
    const refreshAccount = await captureLazyActionAccountContext(
      connection.home.id,
    );
    try {
      await act(async () => {
        await refreshAccount.fetchArtifact(artifactId);
      });
    } finally {
      refreshAccount.dispose();
    }
    await vi.waitFor(() => expect(hook.getCurrent().port).not.toBeNull());
    const attachedSurface = { ...storedSurface, artifactId };
    expect(
      await hook
        .getCurrent()
        .port!.movement!.readAdmission(
          { surface: attachedSurface, instanceId: instance.id },
          attachedSurface,
        ),
    ).toMatchObject({
      status: 'ready',
      instance,
      destination: attachedSurface,
    });
    const moved = await hook
      .getCurrent()
      .port!.movement!.execute(
        {
          actionId: 'widgets.item.move',
          input: {
            ref: { surface: attachedSurface, instanceId: instance.id },
            to: { surface: attachedSurface, area: 'aside', index: 0 },
          },
          preview: { verb: 'Move', target: 'Aside' },
        },
        { serverId: connection.home.id, accountId: 'owner' },
      );
    expect(moved).toMatchObject({ status: 'applied' });
    expect(
      flattenWidgetLayoutWidgetsV1(area.layout().items).find(
        (entry) => entry.instance.id === instance.id,
      )?.area,
    ).toBe('aside');
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-overview-aside.widget.shared-summary'),
      ).not.toBeNull(),
    );
    const capturedSharedPort = hook.getCurrent().port!;
    const sharedWrites = area.writes.length;
    sourceRevoked = true;
    publishHomeAccountChange(connection.home.id, [
      PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
    ]);
    await vi.waitFor(() => expect(hook.getCurrent().port).toBeNull());
    expect(hook.getCurrent().unavailableReasonCode).toBe(
      'widget_project_source_unavailable',
    );
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-overview-main.widget.shared-summary'),
      ).toBeNull(),
    );
    expect(
      screen.findByTestId('project-overview-aside.widget.shared-summary'),
    ).toBeNull();
    expect(
      await capturedSharedPort.execute({
        actionId: 'widgets.item.rename',
        instanceId: instance.id,
        displayName: 'Retired Source',
      }),
    ).toMatchObject({ ok: false });
    expect(area.writes).toHaveLength(sharedWrites);
    serverId = 'other-home';
    await hook.rerender();
    expect(hook.getCurrent().port).toBeNull();
    expect(hook.getCurrent().unavailableReasonCode).toBe(
      'widget_area_scope_unavailable',
    );
    await hook.unmount();
  } finally {
    restoreLoader();
    await connection.dispose();
    storage.setState(previous);
  }
});

it('keeps a group child widget item props when the area re-renders without a layout change', async () => {
  const fallback = createHomeHubArtifactHttpBoundary('viewer');
  let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://project-group-child-identity.test', accountId: 'viewer',
    request: (input, init) => new URL(String(input)).pathname.startsWith('/v1/artifacts') && area
      ? area.request(input, init) : fallback.request(input, init),
  });
  const restoreLoader = await installRealActionExecutorModuleLoader();
  try {
    const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'viewer',
      owner: { kind: 'project', projectId: 'identity-project' } };
    const instance = (id: string) => ({ v: 1 as const, id,
      definition: { kind: 'artifact' as const, artifactId: `missing-${id}` }, bindings: {} });
    const saved = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [
      { kind: 'group', id: 'group', width: 'full', area: 'main', children: [
        { kind: 'widget', instance: instance('first-child') },
        { kind: 'widget', instance: instance('second-child') },
      ] },
    ] });
    area = createLayoutArtifactHttpBoundary('viewer', {
      artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: 'widget-area-layout.v1',
      defaultLayout: saved, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
      buildHeader: buildWidgetSurfaceArtifactHeaderV1,
    });
    area.seed(saved);
    const { ProjectWidgetArea, useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    // A new projection value object re-renders the area's placements without changing its layout.
    const projectionValue = () => ({
      pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current' as const, interactionEnabled: true,
      machineId: null, serverId: connection.home.id, platform: 'web' as const,
      accountLifetime, clientExecutableActivation: { status: 'ready' as const },
      reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
    });
    let republish!: () => void;
    function MountedProject() {
      const binding = useProjectWidgetAreaBinding({ serverId: connection.home.id, projectName: 'Project',
        projectRef: { id: 'offline-checkout', serverId: connection.home.id, machineId: 'offline-machine',
          rootPath: '/repo', projectKey: 'identity-project', createdAtMs: 1 } });
      return <ProjectWidgetArea {...binding} projectName="Project" testID="project-identity" />;
    }
    function Host() {
      const [value, setValue] = React.useState(projectionValue);
      republish = () => setValue(projectionValue());
      return <AppShellPluginUiProjectionValueProvider value={value}>
        <InjectedAuthProvider credentials={connection.credentials}><MountedProject /></InjectedAuthProvider>
      </AppShellPluginUiProjectionValueProvider>;
    }
    const screen = await renderScreen(<Host />);
    const childItems = () => screen.root.findAll(node => node.props?.parent?.group?.id === 'group'
      && typeof node.props?.placement?.instance?.id === 'string' && typeof node.type !== 'string');
    await vi.waitFor(() => expect(new Set(childItems().map(node => node.props.placement.instance.id)))
      .toEqual(new Set(['first-child', 'second-child'])));
    await flushHookEffects();
    const before = new Map(childItems().map(node => [node.props.placement.instance.id, node.props]));
    await act(async () => { republish(); });
    await flushHookEffects();
    for (const node of childItems()) {
      const prior = before.get(node.props.placement.instance.id)!;
      expect(node.props.placement).toBe(prior.placement);
      expect(node.props.parent).toBe(prior.parent);
    }
    await screen.unmount();
  } finally { restoreLoader(); await connection.dispose(); }
});
