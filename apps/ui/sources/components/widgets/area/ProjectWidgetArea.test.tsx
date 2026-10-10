import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, WidgetSurfaceRefV1Schema, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import * as React from 'react';
import { renderHook, renderScreen, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createHomeHubArtifactHttpBoundary, createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import { flattenWidgetLayoutWidgetsV1, resolveWidgetBindingsV1 } from '@happier-dev/protocol/widgets';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { useWidgetAreaLayout } from './useWidgetAreaLayout';

installDisconnectedServerSocketBoundary();
const windowSize = vi.hoisted(() => ({ width: 1024, height: 800 }));
vi.mock('react-native', async () => ({
    ...await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
    // Window dimensions are the platform boundary; responsive composition stays real.
    useWindowDimensions: () => ({ ...windowSize, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
afterEach(standardCleanup);
beforeEach(() => { windowSize.width = 1024; windowSize.height = 800; });
// App-entry composition belongs to collection, before timing the Account-bound journey.
await import('@/sync/syncEngine');
await import('./useProjectWidgetAreaBinding');
await import('@/sync/ops/actions/defaultActionExecutor');

it.each([false, true])('agent selection changes the mounted Project document with route ownership=%s', async routeOwned => {
    const previous = storage.getState();
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'viewer', encryptionMode: 'plain' });
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: `https://project-layout-select-${routeOwned}.test`, accountId: 'viewer',
        request: (input, init) => new URL(String(input)).pathname.startsWith('/v1/artifacts')
            ? artifacts.handle(new URL(String(input)).pathname, init) : fallback.request(input, init) });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { useProjectWidgetAreaBinding } = await import('./useProjectWidgetAreaBinding');
        const executor = createDefaultActionExecutor();
        const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'project', projectId: 'anchor' } };
        const context = { surface: 'mcp' as const, serverId: surface.serverId, expectedAccountId: surface.accountId };
        expect(await executor.execute('widgets.area.layout.create', { surface, layoutId: 'empty', name: 'Empty' }, { ...context, surface: 'ui' })).toMatchObject({ ok: true });
        const checkout: WorkspaceRefV1 = { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        const hook = await renderHook(() => {
            const [routeSelection, setRouteSelection] = React.useState<string | null>(null);
            const binding = useProjectWidgetAreaBinding({ serverId: connection.home.id, projectName: 'Project', activeCheckout: checkout,
                ...(routeOwned ? { layoutId: routeSelection ?? undefined, onSelectLayout: setRouteSelection } : {}) });
            return { routeSelection, layout: useWidgetAreaLayout(binding.port!, binding.context) };
        });
        await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready' }));
        await act(async () => { expect(await executor.execute('widgets.area.layout.select', { surface: { ...surface, owner: { ...surface.owner, layoutId: 'empty' } } }, context)).toMatchObject({ ok: true }); });
        await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'empty' } }, placements: [] }));
        expect(hook.getCurrent().routeSelection).toBe(routeOwned ? 'empty' : null);
        await hook.unmount();
        expect(await executor.execute('widgets.area.layout.select', { surface }, context)).toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_unavailable' });
    } finally { restoreLoader(); await connection.dispose(); storage.setState(previous); }
});

it('binds the authorized portable Source reactively without losing a Source-free or revoked personal checkout layout', async () => {
    const previous = storage.getState();
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    const source: ProjectSourceV1 = { id: 'source', revision: 7, name: 'Repository',
        audience: [{ principal: { kind: 'account', accountId: 'viewer' }, level: 'view' }], createdByAccountId: 'owner',
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } };
    let revoked = false;
    let holdSourceRead = false;
    let finishSourceRead: ((response: Response) => void) | undefined;
    const reads: URL[] = [];
    const readAuthority: (string | null)[] = [];
    let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://project-widget-source.test', accountId: 'viewer',
        request: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname.startsWith('/v1/projects/sources')) {
                reads.push(url);
                readAuthority.push(new Headers(init?.headers).get('Authorization'));
                if (holdSourceRead) return new Promise<Response>(resolve => { finishSourceRead = resolve; });
                return Promise.resolve(new Response(JSON.stringify(revoked ? { ok: false, error: 'source_unavailable' }
                    : { ok: true, source, canManage: false }), { status: revoked ? 404 : 200 }));
            }
            return area?.request(input, init) ?? fallback.request(input, init);
        } });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
        const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'project', projectId: 'anchor' } };
        area = createLayoutArtifactHttpBoundary('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: 'widget-area-layout.v1',
            defaultLayout: { v: 1, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        area.seed({ v: 1, surface, items: [] });
        let checkout: WorkspaceRefV1 = { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        const { useProjectWidgetAreaBinding } = await import('./useProjectWidgetAreaBinding');
        const hook = await renderHook(() => useProjectWidgetAreaBinding({ serverId: connection.home.id, projectName: 'Project', activeCheckout: checkout }));
        const resolve = (slot: 'project' | 'checkout') => resolveWidgetBindingsV1({
            instance: { v: 1, id: 'following', definition: { kind: 'builtin', id: 'project_about' }, bindings: { target: { kind: 'context', slot } } },
            fields: [{ path: 'target', title: 'Target', widget: 'text', required: true }],
            context: widgetProvidedContext(hook.getCurrent().context), viewerValues: {}, validateValue: () => ({ status: 'valid' }),
        });
        await flushHookEffects({ cycles: 4 });
        expect(reads).toEqual([]);
        expect(resolve('project').status).toBe('selection_required');
        expect(resolve('checkout')).toEqual({ status: 'ready', input: { target: checkout } });
        const sourceFreeLayout = await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' });
        expect(sourceFreeLayout, sourceFreeLayout.ok ? undefined : sourceFreeLayout.errorCode).toMatchObject({ ok: true, result: { surface, canEdit: true } });

        checkout = { ...checkout, source: { sourceId: source.id, revision: 1 } };
        await hook.rerender();
        await flushHookEffects({ cycles: 12 });
        expect(resolve('project')).toEqual({ status: 'ready', input: { target: { serverId: connection.home.id, ...source } } });
        expect(reads.every(url => url.pathname === '/v1/projects/sources/source' && url.searchParams.get('serverId') === connection.home.id)).toBe(true);
        expect(reads.length).toBeGreaterThan(0);
        expect(readAuthority.every(value => value === `Bearer ${connection.credentials.token}`)).toBe(true);

        revoked = true;
        holdSourceRead = true;
        await act(async () => publishHomeAccountChange(connection.home.id, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await flushHookEffects({ cycles: 12 });
        expect(resolve('project').status).toBe('ready');
        expect(finishSourceRead).toBeDefined();
        holdSourceRead = false;
        await act(async () => finishSourceRead!(Response.json({ ok: false, error: 'source_unavailable' }, { status: 404 })));
        await flushHookEffects({ cycles: 12 });
        expect(resolve('project').status).toBe('selection_required');
        expect(resolve('checkout')).toEqual({ status: 'ready', input: { target: checkout } });
        expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true, result: { surface, canEdit: true } });
        expect(area.writes).toEqual([]);
        revoked = false;
        await act(async () => publishHomeAccountChange(connection.home.id, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await flushHookEffects({ cycles: 12 });
        expect(resolve('project').status).toBe('ready');
        const capturedPort = hook.getCurrent().port!;
        await act(async () => storage.setState({ profileScope: { serverId: connection.home.id, accountId: 'another-viewer' } }));
        expect(resolve('project').status).toBe('selection_required');
        expect(await capturedPort.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
        await hook.unmount();
    } finally { restoreLoader(); await connection.dispose(); storage.setState(previous); }
});

it.each(['owner', 'view'] as const)('keeps README disclosure local and Code aside area-qualified for %s', async access => {
    await import('@/sync/syncEngine');
    const previous = storage.getState();
    let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: `https://project-disclosure-${access}.test`, accountId: 'viewer',
        request: (input, init) => area?.request(input, init) ?? fallback.request(input, init) });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
        const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'viewer',
            owner: { kind: 'project', projectId: 'anchor', layoutId: 'reading' } };
        const saved: WidgetAreaLayoutV1 = { v: 1, surface, name: 'Reading', items: [
            { kind: 'widget', area: 'main', instance: { v: 1, id: 'readme', definition: { kind: 'builtin', id: 'project_readme' }, bindings: {} } },
            { kind: 'widget', area: 'aside', instance: { v: 1, id: 'about', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} } },
        ] };
        area = createLayoutArtifactHttpBoundary('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: 'widget-area-layout.v1',
            defaultLayout: saved, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        area.seed(saved); area.setCallerAccess(access);
        const { useProjectWidgetAreaBinding, ProjectWidgetArea } = await import('./ProjectWidgetArea');
        const { ProjectOverviewDocument } = await import('@/components/projects/detail/ProjectOverviewWidgets');
        const { WidgetFrame } = await import('@/components/widgets/frame/WidgetFrame');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const hook = await renderHook(() => useProjectWidgetAreaBinding({ serverId: connection.home.id, projectName: 'Project', layoutId: 'reading',
            activeCheckout: { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 } }));
        const binding = hook.getCurrent();
        const port = binding.port!;
        const wrap = (content: React.ReactNode) => <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: null, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>{content}</AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(wrap(<ProjectOverviewDocument port={port} context={binding.context} projectName="Project" />));
        await flushHookEffects({ cycles: 4 });
        const frame = () => screen.findAllByType(WidgetFrame).find(node => node.props.testID.endsWith('.widget.readme.frame'))!;
        expect(frame().props.disclosure.collapsed).toBe(true);
        await act(async () => frame().props.disclosure.onCollapsedChange(false));
        expect(frame().props.disclosure.collapsed).toBe(false);
        await act(async () => screen.findByTestId('project-overview')!.props.onLayout({
            nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 800 } },
        }));
        expect(frame().props.disclosure.collapsed).toBe(false);
        await act(async () => screen.findByTestId('project-overview')!.props.onLayout({
            nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 800 } },
        }));
        expect(frame().props.disclosure.collapsed).toBe(false);
        windowSize.width = 390;
        await screen.update(wrap(<ProjectOverviewDocument port={port} context={binding.context} projectName="Project" />));
        expect(frame().props.disclosure.collapsed).toBe(false);
        windowSize.width = 1024;
        await screen.update(wrap(<ProjectOverviewDocument port={port} context={binding.context} projectName="Project" />));
        expect(frame().props.disclosure.collapsed).toBe(false);
        await act(async () => frame().props.disclosure.onCollapsedChange(true));
        expect(area.layout()).toEqual(saved);
        expect(area.writes).toEqual([]);
        await screen.update(wrap(<ProjectWidgetArea port={port} context={binding.context} projectName="Project" area="aside" testID="code-aside" />));
        await flushHookEffects({ cycles: 4 });
        expect(screen.findByTestId('code-aside.widget.about')).not.toBeNull();
        expect(screen.findByTestId('code-aside.widget.readme')).toBeNull();
        expect(area.writes).toEqual([]);
        await hook.unmount();
    } finally { restoreLoader(); await connection.dispose(); storage.setState(previous); }
});

it('binds a Source-free personal Project dashboard through the real Action and Artifact path and retires its captured port', async () => {
    await import('@/sync/syncEngine');
    const previous = storage.getState();
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://project-widget-binding.test', accountId: 'viewer',
        request: (input, init) => area?.request(input, init) ?? fallback.request(input, init) });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
        const surface = WidgetSurfaceRefV1Schema.parse({ serverId: connection.home.id, accountId: 'viewer',
            owner: { kind: 'project', projectId: 'anchor', layoutId: 'overview' } });
        const instance = { v: 1 as const, id: 'summary', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        area = createLayoutArtifactHttpBoundary('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: 'widget-area-layout.v1',
            defaultLayout: { v: 1, surface, items: [{ kind: 'widget', instance }] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        area.seed({ v: 1, surface, items: [{ kind: 'widget', instance }] });
        const checkout = { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo/feature', createdAtMs: 1, projectKey: 'anchor' };
        let activeCheckout: typeof checkout | undefined = checkout;
        const { useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
        const hook = await renderHook(() => useProjectWidgetAreaBinding({ serverId: connection.home.id, projectName: 'Project', projectRef: checkout, activeCheckout, layoutId: 'overview' }));
        const port = hook.getCurrent().port;
        expect(port).not.toBeNull();
        expect(hook.getCurrent().context.slots?.project?.value).toBeNull();
        expect(hook.getCurrent().context.slots?.checkout?.value?.value).toMatchObject({ id: 'checkout', rootPath: '/repo/feature' });
        expect(await port!.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true, result: { surface, canEdit: true } });
        expect(await port!.movement!.readAdmission({ surface, instanceId: 'summary' }, surface)).toMatchObject({ status: 'ready', destination: surface });
        expect(await port!.execute({ actionId: 'widgets.item.rename', instanceId: 'summary', displayName: 'My Project' })).toMatchObject({ ok: true });
        expect(flattenWidgetLayoutWidgetsV1(area.layout().items)[0]?.instance.displayName).toBe('My Project');
        activeCheckout = undefined;
        await hook.rerender();
        expect(hook.getCurrent().context.slots?.checkout?.value).toBeNull();
        expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true, result: { surface, canEdit: true } });
        const writes = area.writes.length;
        await act(async () => storage.setState({ profileScope: { serverId: connection.home.id, accountId: 'another-viewer' } }));
        expect(await port!.execute({ actionId: 'widgets.item.rename', instanceId: 'summary', displayName: 'Wrong viewer' })).toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
        expect(area.writes).toHaveLength(writes);
        await hook.unmount();
    } finally { restoreLoader(); await connection.dispose(); storage.setState(previous); }
});

it('keeps an attached shared Project dashboard owner distinct from its viewer under the Account UI move waiver and refuses a different Home', async () => {
    const { sync } = await import('@/sync/syncEngine');
    const previous = storage.getState();
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
    let sourceRevoked = false;
    let attachedArtifactId = '';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://project-widget-shared.test', accountId: 'viewer',
        request: async (input, init) => {
            if (new URL(String(input)).pathname === '/v1/projects/sources/team-source') return sourceRevoked
                ? Response.json({ ok: false, error: 'source_unavailable' }, { status: 404 })
                : Response.json({ ok: true, canManage: false, source: { id: 'team-source', revision: 1, name: 'Team repository',
                    createdByAccountId: 'owner', audience: [{ principal: { kind: 'account', accountId: 'viewer' }, level: 'view' }],
                    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                        repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' },
                    attachments: [{ purpose: 'dashboard', ref: { kind: 'doc', artifactId: attachedArtifactId } }] } });
            if (new URL(String(input)).pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'widgets.item.move': ['ui'] } }),
            } }, version: 2 });
            return area?.request(input, init) ?? fallback.request(input, init);
        } });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
        // The routing scenario's immediate move is admitted by persisted Account policy, never an executor bypass.
        await sync.refreshAccountSettingsFromServer(2, { serverId: connection.home.id, accountId: 'viewer' });
        expect(storage.getState().settings.actionsSettingsV1).toMatchObject({ approvalWaivedSurfaces: { 'widgets.item.move': ['ui'] } });
        const storedSurface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'owner', owner: { kind: 'project', projectId: 'owners-private-project', layoutId: 'shared' } };
        const artifactId = buildWidgetSurfaceArtifactIdV1(storedSurface);
        attachedArtifactId = artifactId;
        const instance = { v: 1 as const, id: 'shared-summary', definition: { kind: 'builtin' as const, id: 'project_about' },
            displayName: 'Owner dashboard About', bindings: { target: { kind: 'context' as const, slot: 'checkout' } } };
        area = createLayoutArtifactHttpBoundary('owner', { artifactId, kind: 'widget-area-layout.v1',
            defaultLayout: { v: 1, surface: storedSurface, items: [{ kind: 'widget', instance, area: 'main' }] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        area.seed({ v: 1, surface: storedSurface, name: 'Owner release dashboard', items: [{ kind: 'widget', instance, area: 'main' }] }); area.setCallerAccess('view');
        const { useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
        let serverId = connection.home.id;
        const checkout = { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1, projectKey: 'anchor', source: { sourceId: 'team-source', revision: 1 } };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const hook = await renderHook(() => useProjectWidgetAreaBinding({ serverId, projectName: 'Project', activeCheckout: checkout,
            attachedDashboard: { sourceId: 'team-source', artifactId } }));
        await vi.waitFor(() => expect(hook.getCurrent().port).not.toBeNull());
        expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true,
            result: { surface: { ...storedSurface, artifactId }, canEdit: false, isShared: true } });
        const { ProjectOverviewWidgets } = await import('@/components/projects/detail/ProjectOverviewWidgets');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const wrap = (content: React.ReactNode) => <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: null, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>{content}</AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(wrap(<ProjectOverviewWidgets workspaceRef={checkout} activeRootPath={checkout.rootPath}
            attachedDashboard={{ sourceId: 'team-source', artifactId }} onSelectDashboard={() => {}} />));
        await vi.waitFor(() => expect(screen.findByTestId('project-overview-main.widget.shared-summary')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findByTestId('project-overview-main.widget.shared-summary.body.repository')).not.toBeNull());
        expect(screen.findByTestId('project-overview-main.widget.code')).toBeNull();
        expect(area.writes).toEqual([]);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const priorPublicationPort = hook.getCurrent().port!;
        area.setCallerAccess(null);
        await act(async () => { storage.getState().deleteArtifact(artifactId); });
        await vi.waitFor(() => expect(hook.getCurrent().port).toBeNull());
        expect(hook.getCurrent().sharedDashboard).toBeUndefined();
        await vi.waitFor(() => expect(screen.findByTestId('project-overview-main.widget.shared-summary')).toBeNull());
        expect(await priorPublicationPort.execute({ actionId: 'widgets.item.rename', instanceId: instance.id, displayName: 'Revoked Artifact' }))
            .toMatchObject({ ok: false });
        expect(area.writes).toEqual([]);
        area.setCallerAccess('edit');
        const refreshAccount = await captureLazyActionAccountContext(connection.home.id);
        try { await act(async () => { await refreshAccount.fetchArtifact(artifactId); }); } finally { refreshAccount.dispose(); }
        await vi.waitFor(() => expect(hook.getCurrent().port).not.toBeNull());
        const attachedSurface = { ...storedSurface, artifactId };
        expect(await hook.getCurrent().port!.movement!.readAdmission({ surface: attachedSurface, instanceId: instance.id }, attachedSurface))
            .toMatchObject({ status: 'ready', instance, destination: attachedSurface });
        const moved = await hook.getCurrent().port!.movement!.execute({ actionId: 'widgets.item.move',
            input: { ref: { surface: attachedSurface, instanceId: instance.id }, to: { surface: attachedSurface, area: 'aside', index: 0 } },
            preview: { verb: 'Move', target: 'Aside' } }, { serverId: connection.home.id, accountId: 'owner' });
        expect(moved).toMatchObject({ status: 'applied' });
        expect(flattenWidgetLayoutWidgetsV1(area.layout().items).find(entry => entry.instance.id === instance.id)?.area).toBe('aside');
        await vi.waitFor(() => expect(screen.findByTestId('project-overview-aside.widget.shared-summary')).not.toBeNull());
        const capturedSharedPort = hook.getCurrent().port!;
        const sharedWrites = area.writes.length;
        sourceRevoked = true;
        publishHomeAccountChange(connection.home.id, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await vi.waitFor(() => expect(hook.getCurrent().port).toBeNull());
        expect(hook.getCurrent().unavailableReasonCode).toBe('widget_project_source_unavailable');
        await vi.waitFor(() => expect(screen.findByTestId('project-overview-main.widget.shared-summary')).toBeNull());
        expect(screen.findByTestId('project-overview-aside.widget.shared-summary')).toBeNull();
        expect(await capturedSharedPort.execute({ actionId: 'widgets.item.rename', instanceId: instance.id, displayName: 'Retired Source' }))
            .toMatchObject({ ok: false });
        expect(area.writes).toHaveLength(sharedWrites);
        serverId = 'other-home'; await hook.rerender();
        expect(hook.getCurrent().port).toBeNull();
        expect(hook.getCurrent().unavailableReasonCode).toBe('widget_area_scope_unavailable');
        await hook.unmount();
    } finally { restoreLoader(); await connection.dispose(); storage.setState(previous); }
});
