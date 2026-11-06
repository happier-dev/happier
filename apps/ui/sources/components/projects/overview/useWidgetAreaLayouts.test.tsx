import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createWidgetAreaActionPortV1, createWidgetAreaLayoutArtifactPortV1, createWidgetSurfaceArtifactPortV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { WidgetAreaLayoutsExecute } from './useProjectDashboards';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

// Install transport boundaries before the named-layout/approval consumer graph.
installHomeGovernanceBoundaries(createHomeGovernanceHarness());
const { storage } = await import('@/sync/domains/state/storage');
const { useWidgetAreaLayouts } = await import('./useProjectDashboards');

afterEach(standardCleanup);

it('renews one mounted inventory read when the same Account lifetime retires', async () => {
    const previous = storage.getState();
    const home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://layout-renewal.test', accountId: 'account' }], route: () => undefined });
    const server = home.homes.a!;
    const scope = { serverId: server.id, accountId: 'account' };
    const surface: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } };
    const execute = vi.fn<WidgetAreaLayoutsExecute>(async () => ({ ok: true, result: { surface, layouts: [] } }));
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    storage.setState({ artifacts: {}, profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
    try {
        const hook = await renderHook(() => useWidgetAreaLayouts({ surface, execute }));
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
        await act(async () => { await Promise.resolve(); });
        expect(execute).toHaveBeenCalledTimes(2);
        await hook.unmount();
    } finally { retireActiveServerAccountScopeLifetime(); storage.setState(previous); await home.dispose(); }
});

it.each(['network_error', 'thrown_network_error', 'cancelled', 'abort', 'denied', 'permission_denied', 'thrown_permission_denied'])(
    'retains only authorized Account inventory across %s and a warm mount with an unanswered read', async errorCode => {
    const previous = storage.getState();
    const home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://layout-retention.test', accountId: 'account' }], route: () => undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const scope = { serverId: server.id, accountId: 'account' };
    storage.setState({ artifacts: {}, profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
    const surface: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } };
    const boundary = createWorkBoardArtifactBoundary();
    let held = createDeferred<void>();
    let hold = false;
    let failure = false;
    const transport = { ...boundary.forAccount(scope.accountId), delete: boundary.transport.delete,
        list: async (...args: Parameters<typeof boundary.transport.list>) => { if (hold) await held.promise; return boundary.transport.list(...args); } };
    const owner = createWidgetAreaLayoutArtifactPortV1(transport, { surface, isCurrent: () => true });
    await owner.create({ layoutId: 'mine', name: 'My usage' });
    const unused = async (): Promise<never> => { throw new Error('unexpected_mutation'); };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope,
        widgetSurfaceActions: { corePage: createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(transport, { surface: target, isCurrent: () => true })) },
        widgetAreaLayouts: { list: () => owner.list(), create: unused, rename: unused, delete: unused, reorder: unused, reset: unused, undo: unused } }));
    // The Action invocation is the transport boundary; successful reads still use the real Artifact/Action owners.
    const execute: WidgetAreaLayoutsExecute = async (actionId, args) => {
        if (failure) {
            if (errorCode === 'thrown_network_error') throw new Error('Home transport unavailable');
            if (errorCode === 'abort') throw new DOMException('Cancelled inventory read', 'AbortError');
            if (errorCode === 'thrown_permission_denied') throw Object.assign(new Error('Access denied'), { code: 'permission_denied' });
            return { ok: false, errorCode, error: errorCode };
        }
        return executor.execute(actionId, args, {
        surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId, authority: 'present_user', actionCaller: { kind: 'host' },
        });
    };
    // Host presets (c32df2131d) are served by the Action executor, not Account inventory: only the Account's own layouts are retained or withdrawn.
    const accountNames = (dashboards: readonly Readonly<{ name: string; isPreset: boolean }>[]) => dashboards.filter(row => !row.isPreset).map(row => row.name);
    try {
        const cold = await renderHook(() => useWidgetAreaLayouts({ surface, execute }));
        await vi.waitFor(() => expect(accountNames(cold.getCurrent().state.dashboards)).toEqual(['My usage']));
        failure = true;
        await act(async () => { await expect(cold.getCurrent().reload()).resolves.toBeNull(); });
        const cancelled = errorCode === 'cancelled' || errorCode === 'abort';
        const transient = errorCode === 'network_error' || errorCode === 'thrown_network_error' || cancelled;
        const expectedNames = transient ? ['My usage'] : [];
        expect(cold.getCurrent().state).toMatchObject(cancelled ? { status: 'ready' } : { status: 'offline', readFailure: {
            reasonCode: errorCode === 'thrown_network_error' ? 'widget_area_unavailable'
                : errorCode === 'thrown_permission_denied' ? 'permission_denied' : errorCode,
        } });
        if (cancelled) expect(cold.getCurrent().state).not.toHaveProperty('readFailure');
        expect(accountNames(cold.getCurrent().state.dashboards)).toEqual(expectedNames);
        await cold.unmount();
        failure = false;
        hold = true;
        const warm = await renderHook(() => useWidgetAreaLayouts({ surface, execute }));
        expect(accountNames(warm.getCurrent().state.dashboards)).toEqual(expectedNames);
        await warm.rerender();
        expect(accountNames(warm.getCurrent().state.dashboards)).toEqual(expectedNames);
        held.resolve();
        await warm.unmount();
        held = createDeferred<void>();
        retireActiveServerAccountScopeLifetime();
        const retired = await renderHook(() => useWidgetAreaLayouts({ surface, execute }));
        expect(accountNames(retired.getCurrent().state.dashboards)).toEqual([]);
        await retired.unmount();
    } finally { held.resolve(); retireActiveServerAccountScopeLifetime(); storage.setState(previous); await home.dispose(); }
});

it('refreshes mounted inventory for new and removed same-area publications through another Action entry point', async () => {
    const previous = storage.getState();
    const scope = { serverId: 'home', accountId: 'account' };
    const surface: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } };
    const other: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'corePage', pageId: 'other', area: 'main' } };
    const boundary = createWorkBoardArtifactBoundary();
    const transport = boundary.forAccount(scope.accountId);
    const publish = (artifactId: string) => {
        const row = boundary.rows.get(artifactId)!;
        storage.getState().addArtifact({ id: artifactId, header: { ...row.header, title: String(row.header.title) }, rawHeader: row.header,
            title: String(row.header.title), ...row.revision, ownerAccountId: scope.accountId, access: 'owner',
            isDecrypted: true, storageMode: 'plain', seq: 1, createdAt: 1, updatedAt: 1 });
    };
    // Only persistence and its publication are boundaries. All inventory/Action/admission logic stays real.
    const publishingTransport = { ...transport, list: boundary.transport.list,
        create: async (input: Parameters<typeof transport.create>[0]) => {
            const result = await transport.create(input); publish(input.artifactId); return result;
        },
        delete: async (...args: Parameters<typeof boundary.transport.delete>) => {
            const result = await boundary.transport.delete(...args);
            if (result.ok) storage.getState().deleteArtifact(args[0]);
            return result;
        },
    };
    const owner = (target: WidgetSurfaceRefV1) => createWidgetAreaLayoutArtifactPortV1(publishingTransport, { surface: target, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(publishingTransport, { surface: target, isCurrent: () => true }));
    const unused = async (): Promise<never> => { throw new Error('unexpected_layout_operation'); };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope,
        isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
            context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }), context, undefined, undefined, input),
        widgetSurfaceActions: { corePage: area },
        widgetAreaLayouts: {
            list: args => owner(args.surface).list(), create: args => owner(args.surface).create(args),
            delete: args => owner(args.surface).delete(args), rename: unused, reorder: unused, reset: unused, undo: unused,
        },
    }));
    const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId,
        actionCaller: { kind: 'host' as const }, authority: 'present_user' as const,
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
            'widgets.area.layout.create': ['ui'], 'widgets.area.layout.delete': ['ui'],
        } }),
    };
    const execute: WidgetAreaLayoutsExecute = async (actionId, args) => {
        const result = await executor.execute(actionId, args, context);
        if (actionId === 'widgets.area.layout.create') expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        return result;
    };
    try {
        storage.setState({ artifacts: {} });
        const hook = await renderHook(() => useWidgetAreaLayouts({ surface, execute }));
        await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
        const before = hook.getCurrent().state;
        await act(async () => { expect(await execute('widgets.area.layout.create', { surface: other, layoutId: 'foreign', name: 'Other' })).toMatchObject({ ok: true }); });
        expect(hook.getCurrent().state).toBe(before);
        await act(async () => { expect(await execute('widgets.area.layout.create', { surface, layoutId: 'agent', name: 'Agent view' })).toMatchObject({ ok: true }); });
        await vi.waitFor(() => expect(hook.getCurrent().state.dashboards.map(row => row.name)).toContain('Agent view'));
        const created = hook.getCurrent().state.dashboards.find(row => row.name === 'Agent view')!;
        await act(async () => { expect(await execute('widgets.area.layout.delete', { surface: created.surface, expectedRevision: created.revision })).toMatchObject({ ok: true }); });
        await vi.waitFor(() => expect(hook.getCurrent().state.dashboards.map(row => row.name)).not.toContain('Agent view'));
        await hook.unmount();
    } finally { storage.setState(previous); }
});

it.each(['project', 'home', 'account', 'retired'] as const)('withdraws private inventory immediately when its %s scope retires', async change => {
    const previous = storage.getState();
    let scope = { serverId: 'home', accountId: 'account' };
    const surface: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'project', projectId: 'project-a' } };
    const boundary = createWorkBoardArtifactBoundary();
    let failed = false;
    let release: (() => void) | undefined;
    let pending: Promise<void> | undefined;
    const transport = { ...boundary.forAccount(scope.accountId), delete: boundary.transport.delete, list: async (...args: Parameters<typeof boundary.transport.list>) => {
        await pending;
        if (failed) throw new Error('Home unavailable');
        return boundary.transport.list(...args);
    } };
    const owner = (target: WidgetSurfaceRefV1) => createWidgetAreaLayoutArtifactPortV1(transport, { surface: target, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(transport, { surface: target, isCurrent: () => true }));
    const unused = async (): Promise<never> => { throw new Error('unexpected_layout_operation'); };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope,
        isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
            context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }), context, undefined, undefined, input),
        widgetSurfaceActions: { project: area },
        widgetAreaLayouts: { list: args => owner(args.surface).list(), create: args => owner(args.surface).create(args),
            delete: unused, rename: unused, reorder: unused, reset: unused, undo: unused },
    }));
    const execute: WidgetAreaLayoutsExecute = (actionId, args) => executor.execute(actionId, args, {
        surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        actionCaller: { kind: 'host' }, authority: 'present_user',
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.area.layout.create': ['ui'] } }),
    });
    try {
        storage.setState({ artifacts: {} });
        const created = await execute('widgets.area.layout.create', { surface, layoutId: 'private-a', name: 'Private A' });
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
        const initialProps: { target: WidgetSurfaceRefV1 | null } = { target: surface };
        const hook = await renderHook(({ target }: { target: WidgetSurfaceRefV1 | null }) => useWidgetAreaLayouts({ surface: target, execute }),
            { initialProps });
        await vi.waitFor(() => expect(hook.getCurrent().state.dashboards.map(row => row.name)).toContain('Private A'));
        const retiredCreate = hook.getCurrent().create;
        pending = new Promise<void>(resolve => { release = resolve; });
        if (change === 'home') scope = { ...scope, serverId: 'other-home' };
        if (change === 'account') scope = { ...scope, accountId: 'other-account' };
        const target = change === 'retired' ? null : { ...surface, ...scope,
            ...(change === 'project' ? { owner: { kind: 'project' as const, projectId: 'project-b' } } : {}) };
        await hook.rerender({ target });
        expect(hook.getCurrent().state.dashboards).toEqual([]);
        expect(hook.getCurrent().state.status).toBe('loading');
        const staleCreation = retiredCreate('Stale view');
        failed = true;
        await act(async () => release?.());
        expect(await staleCreation).toMatchObject({ ok: false });
        if (target) await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('offline'));
        expect(hook.getCurrent().state.dashboards).toEqual([]);
        expect([...boundary.rows.values()].some(row => row.header.title === 'Stale view')).toBe(false);
        await hook.unmount();
    } finally { release?.(); storage.setState(previous); }
});
