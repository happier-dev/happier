import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetInstanceActionOutputSchemasV1, WidgetAreaLayoutV1Schema } from '@happier-dev/protocol/widgets';
import { ArtifactAccessGrantSetInputV1Schema, type ArtifactAccessGrantRowV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { Modal } from '@/modal';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let unknownDelete = false;
let refuseWrites = false;
const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let holdInventory: (() => Promise<void>) | null = null;
let holdDelete: (() => Promise<void>) | null = null;
let holdRead: ((path: string) => Promise<void>) | null = null;
let holdCreate: (() => Promise<void>) | null = null;
const deletes: string[] = [];
const selected: (string | null)[] = [];
let grants: ArtifactAccessGrantRowV1[] = [];
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') await holdInventory?.();
    if (path.startsWith('/v1/artifacts/') && (init?.method ?? 'GET') === 'GET') await holdRead?.(path);
    if (path === '/v1/artifacts' && init?.method === 'POST') await holdCreate?.();
    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
            'widgets.area.layout.create': ['ui'], 'widgets.area.layout.rename': ['ui'],
            'widgets.area.layout.reorder': ['ui'], 'widgets.area.layout.delete': ['ui'],
            'widgets.item.remove': ['ui'], 'artifact.access.grants.set': ['ui'],
        } },
    } }, version: 1 });
    // A Home that refuses the write outright (a known non-commit), as a version conflict does.
    if (refuseWrites && path.startsWith('/v1/artifacts') && writeMethods.has(init?.method ?? 'GET')) {
        // The Home's answers to a write that lost its race: an update says so in its body, a delete with 409.
        if (init?.method === 'DELETE') return Response.json({ error: 'version-mismatch' }, { status: 409 });
        const current = artifacts.read(decodeURIComponent(path.split('/')[3] ?? ''));
        return Response.json({ success: false, error: 'version-mismatch',
            ...(current ? { currentHeaderVersion: current.headerVersion + 1, currentHeader: current.header,
                currentBodyVersion: (current.bodyVersion ?? 0) + 1, currentBody: current.body } : {}) });
    }
    const grantMatch = /^\/v1\/artifacts\/([^/]+)\/access\/grants$/.exec(path);
    if (grantMatch && init?.method === 'PUT') {
        const row = artifacts.read(decodeURIComponent(grantMatch[1]!));
        if (!row) return Response.json({ error: 'artifact_not_found' }, { status: 404 });
        const input = ArtifactAccessGrantSetInputV1Schema.parse({ artifactId: row.id, ...JSON.parse(String(init.body)) });
        grants = [{ principal: input.principal, accessLevel: input.accessLevel, createdByAccountId: 'account-a', createdAt: 1,
            display: { name: 'Recipient' } }];
        return Response.json({ artifactId: row.id, ownerAccountId: 'account-a', access: 'owner', grants, changed: true });
    }
    if (init?.method === 'DELETE' && path.startsWith('/v1/artifacts/')) {
        deletes.push(path);
        await holdDelete?.();
        if (unknownDelete) throw new TypeError('The Home lost the deletion acknowledgement');
    }
    return artifacts.handle(path + new URL(String(url)).search, init);
} });
const { ProjectDashboardHeader, projectDashboardRouteId } = await import('./ProjectDashboardHeader');
const { useProjectDashboards } = await import('./useProjectDashboards');
const { WidgetAreaLayoutBar } = await import('@/components/widgets/area/WidgetAreaLayoutBar');
const { useProjectWidgetAreaBinding } = await import('@/components/widgets/area/useProjectWidgetAreaBinding');
let disposeActionLoader: (() => void) | undefined;
beforeAll(async () => { disposeActionLoader = await installRealActionExecutorModuleLoader(); });
afterAll(() => disposeActionLoader?.());
beforeEach(() => { artifacts.clear(); grants = []; unknownDelete = false; refuseWrites = false; holdInventory = null; holdDelete = null; holdRead = null; holdCreate = null; deletes.length = 0; selected.length = 0; });

type MountedDashboardHeaderProps = React.ComponentProps<typeof ProjectDashboardHeader> & Readonly<{ onSelectDashboard: (id: string | null) => void }>;
function MountedDashboardHeader(props: MountedDashboardHeaderProps) {
    const checkout = React.useMemo(() => ({ ...props.workspaceRef, rootPath: props.activeRootPath }), [props.workspaceRef, props.activeRootPath]);
    useProjectWidgetAreaBinding({ serverId: props.workspaceRef.serverId, projectName: props.projectName,
        projectRef: props.workspaceRef, activeCheckout: checkout, layoutId: props.layoutId ?? undefined,
        onSelectLayout: props.onSelectDashboard });
    return <ProjectDashboardHeader {...props} />;
}

function header(layoutId: string | null, overrides: Partial<MountedDashboardHeaderProps> = {}) {
    return <runtime.Wrapper><MountedDashboardHeader
        workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
        activeRootPath="/repo" projectName="happier" layoutId={layoutId} onSelectDashboard={id => selected.push(id)} {...overrides}
    /></runtime.Wrapper>;
}

async function renderReleaseSelected() {
    const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('widgets.area.layout.create', {
        surface, layoutId: 'release', name: 'Release',
    }, { surface: 'ui', serverId: runtime.serverId, expectedAccountId: 'account-a' });
    if (!result.ok) throw new Error(`Dashboard fixture refused: ${JSON.stringify(result)}`);
    const dashboard = WidgetInstanceActionOutputSchemasV1['widgets.area.layout.create'].parse(result.result);
    const screen = await renderScreen(<runtime.Wrapper><MountedDashboardHeader
        workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
        activeRootPath="/repo" projectName="happier" layoutId="release" onSelectDashboard={id => selected.push(id)}
    /></runtime.Wrapper>);
    const actions = () => screen.findAllByType(DropdownMenu).find(node =>
        node.props.items.some((item: { id: string; disabled?: boolean }) => item.id === 'delete' && item.disabled !== true));
    await vi.waitFor(() => expect(actions()).toBeTruthy());
    return { screen, dashboard, actions: actions()! };
}

describe('ProjectDashboardHeader', () => {
    it('PF4 publishes only changed named-dashboard summaries after identical reads and a rename', async () => {
        const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'pf4-project' } };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId: runtime.serverId, expectedAccountId: 'account-a' };
        for (const layoutId of ['one', 'two']) expect(await executor.execute('widgets.area.layout.create', {
            surface, layoutId, name: layoutId,
        }, context)).toMatchObject({ ok: true });
        let current!: ReturnType<typeof useProjectDashboards>;
        const renders: string[] = [];
        type Summary = ReturnType<typeof useProjectDashboards>['state']['dashboards'][number];
        const Row = React.memo(({ summary }: { summary: Summary }) => { renders.push(summary.artifactId); return null; });
        function Probe() {
            current = useProjectDashboards({ serverId: runtime.serverId, projectKey: 'pf4-project' });
            return <>{current.state.dashboards.map(summary => <Row key={summary.artifactId} summary={summary} />)}</>;
        }
        await renderScreen(<runtime.Wrapper><Probe /></runtime.Wrapper>);
        await vi.waitFor(() => expect(current.state.status).toBe('ready'));
        const before = current.state;
        expect(before.dashboards).toHaveLength(3);
        renders.length = 0;
        await act(async () => { await current.reload(); });
        expect({ sameState: current.state === before, sameRows: current.state.dashboards === before.dashboards,
            renders: renders.length }).toEqual({ sameState: true, sameRows: true, renders: 0 });
        const selected = before.dashboards.find(summary => summary.name === 'one')!;
        await act(async () => { await current.rename(selected, 'Renamed'); });
        await vi.waitFor(() => expect(current.state.dashboards.find(row => row.artifactId === selected.artifactId)?.name).toBe('Renamed'));
        expect(current.state).not.toBe(before);
        expect(renders).toEqual([selected.artifactId]);
        for (const row of before.dashboards.filter(row => row.artifactId !== selected.artifactId)) {
            expect(current.state.dashboards.find(next => next.artifactId === row.artifactId)).toBe(row);
        }
    });
    it('materializes the exact missing default only on Share, preserving its preset and ordinary document sharing', async () => {
        const show = vi.spyOn(Modal, 'show');
        try {
            const screen = await renderScreen(header(null));
            const bar = () => screen.findAllByType(WidgetAreaLayoutBar)[0]!;
            await vi.waitFor(() => expect(bar().props.actions?.share).toBeTypeOf('function'));
            const artifactId = bar().props.selectedId;
            expect(artifacts.list()).toEqual([]);
            await act(async () => { await bar().props.actions.share(); });
            expect(artifacts.read(artifactId)).not.toBeNull();
            const layout = WidgetAreaLayoutV1Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
            expect(layout.items.some(item => item.kind === 'widget' && item.instance.id === 'code')).toBe(true);
            expect(show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ artifactId }) }));
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const principal = { kind: 'account', accountId: 'recipient' } as const;
            const granted = await createDefaultActionExecutor().execute('artifact.access.grants.set', {
                artifactId, principal, accessLevel: 'view',
            }, { surface: 'ui', serverId: runtime.serverId, expectedAccountId: 'account-a' });
            expect(granted).toMatchObject({ ok: true, result: { changed: true, grants: [{ principal, accessLevel: 'view' }] } });
            await act(async () => { await bar().props.actions.share(); });
            expect(artifacts.list()).toHaveLength(1);
            expect(selected).toEqual([]);
        } finally { show.mockRestore(); }
    });
    it('does not open sharing or change selection when default materialization is refused', async () => {
        const show = vi.spyOn(Modal, 'show');
        try {
            const screen = await renderScreen(header(null));
            const bar = () => screen.findAllByType(WidgetAreaLayoutBar)[0]!;
            await vi.waitFor(() => expect(bar().props.actions?.share).toBeTypeOf('function'));
            show.mockClear();
            refuseWrites = true;
            await act(async () => { await bar().props.actions.share(); });
            expect(artifacts.list()).toEqual([]);
            expect(show).not.toHaveBeenCalled();
            expect(selected).toEqual([]);
        } finally { show.mockRestore(); }
    });
    it('waits for materialization acknowledgement and ignores it after the sharing destination unmounts', async () => {
        const show = vi.spyOn(Modal, 'show');
        const pending = createDeferred<void>();
        const started = createDeferred<void>();
        let sharing: Promise<void> | undefined;
        try {
            const screen = await renderScreen(header(null));
            const bar = () => screen.findAllByType(WidgetAreaLayoutBar)[0]!;
            await vi.waitFor(() => expect(bar().props.actions?.share).toBeTypeOf('function'));
            show.mockClear();
            holdCreate = async () => { started.resolve(); await pending.promise; };
            await act(async () => { sharing = bar().props.actions.share(); await started.promise; });
            expect(show).not.toHaveBeenCalled();
            expect(artifacts.list()).toEqual([]);
            await screen.unmount();
            pending.resolve();
            await sharing;
            expect(show).not.toHaveBeenCalled();
            expect(selected).toEqual([]);
        } finally { pending.resolve(); await sharing; show.mockRestore(); }
    });
    it('maps the admitted default dashboard to the null Overview route and keeps named dashboard selection exact', async () => {
        const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId: runtime.serverId, expectedAccountId: 'account-a' };
        expect(await executor.execute('widgets.area.layout.create', { surface, layoutId: 'release', name: 'Release' }, context)).toMatchObject({ ok: true });
        const result = await executor.execute('widgets.area.layout.list', { surface }, context);
        if (!result.ok) throw new Error(`Dashboard inventory refused: ${JSON.stringify(result)}`);
        const inventory = WidgetInstanceActionOutputSchemasV1['widgets.area.layout.list'].parse(result.result).layouts;
        expect(inventory.filter(row => row.isDefault)).toHaveLength(1);
        expect(projectDashboardRouteId(inventory.find(row => row.isDefault)!)).toBeNull();
        expect(projectDashboardRouteId(inventory.find(row => !row.isDefault)!)).toBe('release');
    });
    it('keeps an unavailable attached selection distinct from personal Overview and permits only an explicit private selection', async () => {
        const before = artifacts.list();
        const screen = await renderScreen(header(null, { attachedDashboard: { sourceId: 'team-source', artifactId: 'attached-shared-dashboard' } }));
        await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.layouts.some((option: { isDefault?: boolean }) => option.isDefault)).toBe(true));
        const bar = () => screen.findAllByType(WidgetAreaLayoutBar)[0]!;
        expect(bar().props.selectedId).toBe('attached-shared-dashboard');
        expect(bar().props.layouts.find((option: { id: string }) => option.id === 'attached-shared-dashboard')).toMatchObject({ unavailable: true });
        expect(bar().props.actions).toBeNull();
        expect(artifacts.list()).toEqual(before);
        await vi.waitFor(() => expect(bar().props.layouts.find((option: { isDefault?: boolean }) => option.isDefault)?.id).not.toBe('default'));
        const personalDefault = bar().props.layouts.find((option: { isDefault?: boolean }) => option.isDefault);
        await act(async () => { await bar().props.onSelect(personalDefault.id); });
        expect(selected).toEqual([null]);
        expect(artifacts.list()).toEqual(before);
    });
    it.each([
        ['view', []],
        ['edit', ['rename']],
        ['admin', ['share', 'rename']],
        ['owner', ['share', 'rename']],
    ] as const)('offers an attached shared dashboard only the operations its %s access admits', async (access, expected) => {
        const surface = { serverId: runtime.serverId, accountId: 'account-owner', artifactId: 'attached-shared-dashboard',
            owner: { kind: 'project' as const, projectId: 'project-key', layoutId: 'release' } };
        const screen = await renderScreen(header(null, {
            attachedDashboard: { sourceId: 'team-source', artifactId: 'attached-shared-dashboard' },
            sharedDashboard: { artifactId: 'attached-shared-dashboard', surface, name: 'Release', access,
                viewerScope: { serverId: runtime.serverId, accountId: 'account-a' }, revision: { headerVersion: 3, bodyVersion: 3 } },
        }));
        const bar = () => screen.findAllByType(WidgetAreaLayoutBar)[0]!;
        await vi.waitFor(() => expect(bar().props.selectedId).toBe('attached-shared-dashboard'));
        const actions = bar().props.actions;
        const offered = actions ? ['share', 'attach', 'rename', 'moveBefore', 'moveAfter', 'delete'].filter(id => actions[id]) : [];
        // Personal inventory authority (attach, reorder, delete) never extends to someone else's document.
        expect(offered).toEqual(expected);
    });

    it.each([null, 'release'])('creates a present empty dashboard from selection %s before the inventory hydrates', async layoutId => {
        if (layoutId) {
            const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const executor = createDefaultActionExecutor();
            const context = { surface: 'ui' as const, serverId: runtime.serverId, expectedAccountId: 'account-a' };
            expect(await executor.execute('widgets.area.layout.create', { surface, layoutId, name: 'Release', fromSurface: surface }, context)).toMatchObject({ ok: true });
            expect(await executor.execute('widgets.item.remove', { ref: { surface: { ...surface, owner: { ...surface.owner, layoutId } }, instanceId: 'code' } },
                { ...context, bypassApprovals: true } as never)).toMatchObject({ ok: true });
        }
        let releaseInventory!: () => void;
        const waiting = new Promise<void>(resolve => { releaseInventory = resolve; });
        holdInventory = () => waiting;
        let submit!: (name: string) => void;
        const prompt = vi.spyOn(Modal, 'prompt').mockImplementationOnce(() => new Promise<string>(resolve => { submit = resolve; }));
        const screen = await renderScreen(<runtime.Wrapper><MountedDashboardHeader
            workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
            activeRootPath="/repo" projectName="happier" layoutId={layoutId} onSelectDashboard={id => selected.push(id)}
        /></runtime.Wrapper>);
        try {
            await act(async () => screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.onCreate());
            expect(submit).toBeTypeOf('function');
            await act(async () => { holdInventory = null; releaseInventory(); });
            await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.selectedId).not.toBe(''));
            await act(async () => submit('Early copy'));
            await vi.waitFor(() => {
                const created = artifacts.list().find(row => row.id && artifacts.readPlainBody(row.id)?.includes('Early copy'));
                expect(created).toBeTruthy();
                const layout = WidgetAreaLayoutV1Schema.parse(JSON.parse(artifacts.readPlainBody(created!.id)!));
                expect(layout.items).toEqual([]);
            });
            await vi.waitFor(() => expect(selected).toHaveLength(1));
        } finally { prompt.mockRestore(); releaseInventory(); }
    });
    it('keeps a routed dashboard pending, never unavailable, while the inventory has not answered', async () => {
        const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('widgets.area.layout.create', { surface, layoutId: 'release', name: 'Release' },
            { surface: 'ui', serverId: runtime.serverId, expectedAccountId: 'account-a' })).toMatchObject({ ok: true });
        const inventory = createDeferred<void>();
        holdInventory = () => inventory.promise;
        const screen = await renderScreen(header('release'));
        try {
            await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar).length).toBeGreaterThan(0));
            const pending = screen.findAllByType(WidgetAreaLayoutBar)[0]!;
            const routed = pending.props.layouts.find((option: { id: string }) => option.id === pending.props.selectedId);
            expect(routed).toBeTruthy();
            expect(routed).not.toMatchObject({ unavailable: true });
            expect(routed.name).not.toBe('projects.dashboard.unavailable');
            inventory.resolve();
            await vi.waitFor(() => {
                const bar = screen.findAllByType(WidgetAreaLayoutBar)[0]!;
                expect(bar.props.layouts.find((option: { id: string }) => option.id === bar.props.selectedId)).toMatchObject({ name: 'Release' });
            });
        } finally { inventory.resolve(); await screen.unmount(); }
    });

    it('leaves an explicitly missing dashboard unavailable without lending it Overview actions', async () => {
        const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('widgets.item.remove', { ref: { surface, instanceId: 'code' } },
            { surface: 'ui', serverId: runtime.serverId, expectedAccountId: 'account-a', bypassApprovals: true } as never)).toMatchObject({ ok: true });
        const before = artifacts.list();
        const screen = await renderScreen(header('removed'));
        // The routed tab exists while the inventory is pending; only its settled answer establishes absence.
        await vi.waitFor(() => {
            const bar = screen.findAllByType(WidgetAreaLayoutBar)[0]!;
            expect(bar.props.layouts.find((option: { id: string }) => option.id === bar.props.selectedId)).toMatchObject({ unavailable: true });
        });
        const bar = screen.findAllByType(WidgetAreaLayoutBar)[0]!;
        expect(bar.props.layouts.find((option: { id: string }) => option.id === bar.props.selectedId)).toMatchObject({ unavailable: true });
        expect(bar.props.actions).toBeNull();
        expect(artifacts.list()).toEqual(before);
    });

    it.each(['selection', 'checkout', 'project'] as const)('settles only the still-displayed deleted document after its %s changes', async retirement => {
        const { screen, dashboard, actions } = await renderReleaseSelected();
        let complete!: () => void;
        holdDelete = () => new Promise<void>(resolve => { complete = resolve; });
        await act(async () => { actions.props.onSelect('delete'); });
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
        const overrides = retirement === 'checkout' ? { activeRootPath: '/repo/feature', activeWorktreeId: 'feature' }
            : retirement === 'project' ? { workspaceRef: { id: 'w2', serverId: runtime.serverId, machineId: 'm2', rootPath: '/other', createdAtMs: 1, projectKey: 'other-key' }, activeRootPath: '/other' } : {};
        await screen.update(header(retirement === 'selection' ? null : 'release', overrides));
        await act(async () => complete());
        await vi.waitFor(() => expect(artifacts.read(dashboard.artifactId)).toBeNull());
        // Changing checkout keeps the same Project dashboard displayed; another layout or Project must stay put.
        expect(selected).toEqual(retirement === 'checkout' ? [null] : []);
    });

    it('retires a pending Create prompt when the selected dashboard changes before submission', async () => {
        const { screen } = await renderReleaseSelected();
        let submit!: (name: string) => void;
        const prompt = vi.spyOn(Modal, 'prompt').mockImplementationOnce(() => new Promise<string>(resolve => { submit = resolve; }));
        try {
            await act(async () => screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.onCreate());
            await screen.update(header(null));
            await act(async () => submit('Retired dashboard'));
            expect(artifacts.list().some(row => artifacts.readPlainBody(row.id)?.includes('Retired dashboard'))).toBe(false);
            expect(selected).toEqual([]);
        } finally { prompt.mockRestore(); }
    });

    it('asks by name before deleting a named dashboard, and a declined confirmation changes nothing', async () => {
        const { dashboard, actions } = await renderReleaseSelected();
        const prompt = vi.spyOn(Modal, 'confirm').mockResolvedValueOnce(false);
        try {
            await act(async () => actions.props.onSelect('delete'));
            expect(prompt).toHaveBeenCalledTimes(1);
            expect(prompt.mock.calls[0]).toEqual(['projects.dashboard.deleteConfirmTitle(name=Release)', 'projects.dashboard.deleteConfirmBody',
                expect.objectContaining({ destructive: true })]);
            expect(deletes).toEqual([]);
            expect(artifacts.read(dashboard.artifactId)).not.toBeNull();
            expect(selected).toEqual([]);
        } finally { prompt.mockRestore(); }
    });

    it('keeps an acknowledged creation on its captured Project without selecting it after navigation', async () => {
        const { screen } = await renderReleaseSelected();
        let complete!: () => void;
        artifacts.afterNextCreate(() => new Promise<void>(resolve => { complete = resolve; }));
        const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValueOnce('Created on previous Project');
        try {
            await act(async () => screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.onCreate());
            await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
            await screen.update(header('release', { activeRootPath: '/repo/feature', activeWorktreeId: 'feature' }));
            await act(async () => complete());
            await vi.waitFor(() => expect(artifacts.list().some(row => artifacts.readPlainBody(row.id)?.includes('Created on previous Project'))).toBe(true));
            expect(selected).toEqual([]);
        } finally { prompt.mockRestore(); }
    });

    it('commits selection before its read and never selects again after the checkout changes', async () => {
        const { screen, dashboard } = await renderReleaseSelected();
        let complete!: () => void;
        holdRead = path => path === `/v1/artifacts/${dashboard.artifactId}`
            ? new Promise<void>(resolve => { complete = resolve; }) : Promise.resolve();
        let selecting!: Promise<void>;
        await act(async () => { selecting = screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.onSelect(dashboard.artifactId); });
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
        // Selection-before-read is the owner-approved contract; checkout changes retire only its continuation.
        expect(selected).toEqual(['release']);
        await screen.update(header('release', { activeRootPath: '/repo/feature', activeWorktreeId: 'feature' }));
        holdRead = null;
        await act(async () => { complete(); await selecting; });
        expect(selected).toEqual(['release']);
    });
    it('moves a user view before the host Overview through the real menu and canonical layout Action', async () => {
        const { screen, dashboard, actions } = await renderReleaseSelected();
        await act(async () => { actions.props.onSelect('moveBefore'); });
        await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.layouts.map((option: { name: string }) => option.name))
            .toEqual(['Release', 'Overview']));
        expect(artifacts.read(dashboard.artifactId)?.headerVersion).toBeGreaterThan(dashboard.revision!.headerVersion);
        expect(selected).toEqual([]);
    });
    it.each(['owner', 'socket'] as const)('settles the deleted selection before its %s removal publication, without waiting for inventory', async source => {
        const { dashboard, actions } = await renderReleaseSelected();
        const { storage } = await import('@/sync/domains/state/storage');
        const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
        retirePresentationNotice();
        const inventory = createDeferred<void>();
        holdInventory = () => inventory.promise;
        let atRemoval: { selected: (string | null)[]; notice: string | undefined } | undefined;
        const unsubscribe = storage.subscribe((state, previous) => {
            if (previous.artifacts[dashboard.artifactId] && !state.artifacts[dashboard.artifactId]) {
                atRemoval = { selected: [...selected], notice: readPresentationNotice()?.key };
            }
        });
        try {
            if (source === 'owner') await act(async () => { actions.props.onSelect('delete'); });
            else {
                await artifacts.handle(`/v1/artifacts/${dashboard.artifactId}/revision/${dashboard.revision?.headerVersion}/${dashboard.revision?.bodyVersion}`, { method: 'DELETE' });
                const { handleDeleteArtifactSocketUpdate } = await import('@/sync/engine/artifacts/syncArtifacts');
                await act(async () => { handleDeleteArtifactSocketUpdate({ artifactId: dashboard.artifactId,
                    deleteArtifact: storage.getState().deleteArtifact, artifactDataKeys: new Map() }); });
            }
            await vi.waitFor(() => expect(artifacts.read(dashboard.artifactId)).toBeNull());
            expect(atRemoval).toEqual({ selected: [null], notice: source === 'owner' ? `dashboard-deleted:${dashboard.artifactId}` : undefined });
            expect(deletes).toEqual(source === 'owner' ? [`/v1/artifacts/${dashboard.artifactId}/revision/${dashboard.revision?.headerVersion}/${dashboard.revision?.bodyVersion}`] : []);
        } finally { unsubscribe(); holdInventory = null; inventory.resolve(); }
    });

    it.each(['rename', 'moveBefore', 'delete'] as const)('settles a refused %s truthfully: the dashboard stays as it was, the refusal says so once, and Retry repeats the request', async (operation) => {
        const { readPresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
        const { screen, dashboard, actions } = await renderReleaseSelected();
        const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue('Shipping');
        try {
            refuseWrites = true;
            await act(async () => { await actions.props.onSelect(operation); });
            await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'error', undo: { label: 'common.retry' } }));
            // A known refusal is not an unknown delete: it never claims the dashboard may be gone.
            expect(screen.findByTestId('project-dashboards.deleteUnknown')).toBeNull();
            expect(artifacts.read(dashboard.artifactId)).not.toBeNull();
            expect(selected).toEqual([]);
            refuseWrites = false;
            await act(async () => { readPresentationNotice()!.undo!.run(); });
            if (operation === 'rename') {
                // Retry starts from what was asked for, not from the old name.
                expect(prompt.mock.calls.at(-1)?.[2]).toMatchObject({ defaultValue: 'Shipping' });
                await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.layouts
                    .some((option: { name: string }) => option.name === 'Shipping')).toBe(true));
            } else if (operation === 'delete') {
                await vi.waitFor(() => expect(artifacts.read(dashboard.artifactId)).toBeNull());
            } else {
                await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.layouts
                    .map((option: { name: string }) => option.name)).toEqual(['Release', 'Overview']));
            }
        } finally { prompt.mockRestore(); }
    });

    it('keeps the dashboard selected and says so when the delete outcome is unknown', async () => {
        const { readPresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
        const { screen, dashboard, actions } = await renderReleaseSelected();
        unknownDelete = true;
        await act(async () => { actions.props.onSelect('delete'); });
        await vi.waitFor(() => expect(screen.findByTestId('project-dashboards.deleteUnknown')).toBeTruthy());
        expect(selected).toEqual([]);
        expect(artifacts.read(dashboard.artifactId)).not.toBeNull();
        expect(deletes).toHaveLength(1);
        expect(readPresentationNotice()?.undo).toBeUndefined();
    });

    it('marks a host preset this viewer has edited with the quiet dot, and leaves an untouched preset and user views plain', async () => {
        const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const context = { surface: 'ui' as const, serverId: runtime.serverId, expectedAccountId: 'account-a' };
        const executor = createDefaultActionExecutor();
        expect((await executor.execute('widgets.area.layout.create', { surface, layoutId: 'release', name: 'Release' }, context)).ok).toBe(true);
        const render = async () => renderScreen(<runtime.Wrapper><ProjectDashboardHeader
            workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
            activeRootPath="/repo" projectName="happier" layoutId={null}
        /></runtime.Wrapper>);
        const edited = async (screen: Awaited<ReturnType<typeof render>>) => {
            let options: readonly { name: string; isDefault: boolean; edited?: boolean }[] = [];
            await vi.waitFor(() => {
                options = screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.layouts;
                expect(options.length).toBeGreaterThan(1);
            });
            return options.filter(option => option.edited).map(option => option.isDefault ? 'default' : option.name);
        };
        const screen = await render();
        expect(await edited(screen)).toEqual([]);
        // The first personal edit of the Overview preset materializes this viewer's copy of it.
        await act(async () => { expect((await executor.execute('widgets.item.remove', { ref: { surface, instanceId: 'code' } }, { ...context, bypassApprovals: true } as never)).ok).toBe(true); });
        await vi.waitFor(async () => expect(await edited(screen)).toEqual(['default']));
    });
});
