import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { standardCleanup } from '@/dev/testkit';
import { executeCurrentUiContextAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectableMenuResults } from '@/components/ui/forms/dropdown/SelectableMenuResults';
import { UsageCoachSettingsGroup } from './UsageCoachSettingsGroup';
import { t } from '@/text';
import { storage } from '@/sync/domains/state/storage';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/usage', segments: ['(app)', 'settings', 'usage'],
}).module);
// The native portal is the boundary; the dropdown's selection and close ordering stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

it('opens Coach model choices through the mounted agent command and closes through the same dropdown control', async () => {
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-coach-controls.test', accountId: 'account-a' }], route: () => undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const screen = await renderMountedCurrentUiContext(<UsageCoachSettingsGroup serverId={server.id} testID="coach.preferences" />);
    const read = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'agent' } });
    if (!read.ok) throw new Error(read.errorCode);
    const snapshot = CurrentUiContextSnapshotV1Schema.parse(read.result);
    const command = snapshot.commands.find(row => row.title === t('usage.board.coach.detector_model_misfit'));
    expect(command).toBeDefined();
    await act(async () => { expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
        input: { commandId: command!.id }, context: { surface: 'agent' } })).toMatchObject({ ok: true }); });
    expect(screen.findByType(DropdownMenu).props.open).toBe(true);
    await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(false); });
    expect(screen.findByType(DropdownMenu).props.open).toBe(false);
});

it('keeps an agent check change subject to the settings Action surface restriction', async () => {
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-coach-controls.test', accountId: 'account-a',
        settings: { actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent'] } } } }], route: () => undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    await renderMountedCurrentUiContext(<UsageCoachSettingsGroup serverId={server.id} testID="coach.preferences" />);
    const before = storage.getState().settings.usageCoachPreferencesV1;
    const read = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'agent' } });
    if (!read.ok) throw new Error(read.errorCode);
    const command = CurrentUiContextSnapshotV1Schema.parse(read.result).commands.find(row => row.title === t('usage.board.coach.detector_compaction_storms'));
    expect(command).toBeDefined();
    await act(async () => { await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
        input: { commandId: command!.id, input: false }, context: { surface: 'agent' } }); });
    expect(storage.getState().settings.usageCoachPreferencesV1).toEqual(before);
});

it('commits the selected model preference before retiring its mounted menu command', async () => {
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-coach-controls.test', accountId: 'account-a',
        settings: { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent'] } } } }], route: () => undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const screen = await renderMountedCurrentUiContext(<UsageCoachSettingsGroup serverId={server.id} testID="coach.preferences" />);
    await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
    const read = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'agent' } });
    if (!read.ok) throw new Error(read.errorCode);
    const command = CurrentUiContextSnapshotV1Schema.parse(read.result).commands.find(row => row.title ===
        `${t('usage.board.coach.detector_model_misfit')}: ${t('usage.board.coach.modelMode_off')}`);
    expect(command).toBeDefined();
    await act(async () => { await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
        input: { commandId: command!.id }, context: { surface: 'agent' } }); });
    expect(storage.getState().settings.usageCoachPreferencesV1.modelSuggestion).toBe('off');
    expect(screen.findByType(DropdownMenu).props.open).toBe(false);
    await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
    const menu = screen.findByType(SelectableMenuResults);
    const choice = menu.props.categories.flatMap((category: { items: readonly { id: string }[] }) => category.items)
        .find((row: { id: string }) => row.id === 'suggest_with_estimates');
    expect(choice).toBeDefined();
    await act(async () => { menu.props.onPressItem(choice); });
    await vi.waitFor(() => expect(storage.getState().settings.usageCoachPreferencesV1.modelSuggestion).toBe('suggest_with_estimates'));
    expect(screen.findByType(DropdownMenu).props.open).toBe(false);
});
