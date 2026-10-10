import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import type { HomeHubArtifactTransportV1, HomeHubArtifactV1 } from '@happier-dev/protocol/home';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, admitWidgetActionSurfaceV1, type WidgetAreaLayoutV1 } from '@happier-dev/protocol/widgets';
import { createCliWidgetAreaActionDepsV1 } from './widgetAreaActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

it('edits the exact Source-free Project dashboard and refuses retired or foreign private scopes', async () => {
    const surface = { serverId: 'home', accountId: 'actor', owner: { kind: 'project' as const, projectId: 'stable-project' } };
    const rows = new Map<string, HomeHubArtifactV1>();
    let current = true;
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row); return row;
        },
        update: async input => {
            const row = rows.get(input.artifactId);
            if (!row || input.expectedRevision.bodyVersion !== row.revision.bodyVersion) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            const next = { ...row, header: input.header, body: input.body, revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } };
            rows.set(input.artifactId, next);
            return { ok: true, revision: next.revision };
        },
        list: async () => ({ items: [...rows.values()].map(row => ({ artifactId: row.artifactId, header: row.header,
            ownerAccountId: row.ownerAccountId, access: row.access, ...row.revision })) }),
        delete: async (id, options) => {
            const row = rows.get(id);
            if (!row || row.revision.bodyVersion !== options?.expectedRevision?.bodyVersion) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            rows.delete(id); return { ok: true };
        },
    };
    const preset = { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const,
        instance: { v: 1 as const, id: 'preset', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} } }] };
    const deps = createCliWidgetAreaActionDepsV1({ transport, scope: { serverId: 'home', accountId: 'actor' }, isCurrent: () => current,
        resolvePresets: target => target.owner.kind === 'corePage' ? [preset] : undefined });
    const port = deps.widgetSurfaceActions!.project!;
    const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} };
    expect(await port.apply(surface, { kind: 'add', instance }, { surface: 'cli' })).toMatchObject({ ok: true });
    expect(rows.get(buildWidgetSurfaceArtifactIdV1(surface))?.artifactId).toBe(buildWidgetSurfaceArtifactIdV1(surface));
    expect(await port.read(surface, { surface: 'cli' })).toMatchObject({ surface, canEdit: true, instances: expect.arrayContaining([expect.objectContaining({ instance })]) });
    expect(await port.read({ ...surface, accountId: 'foreign' }, { surface: 'cli' })).toMatchObject({ ok: false, errorCode: 'widget_area_owner_mismatch' });
    const core = { ...surface, owner: { kind: 'corePage' as const, pageId: 'usage', area: 'main', layoutId: 'overview' } };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
        widgetAccountScope: () => ({ serverId: 'home', accountId: 'actor' }) });
    const coreRead = await executor.execute('widgets.area.layout.select', { surface: core }, { surface: 'cli' });
    expect(coreRead).toMatchObject({ ok: true, result: { state: 'missing', items: preset.items, preset: { isEdited: false } } });
    expect(rows.has(buildWidgetSurfaceArtifactIdV1(core))).toBe(false);
    await deps.widgetSurfaceActions!.corePage!.apply(core, { kind: 'rename', instanceId: 'preset', displayName: 'Mine' }, { surface: 'cli' });
    const expectedRevision = rows.get(buildWidgetSurfaceArtifactIdV1(core))!.revision;
    expect(await executor.execute('widgets.area.layout.reset', { surface: core, expectedRevision }, { surface: 'cli' })).toMatchObject({ ok: false });
    const reset = await executor.execute('widgets.area.layout.reset', { surface: core, expectedRevision }, { surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId: 'widgets.area.layout.reset' } });
    expect(reset).toMatchObject({ ok: true, result: { layout: { items: preset.items }, undo: { surface: core } } });
    if (!reset.ok || !reset.result || typeof reset.result !== 'object' || !('undo' in reset.result)) throw new Error('Reset must return its acknowledged Undo capture');
    expect(await executor.execute('widgets.area.layout.undo', { capture: reset.result.undo }, { surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId: 'widgets.area.layout.undo' } })).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.area.layout.select', { surface: core }, { surface: 'cli' })).toMatchObject({ ok: true,
        result: { preset: { isEdited: true }, items: [{ instance: { id: 'preset', displayName: 'Mine' } }] } });
    const automated = { surface: 'cli' as const, bypassApprovals: true };
    expect(await executor.execute('widgets.area.layout.list', { surface: core }, automated)).toMatchObject({ ok: true,
        result: { layouts: [{ name: 'Overview', isPreset: true }] } });
    expect(await executor.execute('widgets.area.layout.create', { surface: core, layoutId: 'mine', name: 'Mine', fromSurface: core }, automated))
        .toMatchObject({ ok: true, result: { surface: { owner: { layoutId: 'mine' } }, isPreset: false } });
    const mine = { ...core, owner: { ...core.owner, layoutId: 'mine' } };
    expect(await executor.execute('widgets.area.layout.select', { surface: mine }, automated)).toMatchObject({ ok: true,
        result: { items: [{ instance: { displayName: 'Mine' } }] } });
    current = false;
    expect(await port.read(surface, { surface: 'cli' })).toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
});

it('uses the attached Artifact caller access without impersonating its stored owner', async () => {
    const stored = { serverId: 'home', accountId: 'owner', owner: { kind: 'project' as const, projectId: 'stable-project', layoutId: 'notes' } };
    const layout: WidgetAreaLayoutV1 = { v: 1, surface: stored, name: 'Notes', items: [] };
    const artifactId = buildWidgetSurfaceArtifactIdV1(stored);
    const selected = { ...stored, artifactId };
    let row: HomeHubArtifactV1 | null = { artifactId, ownerAccountId: 'owner', access: 'view', shared: true,
        header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout), revision: { headerVersion: 1, bodyVersion: 1 } };
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => id === artifactId ? row : null,
        create: async () => { throw new Error('An attached missing dashboard must never be cloned'); },
        update: async input => {
            if (!row) throw new Error('Missing selected row');
            row = { ...row, header: input.header, body: input.body, revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } };
            return { ok: true, revision: row.revision };
        },
        list: async () => ({ items: [] }), delete: async () => ({ ok: true }),
    };
    const actor = { serverId: 'home', accountId: 'viewer' };
    const deps = { ...createCliWidgetAreaActionDepsV1({ transport, scope: actor, isCurrent: () => true }), widgetAccountScope: () => actor };
    const port = deps.widgetSurfaceActions!.project!;
    expect(await port.read(selected, { surface: 'cli' })).toMatchObject({ surface: selected, canEdit: false, isShared: true });
    expect(await admitWidgetActionSurfaceV1(deps, selected, { surface: 'cli' })).toBeNull();
    expect(await admitWidgetActionSurfaceV1(deps, stored, { surface: 'cli' })).toMatchObject({ errorCode: 'account_target_mismatch' });
    const revision = row.revision;
    expect(await deps.widgetAreaLayouts!.rename({ surface: selected, name: 'View cannot rename', expectedRevision: revision }, { surface: 'cli' }))
        .toMatchObject({ errorCode: 'artifact_access_forbidden' });
    row = { ...row, access: 'edit' };
    expect(await deps.widgetAreaLayouts!.rename({ surface: selected, name: 'Edited notes', expectedRevision: revision }, { surface: 'cli' }))
        .toMatchObject({ name: 'Edited notes', surface: stored });
    expect(JSON.parse(String(row.body))).toMatchObject({ surface: stored, name: 'Edited notes' });
    expect(await deps.widgetAreaLayouts!.list({ surface: selected }, { surface: 'cli' })).toMatchObject({ errorCode: 'widget_area_layout_owner_required' });
    row = null;
    expect(await admitWidgetActionSurfaceV1(deps, selected, { surface: 'cli' })).toMatchObject({ errorCode: 'widget_area_not_found' });
});
