import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { SelectionList } from '../SelectionList';
import { SelectionListFilterChip } from '../SelectionListFilterChips';
import type { SelectionListStep } from '../_types';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// The anchored portal is the DOM boundary; list and command publication stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 600, maxWidth: 400, placement: 'bottom' }));

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => {
    await standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
    vi.unstubAllGlobals();
});

describe('SelectionList mounted commands', () => {
    it('shares visible option activation, search and back with UI and retires removed choices', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://selection-command.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const selected: string[] = [];
        const close = vi.fn();
        const rootStep: SelectionListStep = { id: 'root', inputPlaceholder: 'Find a destination', sections: [{ kind: 'static', id: 'destinations', options: [
            { id: 'disabled', label: 'Unavailable destination', disabled: true, onSelect: () => selected.push('disabled') },
            { id: 'machine', label: 'Machine', openStep: { id: 'checkouts', sections: [{ kind: 'static', id: 'checkouts', options: [
                { id: 'main', label: 'Main checkout', onSelect: () => selected.push('main') },
                { id: 'feature', label: 'Feature checkout', onSelect: () => selected.push('feature') },
            ] }] } },
        ] }] };
        const screen = await renderMountedCurrentUiContext(<SelectionList rootStep={rootStep} onSelect={() => {}}
            onRequestClose={close} currentUiContextCommandScope="usage.target" testID="picker" disableTransitions />);
        const executor = createDefaultActionExecutor();
        const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
        const invoke = async (key: string, input?: PluginUiJsonValueV1) => {
            const command = commands().find(row => row.description?.startsWith(`usage.target.${key}`));
            expect(command, key).toBeDefined();
            let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
            await act(async () => { result = await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], {
                commandId: command!.id, ...(input === undefined ? {} : { input }),
            }, { surface: 'agent' }); });
            return result;
        };
        expect(await invoke('activate', { id: 'disabled' })).toMatchObject({ ok: false });
        expect(selected).toEqual([]);
        expect(await invoke('activate', { id: 'machine' })).toMatchObject({ ok: true });
        expect(screen.findByTestId('picker:checkouts:option:main')).not.toBeNull();
        expect(await invoke('search', { value: 'Feature' })).toMatchObject({ ok: true });
        expect(screen.findByTestId('picker:checkouts:option:main')).toBeNull();
        expect(await invoke('activate', { id: 'main' })).toMatchObject({ ok: false });
        await screen.pressByTestIdAsync('picker:checkouts:option:feature');
        await vi.waitFor(() => expect(selected).toEqual(['feature']));
        expect(await invoke('back')).toMatchObject({ ok: true });
        expect(screen.findByTestId('picker:root:option:machine')).not.toBeNull();
        expect(await invoke('activate', { id: 'main' })).toMatchObject({ ok: false });
        expect(await invoke('close')).toMatchObject({ ok: true });
        expect(close).toHaveBeenCalledOnce();
    });

    it('opens the opted-in filter chip from an agent and retires choices when UI closes it', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://filter-command.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const selected = vi.fn();
        const screen = await renderMountedCurrentUiContext(<SelectionListFilterChip currentUiContextCommandScope="usage.filter"
            filter={{ id: 'machine', testID: 'machine-filter', label: 'Machine', options: [{ id: 'all', label: 'All machines' }], onChange: selected }} />);
        const executor = createDefaultActionExecutor();
        const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
        const open = commands().find(row => row.description === 'usage.filter.open');
        expect(open).toBeDefined();
        await act(async () => { expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
            { commandId: open!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(screen.findByTestId('machine-filter:all')).not.toBeNull();
        const choose = commands().find(row => row.description?.startsWith('usage.filter.list.activate'));
        expect(choose).toBeDefined();
        await screen.pressByTestIdAsync('machine-filter');
        await vi.waitFor(() => expect(screen.findByTestId('machine-filter:all')).toBeNull());
        expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
            { commandId: choose!.id, input: { id: 'all' } }, { surface: 'agent' })).toMatchObject({ ok: false });
        expect(selected).not.toHaveBeenCalled();
    });

    it('keeps inline choices beside page commands and publishes popup choices with their foreground owner', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://selection-overlay.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const selected: string[] = [];
        const step: SelectionListStep = { id: 'choices', sections: [{ kind: 'static', id: 'choices',
            options: [{ id: 'main', label: 'Main checkout' }] }] };
        function Choices() {
            const [open, setOpen] = React.useState(false);
            const anchorRef = React.useRef(null);
            useCurrentUiContextLocalCommands([{ key: 'open', title: 'Open checkout', description: 'page.open', invoke: () => setOpen(true) }]);
            useCurrentUiContextLocalCommands(open ? [{ key: 'close', title: 'Close checkout', description: 'popup.close', invoke: () => setOpen(false) }] : [],
                { foregroundOverlay: true });
            return <>
                <SelectionList currentUiContextCommandScope="inline" rootStep={step} onSelect={() => {}} />
                <AgentInputSelectionListPopover open={open} anchorRef={anchorRef} currentUiContextCommandScope="popup.list"
                    rootStep={step} onSelect={id => selected.push(id)} onRequestClose={() => setOpen(false)} />
            </>;
        }
        await renderMountedCurrentUiContext(<Choices />);
        const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
        expect(commands().some(row => row.description === 'page.open')).toBe(true);
        expect(commands().some(row => row.description?.startsWith('inline.activate'))).toBe(true);
        const executor = createDefaultActionExecutor();
        await act(async () => { expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
            { commandId: commands().find(row => row.description === 'page.open')!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        const activate = commands().find(row => row.description?.startsWith('popup.list.activate'));
        expect(activate).toBeDefined();
        expect(commands().some(row => row.description === 'page.open')).toBe(false);
        expect(commands().some(row => row.description?.startsWith('inline.activate'))).toBe(false);
        await act(async () => { expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
            { commandId: activate!.id, input: { id: 'main' } }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        await vi.waitFor(() => expect(commands().some(row => row.description === 'page.open')).toBe(true));
        expect(selected).toEqual(['main']);
    });

    it('preserves the agent policy through a selection and a nested local command while UI can copy', async () => {
        const writeText = vi.fn(async (_text: string) => {});
        // The browser clipboard is the OS boundary; nested Action admission remains real.
        vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://selection-policy.test', accountId: 'account-a',
            settings: { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'clipboard.write': { disabledSurfaces: ['agent'] } },
                approvalWaivedSurfaces: { 'clipboard.write': ['ui'] },
            }) } }], route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const results: ActionExecuteResult[] = [];
        function CopySelection() {
            const execution = useMountedActionExecution(server.id);
            const nested = useCurrentUiContextLocalCommands([{ key: 'copy', title: 'Copy selected value', invoke: async (_input, callerContext) => {
                results.push(await execution.execute('clipboard.write', { text: 'selected destination' }, { callerContext }));
            } }]);
            return <SelectionList currentUiContextCommandScope="usage.policy" testID="policy-picker" disableTransitions
                rootStep={{ id: 'policy', sections: [{ kind: 'static', id: 'copy', options: [{ id: 'copy', label: 'Copy destination' }] }] }}
                onSelect={(_id, _option, callerContext) => { void nested.invoke('copy', undefined, callerContext); }} onRequestClose={() => {}} />;
        }
        const screen = await renderMountedCurrentUiContext(<CopySelection />);
        const command = readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands
            .find(row => row.description?.startsWith('usage.policy.activate'));
        expect(command).toBeDefined();
        await act(async () => { await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
            { commandId: command!.id, input: { id: 'copy' } }, { surface: 'agent' }); });
        await vi.waitFor(() => expect(results).toHaveLength(1));
        expect(results[0]).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(writeText).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('policy-picker:policy:option:copy');
        await vi.waitFor(() => expect(results).toHaveLength(2));
        expect(results[1]).toMatchObject({ ok: true, result: { status: 'copied' } });
        expect(writeText).toHaveBeenCalledWith('selected destination');
    });
});
