import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetInstanceActionOutputSchemasV1, WidgetAreaLayoutV1Schema } from '@happier-dev/protocol/widgets';
import { Modal } from '@/modal';
import { renderScreen } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ProjectDashboardHeader } from './ProjectDashboardHeader';
import { WidgetAreaLayoutBar } from '@/components/widgets/area/WidgetAreaLayoutBar';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let unknownDelete = false;
let holdInventory: (() => Promise<void>) | null = null;
let holdDelete: (() => Promise<void>) | null = null;
let holdRead: ((path: string) => Promise<void>) | null = null;
const deletes: string[] = [];
const selected: (string | null)[] = [];
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') await holdInventory?.();
    if (path.startsWith('/v1/artifacts/') && (init?.method ?? 'GET') === 'GET') await holdRead?.(path);
    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'widgets.area.layout.delete': ['ui'] } },
    } }, version: 1 });
    if (init?.method === 'DELETE' && path.startsWith('/v1/artifacts/')) {
        deletes.push(path);
        await holdDelete?.();
        if (unknownDelete) throw new TypeError('The Home lost the deletion acknowledgement');
    }
    return artifacts.handle(path, init);
} });
let disposeActionLoader: (() => void) | undefined;
beforeAll(async () => { disposeActionLoader = await installRealActionExecutorModuleLoader(); });
afterAll(() => disposeActionLoader?.());
beforeEach(() => { artifacts.clear(); unknownDelete = false; holdInventory = null; holdDelete = null; holdRead = null; deletes.length = 0; selected.length = 0; });

function header(layoutId: string | null, overrides: Partial<React.ComponentProps<typeof ProjectDashboardHeader>> = {}) {
    return <runtime.Wrapper><ProjectDashboardHeader
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
    const screen = await renderScreen(<runtime.Wrapper><ProjectDashboardHeader
        workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
        activeRootPath="/repo" projectName="happier" layoutId="release" onSelectDashboard={id => selected.push(id)}
    /></runtime.Wrapper>);
    const actions = () => screen.findAllByType(DropdownMenu).find(node =>
        node.props.items.some((item: { id: string; disabled?: boolean }) => item.id === 'delete' && item.disabled !== true));
    await vi.waitFor(() => expect(actions()).toBeTruthy());
    return { screen, dashboard, actions: actions()! };
}

describe('ProjectDashboardHeader', () => {
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
        const screen = await renderScreen(<runtime.Wrapper><ProjectDashboardHeader
            workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
            activeRootPath="/repo" projectName="happier" layoutId={layoutId} onSelectDashboard={id => selected.push(id)}
        /></runtime.Wrapper>);
        try {
            await act(async () => screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.onCreate());
            expect(submit).toBeTypeOf('function');
            await act(async () => { holdInventory = null; releaseInventory(); });
            await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.selectedId).not.toBe(''));
            await act(async () => submit('Early copy'));
            await vi.waitFor(() => expect(selected).toHaveLength(1));
            const copied = artifacts.list().find(row => row.id && artifacts.readPlainBody(row.id)?.includes('Early copy'));
            expect(copied).toBeTruthy();
            const layout = WidgetAreaLayoutV1Schema.parse(JSON.parse(artifacts.readPlainBody(copied!.id)!));
            expect(layout.items).toEqual([]);
        } finally { prompt.mockRestore(); releaseInventory(); }
    });
    it('leaves an explicitly missing dashboard unavailable without lending it Overview actions', async () => {
        const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('widgets.item.remove', { ref: { surface, instanceId: 'code' } },
            { surface: 'ui', serverId: runtime.serverId, expectedAccountId: 'account-a', bypassApprovals: true } as never)).toMatchObject({ ok: true });
        const before = artifacts.list();
        const screen = await renderScreen(header('removed'));
        await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.layouts.length).toBeGreaterThan(0));
        const bar = screen.findAllByType(WidgetAreaLayoutBar)[0]!;
        expect(bar.props.layouts.find((option: { id: string }) => option.id === bar.props.selectedId)).toMatchObject({ unavailable: true });
        expect(bar.props.actions).toBeNull();
        expect(artifacts.list()).toEqual(before);
    });

    it.each(['selection', 'checkout', 'project'] as const)('does not navigate an acknowledged delete after its %s retires', async retirement => {
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
        expect(selected).toEqual([]);
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

    it('does not remove a document after its confirmation outlives the selected dashboard', async () => {
        const { screen, dashboard, actions } = await renderReleaseSelected();
        let confirm!: (accepted: boolean) => void;
        const prompt = vi.spyOn(Modal, 'confirm').mockImplementationOnce(() => new Promise<boolean>(resolve => { confirm = resolve; }));
        try {
            await act(async () => actions.props.onSelect('delete'));
            await screen.update(header(null));
            await act(async () => confirm(true));
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

    it('does not restore a selected document when its read completes after the checkout changes', async () => {
        const { screen, dashboard } = await renderReleaseSelected();
        let complete!: () => void;
        holdRead = path => path === `/v1/artifacts/${dashboard.artifactId}`
            ? new Promise<void>(resolve => { complete = resolve; }) : Promise.resolve();
        let selecting!: Promise<void>;
        await act(async () => { selecting = screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.onSelect(dashboard.artifactId); });
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
        await screen.update(header('release', { activeRootPath: '/repo/feature', activeWorktreeId: 'feature' }));
        holdRead = null;
        await act(async () => { complete(); await selecting; });
        expect(selected).toEqual([]);
    });
    it('moves a user view before the host Overview through the real menu and canonical layout Action', async () => {
        const { screen, dashboard, actions } = await renderReleaseSelected();
        await act(async () => { actions.props.onSelect('moveBefore'); });
        await vi.waitFor(() => expect(screen.findAllByType(WidgetAreaLayoutBar)[0]!.props.layouts.map((option: { name: string }) => option.name))
            .toEqual(['Release', 'Overview']));
        expect(artifacts.read(dashboard.artifactId)?.headerVersion).toBeGreaterThan(dashboard.revision!.headerVersion);
        expect(selected).toEqual([]);
    });
    it('deletes the exact selected dashboard at its revision, then selects the default Overview', async () => {
        const { dashboard, actions } = await renderReleaseSelected();
        await act(async () => { actions.props.onSelect('delete'); });
        await vi.waitFor(() => expect(selected).toEqual([null]));
        expect(deletes).toEqual([`/v1/artifacts/${dashboard.artifactId}/revision/${dashboard.revision?.headerVersion}/${dashboard.revision?.bodyVersion}`]);
        expect(artifacts.read(dashboard.artifactId)).toBeNull();
    });

    it('keeps the dashboard selected and says so when the delete outcome is unknown', async () => {
        const { screen, dashboard, actions } = await renderReleaseSelected();
        unknownDelete = true;
        await act(async () => { actions.props.onSelect('delete'); });
        await vi.waitFor(() => expect(screen.findByTestId('project-dashboards.deleteUnknown')).toBeTruthy());
        expect(selected).toEqual([]);
        expect(artifacts.read(dashboard.artifactId)).not.toBeNull();
        expect(deletes).toHaveLength(1);
    });

    it('marks a host preset this viewer has edited with the quiet dot, and leaves an untouched preset and user views plain', async () => {
        const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const context = { surface: 'ui' as const, serverId: runtime.serverId, expectedAccountId: 'account-a' };
        const executor = createDefaultActionExecutor();
        expect((await executor.execute('widgets.area.layout.create', { surface, layoutId: 'release', name: 'Release' }, context)).ok).toBe(true);
        const render = async () => renderScreen(<runtime.Wrapper><ProjectDashboardHeader
            workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
            activeRootPath="/repo" projectName="happier" layoutId={null} onSelectDashboard={() => {}}
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
