import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildWidgetSurfaceArtifactIdV1, WidgetInstanceActionOutputSchemasV1 } from '@happier-dev/protocol/widgets';
import { renderHook, renderScreen } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { USAGE_WIDGET_PRESET_IDS } from '@/components/settings/usage/usageWidgetPresets';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readUsageWidgetPageContext, readUsageWidgetPageScope } from '@/components/settings/usage/usageWidgetPageContext';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let actionPolicy = normalizeActionsSettingsV1({ v: 1 });
let artifactReadFails = false;
let layoutReadPaths: string[] = [];
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (/^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET') layoutReadPaths.push(path);
    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: actionPolicy } }, version: 0 });
    if (artifactReadFails && /^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET')
        return Response.json({ error: 'Failed to get artifact' }, { status: 500 });
    return artifacts.handle(path + new URL(String(url)).search, init);
} });
// Load the rendered area graph after installing HTTP boundaries, outside the timed Account journey.
const { WidgetArea } = await import('./WidgetArea');
function setActionPolicy(policy: ReturnType<typeof normalizeActionsSettingsV1>) {
    actionPolicy = policy;
    storage.setState({ settingsScope: { serverId: runtime.serverId, accountId: 'account-a' },
        settings: { ...storage.getState().settings, actionsSettingsV1: policy } });
}
let disposeActionLoader: (() => void) | undefined;
let useCorePageWidgetAreaBinding: typeof import('./useCorePageWidgetAreaBinding')['useCorePageWidgetAreaBinding'];
let useWidgetAreaLayouts: typeof import('@/components/projects/overview/useProjectDashboards')['useWidgetAreaLayouts'];
let useWidgetAreaLayout: typeof import('./useWidgetAreaLayout')['useWidgetAreaLayout'];
let WidgetAreaPresetLine: typeof import('./WidgetAreaPresetLine')['WidgetAreaPresetLine'];
let useUsageWidgetAreaBinding: typeof import('@/components/settings/usage/useUsageWidgetAreaBinding')['useUsageWidgetAreaBinding'];
beforeAll(async () => {
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    disposeActionLoader = await installRealActionExecutorModuleLoader();
    ({ useCorePageWidgetAreaBinding } = await import('./useCorePageWidgetAreaBinding'));
    ({ useWidgetAreaLayouts } = await import('@/components/projects/overview/useProjectDashboards'));
    ({ useWidgetAreaLayout } = await import('./useWidgetAreaLayout'));
    ({ WidgetAreaPresetLine } = await import('./WidgetAreaPresetLine'));
    ({ useUsageWidgetAreaBinding } = await import('@/components/settings/usage/useUsageWidgetAreaBinding'));
});
afterAll(() => disposeActionLoader?.());
beforeEach(() => {
    artifacts.clear(); retirePresentationNotice();
    artifactReadFails = false;
    layoutReadPaths = [];
    // These layout-owner scenarios exercise acknowledged edits under the user's explicit policy.
    setActionPolicy(normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'widgets.item.rename': ['ui'], 'widgets.item.move': ['ui'],
            'widgets.area.layout.create': ['ui'], 'widgets.area.layout.reset': ['ui'], 'widgets.area.layout.undo': ['ui'] },
    }));
});

it('retains an admitted core-page area through a transient Artifact HTTP failure and admits recovery', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const, instance: {
            v: 1 as const, id: 'displayed', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {},
        } }] },
    ] };
    let current!: { binding: ReturnType<typeof useCorePageWidgetAreaBinding>; layout: ReturnType<typeof useWidgetAreaLayout> };
    function Composition() {
        const binding = useCorePageWidgetAreaBinding(input);
        const layout = useWidgetAreaLayout(binding.port!, input.context);
        current = { binding, layout };
        return <WidgetArea port={binding.port} context={input.context} layout={layout} geometry="grid"
            title="Overview" surfaceName="Overview" dashboard={{ addLabel: 'Add widget', emptyTitle: 'No widgets' }} testID="core.area" />;
    }
    const screen = await renderScreen(<Composition />);
    try {
        await vi.waitFor(() => expect(current.layout.state).toMatchObject({ status: 'ready', placements: [{ instance: { id: 'displayed' } }] }));
        const admitted = current.layout.state;
        const body = screen.findByTestId('core.area.widget.displayed.body');
        expect(body).not.toBeNull();
        artifactReadFails = true;
        await act(async () => {
            expect(await current.layout.reload()).toMatchObject({ status: 'unavailable', reasonCode: 'widget_area_unavailable' });
        });
        const failed = current.layout.state;
        expect(failed).toMatchObject({ status: 'ready', readFailure: { reasonCode: 'widget_area_unavailable' } });
        expect(failed.status === 'ready' && admitted.status === 'ready' && failed.placements === admitted.placements).toBe(true);
        expect(failed.status === 'ready' && failed.isReadPending()).toBe(false);
        expect(admitted.status === 'ready' && admitted.isCurrent()).toBe(true);
        expect(screen.findByTestId('core.area.widget.displayed.body')).toBe(body);
        expect(screen.findByTestId('core.area.readFailed')).not.toBeNull();
        artifactReadFails = false;
        await screen.pressByTestIdAsync('core.area.retry');
        await vi.waitFor(() => expect(screen.findByTestId('core.area.readFailed')).toBeNull());
        expect(screen.findByTestId('core.area.widget.displayed.body')).toBe(body);
        expect(current.layout.state).not.toHaveProperty('readFailure');
        await act(async () => {
            expect(await current.binding.port!.execute({ actionId: 'widgets.item.rename', instanceId: 'displayed', displayName: 'Recovered' }))
                .toMatchObject({ ok: true });
            expect(await current.layout.reload()).toMatchObject({ status: 'ready' });
        });
        await vi.waitFor(() => expect(current.layout.state).toMatchObject({ status: 'ready', placements: [{ instance: { displayName: 'Recovered' } }] }));
    } finally { artifactReadFails = false; await screen.unmount(); }
});

it('renews named layouts after same-Account activation without a Profile scope change', async () => {
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const snapshot = getActiveServerSnapshot();
    publishAppliedActiveServerSnapshot(snapshot, false);
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [{ id: 'overview', name: 'Overview', items: [] }] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return { binding, layouts: useWidgetAreaLayouts({ surface: binding.surface, execute: binding.executeLayoutAction }) };
    });
    try {
        expect(hook.getCurrent().binding.surface).toBeNull();
        await act(async () => { publishAppliedActiveServerSnapshot(snapshot); });
        await vi.waitFor(() => expect(hook.getCurrent().layouts.state.dashboards.map(row => row.name)).toEqual(['Overview']));
        const retiredPort = hook.getCurrent().binding.port!;
        await act(async () => { publishAppliedActiveServerSnapshot(snapshot, false); });
        expect(hook.getCurrent().binding.surface).toBeNull();
        expect(await retiredPort.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
        await act(async () => { publishAppliedActiveServerSnapshot(snapshot); });
        await vi.waitFor(() => expect(hook.getCurrent().layouts.state.dashboards.map(row => row.name)).toEqual(['Overview']));
    } finally { await hook.unmount(); publishAppliedActiveServerSnapshot(snapshot); }
});

it('keeps an untouched Usage widget unchanged while its configured UI edit awaits canonical approval', async () => {
    setActionPolicy(normalizeActionsSettingsV1({ v: 1,
        actions: { 'widgets.item.rename': { approvalRequiredSurfaces: ['ui'] } },
    }));
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const, instance: {
            v: 1 as const, id: 'displayed', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {},
        } }] },
    ] };
    const hook = await renderHook(() => useCorePageWidgetAreaBinding(input));
    try {
        const surface = hook.getCurrent().surface!;
        const result = await hook.getCurrent().port!.execute({ actionId: 'widgets.item.rename', instanceId: 'displayed', displayName: 'Personal' });
        expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(artifacts.readPlainBody(buildWidgetSurfaceArtifactIdV1(surface))).toBeNull();
        const approval = artifacts.list().find(row => row.id !== buildWidgetSurfaceArtifactIdV1(surface));
        expect(approval).toBeDefined();
        expect(JSON.parse(artifacts.readPlainBody(approval!.id)!)).toMatchObject({ actionId: 'widgets.item.rename',
            actionArgs: { ref: { surface, instanceId: 'displayed' }, displayName: 'Personal' },
            executionOriginV1: { authority: 'present_user' } });
    } finally { await hook.unmount(); }
});

it('reports a pending new Usage view without treating its approval as an applied layout', async () => {
    setActionPolicy(normalizeActionsSettingsV1({ v: 1,
        actions: { 'widgets.area.layout.create': { approvalRequiredSurfaces: ['ui'] } },
    }));
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return { binding, layouts: useWidgetAreaLayouts({ surface: binding.surface, execute: binding.executeLayoutAction }) };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().layouts.state.status).toBe('ready'));
        let created!: ReturnType<ReturnType<typeof hook.getCurrent>['layouts']['create']>;
        await act(async () => { created = hook.getCurrent().layouts.create('Personal', hook.getCurrent().binding.surface!); });
        await vi.waitFor(() => expect(hook.getCurrent().layouts.approvalId).toBeTypeOf('string'));
        expect(hook.getCurrent().layouts.state.dashboards.map(row => row.name)).toEqual(['Overview']);
        expect(readPresentationNotice()).toMatchObject({ severity: 'info', message: 'widgetAdd.areaApprovalPending' });
        expect(await decideApprovalAsInbox(runtime.serverId, hook.getCurrent().layouts.approvalId!, 'reject')).toMatchObject({ ok: true });
        await expect(created).resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    } finally { await hook.unmount(); }
});

it('keeps an edited preset and offers no Undo while Reset is awaiting approval', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const, instance: {
            v: 1 as const, id: 'displayed', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {},
        } }] },
    ] };
    let binding: ReturnType<typeof useCorePageWidgetAreaBinding> | undefined;
    function Composition() {
        binding = useCorePageWidgetAreaBinding(input);
        return binding.surface ? <WidgetAreaPresetLine preset={{ id: 'overview', name: 'Overview', isEdited: true, changes: [] }}
            surface={binding.surface} presetActions={binding} testID="pending.preset" /> : null;
    }
    const screen = await renderScreen(<Composition />);
    try {
        const port = binding!.port!;
        await act(async () => { expect(await port.execute({ actionId: 'widgets.item.rename', instanceId: 'displayed', displayName: 'Personal' })).toMatchObject({ ok: true }); });
        const artifactId = buildWidgetSurfaceArtifactIdV1(binding!.surface!);
        const before = artifacts.readPlainBody(artifactId);
        setActionPolicy(normalizeActionsSettingsV1({ v: 1,
            actions: { 'widgets.area.layout.reset': { approvalRequiredSurfaces: ['ui'] } },
        }));
        await screen.pressByTestIdAsync('pending.preset.reset');
        await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'info', message: 'widgetAdd.areaApprovalPending' }));
        expect(readPresentationNotice()?.undo).toBeUndefined();
        expect(artifacts.readPlainBody(artifactId)).toBe(before);
        expect(JSON.parse(artifacts.readPlainBody(artifacts.list().find(row => row.id !== artifactId)!.id)!))
            .toMatchObject({ actionId: 'widgets.area.layout.reset' });
    } finally { await screen.unmount(); }
});

it('retains the selected user view while Delete awaits approval', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return { binding, layouts: useWidgetAreaLayouts({ surface: binding.surface, execute: binding.executeLayoutAction }) };
    });
    try {
        await act(async () => { expect(await hook.getCurrent().binding.createLayout('personal', 'Personal')).toMatchObject({ ok: true }); });
        await act(async () => { await hook.getCurrent().layouts.reload(); });
        await vi.waitFor(() => expect(hook.getCurrent().layouts.state.dashboards.some(row => row.name === 'Personal')).toBe(true));
        await act(async () => { expect(await hook.getCurrent().binding.selectLayout('personal')).toMatchObject({ ok: true }); });
        const personal = hook.getCurrent().layouts.state.dashboards.find(row => row.name === 'Personal')!;
        const before = artifacts.readPlainBody(personal.artifactId);
        setActionPolicy(normalizeActionsSettingsV1({ v: 1,
            actions: { 'widgets.area.layout.delete': { approvalRequiredSurfaces: ['ui'] } },
        }));
        let removed!: ReturnType<ReturnType<typeof hook.getCurrent>['layouts']['remove']>;
        await act(async () => { removed = hook.getCurrent().layouts.remove(personal); });
        await vi.waitFor(() => expect(hook.getCurrent().layouts.approvalId).toBeTypeOf('string'));
        expect(hook.getCurrent().binding.surface).toMatchObject({ owner: { layoutId: 'personal' } });
        expect(artifacts.readPlainBody(personal.artifactId)).toBe(before);
        expect(readPresentationNotice()).toMatchObject({ severity: 'info', message: 'widgetAdd.areaApprovalPending' });
        expect(await decideApprovalAsInbox(runtime.serverId, hook.getCurrent().layouts.approvalId!, 'reject')).toMatchObject({ ok: true });
        await expect(removed).resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    } finally { await hook.unmount(); }
});

it('reads the route-selected preset on the first admitted surface without first reading Overview', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, initialLayoutId: 'work', presets: [
        { id: 'overview', name: 'Overview', items: [] },
        { id: 'work', name: 'Work', items: [{ kind: 'widget' as const, instance: {
            v: 1 as const, id: 'work-body', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {},
        } }] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return { binding, layout: useWidgetAreaLayout(binding.port!, input.context) };
    });
    expect(hook.getCurrent().binding.surface).toMatchObject({ owner: { layoutId: 'work' } });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready',
        surface: { owner: { layoutId: 'work' } }, placements: [{ instance: { id: 'work-body' } }] }));
    expect(artifacts.list()).toEqual([]);
    await hook.unmount();
});

it('resets and copies the exact displayed view while a different view is selected', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const, instance: {
            v: 1 as const, id: 'displayed', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {},
        } }] }, { id: 'work', name: 'Work', items: [] },
    ] };
    const hook = await renderHook(() => useCorePageWidgetAreaBinding(input));
    const displayed = hook.getCurrent().surface!;
    expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.rename', instanceId: 'displayed', displayName: 'Personal' })).toMatchObject({ ok: true });
    await act(async () => { expect(await hook.getCurrent().selectLayout('work')).toMatchObject({ ok: true }); });
    const copy = await hook.getCurrent().executeLayoutAction('widgets.area.layout.create', {
        surface: hook.getCurrent().surface, layoutId: 'copy', name: 'Copy', fromSurface: displayed,
    });
    expect(copy).toMatchObject({ ok: true });
    if (!copy.ok) throw new Error(copy.errorCode);
    const copied = WidgetInstanceActionOutputSchemasV1['widgets.area.layout.create'].parse(copy.result);
    expect(JSON.parse(artifacts.readPlainBody(copied.artifactId)!)).toMatchObject({ items: [{ instance: { id: 'displayed', displayName: 'Personal' } }] });
    expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.rename', instanceId: 'displayed', displayName: 'Edited displayed' }, undefined,
        { surface: displayed, context: input.context })).toMatchObject({ ok: true });
    expect(JSON.parse(artifacts.readPlainBody(buildWidgetSurfaceArtifactIdV1(displayed))!)).toMatchObject({ items: [{ instance: { displayName: 'Edited displayed' } }] });
    expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.rename', instanceId: 'displayed', displayName: 'Wrong owner' }, undefined,
        { surface: { ...displayed, accountId: 'other-account' }, context: input.context })).toMatchObject({ ok: false });
    const reset = await hook.getCurrent().resetPreset(displayed);
    expect(reset).toMatchObject({ ok: true, result: { undo: { surface: displayed } } });
    expect(hook.getCurrent().surface).toMatchObject({ owner: { layoutId: 'work' } });
    await hook.unmount();
});

it('updates the mounted core-page model after removing both children from a group without remounting', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'group' as const, id: 'group', children: ['first', 'last'].map(id => ({
            kind: 'widget' as const, frameStyle: 'card' as const,
            instance: { v: 1 as const, id, definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} },
        })) }] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const layout = useWidgetAreaLayout(binding.port!, input.context);
        return { binding, layout };
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', items: [{ kind: 'group' }] }));
    await act(async () => {
        expect(await hook.getCurrent().binding.createLayout('personal', 'Personal')).toMatchObject({ ok: true });
        expect(await hook.getCurrent().binding.selectLayout('personal')).toMatchObject({ ok: true });
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', documentState: 'present',
        surface: { owner: { layoutId: 'personal' } }, items: [{ kind: 'group' }] }));
    for (const id of ['first', 'last']) {
        let acknowledgement: ReturnType<ReturnType<typeof hook.getCurrent>['layout']['write']> | undefined;
        // Do not batch the entire network write and reread into one React commit:
        // the live page renders the Artifact publication before the acknowledgement.
        act(() => {
            acknowledgement = hook.getCurrent().layout.write({ actionId: 'widgets.item.move', instanceId: id, toIndex: 1, groupId: null });
        });
        await vi.waitFor(() => {
            const state = hook.getCurrent().layout.state;
            expect(state.status).toBe('ready');
            if (state.status !== 'ready') throw new Error('Expected ready layout');
            expect(state.isCurrent()).toBe(true);
            expect(state.items.some(item => item.kind === 'widget' && item.instance.id === id && item.frameStyle === 'card')).toBe(true);
            expect(state.items.filter(item => item.kind === 'group').map(item => item.children.map(child => child.instance.id)))
                .toEqual(id === 'first' ? [['last']] : []);
        });
        expect(await acknowledgement).toEqual({ kind: 'applied' });
    }
    await hook.unmount();
});

it('discovers externally created layouts and ignores other areas without remounting', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const other = useCorePageWidgetAreaBinding({ ...input, pageId: 'other-page' });
        const layouts = useWidgetAreaLayouts({ surface: binding.surface, execute: binding.executeLayoutAction });
        return { binding, other, layouts };
    });
    await vi.waitFor(() => expect(hook.getCurrent().layouts.state.status).toBe('ready'));
    const previous = hook.getCurrent().layouts.state;
    await act(async () => { expect(await hook.getCurrent().other.createLayout('unrelated', 'Other')).toMatchObject({ ok: true }); });
    expect(hook.getCurrent().layouts.state).toBe(previous);
    await act(async () => { expect(await hook.getCurrent().binding.createLayout('agent-created', 'Agent view')).toMatchObject({ ok: true }); });
    await vi.waitFor(() => expect(hook.getCurrent().layouts.state.dashboards.map(row => row.name)).toContain('Agent view'));
    await hook.unmount();
});

it('does not rescan the layout Artifact inventory for unrelated store updates', async () => {
    const baseline = storage.getState();
    let enumerations = 0;
    // Observe the real store's full-inventory work without replacing its classification logic.
    const observed = new Proxy(baseline.artifacts, { ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
    } });
    storage.setState({ artifacts: observed });
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return useWidgetAreaLayouts({ surface: binding.surface, execute: binding.executeLayoutAction });
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
        const admitted = hook.getCurrent().state;
        enumerations = 0;
        await act(async () => { storage.setState({ isSessionDraftsReady: !baseline.isSessionDraftsReady }); });
        expect(hook.getCurrent().state).toBe(admitted);
        expect(enumerations).toBe(0);
    } finally {
        await hook.unmount();
        storage.setState({ artifacts: baseline.artifacts, isSessionDraftsReady: baseline.isSessionDraftsReady });
    }
});

it('keeps the Usage tabs and the live preset projection in agreement after edit, Reset and Undo without remounting', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const,
            instance: { v: 1 as const, id: 'child', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} } }] },
        { id: 'costs', name: 'Costs', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const layouts = useWidgetAreaLayouts({ surface: binding.surface, execute: binding.executeLayoutAction });
        const layout = useWidgetAreaLayout(binding.port!, input.context);
        return { binding, layouts, layout };
    });
    const check = async (isEdited: boolean) => vi.waitFor(() => {
        expect(hook.getCurrent().layouts.state.dashboards.find(row => row.name === 'Overview')?.isEdited).toBe(isEdited);
        expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', preset: { isEdited } });
    });
    await check(false);
    await act(async () => { expect(await hook.getCurrent().binding.port!.execute({ actionId: 'widgets.item.rename', instanceId: 'child', displayName: 'Mine' })).toMatchObject({ ok: true }); });
    await check(true);
    // The line's words come from the layout owner's own comparison, through the area read.
    expect(hook.getCurrent().layout.state).toMatchObject({ preset: { changes: [{ kind: 'changed', item: { instance: { id: 'child', displayName: 'Mine' } } }] } });
    let reset!: Awaited<ReturnType<ReturnType<typeof hook.getCurrent>['binding']['resetPreset']>>;
    await act(async () => { reset = await hook.getCurrent().binding.resetPreset(); });
    expect(reset.ok).toBe(true);
    const capture = reset.ok ? WidgetInstanceActionOutputSchemasV1['widgets.area.layout.reset'].parse(reset.result).undo : null;
    await check(false);
    expect(capture).toBeTruthy();
    await act(async () => { expect(await hook.getCurrent().binding.undoReset(capture!)).toMatchObject({ ok: true }); });
    await check(true);
    await hook.unmount();
});

it('resets an edited Usage preset through its captured binding and Undo restores the exact Artifact', async () => {
    const names = Object.fromEntries(USAGE_WIDGET_PRESET_IDS.map(id => [id, id])) as Record<typeof USAGE_WIDGET_PRESET_IDS[number], string>;
    const providedContext = readUsageWidgetPageContext(readUsageWidgetPageScope(normalizeUsageQuery({ period: { startMs: 1000 } })));
    let binding: ReturnType<typeof useUsageWidgetAreaBinding> | undefined;
    function Composition() {
        binding = useUsageWidgetAreaBinding({ serverId: runtime.serverId, providedContext, period: '7days', names });
        const operations = { presetActions: { resetPreset: binding.resetPreset, undoReset: binding.undoReset } };
        return binding.surface ? <WidgetAreaPresetLine preset={{ id: 'overview', name: 'overview', isEdited: true, changes: [] }}
            surface={binding.surface} {...operations} testID="usage.preset" /> : null;
    }
    const screen = await renderScreen(<Composition />);
    const port = binding?.port;
    if (!port) throw new Error('missing_usage_binding');
    const edited = await port.execute({ actionId: 'widgets.item.rename', instanceId: 'overview:group:0:widget:0', displayName: 'Personal daily' });
    if (!edited.ok) throw new Error(`setup_edit_failed: ${edited.errorCode}: ${edited.error}`);
    expect(edited).toMatchObject({ ok: true });
    const before = await port.execute({ actionId: 'widgets.item.list' });
    if (!before.ok) throw new Error(before.errorCode);
    const editedItems = WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(before.result).items;
    await screen.pressByTestIdAsync('usage.preset.reset');
    await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'info', undo: { run: expect.any(Function) } }));
    const reset = await port.execute({ actionId: 'widgets.item.list' });
    if (!reset.ok) throw new Error(reset.errorCode);
    const resetItems = WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(reset.result).items;
    expect(resetItems).toEqual(binding!.presets[0]!.items);
    await act(async () => { readPresentationNotice()!.undo!.run(); });
    await vi.waitFor(async () => {
        const restored = await port.execute({ actionId: 'widgets.item.list' });
        expect(restored).toMatchObject({ ok: true, result: { items: editedItems } });
    });
    await screen.unmount();
});

it('binds every core-page host preset and selects an independently persisted copy through public Actions', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'group' as const, id: 'details', children: [{ kind: 'widget' as const,
            instance: { v: 1 as const, id: 'child', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} } }] }] },
        { id: 'costs', name: 'Costs', items: [] },
    ] };
    const hook = await renderHook(() => useCorePageWidgetAreaBinding(input));
    const listed = await hook.getCurrent().listLayouts();
    expect(listed).toMatchObject({ ok: true, result: { layouts: [{ name: 'Overview' }, { name: 'Costs' }] } });
    expect(artifacts.list()).toEqual([]);
    const created = await hook.getCurrent().createLayout('mine', 'Mine');
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.errorCode);
    const copy = WidgetInstanceActionOutputSchemasV1['widgets.area.layout.create'].parse(created.result);
    expect(JSON.parse(artifacts.readPlainBody(copy.artifactId)!)).toMatchObject({ name: 'Mine', items: [
        { kind: 'group', id: 'details', children: [{ instance: { id: 'child' } }] },
    ] });
    await act(async () => { expect(await hook.getCurrent().selectLayout('mine')).toMatchObject({ ok: true }); });
    expect(hook.getCurrent().surface).toMatchObject({ owner: { layoutId: 'mine' } });
    expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true,
        result: { state: 'present', items: [{ kind: 'group', id: 'details' }] } });
    await act(async () => { expect(await hook.getCurrent().selectLayout('costs')).toMatchObject({ ok: true }); });
    expect(await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' })).toMatchObject({ ok: true,
        result: { state: 'missing', items: [] } });
    expect(artifacts.list()).toHaveLength(1);
    await hook.unmount();
});

it.each([true, false])('acknowledges selection only when cancellation follows its effect (cancelBeforeSelection=%s)', async cancelBeforeSelection => {
    const { selectMountedWidgetAreaLayout } = await import('@/sync/domains/widgets/widgetAreaLayoutSelection');
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] }, { id: 'costs', name: 'Costs', items: [] },
    ] };
    const hook = await renderHook(() => useCorePageWidgetAreaBinding(input));
    try {
        const surface = hook.getCurrent().surface!;
        if (surface.owner.kind !== 'corePage') throw new Error('Expected core page');
        const destination = { ...surface, owner: { ...surface.owner, layoutId: 'costs' } };
        const controller = new AbortController();
        if (cancelBeforeSelection) controller.abort();
        const result = selectMountedWidgetAreaLayout(destination, controller.signal);
        controller.abort();
        await act(async () => { expect(await result).toEqual(cancelBeforeSelection
            ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
            : { ok: true, result: { surface: destination } }); });
        expect(hook.getCurrent().surface?.owner).toMatchObject({ layoutId: cancelBeforeSelection ? 'overview' : 'costs' });
        expect(layoutReadPaths.filter(path => path === `/v1/artifacts/${buildWidgetSurfaceArtifactIdV1(destination)}`)).toHaveLength(0);
    } finally { await hook.unmount(); }
});
