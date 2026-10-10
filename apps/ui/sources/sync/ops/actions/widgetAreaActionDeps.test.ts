import { expect, it } from 'vitest';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, projectOverviewDefaultPlacementsV1, flattenWidgetLayoutWidgetsV1, WidgetAreaLayoutV1Schema, WIDGET_SURFACE_ARTIFACT_KIND_V1, type WidgetAreaLayoutV1 } from '@happier-dev/protocol/widgets';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createWidgetAreaActionDepsV1 } from './widgetAreaActionDeps';
// Match the application entry before Account restoration; real owner initialization belongs to collection.
import '@/sync/syncEngine';

it('uses a stable Project key without a Source through the actual Account Artifact codec', async () => {
    const provisional = { serverId: 'home', accountId: 'actor', owner: { kind: 'project' as const, projectId: 'stable-project' } };
    let surface = provisional;
    let boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1 as const, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
    });
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://source-free-dashboard.test', accountId: 'actor', request: (...args) => boundary.request(...args) });
    surface = { ...provisional, serverId: connection.home.id };
    boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1 as const, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
    });
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const port = createWidgetAreaActionDepsV1(account).widgetSurfaceActions!.project!;
        const defaults = projectOverviewDefaultPlacementsV1();
        expect(await port.read(surface, { surface: 'ui' })).toMatchObject({ surface, state: 'missing', canEdit: true, instances: defaults.map(({ kind: _kind, ...entry }) => entry) });
        expect(boundary.writes).toHaveLength(0);
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} };
        expect(await port.apply(surface, { kind: 'add', instance }, { surface: 'ui' })).toMatchObject({ ok: true });
        const saved = flattenWidgetLayoutWidgetsV1(boundary.layout().items);
        expect(saved.filter(entry => entry.instance.id !== instance.id).map(entry => ({ id: entry.instance.id, area: entry.area })))
            .toEqual(defaults.map(entry => ({ id: entry.instance.id, area: entry.area })));
        expect(saved.find(entry => entry.instance.id === instance.id)).toMatchObject({ instance, area: 'main' });
        expect(await port.read({ ...surface, accountId: 'foreign' }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'widget_area_owner_mismatch' });
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
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://shared-dashboard.test', accountId: 'viewer', request: (...args) => boundary.request(...args) });
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
