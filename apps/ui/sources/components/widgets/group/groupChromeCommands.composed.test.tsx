import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Install the Socket transport boundary before the rendered group imports Sync.
await vi.hoisted(async () => {
    const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    installDisconnectedServerSocketBoundary();
});
import { Pressable, View } from 'react-native';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, type WidgetAreaLayoutV1, type WidgetLayoutGroupV1 } from '@happier-dev/protocol/widgets';
import { standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { useCurrentUiContextCommandBridge, useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { WidgetArea } from '../area/WidgetArea';
import { useCorePageWidgetAreaBinding } from '../area/useCorePageWidgetAreaBinding';
import { WidgetSetupFieldRow } from '../add/WidgetSetupFieldRow';
import { readWidgetDescriptor } from '../widgetCatalog';
import { useWidgetGroupInputsEditor } from './useWidgetGroupInputsEditor';
import { useWidgetGroupKeepFlows } from './useWidgetGroupKeepFlows';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Radix owns DOM dismissal/focus effects; the modal host and command bridge stay real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// Anchored placement is the browser boundary; group owners and their children stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 600, maxWidth: 900, placement: 'bottom' }));

// Load the app-entry graph during collection, outside the timed Account restore.
await import('@/sync/syncEngine');

const candidate = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_period_summary' })!;
const group: WidgetLayoutGroupV1 = { kind: 'group', id: 'spend', title: 'Spend group', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
    { kind: 'widget', size: candidate.sizeDeclaration!.defaultSize, instance: { v: 1, id: 'summary', definition: candidate.definition!, bindings: {} } },
] };
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let serverId = '';
let area: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
beforeEach(async () => {
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://group-chrome.test', accountId: 'viewer' }], route: request =>
        request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : area ? area.request(request.url, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) : undefined });
    const server = home.homes.a!;
    serverId = server.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: server.serverUrl, generation: 0 });
});
afterEach(async () => { await standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; area = undefined; });
const scope = () => ({ serverId, accountId: 'viewer', owner: { kind: 'corePage' as const, pageId: 'usage', area: 'main' } });
const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
async function invoke(description: string, input?: string) {
    const command = commands().find(row => row.description === description);
    expect(command, description).toBeDefined();
    return createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command!.id,
        ...(input === undefined ? {} : { input }) }, { surface: 'agent' });
}

it('shares group input opening, the real setup draft and closing without applying an edit', async () => {
    function Editor() {
        const edit = useWidgetGroupInputsEditor({ group, candidates: [candidate], title: 'Spend group', scope: scope(), context: {},
            setInputs: async () => { throw new Error('Changing a presentation draft must not write'); }, testID: 'group' });
        return <><Pressable testID="inputs" onPress={edit.editInputs?.onPress} />{edit.popover}</>;
    }
    const screen = await renderMountedCurrentUiContext(<CorePluginUiPresentationScope><Editor /></CorePluginUiPresentationScope>);
    await act(async () => { expect(await invoke('group.groupInputs.open')).toMatchObject({ ok: true }); });
    const input = screen.root.findAllByType(WidgetSetupFieldRow).find(row => !row.props.disabled)!;
    const path = input.props.entry.field.path;
    const title = `${t('widgetFrame.groupInputsTitle', { group: 'Spend group' })}: ${input.props.entry.field.prompt ?? input.props.entry.field.title}`;
    const field = commands().find(row => row.title === title)!;
    await act(async () => { expect(await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
        { commandId: field.id, input: 'tokens' }, { surface: 'agent' })).toMatchObject({ ok: true }); });
    expect(screen.root.findAllByType(WidgetSetupFieldRow).find(row => row.props.entry.field.path === path)!.props.plainValue).toBe('tokens');
    await act(async () => { expect(await invoke('group.groupInputs.close')).toMatchObject({ ok: true }); });
    expect(screen.root.findAllByType(WidgetSetupFieldRow)).toHaveLength(0);
    await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
    await screen.pressByTestIdAsync('inputs');
    expect(screen.root.findAllByType(WidgetSetupFieldRow)).toHaveLength(0);
});

it('shares keep-flow opening, the save-name draft and cancel while retiring hidden drafts', async () => {
    function Keep() {
        const anchorRef = React.useRef<View | null>(null);
        const keep = useWidgetGroupKeepFlows({ group, name: 'Spend group', scope: scope(), candidates: [candidate], anchorRef, testID: 'group' });
        return <><Pressable testID="save" onPress={keep.onSave} />{keep.overlay}</>;
    }
    const screen = await renderMountedCurrentUiContext(<CorePluginUiPresentationScope><Keep /></CorePluginUiPresentationScope>);
    await act(async () => { expect(await invoke('group.groupKeep.save')).toMatchObject({ ok: true }); });
    await act(async () => { expect(await invoke('group.saveGroup.panel.name', 'Monthly spend')).toMatchObject({ ok: true }); });
    expect(screen.findHostByTestId('group.saveGroup.panel.nameInput')!.props.value).toBe('Monthly spend');
    const draft = commands().find(row => row.description === 'group.saveGroup.panel.name')!;
    await screen.pressByTestIdAsync('group.saveGroup.panel.cancel');
    expect(screen.findHostByTestId('group.saveGroup.panel.nameInput')).toBeNull();
    expect(await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
        { commandId: draft.id, input: 'Retired draft' }, { surface: 'agent' })).toMatchObject({ ok: false });
    await act(async () => { expect(await invoke('group.groupKeep.addTo')).toMatchObject({ ok: true }); });
    expect(screen.findByTestId('group.addTo')).not.toBeNull();
    await act(async () => { expect(await invoke('group.groupKeep.close')).toMatchObject({ ok: true }); });
    expect(screen.findByTestId('group.addTo')).toBeNull();
});

it('opens the real Usage group menu and empty-slot Add through their mounted presentation commands', async () => {
    const saved = WidgetAreaLayoutV1Schema.parse({ v: 1, surface: scope(), items: [group] });
    area = createLayoutArtifactHttpBoundary('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(scope()), kind: 'widget-area-layout.v1',
        defaultLayout: saved, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
    area.seed(saved);
    const context = {};
    function Area() {
        const binding = useCorePageWidgetAreaBinding({ serverId, pageId: 'usage', area: 'main', context });
        return <WidgetArea port={binding.port} context={context} geometry="grid" columnLayout={{ columns: 2, gap: 16 }} title="Widgets"
            surfaceName="Usage" organize={{ active: true, onChange: () => {} }} testID="usage" />;
    }
    const screen = await renderMountedCurrentUiContext(<CorePluginUiPresentationScope><Area /></CorePluginUiPresentationScope>);
    await vi.waitFor(() => expect(screen.findHostByTestId('usage.group.spend.bar.menu.trigger')).not.toBeNull());
    await vi.waitFor(() => expect(commands().map(row => row.title)).toContain('Spend group'));
    const menu = commands().find(row => row.title === 'Spend group');
    expect(menu).toBeDefined();
    await act(async () => { expect(await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
        { commandId: menu!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
    expect(screen.findHostByTestId('usage.group.spend.bar.menu.trigger')!.props.accessibilityState.expanded).toBe(true);
    await screen.pressByTestIdAsync('usage.group.spend.bar.menu.trigger');
    await act(async () => { expect(await invoke('usage.group.spend.slot.open')).toMatchObject({ ok: true }); });
    expect(screen.findByTestId('usage.group.spend.slotAdd')).not.toBeNull();
    await act(async () => { expect(await invoke('usage.group.spend.slotAdd.close')).toMatchObject({ ok: true }); });
    expect(screen.findByTestId('usage.group.spend.slotAdd')).toBeNull();
});

it('keeps inline diagnostic controls beside the page and hosted modal diagnostics in the foreground', async () => {
    function Details(_props: CustomModalInjectedProps) {
        return <SurfaceStateCard testID="modal-state" kind="error" title="Modal failure" diagnosticCode="modal_failed" />;
    }
    function Page() {
        const commandBridge = useCurrentUiContextCommandBridge();
        useCurrentUiContextLocalCommands([{ key: 'open', title: 'Inspect failure', description: 'page.details',
            invoke: () => { Modal.show({ component: Details, commandBridge }); } }]);
        return <SurfaceStateCard testID="inline-state" kind="error" title="Inline failure" diagnosticCode="inline_failed" />;
    }
    const screen = await renderMountedCurrentUiContext(<Page />, { withModalProvider: true });
    expect(commands().some(row => row.description === 'page.details')).toBe(true);
    expect(commands().some(row => row.title.startsWith('Inline failure: '))).toBe(true);
    await act(async () => { expect(await invoke('page.details')).toMatchObject({ ok: true }); });
    const details = commands().find(row => row.title.startsWith('Modal failure: '));
    expect(details).toBeDefined();
    expect(commands().some(row => row.description === 'page.details')).toBe(false);
    await act(async () => { expect(await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
        { commandId: details!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
    expect(screen.findByTestId('modal-state-details-code')?.props.children).toBe('modal_failed');
    await act(async () => { Modal.hideAll(); });
    expect(commands().some(row => row.description === 'page.details')).toBe(true);
});
