import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import * as React from 'react';
import { renderHook, renderScreen, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createHomeHubArtifactHttpBoundary, createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import { resolveWidgetBindingsV1 } from '@happier-dev/protocol/widgets';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

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
        request: (input, init) => {
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
            defaultLayout: { v: 1, surface, instances: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        area.seed({ v: 1, surface, instances: [] });
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
            owner: { kind: 'project', projectId: 'anchor', dashboardId: 'reading' } };
        const saved: WidgetAreaLayoutV1 = { v: 1, surface, name: 'Reading', instances: [
            { area: 'main', instance: { v: 1, id: 'readme', definition: { kind: 'builtin', id: 'project_readme' }, bindings: {} } },
            { area: 'aside', instance: { v: 1, id: 'about', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} } },
        ] };
        area = createLayoutArtifactHttpBoundary('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: 'widget-area-layout.v1',
            defaultLayout: saved, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        area.seed(saved); area.setCallerAccess(access);
        const { useProjectWidgetAreaBinding, ProjectWidgetArea } = await import('./ProjectWidgetArea');
        const { ProjectOverviewDocument } = await import('@/components/projects/detail/ProjectOverviewWidgets');
        const { WidgetFrame } = await import('@/components/widgets/frame/WidgetFrame');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const hook = await renderHook(() => useProjectWidgetAreaBinding({ serverId: connection.home.id, projectName: 'Project', dashboardId: 'reading',
            activeCheckout: { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 } }));
        const binding = hook.getCurrent();
        const port = binding.port!;
        const wrap = (content: React.ReactNode) => <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: null, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null, platform: 'web', clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>{content}</AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(wrap(<ProjectOverviewDocument port={port} context={binding.context} projectName="Project" />));
        await flushHookEffects({ cycles: 4 });
        const frame = () => screen.root.findAllByType(WidgetFrame).find(node => node.props.testID.endsWith('.widget.readme.frame'))!;
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
        const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'viewer',
            owner: { kind: 'project', projectId: 'anchor', dashboardId: 'overview' } };
        const instance = { v: 1 as const, id: 'summary', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        area = createLayoutArtifactHttpBoundary('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: 'widget-area-layout.v1',
            defaultLayout: { v: 1, surface, instances: [{ instance }] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        area.seed({ v: 1, surface, instances: [{ instance }] });
        const checkout = { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo/feature', createdAtMs: 1, projectKey: 'anchor' };
        let activeCheckout: typeof checkout | undefined = checkout;
        const { useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
        const hook = await renderHook(() => useProjectWidgetAreaBinding({ serverId: connection.home.id, projectName: 'Project', projectRef: checkout, activeCheckout, dashboardId: 'overview' }));
        const port = hook.getCurrent().port;
        expect(port).not.toBeNull();
        expect(hook.getCurrent().context.slots?.project?.value).toBeNull();
        expect(hook.getCurrent().context.slots?.checkout?.value?.value).toMatchObject({ id: 'checkout', rootPath: '/repo/feature' });
        expect(await port!.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true, result: { surface, canEdit: true } });
        expect(await port!.movement!.readAdmission({ surface, instanceId: 'summary' }, surface)).toMatchObject({ status: 'ready', destination: surface });
        expect(await port!.execute({ actionId: 'widgets.item.rename', instanceId: 'summary', displayName: 'My Project' })).toMatchObject({ ok: true });
        expect(area.layout().instances[0]?.instance.displayName).toBe('My Project');
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

it('keeps an attached shared Project dashboard owner distinct from its viewer and refuses a different Home', async () => {
    await import('@/sync/syncEngine');
    const previous = storage.getState();
    const fallback = createHomeHubArtifactHttpBoundary('viewer');
    let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://project-widget-shared.test', accountId: 'viewer',
        request: (input, init) => area?.request(input, init) ?? fallback.request(input, init) });
    const restoreLoader = await installRealActionExecutorModuleLoader();
    try {
        const storedSurface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'owner', owner: { kind: 'project', projectId: 'anchor', dashboardId: 'shared' } };
        const artifactId = buildWidgetSurfaceArtifactIdV1(storedSurface);
        const instance = { v: 1 as const, id: 'shared-summary', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        area = createLayoutArtifactHttpBoundary('owner', { artifactId, kind: 'widget-area-layout.v1',
            defaultLayout: { v: 1, surface: storedSurface, instances: [{ instance, area: 'main' }] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        area.seed({ v: 1, surface: storedSurface, instances: [{ instance, area: 'main' }] }); area.setCallerAccess('view');
        const { useProjectWidgetAreaBinding } = await import('./ProjectWidgetArea');
        let serverId = connection.home.id;
        const checkout = { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1, projectKey: 'anchor' };
        const hook = await renderHook(() => useProjectWidgetAreaBinding({ serverId, projectName: 'Project', activeCheckout: checkout,
            dashboardId: 'shared', artifactId, ownerAccountId: 'owner' }));
        expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true,
            result: { surface: { ...storedSurface, artifactId }, canEdit: false, isShared: true } });
        area.setCallerAccess('edit');
        const attachedSurface = { ...storedSurface, artifactId };
        expect(await hook.getCurrent().port!.movement!.readAdmission({ surface: attachedSurface, instanceId: instance.id }, attachedSurface))
            .toMatchObject({ status: 'ready', instance, destination: attachedSurface });
        expect(await hook.getCurrent().port!.movement!.execute({ actionId: 'widgets.item.move',
            input: { ref: { surface: attachedSurface, instanceId: instance.id }, to: { surface: attachedSurface, area: 'aside', index: 0 } },
            preview: { verb: 'Move', target: 'Aside' } }, { serverId: connection.home.id, accountId: 'owner' }))
            .toMatchObject({ status: 'applied' });
        expect(area.layout().instances.find(entry => entry.instance.id === instance.id)?.area).toBe('aside');
        serverId = 'other-home'; await hook.rerender();
        expect(hook.getCurrent().port).toBeNull();
        expect(hook.getCurrent().unavailableReasonCode).toBe('widget_area_scope_unavailable');
        await hook.unmount();
    } finally { restoreLoader(); await connection.dispose(); storage.setState(previous); }
});
