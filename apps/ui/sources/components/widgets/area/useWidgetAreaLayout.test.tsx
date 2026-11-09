import { expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { act } from 'react-test-renderer';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, flattenWidgetLayoutWidgetsV1, WidgetAreaLayoutV1Schema, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { HomeHubArtifactV1, HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { useWidgetAreaLayout, type WidgetAreaPort } from './useWidgetAreaLayout';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { HappyError } from '@/utils/errors/errors';
import { ServerFetchReadSupersededError } from '@/sync/http/client';
import { createWidgetAreaReadFailureV1 } from '@happier-dev/protocol/widgets';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

it.each(['currentness', 'superseded', 'cancelled', 'offline'] as const)('retains the admitted area through a %s read outcome without automatic retries', async outcome => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://area-currentness-503.test', accountId: 'actor' });
    const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor',
        owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } };
    let failed = false;
    let denied = false;
    let reads = 0;
    const transport: HomeHubArtifactTransportV1 = {
        read: async () => {
            reads++;
            if (denied) throw Object.assign(new Error('Feature or consent unavailable'), { code: 'permission_denied', canTryAgain: false });
            if (failed && outcome === 'superseded') throw new ServerFetchReadSupersededError();
            if (failed && outcome === 'cancelled') throw new DOMException('Cancelled read', 'AbortError');
            if (failed && outcome === 'offline') throw new TypeError('Failed to fetch');
            if (failed) throw new HappyError('Account encryption currentness is temporarily unavailable', true,
                { status: 503, kind: 'server', code: 'account-encryption-currentness-unavailable' });
            return null;
        },
        create: async () => { throw new Error('Unexpected create'); },
        update: async () => { throw new Error('Unexpected update'); },
    };
    const area = createWidgetAreaActionPortV1(() => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true,
        presets: [{ id: 'minimal', name: 'Minimal', items: [{ kind: 'widget', instance: {
            v: 1, id: 'displayed', definition: { kind: 'builtin', id: 'usage_planet' }, bindings: {},
        } }] }],
    }));
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => surface,
        widgetSurfaceActions: { corePage: area } }));
    // Account Actions envelope errors; native Host API reads may reject directly.
    const actionPort: WidgetAreaPort = { surface, execute: async (operation, signal) => {
        if (outcome === 'superseded') return PluginUiWidgetAreaResultV1Schema.parse(await executor.execute(operation.actionId,
            buildWidgetAreaActionInputV1(operation, surface), { surface: 'ui', bypassApprovals: true, signal }));
        const result = await area.read(surface, {});
        return 'ok' in result ? result : PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result });
    } };
    const context = {};
    let returnedIsCurrent: (() => boolean) | undefined;
    let hook = await renderHook(() => useWidgetAreaLayout(actionPort, context));
    try {
        await flushHookEffects();
        const admitted = hook.getCurrent().state;
        expect(admitted.status).toBe('ready');
        failed = true;
        await act(async () => { await hook.getCurrent().reload(); });
        const retained = hook.getCurrent().state;
        expect(retained).toMatchObject({ status: 'ready', readFailure: {
            reasonCode: outcome === 'cancelled' || outcome === 'superseded' ? 'cancelled'
                : outcome === 'offline' ? 'widget_area_unavailable' : 'account-encryption-currentness-unavailable',
        } });
        expect(reads).toBe(2);
        expect(retained.status === 'ready' && admitted.status === 'ready' && retained.items === admitted.items).toBe(true);
        if (outcome === 'offline') {
            await hook.unmount();
            hook = await renderHook(() => useWidgetAreaLayout(actionPort, context));
            await flushHookEffects();
            expect(hook.getCurrent().state, 'a warm return keeps the admitted layout after transport loss').toMatchObject({ status: 'ready' });
            const returned = hook.getCurrent().state;
            expect(returned.status === 'ready' && admitted.status === 'ready' && returned.items === admitted.items).toBe(true);
            if (returned.status === 'ready') returnedIsCurrent = returned.isCurrent;
        }
        failed = false;
        if (outcome === 'offline') {
            await act(async () => { publishHomeAccountChange('other-home', undefined, { source: 'connected' }); });
            expect(reads).toBe(3);
            await act(async () => { publishHomeAccountChange(connection.home.id, undefined, { source: 'connected' }); });
            await flushHookEffects();
            expect(reads).toBe(4);
        } else await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().state).not.toHaveProperty('readFailure');
        if (outcome === 'offline') {
            denied = true;
            await act(async () => { await hook.getCurrent().reload(); });
            expect(hook.getCurrent().state).toMatchObject({ status: 'unavailable', reasonCode: 'permission_denied' });
            await hook.unmount();
            expect(returnedIsCurrent?.(), 'restored facts do not keep a detached reader admitted').toBe(false);
            hook = await renderHook(() => useWidgetAreaLayout(actionPort, context));
            await flushHookEffects();
            expect(hook.getCurrent().state.status).toBe('unavailable');
            denied = false;
            await act(async () => { await hook.getCurrent().reload(); });
            expect(hook.getCurrent().state.status).toBe('ready');
            await hook.unmount();
            failed = true;
            retireActiveServerAccountScopeLifetime();
            hook = await renderHook(() => useWidgetAreaLayout(actionPort, context));
            await flushHookEffects();
            expect(hook.getCurrent().state.status).toBe('unavailable');
        }
    } finally { await hook.unmount(); await connection.dispose(); }
});

it('keeps a connecting plugin area loading, retains authorized data, and clears it on a terminal refusal', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://area-connection-pending.test', accountId: 'actor' });
    const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'pluginArea', pluginId: 'acme.widgets', pageId: 'overview', area: 'pinned', layoutId: 'default' } };
    const transport: HomeHubArtifactTransportV1 = {
        read: async () => null,
        create: async () => { throw new Error('Unexpected create'); },
        update: async () => { throw new Error('Unexpected update'); },
    };
    const area = createWidgetAreaActionPortV1(() => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true,
        presets: [{ id: 'default', name: 'Pinned', items: [{ kind: 'widget', instance: {
            v: 1, id: 'vitals', definition: { kind: 'builtin', id: 'machine_vitals' }, bindings: {},
        } }] }],
    }));
    let readiness: 'pending' | 'ready' | 'failed' | 'denied' = 'pending';
    let retireOnRead = false;
    const port: WidgetAreaPort = { execute: async () => {
        if (retireOnRead) retireActiveServerAccountScopeLifetime();
        return readiness === 'ready'
            ? PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) })
            : readiness === 'failed' ? { ...createWidgetAreaReadFailureV1('widget_area_unavailable'), error: readiness }
            : { ok: false, errorCode: readiness === 'pending' ? 'plugin_surface_connection_pending'
                : 'plugin_action_caller_forbidden', error: readiness };
    } };
    const context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    try {
        await flushHookEffects();
        expect(hook.getCurrent().state).toEqual({ status: 'loading' });
        readiness = 'ready';
        await act(async () => { await hook.getCurrent().reload(); });
        const admitted = hook.getCurrent().state;
        expect(admitted).toMatchObject({ status: 'ready', surface, placements: [{ instance: { id: 'vitals' } }] });
        readiness = 'pending';
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().state).toBe(admitted);
        readiness = 'failed';
        await act(async () => {
            expect(await hook.getCurrent().reload()).toMatchObject({ status: 'unavailable', reasonCode: 'widget_area_unavailable', reason: 'failed' });
        });
        const retained = hook.getCurrent().state;
        expect(retained).toMatchObject({ status: 'ready', readFailure: { reasonCode: 'widget_area_unavailable', reason: 'failed' } });
        expect(retained.status === 'ready' && retained.isReadPending()).toBe(false);
        readiness = 'denied';
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'unavailable', reasonCode: 'plugin_action_caller_forbidden' });
        // An explicit refusal is positive evidence: the write is refused too.
        expect(await hook.getCurrent().write({ actionId: 'widgets.item.rename', instanceId: 'vitals', displayName: 'Denied' }))
            .toEqual({ kind: 'refused', errorCode: 'widget_area_unavailable' });
        readiness = 'pending';
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().state).toEqual({ status: 'loading' });
        retireOnRead = true;
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'unavailable', reasonCode: 'widget_area_scope_retired' });
    } finally { await hook.unmount(); await connection.dispose(); }
});

it('distinguishes a pending observation from retired Account authority and rejects its late completion', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://area-pending-retirement.test', accountId: 'actor' });
    const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'work' } };
    let delayed = false;
    let release: (() => void) | undefined;
    const transport: HomeHubArtifactTransportV1 = {
        read: async () => { if (delayed) await new Promise<void>(resolve => { release = resolve; }); return null; },
        create: async () => { throw new Error('Unexpected create'); },
        update: async () => { throw new Error('Unexpected update'); },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true, presets: [{ id: 'work', name: 'Work', items: [] }] });
    const area = createWidgetAreaActionPortV1(() => owner);
    const port: WidgetAreaPort = { execute: async () => PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) }) };
    let context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    try {
        await flushHookEffects();
        const retained = hook.getCurrent().state;
        if (retained.status !== 'ready') throw new Error('Expected admitted layout');
        delayed = true;
        context = {};
        await hook.rerender();
        expect(retained.isReadPending()).toBe(true);
        expect(retained.isCurrent()).toBe(true);
        retireActiveServerAccountScopeLifetime();
        expect(retained.isCurrent()).toBe(false);
        expect(retained.isReadPending()).toBe(false);
        expect(await hook.getCurrent().write({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Retired' }))
            .toEqual({ kind: 'refused', errorCode: 'widget_area_unavailable' });
        await act(async () => { delayed = false; release?.(); });
        await flushHookEffects();
        expect(hook.getCurrent().state).toMatchObject({ status: 'unavailable', reasonCode: 'widget_area_scope_retired' });
    } finally { await hook.unmount(); await connection.dispose(); }
});

it('projects core-page preset groups and first-edit personalization through the shared area read', async () => {
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'actor', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
    const rows = new Map<string, HomeHubArtifactV1>();
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row); return row;
        },
        update: async input => {
            const row = rows.get(input.artifactId)!;
            if (row.revision.bodyVersion !== input.expectedRevision.bodyVersion) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            const next = { ...row, body: input.body, header: input.header, revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } };
            rows.set(input.artifactId, next); return { ok: true, revision: next.revision };
        },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true, presets: [{
        id: 'overview', name: 'Overview', items: [{ kind: 'group', id: 'group', children: [
            { kind: 'widget', instance: { v: 1, id: 'child', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} } },
        ] }],
    }] });
    const area = createWidgetAreaActionPortV1(() => owner);
    const port: WidgetAreaPort = { execute: async () => PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) }) };
    let context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', documentState: 'missing', preset: { isEdited: false },
        items: [{ kind: 'group', id: 'group', frameStyle: 'card', dividers: 'hairline' }], placements: [{ instance: { id: 'child' } }] });
    expect(rows.size).toBe(0);
    await owner.apply({ kind: 'rename', instanceId: 'group', displayName: 'Mine' });
    context = {};
    await hook.rerender(); await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', documentState: 'present', preset: { isEdited: true }, items: [{ title: 'Mine' }] });
    const reset = await owner.resetPreset();
    context = {};
    await hook.rerender(); await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ preset: { isEdited: false } });
    await owner.undoReset(reset.undo!);
    context = {};
    await hook.rerender(); await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ preset: { isEdited: true }, items: [{ title: 'Mine' }] });
    await hook.unmount();
});

it('exposes missing versus present-empty and current admitted dashboard identity without creating a layout', async () => {
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'actor', owner: { kind: 'project', projectId: 'anchor' } };
    const rows = new Map<string, HomeHubArtifactV1>();
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row); return row;
        },
        update: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 2, bodyVersion: 2 } };
            rows.set(input.artifactId, row); return { ok: true, revision: row.revision };
        },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(() => owner);
    const port: WidgetAreaPort = { execute: async () => PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) }) };
    let context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    const missing = hook.getCurrent().state;
    expect(missing).toMatchObject({ status: 'ready', documentState: 'missing' });
    if (missing.status === 'ready') expect(missing.placements).toHaveLength(7);
    expect(rows.size).toBe(0);
    expect(missing.status === 'ready' && missing.isCurrent()).toBe(true);
    const instance = { v: 1 as const, id: 'explicit', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} };
    await owner.apply({ kind: 'add', instance, area: 'aside' });
    await owner.apply({ kind: 'remove', instanceId: instance.id });
    for (const entry of flattenWidgetLayoutWidgetsV1((await owner.read()).items)) await owner.apply({ kind: 'remove', instanceId: entry.instance.id });
    context = {};
    await hook.rerender();
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', documentState: 'present', placements: [],
        dashboard: { name: 'Overview', ownerAccountId: 'actor', access: 'owner' } });
    expect(rows.size).toBe(1);
    await hook.unmount();
});

it('renders a committed removal from the admitted observation while duplicate Artifact reads are slow', async () => {
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'actor', owner: { kind: 'project', projectId: 'removed' } };
    const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
    const account = boundary.forAccount(surface.accountId);
    const reads = new Map<AbortSignal | undefined, number>();
    let holdDuplicate = false;
    let armOnUpdate = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const publish = (row: HomeHubArtifactV1) => storage.getState().updateArtifact({ id: row.artifactId,
        title: 'Overview', isDecrypted: true, ownerAccountId: 'actor', access: 'owner', storageMode: 'plain',
        headerVersion: row.revision.headerVersion, bodyVersion: row.revision.bodyVersion,
        body: row.body, seq: 1, createdAt: 1, updatedAt: row.revision.bodyVersion });
    const transport: HomeHubArtifactTransportV1 = {
        read: async (id, options) => {
            if (holdDuplicate) {
                const count = (reads.get(options?.signal) ?? 0) + 1;
                reads.set(options?.signal, count);
                // The network answers each observation, but its duplicate is arbitrarily slow.
                if (count > 1) await held;
            }
            return account.read(id, options);
        },
        create: async input => {
            const row = await account.create(input);
            publish(row); return row;
        },
        update: async input => {
            const result = await account.update(input);
            if (result.ok) {
                publish({ ...boundary.rows.get(input.artifactId)!, ownerAccountId: surface.accountId });
                if (armOnUpdate) holdDuplicate = true;
            }
            return result;
        },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    await owner.apply({ kind: 'add', instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} } });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => surface,
        widgetSurfaceActions: { project: createWidgetAreaActionPortV1(() => owner) } }));
    const port: WidgetAreaPort = { execute: async (operation, signal) => {
        const { buildWidgetAreaActionInputV1 } = await import('@happier-dev/protocol/plugins/ui');
        return PluginUiWidgetAreaResultV1Schema.parse(await executor.execute(operation.actionId,
            buildWidgetAreaActionInputV1(operation, surface), { surface: 'ui', bypassApprovals: true, signal }));
    } };
    const context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    try {
        await vi.waitFor(() => expect(hook.getCurrent().state).toMatchObject({ status: 'ready',
            placements: expect.arrayContaining([expect.objectContaining({ instance: expect.objectContaining({ id: 'copy' }) })]) }));
        // Arm only after the writer commits, so policy and CAS reads remain fully fresh.
        armOnUpdate = true;
        await act(async () => { expect(await hook.getCurrent().write({ actionId: 'widgets.item.remove', instanceId: 'copy' })).toEqual({ kind: 'applied' }); });
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.status).toBe('ready');
            if (state.status === 'ready') {
                expect(state.placements.some(row => row.instance.id === 'copy')).toBe(false);
                expect(state.isCurrent()).toBe(true);
            }
        });
    } finally { holdDuplicate = false; release(); await hook.unmount(); storage.getState().deleteArtifact(artifactId); }
});

it('settles an acknowledged widget add even when its follow-up layout read is still pending', async () => {
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'actor', owner: { kind: 'project', projectId: 'anchor' } };
    const rows = new Map<string, HomeHubArtifactV1>();
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row);
            return row;
        },
        update: async input => {
            const row = rows.get(input.artifactId)!;
            if (row.revision.bodyVersion !== input.expectedRevision.bodyVersion) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            const next = { ...row, body: input.body, header: input.header, revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } };
            rows.set(input.artifactId, next);
            return { ok: true, revision: next.revision };
        },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(() => owner);
    let listReads = 0;
    const port: WidgetAreaPort = { execute: async (operation) => {
        if (operation.actionId === 'widgets.item.list') {
            listReads += 1;
            if (listReads > 1) await new Promise<never>(() => {});
            return PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) });
        }
        if (operation.actionId !== 'widgets.item.add') throw new Error('Unexpected operation');
        return PluginUiWidgetAreaResultV1Schema.parse(await area.apply(surface, {
            kind: 'add',
            instance: operation.instance,
            ...(operation.area ? { area: operation.area } : {}),
            ...(operation.size ? { size: operation.size } : {}),
        }, {}));
    } };
    const context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    let settled: unknown;
    void hook.getCurrent().write({
        actionId: 'widgets.item.add',
        instance: { v: 1, id: 'added', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} },
        area: 'aside',
    }).then(outcome => { settled = outcome; });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(settled).toEqual({ kind: 'applied' });
    // Observing another read is not a terminal fact about the still-authorized layout.
    const retained = hook.getCurrent().state;
    expect(retained.status === 'ready' && retained.isCurrent()).toBe(true);
    expect(rows.size).toBe(1);
    await hook.unmount();
});

it('withdraws mounted effect admission on exact Artifact publication before a delayed reread settles', async () => {
    const storedSurface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'owner',
        owner: { kind: 'project', projectId: 'anchor', layoutId: 'named' } };
    const artifactId = buildWidgetSurfaceArtifactIdV1(storedSurface);
    const surface = { ...storedSurface, artifactId };
    const layout = { v: 1 as const, surface: storedSurface, items: [] } satisfies WidgetAreaLayoutV1;
    const row: HomeHubArtifactV1 = { artifactId, ownerAccountId: 'owner', access: 'view',
        header: buildWidgetSurfaceArtifactHeaderV1(layout), revision: { headerVersion: 1, bodyVersion: 1 },
        body: JSON.stringify(layout) };
    const publication = { id: artifactId, title: 'Named', isDecrypted: true as const, ownerAccountId: 'owner', access: 'view' as const,
        storageMode: 'plain' as const, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    let revoked = false;
    let readFails = false;
    let reads = 0;
    let releaseRead: (() => void) | undefined;
    let waitForRead = false;
    const transport: HomeHubArtifactTransportV1 = {
        read: async () => {
            reads++;
            if (waitForRead) await new Promise<void>(resolve => { releaseRead = resolve; });
            if (readFails) throw new Error('Artifact read failed');
            if (!revoked) storage.getState().applyArtifacts([{ ...publication }]);
            return revoked ? null : row;
        },
        create: async () => { throw new Error('Unexpected create'); },
        update: async () => { throw new Error('Unexpected update'); },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(() => owner);
    const port: WidgetAreaPort = { execute: async (operation) => {
        // The writer's own acknowledgement does not depend on this area's failing read.
        if (operation.actionId === 'widgets.item.rename') return {
            ok: true, result: { ref: { surface, instanceId: operation.instanceId }, instance: null },
        };
        if (operation.actionId !== 'widgets.item.list') throw new Error('Unexpected widget operation');
        const result = await area.read(surface, {});
        return PluginUiWidgetAreaResultV1Schema.parse('ok' in result ? result : { ok: true, result });
    } };
    const context = {};
    storage.getState().applyArtifacts([{ ...publication }]);
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    const admitted = hook.getCurrent().state;
    expect(admitted.status).toBe('ready');
    if (admitted.status !== 'ready') throw new Error('Expected admitted attached surface');
    expect(admitted.isCurrent()).toBe(true);
    expect(reads).toBe(1);
    await act(async () => storage.getState().applyArtifacts([{ ...publication }]));
    await flushHookEffects();
    expect(reads).toBe(1);
    await act(async () => { await hook.getCurrent().reload(); });
    expect(reads).toBe(2);
    const firstPublication = storage.getState().artifacts[artifactId];
    waitForRead = true;
    publication.updatedAt = 2;
    await act(async () => storage.getState().applyArtifacts([{ ...publication }]));
    expect(reads).toBe(3);
    expect(admitted.isCurrent()).toBe(false);
    expect(admitted.isReadPending()).toBe(true);
    expect(hook.getCurrent().state.status).toBe('ready'); // Last admitted layout remains during the read.
    // A transient failure cannot keep admission after its exact publication has changed.
    readFails = true;
    await act(async () => { waitForRead = false; releaseRead?.(); });
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'unavailable', reasonCode: 'widget_area_unavailable' });
    // Mounted effects stay withdrawn, but a failed refresh never refuses a person's Add on the layout they opened.
    expect(await hook.getCurrent().write({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Kept' }))
        .toEqual({ kind: 'applied' });
    readFails = false;
    await act(async () => { await hook.getCurrent().reload(); });
    await flushHookEffects();
    const renewed = hook.getCurrent().state;
    if (renewed.status !== 'ready') throw new Error('Expected read to renew admission');
    expect(renewed.isCurrent()).toBe(true);
    expect(renewed.isReadPending()).toBe(false);
    expect(storage.getState().artifacts[artifactId]).not.toBe(firstPublication);
    waitForRead = true;
    revoked = true;
    await act(async () => storage.getState().deleteArtifact(artifactId));
    expect(renewed.isCurrent()).toBe(false);
    await act(async () => { waitForRead = false; releaseRead?.(); });
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'unavailable' });
    await hook.unmount();
});

it('admits the Artifact published by its own first read without another read', async () => {
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'owner',
        owner: { kind: 'project', projectId: 'self-publication', layoutId: 'named' } };
    const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    const layout: WidgetAreaLayoutV1 = { v: 1, surface, items: [] };
    let reads = 0;
    const transport: HomeHubArtifactTransportV1 = {
        read: async () => {
            reads++;
            if (reads === 1) storage.getState().applyArtifacts([{ id: artifactId, title: 'Named', isDecrypted: true,
                ownerAccountId: 'owner', access: 'view', storageMode: 'plain', headerVersion: 1,
                bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
            return { artifactId, ownerAccountId: 'owner', access: 'view',
                header: buildWidgetSurfaceArtifactHeaderV1(layout), revision: { headerVersion: 1, bodyVersion: 1 },
                body: JSON.stringify(layout) };
        },
        create: async () => { throw new Error('Unexpected create'); },
        update: async () => { throw new Error('Unexpected update'); },
    };
    const area = createWidgetAreaActionPortV1(() => createWidgetSurfaceArtifactPortV1(transport, {
        surface, isCurrent: () => true,
    }));
    const port: WidgetAreaPort = { execute: async () => {
        const result = await area.read(surface, {});
        return PluginUiWidgetAreaResultV1Schema.parse('ok' in result ? result : { ok: true, result });
    } };
    const context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    try {
        await flushHookEffects();
        expect(hook.getCurrent().state.status).toBe('ready');
        const state = hook.getCurrent().state;
        expect(state.status === 'ready' && state.isCurrent()).toBe(true);
        expect(reads).toBe(1);
    } finally { await hook.unmount(); storage.getState().deleteArtifact(artifactId); }
});

it('applies a reversible edit to the displayed area during a publication refresh without losing concurrent edits', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://area-write-refresh.test', accountId: 'actor' });
    const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor',
        owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
    const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    const layout: WidgetAreaLayoutV1 = { v: 1, surface, items: ['first', 'sibling'].map(id => ({ kind: 'widget',
        instance: { v: 1, id, definition: { kind: 'builtin', id: 'project_about' }, bindings: {} } })) };
    let row: HomeHubArtifactV1 = { artifactId, ownerAccountId: 'actor', access: 'owner',
        header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout), revision: { headerVersion: 1, bodyVersion: 1 } };
    const transport: HomeHubArtifactTransportV1 = {
        read: async () => row,
        create: async () => { throw new Error('Unexpected create'); },
        update: async input => {
            if (input.expectedRevision.bodyVersion !== row.revision.bodyVersion) return { ok: false, errorCode: 'version_mismatch', error: 'Conflict' };
            row = { ...row, header: input.header, body: input.body,
                revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } };
            return { ok: true, revision: row.revision };
        },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(() => owner);
    let blockRead = false;
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const port: WidgetAreaPort = { execute: async (operation, signal, target) => {
        const selected = target?.surface ?? surface;
        if (operation.actionId === 'widgets.item.list') {
            if (blockRead) await pending;
            return PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(selected, {}, signal) });
        }
        if (operation.actionId !== 'widgets.item.frame.set') throw new Error('Unexpected operation');
        return PluginUiWidgetAreaResultV1Schema.parse(await area.apply(selected,
            { kind: 'frame', instanceId: operation.instanceId, frameStyle: operation.frameStyle }, {}, signal));
    } };
    const context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    try {
        await flushHookEffects();
        const retained = hook.getCurrent().state;
        if (retained.status !== 'ready') throw new Error('Expected admitted area');
        await owner.apply({ kind: 'rename', instanceId: 'sibling', displayName: 'Concurrent edit' });
        blockRead = true;
        await act(async () => storage.getState().applyArtifacts([{ id: artifactId, title: 'Overview', isDecrypted: true,
            ownerAccountId: 'actor', access: 'owner', storageMode: 'plain', headerVersion: 2, bodyVersion: 2,
            seq: 2, createdAt: 1, updatedAt: 2 }]));
        expect(retained.isCurrent()).toBe(false);
        expect(retained.isReadPending()).toBe(true);
        await act(async () => {
            expect(await hook.getCurrent().write({ actionId: 'widgets.item.frame.set', instanceId: 'first', frameStyle: 'plain' }))
                .toEqual({ kind: 'applied' });
        });
        expect((await owner.read()).items).toMatchObject([
            { kind: 'widget', frameStyle: 'plain', instance: { id: 'first' } },
            { kind: 'widget', instance: { id: 'sibling', displayName: 'Concurrent edit' } },
        ]);
        // Refresh-time editing still rechecks the writer's latest access, not the retained read.
        row = { ...row, access: 'view' };
        await act(async () => {
            expect(await hook.getCurrent().write({ actionId: 'widgets.item.frame.set', instanceId: 'first', frameStyle: 'card' }))
                .toEqual({ kind: 'refused', errorCode: 'artifact_access_forbidden' });
        });
        await act(async () => { blockRead = false; release?.(); });
        await flushHookEffects();
        expect(hook.getCurrent().state).toMatchObject({ status: 'ready', canEdit: false, items: [
            { frameStyle: 'plain' }, { instance: { displayName: 'Concurrent edit' } },
        ] });
    } finally {
        release?.();
        await hook.unmount();
        storage.getState().deleteArtifact(artifactId);
        await connection.dispose();
    }
});

it('keeps the newly selected area when an earlier captured durable write acknowledges late', async () => {
    const surface = (pageId: string): WidgetSurfaceRefV1 => ({ serverId: 'home', accountId: 'actor', owner: { kind: 'pluginArea', pluginId: 'acme', pageId, area: 'main' } });
    const first = surface('first'); const second = surface('second');
    const rows = new Map<string, HomeHubArtifactV1>();
    let releaseWrite: (() => void) | undefined;
    let enteredWrite: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { enteredWrite = resolve; });
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row); return row;
        },
        update: async input => {
            enteredWrite?.();
            await new Promise<void>(resolve => { releaseWrite = resolve; });
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 2, bodyVersion: 2 } };
            rows.set(input.artifactId, row); return { ok: true, revision: row.revision };
        },
    };
    const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
    const bind = (ref: WidgetSurfaceRefV1): WidgetAreaPort => ({ execute: async (operation, signal) => {
        const result = operation.actionId === 'widgets.item.list'
            ? { ok: true, result: await area.read(ref, { surface: 'ui' }, signal) }
            : operation.actionId === 'widgets.item.rename'
                ? await area.apply(ref, { kind: 'rename', instanceId: operation.instanceId, displayName: operation.displayName }, { surface: 'ui' }, signal)
                : (() => { throw new Error('Unsupported fixture operation'); })();
        return PluginUiWidgetAreaResultV1Schema.parse(result);
    } });
    const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
    const firstLayout = { v: 1 as const, surface: first, items: [{ kind: 'group', id: 'group', width: 'full',
        frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance }] }] } satisfies WidgetAreaLayoutV1;
    rows.set(buildWidgetSurfaceArtifactIdV1(first), { artifactId: buildWidgetSurfaceArtifactIdV1(first), ownerAccountId: 'actor', access: 'owner',
        header: buildWidgetSurfaceArtifactHeaderV1(firstLayout), body: JSON.stringify(firstLayout), revision: { headerVersion: 1, bodyVersion: 1 } });
    let port = bind(first);
    let context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', placements: [{ instance: { id: 'copy' } }] });
    const retiredWrite = hook.getCurrent().write;
    let pending: Promise<unknown> | undefined;
    await act(async () => { pending = hook.getCurrent().write({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Updated old area' }); await entered; });
    port = bind(second);
    context = {};
    await hook.rerender();
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', surface: second });
    expect(await retiredWrite({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Retired callback' }))
        .toEqual({ kind: 'refused', errorCode: 'widget_area_unavailable' });
    await act(async () => { releaseWrite?.(); await pending; });
    expect(JSON.parse(String(rows.get(buildWidgetSurfaceArtifactIdV1(first))?.body))).toMatchObject({ items: [{ kind: 'group',
        children: [{ kind: 'widget', instance: { displayName: 'Updated old area' } }] }] });
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', surface: second });
    const unmountedWrite = hook.getCurrent().write;
    await hook.unmount();
    expect(await unmountedWrite({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Unmounted callback' }))
        .toEqual({ kind: 'refused', errorCode: 'widget_area_unavailable' });
});

it('writes the displayed Artifact rather than the newly selected same-id copy while its read is pending', async () => {
    const surface = (layoutId: string): WidgetSurfaceRefV1 => ({ serverId: 'home', accountId: 'actor', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId } });
    const first = surface('first'); const second = surface('second');
    const rows = new Map<string, HomeHubArtifactV1>();
    const seed = (ref: WidgetSurfaceRefV1, displayName: string) => {
        const layout: WidgetAreaLayoutV1 = { v: 1, surface: ref, items: [{ kind: 'widget', instance: { v: 1, id: 'same-id',
            definition: { kind: 'builtin', id: 'project_about' }, bindings: {}, displayName } }] };
        rows.set(buildWidgetSurfaceArtifactIdV1(ref), { artifactId: buildWidgetSurfaceArtifactIdV1(ref), ownerAccountId: 'actor', access: 'owner',
            header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout), revision: { headerVersion: 1, bodyVersion: 1 } });
    };
    seed(first, 'Displayed'); seed(second, 'Selected');
    let blockNextRead = false;
    let release: (() => void) | undefined;
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async () => { throw new Error('Unexpected create'); },
        update: async input => { const prior = rows.get(input.artifactId)!;
            const revision = { headerVersion: prior.revision.headerVersion + 1, bodyVersion: prior.revision.bodyVersion + 1 };
            rows.set(input.artifactId, { ...prior, ...input, revision }); return { ok: true, revision }; },
    };
    const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
    const pendingRead = new Promise<void>(resolve => { release = resolve; });
    const bind = (ref: WidgetSurfaceRefV1): WidgetAreaPort => ({ execute: async (operation, signal, target) => {
        const selected = target?.surface ?? ref;
        if (operation.actionId === 'widgets.item.list' && selected === second && blockNextRead) await pendingRead;
        const result = operation.actionId === 'widgets.item.list' ? { ok: true, result: await area.read(selected, {}, signal) }
            : operation.actionId === 'widgets.item.rename' ? await area.apply(selected, { kind: 'rename', instanceId: operation.instanceId, displayName: operation.displayName }, {}, signal)
            : (() => { throw new Error('Unsupported operation'); })();
        return PluginUiWidgetAreaResultV1Schema.parse(result);
    } });
    let port = bind(first);
    const context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    try {
        await flushHookEffects();
        blockNextRead = true;
        port = bind(second);
        await hook.rerender();
        expect(hook.getCurrent().state).toMatchObject({ status: 'ready', surface: first });
        await act(async () => { expect(await hook.getCurrent().write({ actionId: 'widgets.item.rename', instanceId: 'same-id', displayName: 'Edited displayed' })).toEqual({ kind: 'applied' }); });
        const displayedBody = rows.get(buildWidgetSurfaceArtifactIdV1(first))?.body;
        const selectedBody = rows.get(buildWidgetSurfaceArtifactIdV1(second))?.body;
        if (typeof displayedBody !== 'string' || typeof selectedBody !== 'string') throw new Error('Expected both stored layout bodies');
        const displayed = WidgetAreaLayoutV1Schema.parse(JSON.parse(displayedBody));
        const selected = WidgetAreaLayoutV1Schema.parse(JSON.parse(selectedBody));
        expect(flattenWidgetLayoutWidgetsV1(displayed.items)[0]!.instance.displayName).toBe('Edited displayed');
        expect(flattenWidgetLayoutWidgetsV1(selected.items)[0]!.instance.displayName).toBe('Selected');
    } finally { await act(async () => { release?.(); }); await hook.unmount(); }
});

it('keeps the host\'s sentence for a refused area, so the area can say which Machine cannot answer', async () => {
    // D1: a plugin page's widget area whose Run-on Machine is unreachable is refused with a code and the
    // host's sentence naming that Machine. The area keeps both; a sentence that only repeats the code is not a reason.
    let error = 'This operation is unavailable on studio-mac. Reconnect it or choose another machine with Run on.';
    const port: WidgetAreaPort = { execute: async () => ({ ok: false, errorCode: 'plugin_mounted_caller_unavailable', error }) };
    const hook = await renderHook(() => useWidgetAreaLayout(port, {}));
    try {
        await flushHookEffects();
        expect(hook.getCurrent().state).toEqual({ status: 'unavailable', reasonCode: 'plugin_mounted_caller_unavailable', reason: error });
    } finally { await hook.unmount(); }
    error = 'plugin_mounted_caller_unavailable';
    const bare = await renderHook(() => useWidgetAreaLayout(port, {}));
    try {
        await flushHookEffects();
        expect(bare.getCurrent().state).toEqual({ status: 'unavailable', reasonCode: 'plugin_mounted_caller_unavailable' });
    } finally { await bare.unmount(); }
});
