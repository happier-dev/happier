import { describe, expect, it } from 'vitest';
import { buildWidgetSurfaceArtifactIdV1, createWidgetSurfaceArtifactPortV1, createWidgetAreaActionPortV1, flattenWidgetLayoutWidgetsV1, type WidgetSurfaceRefV1 } from './index.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { enrichWorkspaceRefV1, projectWorkspaceRefV1 } from '../workspaces/workspaceRefResolutionV1.js';
import { WorkspaceRefV1Schema } from '../workspaces/workspaceRefV1.js';
import { createWidgetAreaLayoutArtifactPortV1 } from './widgetSurfaceArtifactV1.js';
import * as areaOwner from './widgetSurfaceArtifactV1.js';

const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } };
const instance = (id: string, value = 'A') => ({ v: 1 as const, id, definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: { session: { kind: 'value' as const, value } } });
function boundary() {
    const b = createWorkBoardArtifactBoundary();
    const transport = b.forAccount('one');
    const port = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    return { ...b, transport, port, dashboardTransport: { ...transport, list: b.transport.list, delete: b.transport.delete } };
}

describe('personal widget areas at the Account Artifact owner', () => {
    it('lists the same edited state Reset uses through edit, reset, undo, rename and reorder', async () => {
        const b = boundary();
        const core: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } };
        const presets = [{ id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const, instance: instance('preset') }] },
            { id: 'costs', name: 'Costs', items: [] }];
        const views = createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: core, presets, isCurrent: () => true });
        const initial = await views.list();
        expect(initial.map(layout => layout.isEdited)).toEqual([false, false]);
        const selected = initial[0]!;
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: selected.surface, presets, isCurrent: () => true });
        const edited = async () => {
            const state = await port.readState();
            const listed = (await views.list()).find(layout => layout.artifactId === selected.artifactId)!;
            expect(listed.isEdited).toBe(state.preset?.isEdited);
            return listed;
        };
        await port.apply({ kind: 'rename', instanceId: 'preset', displayName: 'Mine' });
        expect((await edited()).isEdited).toBe(true);
        const reset = await port.resetPreset();
        expect((await edited()).isEdited).toBe(false);
        await port.undoReset(reset.undo!);
        expect((await edited()).isEdited).toBe(true);
        await port.resetPreset();
        const personal = await edited();
        await views.reorder({ surface: selected.surface, expectedRevision: personal.revision,
            position: { placement: 'after', anchorId: initial[1]!.artifactId } });
        expect((await edited()).isEdited).toBe(false);
        const renamed = await views.rename({ surface: selected.surface, expectedRevision: (await edited()).revision, name: 'My overview' });
        expect(renamed.isEdited).toBe(true);
        expect((await edited()).isEdited).toBe(true);
        expect((await views.create({ layoutId: 'mine', name: 'Mine', fromSurface: selected.surface })).isEdited).toBe(false);
    });
    it('lists core-page host layouts and copies the selected current layout into an independent user view', async () => {
        const b = boundary();
        const core: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'corePage', pageId: 'usage', area: 'main' } };
        const presets = [{ id: 'overview', name: 'Overview', items: [
            { kind: 'widget' as const, instance: instance('preset') },
            { kind: 'group' as const, id: 'group', width: 'full' as const, title: 'Details', children: [{ kind: 'widget' as const, instance: instance('child') }] },
        ] }, { id: 'costs', name: 'Costs', items: [] }];
        const views = areaOwner.createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: core, presets, isCurrent: () => true });
        const listed = await views.list();
        expect(listed).toMatchObject([{ name: 'Overview', isPreset: true }, { name: 'Costs', isPreset: true }]);
        expect(b.rows.size).toBe(0);
        const source = listed[0]!.surface;
        const editing = createWidgetSurfaceArtifactPortV1(b.transport, { surface: source, presets, isCurrent: () => true });
        await editing.apply({ kind: 'rename', instanceId: 'preset', displayName: 'My data' });
        const copied = await views.create({ layoutId: 'mine', name: 'Mine', fromSurface: source });
        const copy = createWidgetSurfaceArtifactPortV1(b.transport, { surface: copied.surface, isCurrent: () => true });
        expect((await copy.read()).items).toEqual((await editing.read()).items);
        expect((await copy.read()).items).toMatchObject([{ instance: { displayName: 'My data' } },
            { kind: 'group', title: 'Details', children: [{ instance: { id: 'child' } }] }]);
        await copy.apply({ kind: 'rename', instanceId: 'child', displayName: 'Copied child' });
        expect(flattenWidgetLayoutWidgetsV1((await editing.read()).items).find(entry => entry.instance.id === 'child')?.instance.displayName).toBeUndefined();
        await copy.apply({ kind: 'remove', instanceId: 'preset' });
        await copy.apply({ kind: 'remove', instanceId: 'group' });
        expect((await editing.read()).items).toHaveLength(2);
        expect((await copy.read()).items).toEqual([]);
        expect((await views.list()).map(row => row.name)).toEqual(['Overview', 'Costs', 'Mine']);
    });
    it('refuses Reset when a concurrent edit wins its CAS instead of overwriting the new personal layout', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'reset-race' } };
        const owner = createWidgetSurfaceArtifactPortV1(b.transport, { surface: project, isCurrent: () => true });
        await owner.apply({ kind: 'rename', instanceId: 'about', displayName: 'Mine' });
        let racing = true;
        const port = createWidgetSurfaceArtifactPortV1({ ...b.transport, update: async input => {
            if (racing) { racing = false; await owner.apply({ kind: 'rename', instanceId: 'about', displayName: 'Later' }); }
            return b.transport.update(input);
        } }, { surface: project, isCurrent: () => true });
        const state = await owner.readState();
        if (state.kind !== 'present') throw new Error('Expected personal layout');
        await expect(port.resetPreset()).rejects.toMatchObject({ code: 'version_mismatch' });
        expect((await owner.read()).items).toMatchObject(expect.arrayContaining([expect.objectContaining({ instance: expect.objectContaining({ displayName: 'Later' }) })]));
    });
    it('preserves host tab order on first item or metadata edit and keeps an explicit personal reorder', async () => {
        const b = boundary();
        const core: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } };
        const presets = ['one', 'two', 'three'].map(id => ({ id, name: id, items: [{ kind: 'widget' as const, instance: instance(id) }] }));
        const views = createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: core, presets, isCurrent: () => true });
        const initial = await views.list();
        const second = initial[1]!;
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: second.surface, presets, isCurrent: () => true });
        await port.apply({ kind: 'rename', instanceId: 'two', displayName: 'Mine' });
        expect(b.rows.get(second.artifactId)?.header.sortKey).toBe(second.sortKey);
        await views.rename({ surface: initial[2]!.surface, expectedRevision: null, name: 'Third' });
        expect((await views.list()).map(entry => entry.name)).toEqual(['one', 'two', 'Third']);
        const personal = (await views.list())[1]!;
        await views.reorder({ surface: second.surface, expectedRevision: personal.revision!, position: { placement: 'before', anchorId: initial[0]!.artifactId } });
        await port.apply({ kind: 'rename', instanceId: 'two', displayName: 'Later' });
        expect((await views.list()).map(entry => entry.name)).toEqual(['two', 'one', 'Third']);
    });
    it('projects a named core-page preset without writing and personalizes only its first edit', async () => {
        const b = boundary();
        const core: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
        const preset = { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const, instance: instance('preset') }] };
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: core, presets: [preset], isCurrent: () => true });
        expect((await port.read()).items).toEqual(preset.items);
        expect(await port.readState()).toMatchObject({ kind: 'missing', preset: { id: 'overview', isEdited: false } });
        expect(b.rows.size).toBe(0);
        await port.apply({ kind: 'rename', instanceId: 'preset', displayName: 'Mine' });
        expect(await port.readState()).toMatchObject({ kind: 'present', preset: { id: 'overview', isEdited: true } });
        expect(preset.items[0]?.instance).not.toHaveProperty('displayName');
        expect((await port.read()).items).toMatchObject([{ instance: { id: 'preset', displayName: 'Mine' } }]);
        expect(b.rows.size).toBe(1);
    });
    it('resets a preset immediately, restores its personal copy with Undo and rejects Undo after a later edit', async () => {
        const b = boundary();
        const core: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
        const preset = { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const, instance: instance('preset') }] };
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: core, presets: [preset], isCurrent: () => true });
        await port.apply({ kind: 'rename', instanceId: 'preset', displayName: 'Mine' });
        const reset = await port.resetPreset();
        expect(reset.layout.items).toEqual(preset.items);
        expect(await port.readState()).toMatchObject({ preset: { isEdited: false } });
        await port.undoReset(reset.undo!);
        expect((await port.read()).items).toMatchObject([{ instance: { displayName: 'Mine' } }]);
        const again = await port.resetPreset();
        await port.apply({ kind: 'rename', instanceId: 'preset', displayName: 'Later' });
        await expect(port.undoReset(again.undo!)).rejects.toMatchObject({ code: 'version_mismatch' });
        expect((await port.read()).items).toMatchObject([{ instance: { displayName: 'Later' } }]);
        expect(preset.items[0]?.instance).not.toHaveProperty('displayName');
    });
    it('keeps different named presets independent and gives preset groups Card and Lines defaults', async () => {
        const b = boundary();
        const core: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
        const preset = { id: 'overview', name: 'Overview', items: [{ kind: 'group' as const, id: 'group', width: 'full' as const, children: [{ kind: 'widget' as const, instance: instance('child') }] }] };
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: core, presets: [preset], isCurrent: () => true });
        expect((await port.read()).items).toMatchObject([{ kind: 'group', frameStyle: 'card', dividers: 'hairline' }]);
        await port.apply({ kind: 'rename', instanceId: 'group', displayName: 'Mine' });
        const other: WidgetSurfaceRefV1 = { ...core, owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'costs' } };
        const costs = createWidgetSurfaceArtifactPortV1(b.transport, { surface: other, presets: [{ ...preset, id: 'costs', name: 'Costs' }], isCurrent: () => true });
        expect(await costs.readState()).toMatchObject({ kind: 'missing', preset: { isEdited: false } });
        expect((await costs.read()).items).not.toMatchObject([{ title: 'Mine' }]);
        const unavailable = createWidgetSurfaceArtifactPortV1(b.transport, { surface: { ...core, owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'unavailable' } }, presets: [preset], isCurrent: () => true });
        await expect(unavailable.read()).rejects.toMatchObject({ code: 'widget_area_not_found' });
        expect(() => createWidgetSurfaceArtifactPortV1(b.transport, { surface: core, presets: [preset, preset], isCurrent: () => true })).toThrow('widget_area_preset_mismatch');
    });
    it('draws missing Overview defaults without writes and materializes the whole layout on its first explicit edit', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'project', projectId: 'defaults' } };
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: project, isCurrent: () => true });
        expect(await port.readState()).toMatchObject({ kind: 'missing' });
        expect(flattenWidgetLayoutWidgetsV1((await port.read()).items).map(entry => [entry.instance.id, entry.area])).toEqual([
            ['code', 'main'], ['readme', 'main'], ['about', 'aside'], ['changes', 'aside'],
            ['checkouts', 'aside'], ['scripts', 'aside'], ['sessions', 'aside'],
        ]);
        expect(b.rows.size).toBe(0);
        expect(await createWidgetAreaActionPortV1(() => port).read(project, {})).toMatchObject({
            state: 'missing', instances: expect.arrayContaining([{ area: 'main', frameStyle: 'plain', instance: {
                v: 1, id: 'code', definition: { kind: 'builtin', id: 'project_code' }, bindings: { checkout: { kind: 'context', slot: 'checkout' } },
            } }]),
        });
        await port.apply({ kind: 'rename', instanceId: 'about', displayName: 'Our project' });
        expect(await port.readState()).toMatchObject({ kind: 'present' });
        expect(flattenWidgetLayoutWidgetsV1((await port.read()).items)).toHaveLength(7);
        expect(flattenWidgetLayoutWidgetsV1((await port.read()).items).find(entry => entry.instance.id === 'about')?.instance.displayName).toBe('Our project');
        for (const entry of flattenWidgetLayoutWidgetsV1((await port.read()).items)) await port.apply({ kind: 'remove', instanceId: entry.instance.id });
        expect(flattenWidgetLayoutWidgetsV1((await port.read()).items)).toEqual([]);
        expect(await port.readState()).toMatchObject({ kind: 'present', layout: { items: [] } });
        expect(b.rows.size).toBe(1);
    });
    it('uses one canonical Project Overview Artifact for omitted and explicit default layout identities', async () => {
        const b = boundary();
        const implicit: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'one-overview' } };
        const explicit: WidgetSurfaceRefV1 = { ...implicit, owner: { kind: 'project', projectId: 'one-overview', layoutId: 'overview' } };
        const first = createWidgetSurfaceArtifactPortV1(b.transport, { surface: explicit, isCurrent: () => true });
        const second = createWidgetSurfaceArtifactPortV1(b.transport, { surface: implicit, isCurrent: () => true });
        expect(first.surface).toEqual(implicit);
        expect(buildWidgetSurfaceArtifactIdV1(explicit)).toBe(buildWidgetSurfaceArtifactIdV1(implicit));
        expect((await first.read()).surface).toEqual(implicit);
        expect(b.rows.size).toBe(0);
        await first.apply({ kind: 'rename', instanceId: 'about', displayName: 'Mine' });
        await second.apply({ kind: 'rename', instanceId: 'about', displayName: 'Later' });
        expect((await first.read()).items).toEqual((await second.read()).items);
        expect(b.rows.size).toBe(1);
        expect(JSON.parse(b.rows.get(buildWidgetSurfaceArtifactIdV1(implicit))!.body!).surface).toEqual(implicit);
    });
    it('projects render-only defaults through Actions and retains them on a first dashboard metadata edit', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'project', projectId: 'metadata-defaults' } };
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: project, isCurrent: () => true });
        const area = createWidgetAreaActionPortV1(() => port);
        expect(await area.read(project, {})).toMatchObject({ state: 'missing', instances: [
            { instance: { id: 'code' } }, { instance: { id: 'readme' } }, { instance: { id: 'about' } },
            { instance: { id: 'changes' } }, { instance: { id: 'checkouts' } }, { instance: { id: 'scripts' } }, { instance: { id: 'sessions' } },
        ] });
        expect(b.rows.size).toBe(0);
        const dashboards = createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: project, isCurrent: () => true });
        await dashboards.rename({ surface: project, expectedRevision: null, name: 'My overview' });
        expect(await port.read()).toMatchObject({ name: 'My overview', items: Array.from({ length: 7 }, () => ({ instance: {} })) });
        expect(await port.readState()).toMatchObject({ preset: { isEdited: true } });
        const reset = await port.resetPreset();
        expect(reset.layout.name).toBe('Overview');
        await port.undoReset(reset.undo!);
        expect((await port.read()).name).toBe('My overview');
        const ordered: WidgetSurfaceRefV1 = { ...project, owner: { kind: 'project', projectId: 'ordered-defaults' } };
        const ordering = createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: ordered, isCurrent: () => true });
        const named = await ordering.create({ layoutId: 'named', name: 'Empty' });
        await ordering.reorder({ surface: ordered, expectedRevision: null, position: { placement: 'after', anchorId: named.artifactId } });
        expect(flattenWidgetLayoutWidgetsV1((await createWidgetSurfaceArtifactPortV1(b.transport, { surface: ordered, isCurrent: () => true }).read()).items)).toHaveLength(7);
    });
    it('uses the selected Project host layout name in its render-only Action metadata', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'host-layouts', layoutId: 'costs' } };
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: project, presets: [{ id: 'costs', name: 'Costs', items: [] }], isCurrent: () => true });
        expect(await createWidgetAreaActionPortV1(() => port).read(project, {})).toMatchObject({ state: 'missing',
            dashboard: { name: 'Costs' }, preset: { id: 'costs', name: 'Costs' }, items: [] });
        expect(b.rows.size).toBe(0);
    });
    it('sets selected inputs against the current CAS winner and retains unrelated choices', async () => {
        const b = boundary();
        const bindings = { connection: { kind: 'value' as const, value: 'private' }, count: { kind: 'value' as const, value: 1 } };
        await b.port.apply({ kind: 'add', instance: { ...instance('a'), bindings } });
        let concurrent = true;
        const editing = createWidgetSurfaceArtifactPortV1({ ...b.transport, update: async input => {
            if (concurrent) {
                concurrent = false;
                await b.port.apply({ kind: 'inputs', instanceId: 'a', bindings: { ...bindings, count: { kind: 'value', value: 2 } } });
            }
            return b.transport.update(input);
        } }, { surface, isCurrent: () => true });
        await editing.apply({ kind: 'inputs', instanceId: 'a', bindings: { connection: { kind: 'value', value: 'public' } }, paths: ['connection'] });
        expect(flattenWidgetLayoutWidgetsV1((await b.port.read()).items)[0]?.instance.bindings).toEqual({ connection: { kind: 'value', value: 'public' }, count: { kind: 'value', value: 2 } });
    });
    it('does not discover another owner document from matching stored Project header facts', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'inventory' } };
        const dashboards = createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: project, isCurrent: () => true });
        const created = await dashboards.create({ layoutId: 'named', name: 'Own' });
        const row = b.rows.get(created.artifactId)!;
        const transport = { ...b.dashboardTransport, list: async () => ({ items: [{ artifactId: row.artifactId, header: row.header,
            ...row.revision, ownerAccountId: 'other', access: 'edit' as const }] }) };
        const admitted = createWidgetAreaLayoutArtifactPortV1(transport, { surface: project, isCurrent: () => true });
        expect(await admitted.list()).toMatchObject([{ isDefault: true }]);
        expect(await admitted.list()).toHaveLength(1);
    });
    it('resets selected inputs against the latest CAS winner without overwriting unrelated choices', async () => {
        const b = boundary();
        await b.port.apply({ kind: 'add', instance: { ...instance('a'), bindings: {
            connection: { kind: 'value', value: 'private' }, count: { kind: 'value', value: 1 },
        } } });
        let concurrent = true;
        const resetting = createWidgetSurfaceArtifactPortV1({ ...b.transport, update: async input => {
            if (concurrent) {
                concurrent = false;
                await b.port.apply({ kind: 'inputs', instanceId: 'a', bindings: {
                    connection: { kind: 'value', value: 'private' }, count: { kind: 'value', value: 2 },
                } });
            }
            return b.transport.update(input);
        } }, { surface, isCurrent: () => true });
        await resetting.apply({ kind: 'inputs_reset', instanceId: 'a', paths: ['connection'] });
        expect(flattenWidgetLayoutWidgetsV1((await b.port.read()).items)[0]?.instance.bindings).toEqual({ count: { kind: 'value', value: 2 } });
    });
    it('reloads anchored personal dashboards unchanged after hosting and Source enrichment', async () => {
        const b = boundary();
        const ref = { id: 'fallback', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
        const projectSurface = (value: typeof ref): WidgetSurfaceRefV1 => ({ serverId: value.serverId, accountId: 'one',
            owner: { kind: 'project', projectId: projectWorkspaceRefV1(value).projectKey } });
        const originalSurface = projectSurface(ref);
        const original = createWidgetSurfaceArtifactPortV1(b.transport, { surface: originalSurface, isCurrent: () => true });
        await original.apply({ kind: 'add', instance: instance('main'), area: 'main' });
        await original.apply({ kind: 'add', instance: instance('aside', 'Aside'), area: 'aside' });
        const before = await original.read();
        const named = await createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: originalSurface, isCurrent: () => true })
            .create({ layoutId: 'named', name: 'Named' });
        const namedPort = createWidgetSurfaceArtifactPortV1(b.transport, { surface: named.surface, isCurrent: () => true });
        await namedPort.apply({ kind: 'add', instance: instance('named-main'), area: 'main' });
        await namedPort.apply({ kind: 'add', instance: instance('named-aside'), area: 'aside' });
        const namedBefore = await namedPort.read();
        const enriched = WorkspaceRefV1Schema.parse(enrichWorkspaceRefV1(ref, {
            repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' },
            source: { sourceId: 'source', revision: 2 },
        }));
        const reloadedSurface = projectSurface(enriched);
        expect(buildWidgetSurfaceArtifactIdV1(reloadedSurface)).toBe(buildWidgetSurfaceArtifactIdV1(originalSurface));
        const reloaded = createWidgetSurfaceArtifactPortV1(b.transport, { surface: reloadedSurface, isCurrent: () => true });
        expect(await reloaded.read()).toEqual(before);
        const namedReloadSurface: WidgetSurfaceRefV1 = { ...reloadedSurface,
            owner: { kind: 'project', projectId: projectWorkspaceRefV1(enriched).projectKey, layoutId: 'named' } };
        expect(buildWidgetSurfaceArtifactIdV1(namedReloadSurface)).toBe(named.artifactId);
        expect(await createWidgetSurfaceArtifactPortV1(b.transport, { surface: namedReloadSurface, isCurrent: () => true }).read()).toEqual(namedBefore);
        const independent = enrichWorkspaceRefV1({ ...ref, id: 'independent' }, { repositoryIdentity: enriched.repositoryIdentity });
        expect(buildWidgetSurfaceArtifactIdV1(projectSurface(independent))).not.toBe(buildWidgetSurfaceArtifactIdV1(originalSurface));
        expect(b.rows.size).toBe(2);
    });
    it('keeps paged named dashboards independent, protects the default and writes only the reordered document', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'project', projectId: 'source-free' } };
        const transport = { ...b.transport, list: async ({ cursor }: { cursor?: string }) => {
            const items = [...b.rows.values()].map(row => ({ artifactId: row.artifactId, header: row.header, ...row.revision,
                ownerAccountId: row.ownerAccountId, access: row.access }));
            return cursor ? { items: items.slice(1) } : { items: items.slice(0, 1), ...(items.length > 1 ? { nextCursor: 'next' } : {}) };
        }, delete: b.dashboardTransport.delete };
        const dashboards = createWidgetAreaLayoutArtifactPortV1(transport, { surface: project, isCurrent: () => true });
        expect(await dashboards.list()).toMatchObject([{ name: 'Overview', isDefault: true, revision: null }]);
        expect(b.rows.size).toBe(0);
        const release = await dashboards.create({ layoutId: 'release', name: 'Release' });
        const notes = await dashboards.create({ layoutId: 'notes', name: 'Notes' });
        expect(release.artifactId).not.toBe(notes.artifactId);
        const layout = createWidgetSurfaceArtifactPortV1(transport, { surface: release.surface, isCurrent: () => true });
        await layout.apply({ kind: 'add', instance: instance('main'), area: 'main' });
        await layout.apply({ kind: 'add', instance: instance('aside'), area: 'aside' });
        const before = (await dashboards.list()).find(item => item.artifactId === release.artifactId)!;
        const renamed = await dashboards.rename({ surface: release.surface, name: 'Launch', expectedRevision: before.revision! });
        expect(renamed.artifactId).toBe(release.artifactId);
        expect(flattenWidgetLayoutWidgetsV1((await layout.read()).items).map(entry => entry.area)).toEqual(['main', 'aside']);
        const writes = b.updates.length;
        await dashboards.reorder({ surface: release.surface, position: { placement: 'before', anchorId: buildWidgetSurfaceArtifactIdV1(project) }, expectedRevision: renamed.revision! });
        expect(b.updates.slice(writes)).toEqual([release.artifactId]);
        expect((await dashboards.list()).map(item => item.name)).toEqual(['Launch', 'Overview', 'Notes']);
        await expect(dashboards.delete({ surface: project, expectedRevision: { headerVersion: 0, bodyVersion: 0 } })).rejects.toMatchObject({ code: 'widget_area_layout_default_protected' });
        await expect(dashboards.rename({ surface: release.surface, name: 'Stale', expectedRevision: renamed.revision! })).rejects.toMatchObject({ code: 'version_mismatch' });
        await dashboards.delete({ surface: notes.surface, expectedRevision: notes.revision! });
        expect((await dashboards.list()).map(item => item.name)).toEqual(['Launch', 'Overview']);
    });
    it('moves between the two areas under one revision and distinguishes missing from present empty', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'stable' } };
        const port = createWidgetSurfaceArtifactPortV1(b.transport, { surface: project, isCurrent: () => true });
        expect(await port.readState()).toMatchObject({ kind: 'missing' });
        expect(b.rows.size).toBe(0);
        await port.apply({ kind: 'add', instance: instance('a'), area: 'main' });
        await port.apply({ kind: 'add', instance: instance('b'), area: 'aside' });
        await port.apply({ kind: 'move', instanceId: 'a', toIndex: 6, area: 'aside' });
        expect(flattenWidgetLayoutWidgetsV1((await port.read()).items).filter(entry => ['a', 'b'].includes(entry.instance.id)).map(entry => [entry.instance.id, entry.area])).toEqual([['b', 'aside'], ['a', 'aside']]);
        const updates = b.updates.length;
        await port.apply({ kind: 'move', instanceId: 'a', toIndex: 6, area: 'aside' });
        expect(b.updates.length).toBe(updates);
        await port.apply({ kind: 'remove', instanceId: 'a' });
        await port.apply({ kind: 'remove', instanceId: 'b' });
        for (const entry of flattenWidgetLayoutWidgetsV1((await port.read()).items)) await port.apply({ kind: 'remove', instanceId: entry.instance.id });
        expect(await port.readState()).toMatchObject({ kind: 'present', layout: { items: [] } });
        expect(b.rows.size).toBe(1);
    });
    it('uses current shared Artifact access, preserves owner order and refuses after revoke', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'shared', layoutId: 'release' } };
        const dashboards = createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: project, isCurrent: () => true });
        const created = await dashboards.create({ layoutId: 'release', name: 'Release' });
        const owner = createWidgetSurfaceArtifactPortV1(b.transport, { surface: project, isCurrent: () => true });
        await owner.apply({ kind: 'add', instance: instance('a'), area: 'main' });
        let access: 'view' | 'edit' | null = 'view';
        const recipient = createWidgetSurfaceArtifactPortV1({ ...b.transport, read: async id => {
            if (!access) throw Object.assign(new Error('revoked'), { code: 'artifact_access_forbidden' });
            const row = b.rows.get(id);
            return row ? { ...row, ownerAccountId: 'one', access } : null;
        } }, { surface: { ...project, artifactId: created.artifactId }, isCurrent: () => true });
        const area = createWidgetAreaActionPortV1(() => recipient);
        expect(await area.read(recipient.surface, {})).toMatchObject({ canEdit: false, instances: [{ instance: { id: 'a' } }],
            dashboard: { name: 'Release', ownerAccountId: 'one', access: 'view' } });
        await expect(recipient.apply({ kind: 'rename', instanceId: 'a', displayName: 'Denied' })).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
        access = 'edit';
        expect(await area.read(recipient.surface, {})).toMatchObject({ canEdit: true,
            dashboard: { name: 'Release', ownerAccountId: 'one', access: 'edit' } });
        const sortKey = b.rows.get(created.artifactId)!.header.sortKey;
        await recipient.apply({ kind: 'rename', instanceId: 'a', displayName: 'Shared edit' });
        expect(flattenWidgetLayoutWidgetsV1((await owner.read()).items)[0]?.instance.displayName).toBe('Shared edit');
        expect(b.rows.get(created.artifactId)!.header.sortKey).toBe(sortKey);
        expect(JSON.parse(b.rows.get(created.artifactId)!.body!).surface).toEqual(project);
        access = null;
        expect(await area.read(recipient.surface, {})).toMatchObject({ ok: false, errorCode: 'artifact_access_forbidden' });
        await expect(recipient.read()).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
        await expect(recipient.apply({ kind: 'remove', instanceId: 'a' })).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
        expect(flattenWidgetLayoutWidgetsV1((await owner.read()).items)).toHaveLength(1);
    });
    it('does not infer edit authority for a present row with no admitted caller access', async () => {
        const b = boundary();
        await b.port.apply({ kind: 'add', instance: instance('a') });
        const port = createWidgetSurfaceArtifactPortV1({ ...b.transport, read: async id => {
            const row = await b.transport.read(id);
            if (!row) return null;
            const { access: _unavailable, ...unknown } = row;
            return unknown;
        } }, { surface, isCurrent: () => true });
        await expect(port.read()).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
        await expect(port.apply({ kind: 'remove', instanceId: 'a' })).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
    });
    it('can reorder documents created concurrently without changing sibling headers', async () => {
        const b = boundary();
        const project: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'concurrent' } };
        const dashboards = createWidgetAreaLayoutArtifactPortV1(b.dashboardTransport, { surface: project, isCurrent: () => true });
        const [a, c] = await Promise.all([
            dashboards.create({ layoutId: 'a', name: 'A' }), dashboards.create({ layoutId: 'c', name: 'C' }),
        ]);
        const middle = await dashboards.create({ layoutId: 'b', name: 'B' });
        const untouched = [a, c].map(entry => b.rows.get(entry.artifactId)!.header);
        const ordered = (await dashboards.list()).filter(entry => !entry.isDefault && entry.artifactId !== middle.artifactId);
        await dashboards.reorder({ surface: middle.surface, expectedRevision: middle.revision,
            position: { anchorId: ordered[1]!.artifactId, placement: 'before' } });
        expect((await dashboards.list()).filter(entry => !entry.isDefault).map(entry => entry.artifactId))
            .toEqual([ordered[0]!.artifactId, middle.artifactId, ordered[1]!.artifactId]);
        expect([a, c].map(entry => b.rows.get(entry.artifactId)!.header)).toEqual(untouched);
    });
    it('drops nested stored extras while keeping required identity and Action inputs strict', async () => {
        const b = boundary();
        await b.port.apply({ kind: 'add', instance: instance('a') });
        const id = buildWidgetSurfaceArtifactIdV1(surface);
        const row = b.rows.get(id)!;
        const canonical = JSON.parse(row.body!);
        const raw = { ...canonical, extra: true, surface: { ...surface, extra: true, owner: { ...surface.owner, extra: true } },
            items: [{ ...canonical.items[0], extra: true, instance: { ...instance('a'), extra: true } }] };
        b.rows.set(id, { ...row, body: JSON.stringify(raw) });
        expect(await b.port.read()).toEqual(canonical);
        await b.port.apply({ kind: 'rename', instanceId: 'a', displayName: 'Renamed' });
        expect(JSON.parse(b.rows.get(id)!.body!)).toEqual({ ...canonical, items: [{ ...canonical.items[0], instance: { ...instance('a'), displayName: 'Renamed' } }] });
        await expect(b.port.apply({ kind: 'add', instance: { ...instance('b'), extra: true } } as Parameters<typeof b.port.apply>[0])).rejects.toBeDefined();
        b.rows.set(id, { ...row, body: JSON.stringify({ ...raw, surface: { ...raw.surface, accountId: undefined } }) });
        await expect(b.port.read()).rejects.toMatchObject({ code: 'invalid_widget_area_record' });
    });
    it('preserves both adds when another writer edits before the singleton create acknowledgement returns', async () => {
        const b = boundary();
        const delayed = createWidgetSurfaceArtifactPortV1({ ...b.transport, create: async input => {
            const result = await b.transport.create(input);
            await b.port.apply({ kind: 'add', instance: instance('b') });
            return result;
        } }, { surface, isCurrent: () => true });
        await expect(delayed.apply({ kind: 'add', instance: instance('a') })).resolves.toMatchObject({ items: [{ instance: { id: 'b' } }, { instance: { id: 'a' } }] });
        expect(flattenWidgetLayoutWidgetsV1((await b.port.read()).items).map(entry => entry.instance.id)).toEqual(['b', 'a']);
    });
    it('persists independent copies, bindings, frame, size and order through conflict replay and reload', async () => {
        const b = boundary();
        expect(flattenWidgetLayoutWidgetsV1((await b.port.read()).items)).toEqual([]);
        expect(b.rows.size).toBe(0);
        await Promise.all([b.port.apply({ kind: 'add', instance: instance('a'), size: 'tall' }), b.port.apply({ kind: 'add', instance: instance('b', 'B') })]);
        expect(flattenWidgetLayoutWidgetsV1((await b.port.read()).items).find(entry => entry.instance.id === 'a')).toMatchObject({ size: 'tall' });
        await Promise.all([b.port.apply({ kind: 'size', instanceId: 'a', size: 'large' }), b.port.apply({ kind: 'frame', instanceId: 'b', frameStyle: 'card' })]);
        await b.port.apply({ kind: 'inputs', instanceId: 'a', bindings: instance('a', 'C').bindings });
        await b.port.apply({ kind: 'move', instanceId: 'b', toIndex: 0 });
        const reload = createWidgetSurfaceArtifactPortV1(b.transport, { surface, isCurrent: () => true });
        expect(flattenWidgetLayoutWidgetsV1((await reload.read()).items)).toEqual([
            { kind: 'widget', instance: instance('b', 'B'), size: 'medium', frameStyle: 'card' }, { kind: 'widget', instance: instance('a', 'C'), size: 'large' },
        ]);
        expect(b.rows.size).toBe(1);
    });
    it('qualifies singleton identity by Home, Account, plugin, page and area', () => {
        const variations = [surface, { ...surface, serverId: 'other' }, { ...surface, accountId: 'two' },
            ...['pluginId', 'pageId', 'area'].map(key => ({ ...surface, owner: { ...surface.owner, [key]: 'other' } }))];
        expect(new Set(variations.map(buildWidgetSurfaceArtifactIdV1)).size).toBe(variations.length);
    });
    it('refuses invalid or substituted rows without resetting them and preserves transport mode refusals', async () => {
        const b = boundary();
        await b.port.apply({ kind: 'add', instance: instance('a') });
        const id = buildWidgetSurfaceArtifactIdV1(surface);
        const original = b.rows.get(id)!;
        b.rows.set(id, { ...original, body: JSON.stringify({ v: 1, surface: { ...surface, accountId: 'other' }, items: [] }) });
        await expect(b.port.apply({ kind: 'remove', instanceId: 'a' })).rejects.toMatchObject({ code: 'invalid_widget_area_record' });
        expect(b.rows.get(id)?.body).not.toBe(original.body);
        const refused = createWidgetSurfaceArtifactPortV1({ ...b.transport, read: async () => { throw Object.assign(new Error('mode mismatch'), { code: 'artifact_account_mode_mismatch' }); } }, { surface, isCurrent: () => true });
        await expect(refused.read()).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
        await expect(refused.apply({ kind: 'add', instance: instance('new') })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    });
    it('fences late page/Account callbacks before writes and refuses conditional removal after a concurrent edit', async () => {
        const b = boundary();
        await b.port.apply({ kind: 'add', instance: instance('a') });
        const adapter = createWidgetAreaActionPortV1(() => b.port);
        const captured = await adapter.captureMove!(surface, 'a', {});
        expect(captured).toHaveProperty('expectedInstance');
        await b.port.apply({ kind: 'rename', instanceId: 'a', displayName: 'Edited' });
        if ('ok' in captured) throw new Error('capture refused');
        expect(await adapter.apply(surface, { kind: 'remove', instanceId: 'a', ...captured }, {})).toMatchObject({ ok: false, errorCode: 'widget_instance_changed' });
        const updates = b.updates.length;
        let current = true;
        const retired = createWidgetSurfaceArtifactPortV1({ ...b.transport, read: async id => { const row = await b.transport.read(id); current = false; return row; } }, { surface, isCurrent: () => current });
        await expect(retired.apply({ kind: 'remove', instanceId: 'a' })).rejects.toMatchObject({ code: 'widget_area_scope_retired' });
        expect(b.updates).toHaveLength(updates);
    });
    it('keeps Project order/Plain geometry linear while plugin areas admit grid sizes', async () => {
        const b = boundary();
        const project = createWidgetSurfaceArtifactPortV1(b.transport, { surface: { ...surface, owner: { kind: 'project', projectId: 'source' } }, isCurrent: () => true });
        const defaults = flattenWidgetLayoutWidgetsV1((await project.read()).items);
        const updated = flattenWidgetLayoutWidgetsV1((await project.apply({ kind: 'add', instance: instance('a') })).items);
        expect(updated.filter(entry => entry.instance.id === 'a')).toEqual([{ kind: 'widget', instance: instance('a'), area: 'main' }]);
        expect(updated.filter(entry => entry.instance.id !== 'a')).toEqual(defaults);
        await expect(project.apply({ kind: 'size', instanceId: 'a', size: 'full' })).rejects.toMatchObject({ code: 'widget_size_unsupported' });
    });
});

describe('an edited preset names what changed, from the same comparison Reset uses', () => {
    const core: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
    const widget = (id: string) => ({ kind: 'widget' as const, instance: instance(id) });
    const preset = { id: 'overview', name: 'Overview', items: [widget('daily'), widget('month'), widget('limits'), widget('days')] };
    const open = () => {
        const b = boundary();
        return createWidgetSurfaceArtifactPortV1(b.transport, { surface: core, presets: [preset], isCurrent: () => true });
    };
    const changes = async (port: ReturnType<typeof open>) => (await port.readState()).preset?.changes
        .map(change => [change.kind, change.kind === 'renamed' ? null : change.item.kind === 'widget' ? change.item.instance.id : change.item.id, 'direction' in change ? change.direction : undefined]);

    it('reports nothing for the untouched preset and after Reset', async () => {
        const port = open();
        expect((await port.readState()).preset).toMatchObject({ isEdited: false, changes: [] });
        await port.apply({ kind: 'remove', instanceId: 'days' });
        await port.resetPreset();
        expect((await port.readState()).preset).toMatchObject({ isEdited: false, changes: [] });
    });
    it('names the one item that moved (not the neighbours it passed) and the one that was removed', async () => {
        const port = open();
        await port.apply({ kind: 'move', instanceId: 'limits', toIndex: 0 });
        await port.apply({ kind: 'remove', instanceId: 'days' });
        expect(await changes(port)).toEqual([['moved', 'limits', 'up'], ['removed', 'days', undefined]]);
        const removed = (await port.readState()).preset!.changes.find(change => change.kind === 'removed');
        // A removed item is no longer in the layout: the summary carries the preset's own item so a reader can name it.
        expect(removed).toMatchObject({ item: preset.items[3] });
    });
    it('reports an item whose options changed, and one that was added, in the layout order', async () => {
        const port = open();
        await port.apply({ kind: 'rename', instanceId: 'month', displayName: 'Mine' });
        await port.apply({ kind: 'add', instance: instance('extra') });
        const read = await changes(port);
        expect(read).toContainEqual(['changed', 'month', undefined]);
        expect(read).toContainEqual(['added', 'extra', undefined]);
        expect(read).toHaveLength(2);
    });
    it('is edited exactly when it has a change to name', async () => {
        const port = open();
        await port.apply({ kind: 'move', instanceId: 'daily', toIndex: 3 });
        const state = (await port.readState()).preset!;
        expect(state.isEdited).toBe(true);
        expect(state.changes).toMatchObject([{ kind: 'moved', direction: 'down', item: { instance: { id: 'daily' } } }]);
    });
});
