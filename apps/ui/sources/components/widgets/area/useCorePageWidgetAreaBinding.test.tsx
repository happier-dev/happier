import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { WidgetInstanceActionOutputSchemasV1 } from '@happier-dev/protocol/widgets';
import { renderHook, renderScreen } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { useCorePageWidgetAreaBinding } from './useCorePageWidgetAreaBinding';
import { useWidgetAreaLayouts } from '@/components/projects/overview/useProjectDashboards';
import { useWidgetAreaLayout } from './useWidgetAreaLayout';
import { WidgetAreaPresetLine } from './WidgetAreaPresetLine';
import { useUsageWidgetAreaBinding } from '@/components/settings/usage/useUsageWidgetAreaBinding';
import { USAGE_WIDGET_PRESET_IDS } from '@/components/settings/usage/usageWidgetPresets';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readUsageWidgetPageContext, readUsageWidgetPageScope } from '@/components/settings/usage/usageWidgetPageContext';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => artifacts.handle(new URL(String(url)).pathname, init) });
let disposeActionLoader: (() => void) | undefined;
beforeAll(async () => { disposeActionLoader = await installRealActionExecutorModuleLoader(); });
afterAll(() => disposeActionLoader?.());
beforeEach(() => { artifacts.clear(); retirePresentationNotice(); });

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

it('an agent select changes the mounted area document, and refuses after its owner unmounts', async () => {
    const input = { serverId: runtime.serverId, pageId: 'automation', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const,
            instance: { v: 1 as const, id: 'child', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} } }] },
        { id: 'empty', name: 'Empty', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return { binding, layout: useWidgetAreaLayout(binding.port!, input.context) };
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', placements: [{ instance: { id: 'child' } }] }));
    const surface = hook.getCurrent().binding.surface!;
    const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
    const receive = createUiClientActionReverseHandler({ serverId: surface.serverId, accountId: surface.accountId, isCurrent: () => true });
    const execute = async (selectedSurface: typeof surface) => (await receive({ v: 1, actionId: 'widgets.area.layout.select', input: { surface: selectedSurface },
        context: { surface: 'mcp', authority: 'account_automation' } }, { signal: new AbortController().signal })).execution;
    await act(async () => {
        const result = await execute({ ...surface, owner: { ...surface.owner, layoutId: 'empty' } });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'empty' } }, placements: [] }));
    await hook.unmount();
    expect(await execute(surface)).toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_unavailable' });
});

it('refuses an ambiguous mounted area instead of changing either selection', async () => {
    const input = { serverId: runtime.serverId, pageId: 'twice', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] }, { id: 'empty', name: 'Empty', items: [] },
    ] };
    const hook = await renderHook(() => ({ first: useCorePageWidgetAreaBinding(input), second: useCorePageWidgetAreaBinding(input) }));
    const surface = hook.getCurrent().first.surface!;
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(await createDefaultActionExecutor().execute('widgets.area.layout.select', { surface: { ...surface, owner: { ...surface.owner, layoutId: 'empty' } } }, {
        surface: 'mcp', serverId: surface.serverId, expectedAccountId: surface.accountId,
    })).toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_ambiguous' });
    expect(hook.getCurrent().first.surface).toEqual(surface);
    expect(hook.getCurrent().second.surface).toEqual(surface);
    await hook.unmount();
});

it('a bound select Action changes the displayed core document without a caller-side state update', async () => {
    const input = { serverId: runtime.serverId, pageId: 'bound-action', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] }, { id: 'empty', name: 'Empty', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return { binding, layout: useWidgetAreaLayout(binding.port!, input.context) };
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'overview' } } }));
    const surface = hook.getCurrent().binding.surface!;
    await act(async () => {
        expect(await hook.getCurrent().binding.executeLayoutAction('widgets.area.layout.select', {
            surface: { ...surface, owner: { ...surface.owner, layoutId: 'empty' } },
        })).toMatchObject({ ok: true });
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'empty' } } }));
    await hook.unmount();
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
        binding = useUsageWidgetAreaBinding({ serverId: runtime.serverId, providedContext, names });
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
