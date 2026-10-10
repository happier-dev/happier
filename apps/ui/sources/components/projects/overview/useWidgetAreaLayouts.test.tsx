import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createWidgetAreaLayoutArtifactPortV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import { useWidgetAreaLayouts, type WidgetAreaLayoutsExecute } from './useProjectDashboards';

afterEach(standardCleanup);

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
    const unused = async (): Promise<never> => { throw new Error('unexpected_layout_operation'); };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope,
        widgetAreaLayouts: {
            list: args => owner(args.surface).list(), create: args => owner(args.surface).create(args),
            delete: args => owner(args.surface).delete(args), rename: unused, reorder: unused, reset: unused, undo: unused,
        },
    }));
    const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId,
        actionCaller: { kind: 'host' as const }, authority: 'present_user' as const,
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.area.layout.delete': ['ui'] } }),
    };
    const execute: WidgetAreaLayoutsExecute = (actionId, args) => executor.execute(actionId, args, context);
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
    const transport = { ...boundary.forAccount(scope.accountId), list: async (...args: Parameters<typeof boundary.transport.list>) => {
        await pending;
        if (failed) throw new Error('Home unavailable');
        return boundary.transport.list(...args);
    } };
    const owner = (target: WidgetSurfaceRefV1) => createWidgetAreaLayoutArtifactPortV1(transport, { surface: target, isCurrent: () => true });
    const unused = async (): Promise<never> => { throw new Error('unexpected_layout_operation'); };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope,
        widgetAreaLayouts: { list: args => owner(args.surface).list(), create: args => owner(args.surface).create(args),
            delete: unused, rename: unused, reorder: unused, reset: unused, undo: unused },
    }));
    const execute: WidgetAreaLayoutsExecute = (actionId, args) => executor.execute(actionId, args, {
        surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        actionCaller: { kind: 'host' }, authority: 'present_user',
    });
    try {
        storage.setState({ artifacts: {} });
        expect(await execute('widgets.area.layout.create', { surface, layoutId: 'private-a', name: 'Private A' })).toMatchObject({ ok: true });
        const hook = await renderHook(({ target }: { target: WidgetSurfaceRefV1 | null }) => useWidgetAreaLayouts({ surface: target, execute }),
            { initialProps: { target: surface } });
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
