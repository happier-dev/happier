import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildWidgetSurfaceArtifactIdV1, createUsageWidgetPresets, WidgetInstanceActionOutputSchemasV1 } from '@happier-dev/protocol/widgets';
import { renderHook, renderScreen } from '@/dev/testkit';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { USAGE_WIDGET_PRESET_IDS } from '@/components/settings/usage/usageWidgetPresets';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readUsageWidgetPageContext, readUsageWidgetPageScope } from '@/components/settings/usage/usageWidgetPageContext';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { WidgetAreaPort } from './useWidgetAreaLayout';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { encodeBase64 } from '@/encryption/base64';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let actionPolicy = normalizeActionsSettingsV1({ v: 1 });
let artifactReadFails = false;
let artifactReadFailureStatus = 500;
let artifactReadError: Error | undefined;
let artifactReadInvalid = false;
let artifactBatchReadFails = false;
let artifactBatchFailureStatus = 503;
let beforeArtifactRead: ((artifactId: string) => Promise<void>) | undefined;
let beforeInventoryRead: (() => Promise<void>) | undefined;
let layoutReadRequests = 0;
let layoutInventoryRequests = 0;
let layoutReadPaths: string[] = [];
async function artifactHttp(url: RequestInfo | URL, init?: RequestInit, boundary = artifacts) {
    const path = new URL(String(url)).pathname;
    if ((path === '/v1/artifacts/read' && init?.method === 'POST')
        || (/^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET')) {
        layoutReadRequests++;
        layoutReadPaths.push(path);
    }
    if (path === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
        layoutInventoryRequests++;
        await beforeInventoryRead?.();
    }
    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: actionPolicy } }, version: 0 });
    if (artifactBatchReadFails && path === '/v1/artifacts/read' && init?.method === 'POST')
        return Response.json({ error: artifactBatchFailureStatus === 503 ? 'database_transaction_timeout' : 'content_unavailable' },
            { status: artifactBatchFailureStatus });
    if (/^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET')
        await beforeArtifactRead?.(decodeURIComponent(path.slice('/v1/artifacts/'.length)));
    if (artifactReadError && /^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET')
        throw artifactReadError;
    if (artifactReadInvalid && /^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET')
        return Response.json(createPlainArtifactHttpFixture({ id: decodeURIComponent(path.slice('/v1/artifacts/'.length)),
            isDecrypted: true, header: { title: 'Unreadable layout' }, title: 'Unreadable layout', body: '{}',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'account-a'));
    if (artifactReadFails && /^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET')
        return Response.json({ error: artifactReadFailureStatus === 503 ? 'database_transaction_timeout' : 'Failed to get artifact' },
            { status: artifactReadFailureStatus });
    return boundary.handle(path + new URL(String(url)).search, init);
}
const runtime = installSessionPaneRuntimeTestHarness({ request: artifactHttp });
// Load the rendered area graph after installing HTTP boundaries, outside the timed Account journey.
const { WidgetArea } = await import('./WidgetArea');
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { t } = await import('@/text');
function setActionPolicy(policy: ReturnType<typeof normalizeActionsSettingsV1>) {
    actionPolicy = policy;
    storage.setState({ settingsScope: { serverId: runtime.serverId, accountId: 'account-a' },
        settings: { ...storage.getState().settings, actionsSettingsV1: policy } });
}
let disposeActionLoader: (() => void) | undefined;
let useCorePageWidgetAreaBinding: typeof import('./useCorePageWidgetAreaBinding')['useCorePageWidgetAreaBinding'];
let useWidgetAreaLayouts: typeof import('@/components/projects/overview/useProjectDashboards')['useWidgetAreaLayouts'];
let useWidgetAreaLayout: typeof import('./useWidgetAreaLayout')['useWidgetAreaLayout'];
let useCorePageWidgetAreaLayoutBar: typeof import('./useCorePageWidgetAreaLayoutBar')['useCorePageWidgetAreaLayoutBar'];
let WidgetAreaPresetLine: typeof import('./WidgetAreaPresetLine')['WidgetAreaPresetLine'];
let useUsageWidgetAreaBinding: typeof import('@/components/settings/usage/useUsageWidgetAreaBinding')['useUsageWidgetAreaBinding'];
beforeAll(async () => {
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    disposeActionLoader = await installRealActionExecutorModuleLoader();
    ({ useCorePageWidgetAreaBinding } = await import('./useCorePageWidgetAreaBinding'));
    ({ useWidgetAreaLayouts } = await import('@/components/projects/overview/useProjectDashboards'));
    ({ useWidgetAreaLayout } = await import('./useWidgetAreaLayout'));
    ({ useCorePageWidgetAreaLayoutBar } = await import('./useCorePageWidgetAreaLayoutBar'));
    ({ WidgetAreaPresetLine } = await import('./WidgetAreaPresetLine'));
    ({ useUsageWidgetAreaBinding } = await import('@/components/settings/usage/useUsageWidgetAreaBinding'));
});
afterAll(() => disposeActionLoader?.());
beforeEach(() => {
    artifacts.clear(); retirePresentationNotice();
    artifactReadFails = false;
    artifactReadFailureStatus = 500;
    artifactReadError = undefined;
    artifactReadInvalid = false;
    artifactBatchReadFails = false;
    artifactBatchFailureStatus = 503;
    beforeArtifactRead = undefined;
    beforeInventoryRead = undefined;
    layoutReadRequests = 0;
    layoutInventoryRequests = 0;
    layoutReadPaths = [];
    // These layout-owner scenarios exercise acknowledged edits under the user's explicit policy.
    setActionPolicy(normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'widgets.item.rename': ['ui'], 'widgets.item.move': ['ui'],
            'widgets.area.layout.create': ['ui'], 'widgets.area.layout.reset': ['ui'], 'widgets.area.layout.undo': ['ui'] },
    }));
});

it('admits every Usage view through the real layout and inventory owners', async () => {
    const presets = createUsageWidgetPresets();
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const area = useWidgetAreaLayout(binding.port!, input.context);
        const inventory = useWidgetAreaLayouts({ surface: binding.surface, execute: binding.executeLayoutAction });
        return { binding, area, inventory, bar: useCorePageWidgetAreaLayoutBar({ binding, area, presets }) };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().bar.inventoryStatus).toBe('ready'));
        setActionPolicy(normalizeActionsSettingsV1({ v: 1, actions: {
            [ACTION_ID_FAMILIES_V1.widgets[19]]: { disabledSurfaces: ['agent'] },
        } }));
        await act(async () => {
            expect(await hook.getCurrent().binding.selectLayout('costs', {
                surface: 'agent', authority: 'account_automation',
            })).toMatchObject({ ok: false });
        });
        expect(hook.getCurrent().bar.selectedId).toBe('overview');
        for (const layoutId of USAGE_WIDGET_PRESET_IDS) {
            if (layoutId !== 'overview') await act(async () => {
                expect(await hook.getCurrent().binding.selectLayout(layoutId)).toMatchObject({ ok: true });
            });
            await vi.waitFor(() => expect(hook.getCurrent().area.state).toMatchObject({ status: 'ready',
                surface: { owner: { layoutId } }, items: presets.find(preset => preset.id === layoutId)!.items }));
            expect(hook.getCurrent().bar.selectedId).toBe(layoutId);
            expect(hook.getCurrent().area.state).not.toHaveProperty('readFailure');
        }
        await vi.waitFor(() => expect(hook.getCurrent().inventory.state.status).toBe('ready'));
        setActionPolicy(normalizeActionsSettingsV1({ v: 1, actions: {
            [ACTION_ID_FAMILIES_V1.widgets[22]]: { disabledSurfaces: ['agent'] },
        } }));
        const readsBeforeAgentRetry = layoutInventoryRequests;
        await act(async () => {
            await hook.getCurrent().inventory.reload({ surface: 'agent', authority: 'account_automation' });
        });
        expect(layoutInventoryRequests).toBe(readsBeforeAgentRetry);
        expect(hook.getCurrent().inventory.state.readFailure).toBeDefined();
        await act(async () => { await hook.getCurrent().inventory.reload(); });
        expect(hook.getCurrent().inventory.state.status).toBe('ready');
    } finally { await hook.unmount(); }
});

it('opens named-view prompts through their mounted owner and preserves the actual confirmer authority', async () => {
    const presets = createUsageWidgetPresets();
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets };
    const mounted: { reader: ReturnType<typeof useOptionalCurrentUiContextReader>;
        bar?: ReturnType<typeof useCorePageWidgetAreaLayoutBar> } = { reader: null };
    function Page() {
        const binding = useCorePageWidgetAreaBinding(input);
        const area = useWidgetAreaLayout(binding.port!, input.context);
        mounted.bar = useCorePageWidgetAreaLayoutBar({ binding, area, presets });
        mounted.reader = useOptionalCurrentUiContextReader();
        return null;
    }
    const screen = await renderMountedCurrentUiContext(<Page />, { withModalProvider: true });
    const command = (title: string) => mounted.reader?.readCurrentUiContext()?.commands.find(row => row.title === title);
    const invoke = async (title: string, value?: { value: string }, ui = false) => {
        const current = command(title);
        expect(current, title).toBeDefined();
        await act(async () => {
            expect(await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
                { commandId: current!.id, ...(value ? { input: value } : {}) },
                ui ? { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }
                    : { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: true });
        });
    };
    try {
        await vi.waitFor(() => expect(mounted.bar?.inventoryStatus).toBe('ready'));
        const createTitle = t('usage.board.page.newViewTitle');
        await invoke(createTitle);
        await invoke(createTitle, { value: 'Agent refused view' });
        setActionPolicy(normalizeActionsSettingsV1({ v: 1, actions: {
            [ACTION_ID_FAMILIES_V1.widgets[23]]: { disabledSurfaces: ['agent'] },
        }, approvalWaivedSurfaces: { [ACTION_ID_FAMILIES_V1.widgets[23]]: ['ui'] } }));
        await invoke(t('common.create'));
        await vi.waitFor(() => expect(command(createTitle)).toBeDefined());
        expect(mounted.bar?.layouts.some(row => row.name === 'Agent refused view')).toBe(false);
        await act(async () => { await mounted.bar!.create(); });
        await invoke(createTitle, { value: 'Personal view' }, true);
        await invoke(t('common.create'), undefined, true);
        await vi.waitFor(() => expect(mounted.bar?.selectedName).toBe('Personal view'));
        await invoke(t('usage.board.page.renameViewTitle'));
        await invoke(t('common.cancel'));
        expect(mounted.bar?.selectedName).toBe('Personal view');
    } finally { await screen.unmount(); }
});

it.each([false, true])('commits selection before destination reads and keeps the latest click (second click: %s)', async secondClick => {
    const { selectMountedWidgetAreaLayout } = await import('@/sync/domains/widgets/widgetAreaLayoutSelection');
    const selections: string[] = [];
    const presets = ['overview', 'costs', 'plans'].map(id => ({ id, name: id, items: [] }));
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets,
        onSelectLayout: (id: string) => selections.push(id) };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const area = useWidgetAreaLayout(binding.port!, input.context);
        return { binding, area, bar: useCorePageWidgetAreaLayoutBar({ binding, area, presets }) };
    });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const results: Promise<unknown>[] = [];
    try {
        await vi.waitFor(() => expect(hook.getCurrent().area.state.status).toBe('ready'));
        const surface = hook.getCurrent().binding.surface!;
        if (surface.owner.kind !== 'corePage') throw new Error('Expected core page');
        const owner = surface.owner;
        beforeArtifactRead = async id => {
            if (id !== buildWidgetSurfaceArtifactIdV1(surface)) await pending;
        };
        await act(async () => {
            results.push(selectMountedWidgetAreaLayout({ ...surface, owner: { ...owner, layoutId: 'costs' } }));
            // No microtask, transport completion, or second click can be needed to acknowledge intent.
            expect(selections).toEqual(['costs']);
        });
        expect(hook.getCurrent().bar.selectedId).toBe('costs');
        expect(hook.getCurrent().area.state.status).toBe('loading');
        if (secondClick) {
            await act(async () => {
                results.push(selectMountedWidgetAreaLayout({ ...surface, owner: { ...owner, layoutId: 'plans' } }));
                expect(selections).toEqual(['costs', 'plans']);
            });
            expect(hook.getCurrent().bar.selectedId).toBe('plans');
            expect(hook.getCurrent().area.state.status).toBe('loading');
        }
        release();
        await act(async () => { await Promise.all(results); });
        await vi.waitFor(() => expect(hook.getCurrent().area.state).toMatchObject({ status: 'ready',
            surface: { owner: { layoutId: secondClick ? 'plans' : 'costs' } } }));
        expect(hook.getCurrent().bar.selectedId).toBe(secondClick ? 'plans' : 'costs');
        expect(selections).toEqual(secondClick ? ['costs', 'plans'] : ['costs']);
        const selected = { ...surface, owner: { ...owner, layoutId: secondClick ? 'plans' : 'costs' } };
        expect(layoutReadPaths.filter(path => path === `/v1/artifacts/${buildWidgetSurfaceArtifactIdV1(selected)}`)).toHaveLength(1);
    } finally {
        release();
        await Promise.allSettled(results);
        beforeArtifactRead = undefined;
        await hook.unmount();
    }
});

it('reads a selected core-page layout once and leaves the settled inventory alone', async () => {
    const { selectMountedWidgetAreaLayout } = await import('@/sync/domains/widgets/widgetAreaLayoutSelection');
    const presets = ['overview', 'costs'].map(id => ({ id, name: id, items: [] }));
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const area = useWidgetAreaLayout(binding.port!, input.context);
        return { binding, area, bar: useCorePageWidgetAreaLayoutBar({ binding, area, presets }) };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().bar.inventoryStatus).toBe('ready'));
        await vi.waitFor(() => expect(hook.getCurrent().area.state.status).toBe('ready'));
        layoutReadRequests = 0;
        layoutInventoryRequests = 0;
        layoutReadPaths = [];
        const surface = hook.getCurrent().binding.surface!;
        if (surface.owner.kind !== 'corePage') throw new Error('Expected core page');
        const destination = { ...surface, owner: { ...surface.owner, layoutId: 'costs' } };
        const destinationPath = `/v1/artifacts/${buildWidgetSurfaceArtifactIdV1(destination)}`;
        await act(async () => {
            expect(await selectMountedWidgetAreaLayout(destination)).toMatchObject({ ok: true });
        });
        await vi.waitFor(() => expect(hook.getCurrent().area.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'costs' } } }));
        expect(layoutReadPaths.filter(path => path === destinationPath), JSON.stringify(layoutReadPaths)).toHaveLength(1);
        expect(layoutInventoryRequests).toBe(0);
    } finally { await hook.unmount(); }
});

it('hands a completed selection read to an area mounted afterward', async () => {
    const { selectMountedWidgetAreaLayout } = await import('@/sync/domains/widgets/widgetAreaLayoutSelection');
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] }, { id: 'costs', name: 'Costs', items: [] },
    ] };
    const binding = await renderHook(() => useCorePageWidgetAreaBinding(input));
    let disposeArea: (() => Promise<void>) | undefined;
    try {
        const surface = binding.getCurrent().surface!;
        if (surface.owner.kind !== 'corePage') throw new Error('Expected core page');
        const destination = { ...surface, owner: { ...surface.owner, layoutId: 'costs' } };
        await act(async () => {
            expect(await selectMountedWidgetAreaLayout(destination)).toMatchObject({ ok: true });
        });
        const destinationPath = `/v1/artifacts/${buildWidgetSurfaceArtifactIdV1(destination)}`;
        const beforeMount = layoutReadPaths.filter(path => path === destinationPath).length;
        expect(beforeMount).toBe(1);
        const area = await renderHook(() => useWidgetAreaLayout(binding.getCurrent().port!, input.context));
        disposeArea = area.unmount;
        await vi.waitFor(() => expect(area.getCurrent().state).toMatchObject({ status: 'ready', surface: destination }));
        expect(layoutReadPaths.filter(path => path === destinationPath)).toHaveLength(beforeMount);
    } finally { await disposeArea?.(); await binding.unmount(); }
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

it('re-reads a selected layout if its Artifact changes before the area takes the settled read', async () => {
    const { selectMountedWidgetAreaLayout } = await import('@/sync/domains/widgets/widgetAreaLayoutSelection');
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] }, { id: 'costs', name: 'Costs', items: [] },
    ] };
    const binding = await renderHook(() => useCorePageWidgetAreaBinding(input));
    let disposeArea: (() => Promise<void>) | undefined;
    try {
        const surface = binding.getCurrent().surface!;
        if (surface.owner.kind !== 'corePage') throw new Error('Expected core page');
        await act(async () => { expect(await binding.getCurrent().createLayout('alternate', 'Alternate')).toMatchObject({ ok: true }); });
        const destination = { ...surface, owner: { ...surface.owner, layoutId: 'alternate' } };
        const path = `/v1/artifacts/${buildWidgetSurfaceArtifactIdV1(destination)}`;
        const beforeSelection = layoutReadPaths.filter(readPath => readPath === path).length;
        await act(async () => { expect(await selectMountedWidgetAreaLayout(destination)).toMatchObject({ ok: true }); });
        const id = buildWidgetSurfaceArtifactIdV1(destination);
        const original = storage.getState().artifacts[id];
        expect(original).toBeDefined();
        await act(async () => { storage.setState({ artifacts: { ...storage.getState().artifacts, [id]: { ...original! } } }); });
        const beforeMount = layoutReadPaths.filter(readPath => readPath === path).length;
        expect(beforeMount).toBe(beforeSelection + 1);
        const originalPort = binding.getCurrent().port!;
        let mountedLists = 0;
        const port = { ...originalPort, execute: async (...args: Parameters<typeof originalPort.execute>) => {
            if (args[0].actionId === 'widgets.item.list') mountedLists++;
            return originalPort.execute(...args);
        } };
        const area = await renderHook(() => useWidgetAreaLayout(port, input.context));
        disposeArea = area.unmount;
        await vi.waitFor(() => expect(area.getCurrent().state).toMatchObject({ status: 'ready', surface: destination }));
        expect(mountedLists).toBe(1);
        expect(layoutReadPaths.filter(readPath => readPath === path).length).toBeGreaterThan(beforeMount);
    } finally { await disposeArea?.(); await binding.unmount(); }
});

it('keeps a pending view inventory admitted across scroll-driven host callback publication', async () => {
    const { ScrollView } = await import('react-native');
    const entered = createDeferred<void>();
    const settle = createDeferred<void>();
    beforeInventoryRead = async () => { entered.resolve(); await settle.promise; };
    const presets = [{ id: 'agents', name: 'Agents', items: [] }];
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets };
    let current!: Readonly<{ area: ReturnType<typeof useWidgetAreaLayout>; bar: ReturnType<typeof useCorePageWidgetAreaLayoutBar> }>;
    function Host() {
        const [offset, setOffset] = React.useState(0);
        // Republish the host callback without changing its page/Account scope.
        const onSelectLayout = React.useCallback((_layoutId: string) => {}, [offset]);
        const binding = useCorePageWidgetAreaBinding({ ...input, onSelectLayout });
        const area = useWidgetAreaLayout(binding.port!, input.context);
        current = { area, bar: useCorePageWidgetAreaLayoutBar({ binding, area, presets }) };
        return <ScrollView testID="inventory-page" onScroll={event => setOffset(event.nativeEvent.contentOffset.y)} />;
    }
    const screen = await renderScreen(<Host />);
    try {
        await entered.promise;
        await act(async () => { screen.findByTestId('inventory-page')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 1800 } } }); });
        await act(async () => { screen.findByTestId('inventory-page')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } }); });
        await act(async () => { settle.resolve(); });
        await vi.waitFor(() => expect(current.bar.inventoryStatus).not.toBe('loading'));
        expect(current.bar.readFailure).toBeUndefined();
        expect(current.bar.inventoryStatus).toBe('ready');
        expect(current.bar.selectedId).toBe('agents');
        expect(current.area.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'agents' } } });
    } finally { settle.resolve(); beforeInventoryRead = undefined; await screen.unmount(); }
});

it('refreshes the layout inventory when its host preset changes', async () => {
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {} };
    const presets = (name: string) => [{ id: 'overview', name, items: [] }];
    const hook = await renderHook(({ name }: { name: string }) => {
        const ownedPresets = React.useMemo(() => presets(name), [name]);
        const binding = useCorePageWidgetAreaBinding({ ...input, presets: ownedPresets });
        return useWidgetAreaLayouts({ surface: binding.surface, execute: binding.executeLayoutAction });
    }, { initialProps: { name: 'Original' } });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().state.dashboards.map(row => row.name)).toEqual(['Original']));
        await hook.rerender({ name: 'Updated' });
        await vi.waitFor(() => expect(hook.getCurrent().state.dashboards.map(row => row.name)).toEqual(['Updated']));
    } finally { await hook.unmount(); }
});

it.each([
    { pageId: 'machines', presetId: 'overview' },
    { pageId: 'public-profile', presetId: 'minimal' },
])('shows the acknowledged personal preset name through the $pageId layout inventory and Rename Action', async ({ pageId, presetId }) => {
    const { Modal } = await import('@/modal');
    const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue('My view');
    setActionPolicy(normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.area.layout.rename': ['ui'] } }));
    const presets = [{ id: presetId, name: 'Canonical stock', items: [] }];
    const displayPresets = [{ id: presetId, name: 'Translated stock' }];
    const input = { serverId: runtime.serverId, pageId, area: 'main', context: {}, presets };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const area = useWidgetAreaLayout(binding.port!, input.context);
        return useCorePageWidgetAreaLayoutBar({ binding, area, presets: displayPresets });
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().actions?.rename).toBeTypeOf('function'));
        expect(hook.getCurrent().selectedName).toBe('Translated stock');
        await act(async () => {
            const rename = hook.getCurrent().actions?.rename;
            if (!rename) throw new Error('Expected the selected layout Rename action');
            await rename();
        });
        await vi.waitFor(() => expect(hook.getCurrent().selectedName).toBe('My view'));
        expect(hook.getCurrent().layouts).toMatchObject([{ id: presetId, name: 'My view', isPreset: true }]);
        prompt.mockResolvedValue(null);
        await act(async () => {
            const rename = hook.getCurrent().actions?.rename;
            if (!rename) throw new Error('Expected the selected layout Rename action');
            await rename();
        });
        expect(prompt.mock.calls.at(-1)?.[2]).toMatchObject({ defaultValue: 'My view' });
    } finally { prompt.mockRestore(); await hook.unmount(); }
});

it('keeps personal layout actions among personal neighbors and selects through the page command', async () => {
    setActionPolicy(normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
        'widgets.area.layout.create': ['ui'], 'widgets.area.layout.reorder': ['ui'], 'widgets.area.layout.delete': ['ui'],
    } }));
    const presets = [{ id: 'overview', name: 'Overview', items: [] }, { id: 'costs', name: 'Costs', items: [] }];
    const input = { serverId: runtime.serverId, pageId: 'usage', area: 'main', context: {}, presets };
    const selections: string[] = [];
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const area = useWidgetAreaLayout(binding.port!, input.context);
        const bar = useCorePageWidgetAreaLayoutBar({ binding, area, presets,
            selectLayout: async (id: string) => { selections.push(id); await binding.selectLayout(id); } });
        return { binding, bar };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().bar.inventoryStatus).toBe('ready'));
        expect(hook.getCurrent().bar.personalActions).toBeNull();
        await vi.waitFor(() => expect(hook.getCurrent().bar.actions?.delete).toHaveProperty('disabledReason'));
        await act(async () => {
            expect(await hook.getCurrent().binding.createLayout('first', 'First')).toMatchObject({ ok: true });
            expect(await hook.getCurrent().binding.createLayout('second', 'Second')).toMatchObject({ ok: true });
        });
        await vi.waitFor(() => expect(hook.getCurrent().bar.layouts.map(row => row.id)).toEqual(['overview', 'costs', 'first', 'second']));
        await act(async () => { hook.getCurrent().bar.onSelect('first'); });
        await vi.waitFor(() => expect(hook.getCurrent().bar.selectedId).toBe('first'));
        expect(selections).toEqual(['first']);
        expect(hook.getCurrent().bar.personalActions?.moveBefore).toBeUndefined();
        expect(hook.getCurrent().bar.personalActions?.moveAfter?.name).toBe('Second');
        await act(async () => { hook.getCurrent().bar.onSelect('second'); });
        await vi.waitFor(() => expect(hook.getCurrent().bar.selectedId).toBe('second'));
        expect(hook.getCurrent().bar.personalActions?.moveBefore?.name).toBe('First');
        expect(hook.getCurrent().bar.personalActions?.moveAfter).toBeUndefined();
        await act(async () => { hook.getCurrent().bar.personalActions?.moveBefore?.onPress(); });
        await vi.waitFor(() => expect(hook.getCurrent().bar.layouts.map(row => row.id)).toEqual(['overview', 'costs', 'second', 'first']));
        await act(async () => {
            const deletion = hook.getCurrent().bar.personalActions?.delete;
            if (!deletion || !('onPress' in deletion)) throw new Error('Expected personal-view deletion');
            await deletion.onPress();
        });
        await vi.waitFor(() => expect(hook.getCurrent().bar.selectedId).toBe('overview'));
        expect(hook.getCurrent().bar.layouts.map(row => row.id)).toEqual(['overview', 'costs', 'first']);
        expect(selections).toEqual(['first', 'second', 'overview']);
    } finally { await hook.unmount(); }
});

it.each(['public-profile', 'usage'])('creates and selects a copied view through the %s layout bar', async pageId => {
    const { Modal } = await import('@/modal');
    const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue('Quiet week');
    const presets = [{ id: 'minimal', name: 'Minimal', items: [] }];
    const input = { serverId: runtime.serverId, pageId, area: 'main', context: {}, presets };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const area = useWidgetAreaLayout(binding.port!, input.context);
        return useCorePageWidgetAreaLayoutBar({ binding, area, presets });
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().onCreate).toBeTypeOf('function'));
        await act(async () => { await hook.getCurrent().create(); });
        await vi.waitFor(() => expect(hook.getCurrent().selectedName).toBe('Quiet week'));
        expect(hook.getCurrent().layouts).toHaveLength(2);
        expect(readPresentationNotice()?.severity).not.toBe('error');
    } finally { prompt.mockRestore(); await hook.unmount(); }
});

it('reports the typed refusal when a new view is created but cannot be selected', async () => {
    const { Modal } = await import('@/modal');
    const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue('Quiet week');
    setActionPolicy(normalizeActionsSettingsV1({ v: 1, actions: {
        'widgets.area.layout.select': { disabledSurfaces: ['ui'] },
    } }));
    const presets = [{ id: 'minimal', name: 'Minimal', items: [] }];
    const input = { serverId: runtime.serverId, pageId: 'public-profile', area: 'main', context: {}, presets };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        const area = useWidgetAreaLayout(binding.port!, input.context);
        return useCorePageWidgetAreaLayoutBar({ binding, area, presets });
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().onCreate).toBeTypeOf('function'));
        await act(async () => { await hook.getCurrent().create(); });
        expect(hook.getCurrent().selectedId).toBe('minimal');
        expect(readPresentationNotice()).toMatchObject({ severity: 'error' });
    } finally { prompt.mockRestore(); await hook.unmount(); }
});

it.each([500, 503, 'AbortError', 'invalidRecord', 'batch503', 'batch403'] as const)('never restores Costs after Work HTTP %s and Retry reads Work', async status => {
    const destinationRead = createDeferred<void>();
    let inventory!: ReturnType<typeof useCorePageWidgetAreaLayoutBar>;
    let encryptedHome: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
    if (status === 'batch503' || status === 'batch403') {
        const secret = new Uint8Array(32).fill(24);
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'e2ee' });
        encryptedHome = await serveActionHomes({ homes: [{ key: 'encrypted', serverUrl: 'https://layout-read-e2ee.test',
            accountId: 'account-a', accountMode: 'e2ee', credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`,
                secret: encodeBase64(secret, 'base64url') },
            encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }) }],
            route: async request => {
                const init = { method: request.method, headers: request.headers, signal: request.signal,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
                return await artifactHttp(request.url, init, boundary)
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, init) ?? undefined;
            } });
    }
    const input = { serverId: encryptedHome?.homes.encrypted!.id ?? runtime.serverId, pageId: 'usage', area: 'main', initialLayoutId: 'costs', context: {}, presets: ['costs', 'work'].map(id => ({
        id, name: id, items: [{ kind: 'widget' as const, instance: { v: 1 as const, id: `${id}-body`,
            definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} } }],
    })) };
    let current!: { binding: ReturnType<typeof useCorePageWidgetAreaBinding>; layout: ReturnType<typeof useWidgetAreaLayout> };
    function Composition() {
        const binding = useCorePageWidgetAreaBinding(input);
        // Observe the automatic read's settlement; do not issue a second read to make it finish.
        const port = React.useMemo<WidgetAreaPort | null>(() => {
            const original = binding.port;
            return original && { ...original, execute: async (operation, signal, target) => {
                try { return await original.execute(operation, signal, target); }
                finally {
                    if (operation.actionId === 'widgets.item.list' && original.surface?.owner.kind === 'corePage'
                        && original.surface.owner.layoutId === 'work') destinationRead.resolve();
                }
            } };
        }, [binding.port]);
        const layout = useWidgetAreaLayout(port!, input.context);
        inventory = useCorePageWidgetAreaLayoutBar({ binding, area: layout, presets: input.presets });
        current = { binding, layout };
        return <WidgetArea port={port} context={input.context} layout={layout} geometry="grid"
            title="Usage" surfaceName="Usage" testID="core.area" />;
    }
    const screen = await renderScreen(<Composition />);
    try {
        await vi.waitFor(() => expect(current.layout.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'costs' } } }));
        await vi.waitFor(() => expect(inventory.inventoryStatus).toBe('ready'));
        if (status === 'AbortError') artifactReadError = new DOMException('Superseded layout read', 'AbortError');
        else if (status === 'invalidRecord') artifactReadInvalid = true;
        else if (status === 'batch503' || status === 'batch403') {
            artifactBatchFailureStatus = status === 'batch403' ? 403 : 503;
            artifactBatchReadFails = true;
        }
        else { artifactReadFailureStatus = status; artifactReadFails = true; }
        await act(async () => { await current.binding.selectLayout('work'); });
        expect(current.binding.surface).toMatchObject({ owner: { layoutId: 'work' } });
        expect(inventory.selectedId).toBe('work');
        await act(async () => { await destinationRead.promise; });
        // Selection changes document identity. Only a refresh of the SAME view may retain its cards.
        await vi.waitFor(() => expect(current.layout.state).toMatchObject({ status: 'unavailable',
            reasonCode: status === 'AbortError' ? 'cancelled' : status === 'invalidRecord' ? 'invalid_widget_area_record'
                : status === 'batch503' || status === 'batch403' ? 'artifact_content_unavailable' : 'widget_area_unavailable' }));
        expect(screen.findAllHostsByTestId('core.area.readFailed')).toHaveLength(0);
        expect(screen.findByTestId('core.area.unavailable')).not.toBeNull();
        expect(screen.findByTestId('core.area.widget.costs-body.body')).toBeNull();
        artifactReadFails = false;
        artifactReadError = undefined;
        artifactReadInvalid = false;
        artifactBatchReadFails = false;
        await screen.pressByTestIdAsync('core.area.retry');
        await vi.waitFor(() => expect(current.layout.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'work' } } }));
        expect(current.layout.state).not.toHaveProperty('readFailure');
        expect(screen.findByTestId('core.area.widget.work-body.body')).not.toBeNull();
        expect(screen.findByTestId('core.area.widget.costs-body.body')).toBeNull();
    } finally { artifactReadFails = false; artifactReadError = undefined; artifactReadInvalid = false; artifactBatchReadFails = false;
        await screen.unmount(); await encryptedHome?.dispose(); }
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
        });
        await act(async () => {
            await current.layout.reload();
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
        const personal = hook.getCurrent().layouts.state.dashboards.find(row => row.name === 'Personal')!;
        const before = artifacts.readPlainBody(personal.artifactId);
        await act(async () => { expect(await hook.getCurrent().binding.selectLayout('personal')).toMatchObject({ ok: true }); });
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
