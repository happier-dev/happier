import { expect, it } from 'vitest';
import { z } from 'zod/mini';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, readWidgetSurfaceArtifactV1, projectOverviewDefaultPlacementsV1, flattenWidgetLayoutWidgetsV1, WidgetAreaLayoutV1Schema, WIDGET_SURFACE_ARTIFACT_KIND_V1, WidgetDefinitionV1Schema, buildWidgetDefinitionArtifactHeaderV1, WidgetLayoutGroupV1Schema, type WidgetAreaLayoutV1, type WidgetDefinitionV1 } from '@happier-dev/protocol/widgets';
import { resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { WorkspaceRefV1WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createWidgetAreaActionDepsV1 } from './widgetAreaActionDeps';
import { createWidgetCatalogActionDepsV1 } from './widgetCatalogActionDeps';
import { createWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
// Match the application entry before Account restoration; real owner initialization belongs to collection.
import '@/sync/syncEngine';

it('protects referenced Overviews, preserves forgotten bytes, and explicitly deletes an unreferenced Overview through the dashboard Action', async () => {
    let surface = { serverId: 'home', accountId: 'actor', owner: { kind: 'project' as const, projectId: 'project' } };
    const makeBoundary = () => createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: buildWidgetSurfaceArtifactHeaderV1,
    });
    let boundary = makeBoundary();
    const deletes: string[] = [];
    let rowsAvailable = true;
    let forgotten = false;
    let remainingRef = true;
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://forgotten-overview.test', accountId: 'actor', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/project-rows/list' && !rowsAvailable) return Promise.resolve(Response.json({ status: 'account-inconsistent', reason: 'test refusal' }));
        if (path === '/v1/account/project-rows/list' && forgotten) {
            const remaining = createPlainProjectAccountRowListFixture({ workspaceRefs: remainingRef ? [secondRef] : [] });
            if (remaining.status !== 'listed') throw new Error('Expected complete Project rows');
            return Promise.resolve(Response.json({ status: 'listed', coverage: 'complete',
            rows: [{ key: { kind: 'workspace-ref', serverId: surface.serverId, id: 'checkout' }, revision: 1, content: null },
                ...remaining.rows,
                ...(remainingRef ? [] : [{ key: { kind: 'workspace-ref', serverId: surface.serverId, id: 'second-checkout' }, revision: 1, content: null }])] }));
        }
        if (init?.method === 'DELETE') {
            deletes.push(path);
            return Promise.resolve(Response.json({ success: true }));
        }
        return boundary.request(url, init);
    } });
    surface = { ...surface, serverId: connection.home.id }; boundary = makeBoundary();
    boundary.seed({ v: 1, surface, items: [] });
    const ref = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', projectKey: 'project', serverId: surface.serverId,
        machineId: 'machine', rootPath: '/repo', createdAtMs: 1 });
    const secondRef = { ...ref, id: 'second-checkout', rootPath: '/second' };
    boundary.setWorkspaceRefs([ref, secondRef]);
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createWidgetAreaActionDepsV1(account), widgetAccountScope: () => account,
        }));
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: account.serverId,
            runtimeAccountId: account.accountId, actionCaller: { kind: 'host' as const }, bypassApprovals: true };
        const args = { surface, expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
        expect(await executor.execute('widgets.area.layout.delete', args, context))
            .toMatchObject({ ok: false, errorCode: 'widget_area_layout_default_protected' });
        expect(deletes).toEqual([]);
        // A different client has Forgotten the last private ref. Forget itself preserves the Artifact.
        boundary.setWorkspaceRefs([]);
        forgotten = true;
        expect((await account.homeHubArtifactTransport.read(boundary.artifactId))?.body).toBeTruthy();
        expect(await executor.execute('widgets.area.layout.delete', args, context))
            .toMatchObject({ ok: false, errorCode: 'widget_area_layout_default_protected' });
        remainingRef = false;
        rowsAvailable = false;
        expect(await executor.execute('widgets.area.layout.delete', args, context)).toMatchObject({ ok: false });
        expect(deletes).toEqual([]);
        rowsAvailable = true;
        const deleted = await executor.execute('widgets.area.layout.delete', args, context);
        expect(deleted, JSON.stringify(deleted)).toMatchObject({ ok: true });
        expect(deletes).toEqual([`/v1/artifacts/${boundary.artifactId}/revision/1/1`]);
        boundary.setCallerAccess('admin');
        expect(await executor.execute('widgets.area.layout.delete', args, context))
            .toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_required' });
        expect(deletes).toHaveLength(1);
    } finally { account.dispose(); await connection.dispose(); }
});

it('adds repository-qualified Project widgets through the same catalog for mounted and headless Actions', async () => {
    const React = await import('react');
    const { default: renderer, act } = await import('react-test-renderer');
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { widgetProjectionEntry, widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
    const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
    const { PluginProjectionV2Schema} = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const { ProjectSourceV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
    const { storage } = await import('@/sync/domains/state/storage');
    const source = ProjectSourceV1Schema.parse({ id: 'source', revision: 1, name: 'Repo', audience: [], createdByAccountId: 'actor',
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' } });
    let surface = { serverId: 'home', accountId: 'actor', owner: { kind: 'project' as const, projectId: 'logical-project' } };
    const makeBoundary = () => createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: buildWidgetSurfaceArtifactHeaderV1,
    });
    let boundary = makeBoundary();
    const reads: string[] = [];
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://project-widget-policy.test', accountId: 'actor', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        reads.push(path);
        return path === '/v1/projects/sources/source' ? Promise.resolve(Response.json({ ok: true, source, canManage: true })) : boundary.request(url, init);
    } });
    surface = { ...surface, serverId: connection.home.id }; boundary = makeBoundary();
    const checkout = WorkspaceRefV1WriteSchema.parse({ id: 'not-the-project-key', projectKey: surface.owner.projectId,
        serverId: surface.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1, source: { sourceId: source.id, revision: 1 } });
    boundary.setWorkspaceRefs([checkout, { ...checkout, id: 'second-checkout', rootPath: '/second', createdAtMs: 2 },
        { ...checkout, id: 'other-project', projectKey: 'other-project', source: undefined, rootPath: '/other' }]);
    const account = await captureLazyActionAccountContext(connection.home.id);
    const previous = storage.getState();
    let tree: import('react-test-renderer').ReactTestRenderer | undefined;
    try {
        const pluginId = 'acme.project-status';
        const entry = widgetProjectionEntry({ pluginId, localId: 'github-project-status', target: 'project' });
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [pluginId]: { ...widgetInstalledPackage(pluginId, 'Project status'), occurrenceId: `${pluginId}#1` } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { widget: { ...entry,
                availability: { state: 'available', reason: 'available', diagnostics: [], when: {
                    fact: 'project.repository.kind', operator: 'equals', value: 'github',
                } } } } } } }));
        await act(async () => { tree = renderer.create(React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: null, serverId: account.serverId, platform: 'web', accountLifetime: account.accountLifetime,
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {}, reloadConnectedAccountProjection() {},
        }, children: React.createElement(React.Fragment) })); });
        const base = createActionExecutorBoundaryFixture({ ...createWidgetAreaActionDepsV1(account), widgetAccountScope: () => account });
        const catalog = createWidgetCatalogActionDepsV1(account, base);
        const deps = { ...base, ...catalog, ...createWidgetInputActionDepsV1(account, { ...base, ...catalog }) };
        const executor = createActionExecutor(deps);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: account.serverId,
            runtimeAccountId: account.accountId, actionCaller: { kind: 'host' as const },
            actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.item.add': ['ui'] } }) };
        for (const mounted of [false, true]) {
            const instance = { v: 1 as const, id: mounted ? 'mounted' : 'headless',
                definition: { kind: 'installed' as const, surface: { pluginId, localId: 'github-project-status' } }, bindings: {} };
            const invocation = mounted ? { ...context, widgetAreaContext: { surface, values: { checkout: [checkout] } } } : context;
            const sourceReads = reads.filter(path => path === '/v1/projects/sources/source').length;
            const candidates = await catalog.widgetCatalog!.list(surface, invocation);
            expect(candidates).toEqual(
                expect.arrayContaining([expect.objectContaining({ definition: instance.definition, availability: 'available' })]));
            // One demand reads one qualified Source, independent of the number
            // of accepted checkouts or candidate declarations; no per-row probe.
            expect(reads.filter(path => path === '/v1/projects/sources/source').length - sourceReads).toBe(1);
            const added = await executor.execute('widgets.item.add', { surface, instance }, invocation);
            expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
            expect(flattenWidgetLayoutWidgetsV1(boundary.layout().items).some(row => row.instance.id === instance.id)).toBe(true);
        }
        const other = { ...surface, owner: { kind: 'project' as const, projectId: 'other-project' } };
        const others = await catalog.widgetCatalog!.list(other, context);
        expect(Array.isArray(others) && others.some(row => row.definition.kind === 'installed')).toBe(false);
        expect(await catalog.widgetCatalog!.list({ ...surface, serverId: 'other-home' }, context)).toMatchObject({ ok: false });
        expect(reads.filter(path => path === '/v1/projects/sources/source').length).toBeGreaterThan(0);
        expect(reads.some(path => path.includes('/rpc') || path.includes('/scm'))).toBe(false);
    } finally {
        if (tree) await act(async () => { tree!.unmount(); });
        storage.setState(previous, true); account.dispose(); await connection.dispose();
    }
});

it('reuses one admitted placement for a copy configuration and reads fresh on the next resolution', async () => {
    let boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: 'unused', kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface: { serverId: 'home', accountId: 'actor', owner: { kind: 'project', projectId: 'project' } }, items: [] },
        parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
    });
    const reads: string[] = [];
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://copy-placement-read.test', accountId: 'actor',
        request: (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === `/v1/artifacts/${boundary.artifactId}` && init?.method !== 'POST') reads.push(path);
            return boundary.request(url, init);
        } });
    const surface = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'project' as const, projectId: 'project' } };
    boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: value => buildWidgetSurfaceArtifactHeaderV1(value),
    });
    boundary.seed({ v: 1, surface, items: [] });
    const checkout = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', serverId: surface.serverId, machineId: 'machine',
        rootPath: '/repo', projectKey: surface.owner.projectId, createdAtMs: 1 });
    boundary.setWorkspaceRefs([checkout]);
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const area = createWidgetAreaActionDepsV1(account);
        const deps = createActionExecutorBoundaryFixture({ ...area, widgetAccountScope: () => account });
        const inputs = createWidgetInputActionDepsV1(account, deps).widgetInputs!;
        const request = { ref: { surface, instanceId: 'copy' }, instance: { v: 1 as const, id: 'copy',
            definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: { checkout: { kind: 'value' as const, value: checkout } } },
            context: { surface: 'ui' as const, authority: 'present_user' as const }, admission: 'configuration' as const };
        expect(await inputs.resolve(request)).toMatchObject({ status: 'ready' });
        expect(reads).toHaveLength(1);
        boundary.setCallerAccess(null);
        expect(await inputs.resolve(request)).toMatchObject({ status: 'unavailable' });
        expect(reads).toHaveLength(2);
    } finally { account.dispose(); await connection.dispose(); }
});

it('admits local and portable Home identities through the widget Action owner without admitting another Home', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://widget-identity.test',
        serverIdentityId: 'srv_0123456789abcdefghijklmnopqrstuv', accountId: 'actor' });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const surface = { serverId: connection.home.id, accountId: 'actor',
        owner: { kind: 'project' as const, projectId: 'identity-project' } };
    const boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: value => buildWidgetSurfaceArtifactHeaderV1(value),
    });
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(boundary.request);
    try {
        const area = createWidgetAreaActionDepsV1(account);
        const deps = createActionExecutorBoundaryFixture(area);
        const executor = createActionExecutor({ ...deps, ...createWidgetCatalogActionDepsV1(account, deps) });
        const context = { surface: 'ui' as const, serverId: connection.home.id, serverIdentityId: 'srv_0123456789abcdefghijklmnopqrstuv' };
        expect(await executor.execute('widgets.item.list', { surface }, context))
            .toMatchObject({ ok: true, result: { surface } });
        const portableSurface = { ...surface, serverId: context.serverIdentityId };
        expect(await executor.execute('widgets.item.list', { surface: portableSurface }, context))
            .toMatchObject({ ok: true, result: { surface: portableSurface } });
        expect(await executor.execute('widgets.item.list', { surface: { ...surface, serverId: 'srv-other' } }, context))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(await executor.execute('widgets.item.list', { surface }, { ...context, serverIdentityId: 'srv-other' }))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(boundary.writes).toHaveLength(0);
    } finally { account.dispose(); await connection.dispose(); }
});

it('uses a stable Project key without a Source through the actual Account Artifact codec', async () => {
    const produced: { header: Readonly<Record<string, unknown>>; body: string }[] = [];
    const provisional = { serverId: 'home', accountId: 'actor', owner: { kind: 'project' as const, projectId: 'stable-project' } };
    let surface = provisional;
    let boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1 as const, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
    });
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://source-free-dashboard.test', accountId: 'actor', request: async (url, init) => {
        if (init?.method === 'POST' && new URL(String(url)).pathname.startsWith('/v1/artifacts')) {
            const wire: unknown = JSON.parse(String(init.body));
            if (!wire || typeof wire !== 'object') throw new Error('Expected Artifact mutation');
            const header = z.record(z.string(), StrictJsonValueSchema).parse(decodePlainArtifactStoredContent(String(Reflect.get(wire, 'header'))));
            const body = decodePlainArtifactStoredContent(String(Reflect.get(wire, 'body')));
            if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'body') !== 'string') throw new Error('Expected Artifact text body');
            const text = String(Reflect.get(body, 'body'));
            produced.push({ header, body: text });
        }
        return boundary.request(url, init);
    } });
    surface = { ...provisional, serverId: connection.home.id };
    const checkout = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', serverId: surface.serverId,
        machineId: 'machine', rootPath: '/repo', projectKey: surface.owner.projectId, createdAtMs: 1 });
    boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1 as const, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
    });
    // The checkout is admitted against the Account's Project rows, never against page context alone.
    boundary.setWorkspaceRefs([checkout]);
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: connection.home.id,
            expectedAccountId: 'actor', actionCaller: { kind: 'host' as const },
            widgetAreaContext: { surface, values: { checkout: [checkout] } },
            actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
                'widgets.item.add': ['ui'], 'widgets.item.rename': ['ui'],
            } }),
        };
        const defaults = projectOverviewDefaultPlacementsV1();
        expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true, result: {
            surface, state: 'missing', canEdit: true, instances: defaults.map(({ kind: _kind, ...entry }) => entry) } });
        expect(boundary.writes).toHaveLength(0);
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'project_about' },
            bindings: { checkout: { kind: 'value' as const, value: checkout } } };
        const added = await executor.execute('widgets.item.add', { surface, instance }, context);
        expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
        const saved = flattenWidgetLayoutWidgetsV1(boundary.layout().items);
        expect(saved.filter(entry => entry.instance.id !== instance.id).map(entry => ({ id: entry.instance.id, area: entry.area })))
            .toEqual(defaults.map(entry => ({ id: entry.instance.id, area: entry.area })));
        // The retained preset is not the person's frame choice: each widget keeps following its area's default.
        expect(saved.filter(entry => entry.instance.id !== instance.id).map(entry => entry.frameStyle ?? null))
            .toEqual(defaults.map(() => null));
        expect(saved.find(entry => entry.instance.id === instance.id)).toMatchObject({ instance, area: 'main' });
        expect(await executor.execute('widgets.item.rename', { ref: { surface, instanceId: instance.id }, displayName: 'My project' }, context))
            .toMatchObject({ ok: true });
        expect(flattenWidgetLayoutWidgetsV1(boundary.layout().items).find(entry => entry.instance.id === instance.id)?.instance.displayName).toBe('My project');
        expect(produced.length).toBeGreaterThan(0);
        for (const wire of produced) {
            const layout = WidgetAreaLayoutV1Schema.parse(JSON.parse(wire.body));
            // Assert outside HTTP: the Action's unknown-outcome projection must
            // not swallow a producer/consumer assertion thrown by the boundary.
            expect(readWidgetSurfaceArtifactV1({ artifactId: boundary.artifactId, ...wire })).toEqual(layout);
            expect(wire.header).toMatchObject(buildWidgetSurfaceArtifactHeaderV1(layout));
        }
        expect(await executor.execute('widgets.item.list', { surface: { ...surface, accountId: 'foreign' } }, context))
            .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    } finally { account.dispose(); await connection.dispose(); }
});

it('opens and edits one explicitly attached owner dashboard through the recipient Artifact admission', async () => {
    let surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'project' as const, projectId: 'stable-project', layoutId: 'notes' } };
    const makeBoundary = () => createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('owner', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface, name: 'Notes', items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: value => buildWidgetSurfaceArtifactHeaderV1(value),
    });
    let boundary = makeBoundary();
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://shared-dashboard.test', accountId: 'viewer', request: boundary.request });
    surface = { ...surface, serverId: connection.home.id }; boundary = makeBoundary();
    boundary.seed({ v: 1, surface, name: 'Notes', items: [{ kind: 'widget', instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} } }] });
    boundary.setCallerAccess('view');
    const selected = { ...surface, artifactId: boundary.artifactId };
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const port = createWidgetAreaActionDepsV1(account).widgetSurfaceActions!.project!;
        expect(await port.read(selected, { surface: 'ui' })).toMatchObject({ surface: selected, canEdit: false, isShared: true });
        expect(await port.apply(selected, { kind: 'rename', instanceId: 'copy', displayName: 'Not permitted' }, { surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'artifact_access_forbidden' });
        expect(boundary.writes).toHaveLength(0);
        boundary.setCallerAccess('edit');
        expect(await port.apply(selected, { kind: 'rename', instanceId: 'copy', displayName: 'Recipient edit' }, { surface: 'ui' }))
            .toMatchObject({ ok: true });
        expect(boundary.layout()).toMatchObject({ surface, items: [{ kind: 'widget', instance: { displayName: 'Recipient edit' } }] });
        expect(await port.read(surface, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'widget_area_owner_mismatch' });
    } finally { account.dispose(); await connection.dispose(); }
});

it('publishes only widget titles when a personal dashboard becomes shared and keeps later additions and renames readable by recipients', async () => {
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'private-widget', name: 'Release health',
        body: { kind: 'builtin', id: 'project_about' }, inputs: { fields: [] },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        provenance: { source: { kind: 'authored' }, authorAccountId: 'owner' } });
    const privateDefinition = createLayoutArtifactHttpBoundary<WidgetDefinitionV1>('owner', {
        artifactId: definition.id, kind: 'widget-definition.v1', defaultLayout: definition,
        parseLayout: value => WidgetDefinitionV1Schema.parse(value), buildHeader: buildWidgetDefinitionArtifactHeaderV1,
    });
    privateDefinition.seed(definition);
    let surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'project' as const, projectId: 'project', layoutId: 'shared' } };
    const makeLayoutBoundary = () => createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('owner', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface, name: 'Team overview', items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: buildWidgetSurfaceArtifactHeaderV1,
    });
    let boundary = makeLayoutBoundary();
    let definitionReads = 0;
    const grant = { principal: { kind: 'account' as const, accountId: 'recipient' }, accessLevel: 'view' as const,
        createdByAccountId: 'owner', createdAt: 1, display: { name: 'Recipient' } };
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://shared-widget-titles.test', accountId: 'owner', request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === `/v1/artifacts/${definition.id}`) { definitionReads += 1; return privateDefinition.request(url, init); }
        if (path.startsWith(`/v1/artifacts/${definition.id}/`)) return privateDefinition.request(url, init);
        if (path === '/v1/artifacts/read' && init?.method === 'POST') {
            const request = JSON.parse(String(init.body)) as { artifactIds: string[] };
            if (request.artifactIds.includes(definition.id)) {
                definitionReads += 1;
                return privateDefinition.request(url, init);
            }
        }
        if (path === `/v1/artifacts/${boundary.artifactId}/access/grants` && init?.method === 'PUT') {
            boundary.setGrants([grant]);
            return Response.json({ artifactId: boundary.artifactId, ownerAccountId: 'owner', access: 'owner', grants: [grant], changed: true });
        }
        return boundary.request(url, init);
    } });
    surface = { ...surface, serverId: connection.home.id }; boundary = makeLayoutBoundary();
    boundary.seed({ v: 1, surface, name: 'Team overview', items: [] });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const instance = (id: string) => ({ v: 1 as const, id, definition: { kind: 'artifact' as const, artifactId: definition.id }, bindings: {} });
    try {
        const port = createWidgetAreaActionDepsV1(account).widgetSurfaceActions!.project!;
        expect(await port.apply(surface, { kind: 'add', instance: instance('personal') }, { surface: 'ui' })).toMatchObject({ ok: true });
        expect(flattenWidgetLayoutWidgetsV1(boundary.layout().items)[0]!.instance.displayName).toBeUndefined();
        expect(definitionReads).toBe(0);
        expect(await port.apply(surface, { kind: 'group_add', group: WidgetLayoutGroupV1Schema.parse({ kind: 'group', id: 'group',
            children: [{ kind: 'widget', instance: instance('grouped') }] }) }, { surface: 'ui' })).toMatchObject({ ok: true });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const shared = await createDefaultActionExecutor({ presentUserActionConfirmation: async () => true }).execute('artifact.access.grants.set', {
            artifactId: boundary.artifactId, principal: grant.principal, accessLevel: grant.accessLevel,
        }, { surface: 'ui', serverId: connection.home.id, expectedAccountId: 'owner', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(shared, JSON.stringify(shared)).toMatchObject({ ok: true });
        expect(flattenWidgetLayoutWidgetsV1(boundary.layout().items).map(({ instance }) => instance.displayName)).toEqual(['Release health', 'Release health']);
        expect(definitionReads).toBe(1);
        const added = await createDefaultActionExecutor({ presentUserActionConfirmation: async () => true }).execute('widgets.item.add', {
            surface, instance: instance('added-shared'),
        }, { surface: 'ui', serverId: connection.home.id, expectedAccountId: 'owner', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(added, JSON.stringify(added))
            .toMatchObject({ ok: true, result: { instance: { displayName: 'Release health' } } });
        expect(await port.apply(surface, { kind: 'rename', instanceId: 'personal', displayName: 'Rollout health' }, { surface: 'ui' })).toMatchObject({ ok: true });
        const recipient = readWidgetSurfaceArtifactV1({ artifactId: boundary.artifactId,
            header: buildWidgetSurfaceArtifactHeaderV1(boundary.layout()), body: JSON.stringify(boundary.layout()) })!;
        expect(flattenWidgetLayoutWidgetsV1(recipient.items).map(({ instance }) => resolveWidgetInstanceTitle(instance, null, { definitionState: 'unavailable' })))
            .toEqual(['Rollout health', 'Release health', 'Release health']);
        expect(recipient.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ definition })]));
        expect(JSON.stringify(recipient)).not.toContain('inputSchema');
        const readsBeforeFrameChange = definitionReads;
        expect(await port.apply(surface, { kind: 'frame', instanceId: 'personal', frameStyle: 'card' }, { surface: 'ui' })).toMatchObject({ ok: true });
        expect(definitionReads).toBe(readsBeforeFrameChange);
        expect(await port.apply(surface, { kind: 'rename', instanceId: 'personal', displayName: null }, { surface: 'ui' })).toMatchObject({ ok: true });
        expect(flattenWidgetLayoutWidgetsV1(boundary.layout().items)[0]!.instance.displayName).toBe('Release health');
        const writesBeforeRepeatedShare = boundary.writes.length;
        const readsBeforeRepeatedShare = definitionReads;
        expect(await createDefaultActionExecutor({ presentUserActionConfirmation: async () => true }).execute('artifact.access.grants.set', {
            artifactId: boundary.artifactId, principal: grant.principal, accessLevel: grant.accessLevel,
        }, { surface: 'ui', serverId: connection.home.id, expectedAccountId: 'owner', authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
        expect(boundary.writes).toHaveLength(writesBeforeRepeatedShare);
        expect(definitionReads).toBe(readsBeforeRepeatedShare);
    } finally { account.dispose(); await connection.dispose(); }
});
