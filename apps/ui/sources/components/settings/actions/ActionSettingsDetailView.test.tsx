import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { renderScreen as renderRealScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness, type SecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
    createMachineAdministrationTargetSelectionFixture,
    createMachineAdministrationTargetSelectionMock,
    installMachineAdministrationTargetSelectionBoundary,
} from '@/dev/testkit/mocks/machineAdministrationTargetSelection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    itemListsWithSearchHeader: 0,
    itemGroupsWithSearchHeader: 0,
    renderOrder: [] as string[],
    rawPolicy: { v: 1, allowEnvironmentVariables: false, allowCrossMachine: false } as unknown,
    rawAllowLists: { v: 1, allowedRoleIds: null, allowedAgentTargetKeys: null } as unknown,
    stackOptions: null as Record<string, unknown> | null,
    windowWidth: 800,
    routeActionId: 'review.start',
    reset() {
        this.itemListsWithSearchHeader = 0;
        this.itemGroupsWithSearchHeader = 0;
        this.renderOrder = [];
        this.rawPolicy = { v: 1, allowEnvironmentVariables: false, allowCrossMachine: false };
        this.rawAllowLists = { v: 1, allowedRoleIds: null, allowedAgentTargetKeys: null };
        this.stackOptions = null;
        this.windowWidth = 800;
        this.routeActionId = 'review.start';
    },
}));

const administrationTargetSelection = createMachineAdministrationTargetSelectionMock({
    selectedMachineId: null,
});
const disabledAdministrationTargetSelection = createMachineAdministrationTargetSelectionFixture({
    selectedMachineId: null,
});
installMachineAdministrationTargetSelectionBoundary(administrationTargetSelection);
const administrationSelectionCalls: Array<Readonly<{
    selectionKey: string;
    options: unknown;
}>> = [];
vi.doMock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    ...administrationTargetSelection.module,
    useMachineAdministrationTargetSelection: (selectionKey: string, options: { enabled?: boolean } | undefined) => {
        administrationSelectionCalls.push({ selectionKey, options });
        if (options?.enabled === false) {
            return disabledAdministrationTargetSelection;
        }
        return administrationTargetSelection.module.useMachineAdministrationTargetSelection(selectionKey);
    },
}));

const daemonProjection = vi.hoisted(() => ({
    byMachineId: {} as Record<string, unknown>,
    reset() {
        this.byMachineId = {};
    },
}));

// Browser portal placement is a system boundary; the dropdown and option rows remain real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: (params: Readonly<{ machineId?: unknown }>) => {
        const machineId = typeof params.machineId === 'string' ? params.machineId : '';
        return daemonProjection.byMachineId[machineId] ?? { phase: 'idle', inputs: null };
    },
}));

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: { get: () => ({ width: capture.windowWidth, height: 844, scale: 2, fontScale: 1 }) },
            useWindowDimensions: () => ({
                width: capture.windowWidth,
                height: 844,
                scale: 2,
                fontScale: 1,
            }),
        });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => {
        const { createExpoRouterMock, createStackOptionsCapture } = await import('@/dev/testkit/mocks/router');
        const stackOptionsCapture = createStackOptionsCapture();
        const routerMock = createExpoRouterMock({
            params: () => ({ actionId: capture.routeActionId }),
            stackOptionsCapture,
        });
        const StackScreen = routerMock.module.Stack.Screen;
        return {
            ...routerMock.module,
            Stack: Object.assign(routerMock.module.Stack, {
                Screen: (props: { options?: Record<string, unknown> }) => {
                    StackScreen(props);
                    capture.stackOptions = stackOptionsCapture.getResolved();
                    return React.createElement('StackScreen', props);
                },
            }),
        };
});











let account: SecretSettingsTestHarness;
beforeEach(async () => {
    account = await createSecretSettingsTestHarness({ settings: settingsParse({
        sessionAgentSpawnPolicyV1: capture.rawPolicy,
        sessionAgentStartAllowListsV1: capture.rawAllowLists,
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'actions.policy.set': ['ui'], 'settings.set': ['ui'] } },
    }) });
});
afterEach(async () => {
    standardCleanup();
    await account.dispose();
    capture.reset();
    administrationTargetSelection.controller.reset();
    administrationSelectionCalls.length = 0;
    daemonProjection.reset();
});

// Resolve the shared catalog/module graph during collection, outside individual
// interaction-test deadlines; the page and domain logic remain real.
await loadSyncSingletonForTests();
await import('./ActionSettingsDetailView');
const { Item } = await import("@/components/ui/lists/Item");
const { CompactSearchField } = await import("@/components/ui/forms/CompactSearchField");
const { Switch } = await import("@/components/ui/forms/Switch");
const { DropdownMenu } = await import("@/components/ui/forms/dropdown/DropdownMenu");
const { SegmentedTabBar } = await import("@/components/ui/navigation/SegmentedTabBar");
let renderedScreen: Awaited<ReturnType<typeof renderRealScreen>> | null = null;
async function renderScreen(...args: Parameters<typeof renderRealScreen>) {
    renderedScreen = await renderRealScreen(...args);
    return renderedScreen;
}
function renderedProps(component: React.ElementType): Array<Record<string, unknown>> {
    return renderedScreen?.findAllByType(component).map(node => node.props) ?? [];
}


describe('ActionSettingsDetailView', () => {
    it('keeps built-in action rows stable when the machine inventory refreshes', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        const screen = await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);
        const renderedItems = screen.findAllByType(Item);

        await React.act(async () => {
            administrationTargetSelection.controller.setMachines([
                { machineId: 'machine-a', displayName: 'Mac updated' },
            ]);
        });

        expect(administrationSelectionCalls).toContainEqual({
            selectionKey: 'actions.settings',
            options: { enabled: false },
        });
        expect(screen.findAllByType(Item)).toEqual(renderedItems);
    });

    it('admits host capture approval changes under Off, Ask and Allowed only for the selected plugin', async () => {
        daemonProjection.byMachineId = {
            'machine-a': { phase: 'ready', inputs: { pluginProjectionById: {
                'acme.viewer': { pluginId: 'acme.viewer', title: 'My viewer', actions: [] },
                'acme.other': { pluginId: 'acme.other', title: 'Other viewer', actions: [] },
            } } },
        };
        administrationTargetSelection.controller.select('machine-a');
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
            v: 1, actions: { 'actions.policy.set': { disabledSurfaces: ['ui'] } },
            pluginHostCaptureApprovalWaived: ['acme.retained'],
        } }));
        await renderScreen(<ActionSettingsDetailContent actionId="capture.view" />);
        const control = () => renderedProps(SegmentedTabBar).find(bar => (
            bar.testIDPrefix === 'settings-actions:host-capture:acme.viewer:mode'
        ));
        const choose = (value: string) => (control()?.onSelectTab as (value: string) => void)(value);
        expect(control()?.activeTabId).toBe('ask_first');
        expect(control()?.accessibilityLabel).toBe('My viewer');
        expect(storage.getState().settings.actionsSettingsV1.actions['actions.policy.set']?.disabledSurfaces).toEqual(['ui']);
        expect(storage.getState().settings.actionsSettingsV1.approvalWaivedSurfaces?.['actions.policy.set']).toBeUndefined();
        await React.act(async () => { choose('allowed'); });
        expect(account.settingsWrites).toEqual([]);
        const setAdmission = async (ask: boolean) => {
            await React.act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { ...account.persistedSettings.actionsSettingsV1,
                    actions: { 'actions.policy.set': ask ? { approvalRequiredSurfaces: ['ui'] } : {} },
                    approvalWaivedSurfaces: ask ? {} : { 'actions.policy.set': ['ui'] },
                },
            })); });
        };
        await setAdmission(true);
        await React.act(async () => { choose('allowed'); });
        await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
        expect(account.persistedSettings.actionsSettingsV1.pluginHostCaptureApprovalWaived).toEqual(['acme.retained']);
        await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
        expect(account.persistedSettings.actionsSettingsV1.pluginHostCaptureApprovalWaived).toEqual(['acme.retained']);
        await React.act(async () => { choose('allowed'); });
        await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
        await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
        await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.pluginHostCaptureApprovalWaived).toEqual(['acme.retained', 'acme.viewer']));
        await setAdmission(false);
        await React.act(async () => { choose('ask_first'); });
        await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.pluginHostCaptureApprovalWaived).toEqual(['acme.retained']));
    });

    it('renders approval-capable targets as mode tabs and ordinary placements as switches', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        expect(administrationSelectionCalls).toContainEqual({
            selectionKey: 'actions.settings',
            options: undefined,
        });
        // The page opens on the action itself (entity header with its on/off switch); the surface
        // filter sits between the header and the surfaces, outside any section sheet.
        expect(renderedProps(CompactSearchField)).toHaveLength(1);
        const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
        expect(screen.findAllByType(ItemGroup).some(group => group.findAllByType(CompactSearchField).length > 0)).toBe(false);
        expect(await screen.findByTestId('settings-actions:action:review.start:summary')).toBeTruthy();
        const summarySwitch = renderedProps(Switch).find((switchProps) =>
            switchProps.testID === 'settings-actions:action:review.start:enabled',
        );
        expect(summarySwitch?.accessibilityLabel).toBe('Start review');
        expect(renderedProps(Item).some((item) => item.testID === 'settings-actions:action:review.start:target:cli')).toBe(true);
        expect(renderedProps(Item).some((item) => item.testID === 'settings-actions:action:review.start:target:api')).toBe(true);
        expect(renderedProps(Item).some((item) => item.testID === 'settings-actions:action:review.start:target:plugin')).toBe(true);
        expect(renderedProps(SegmentedTabBar).some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode'
            && bar.valueSource === 'inherited',
        )).toBe(true);
        expect(renderedProps(SegmentedTabBar).some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:api:mode'
            && bar.valueSource === 'inherited',
        )).toBe(true);
        expect(renderedProps(SegmentedTabBar).some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:plugin:mode'
            && bar.valueSource === 'inherited',
        )).toBe(true);
        const apiMode = renderedProps(SegmentedTabBar).find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:api:mode',
        );
        const apiRow = renderedProps(Item).find((item) =>
            item.testID === 'settings-actions:action:review.start:target:api',
        );
        expect(apiMode?.accessibilityLabel).toBe(apiRow?.title);
        const commandPaletteSwitch = renderedProps(Switch).find((switchProps) =>
            switchProps.testID === 'settings-actions:action:review.start:target:command_palette:enabled',
        );
        const commandPaletteRow = renderedProps(Item).find((item) =>
            item.testID === 'settings-actions:action:review.start:target:command_palette',
        );
        expect(commandPaletteSwitch?.accessibilityLabel).toBe(commandPaletteRow?.title);
    });

    it('renders a declared non-waivable Action without an Allowed or Default choice', async () => {
        const actionId = 'workflow.trigger.add';
        const spec = getActionSpec(actionId);
        const descriptor = Object.getOwnPropertyDescriptor(spec, 'approvalPolicy')!;
        Object.defineProperty(spec, 'approvalPolicy', { ...descriptor, value: { ...spec.approvalPolicy, nonWaivable: true } });
        account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
            ...account.persistedSettings.actionsSettingsV1,
            approvalWaivedSurfaces: { [actionId]: ['agent'] },
        } }));
        try {
            const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
            await renderScreen(<ActionSettingsDetailContent actionId={actionId} />);
            const agentMode = renderedProps(SegmentedTabBar).find(bar =>
                bar.testIDPrefix === `settings-actions:action:${actionId}:target:agent:mode`);
            expect(agentMode?.activeTabId).toBe('ask_first');
            expect((agentMode?.tabs as Array<{ id: string }>).map(tab => tab.id)).toEqual(['off', 'ask_first']);
        } finally { Object.defineProperty(spec, 'approvalPolicy', descriptor); }
    });

    it('renders dangerous Agent confirmation as the inherited default with explicit overrides', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailContent actionId="prompt_doc.update" />);

        const sessionAgentMode = renderedProps(SegmentedTabBar).find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:prompt_doc.update:target:agent:mode',
        );
        expect(sessionAgentMode).toBeTruthy();
        expect(sessionAgentMode?.valueSource).toBe('inherited');
        expect((sessionAgentMode?.tabs as Array<{ id: string }>).map((tab) => tab.id)).toEqual([
            'off',
            'ask_first',
            'allowed',
        ]);
    });

    it('shows resource safety and automation facts without creating an automation approval control', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        await renderScreen(<ActionSettingsDetailContent actionId="machines.storage.trash.move" />);

        const factIds = renderedProps(Item)
            .map((item) => item.testID)
            .filter((id) => typeof id === 'string' && id.includes(':fact:'));
        expect(factIds).toEqual([
            'settings-actions:action:machines.storage.trash.move:fact:automations',
            'settings-actions:action:machines.storage.trash.move:fact:forbidden',
            'settings-actions:action:machines.storage.trash.move:fact:trash-first',
        ]);
        expect(renderedProps(SegmentedTabBar).some((bar) => String(bar.testIDPrefix).includes('automations'))).toBe(false);
        expect(renderedProps(Item).find((item) => item.testID === factIds[0])?.rightElement).toBeUndefined();
        expect(renderedProps(SegmentedTabBar).find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:machines.storage.trash.move:target:agent:mode',
        )?.tabs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'allowed' })]));
    });

    it('persists ask-first approval mode through the canonical settings writer', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const cliMode = renderedProps(SegmentedTabBar).find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode',
        );
        expect(cliMode).toBeTruthy();

        await React.act(async () => { (cliMode?.onSelectTab as (tabId: string) => void)('ask_first'); });
        await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.actions['review.start']?.approvalRequiredSurfaces).toEqual(['cli']));
    });

    it('persists the MCP Allowed choice for widget rename through the real detail control', async () => {
        account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
            ...account.persistedSettings.actionsSettingsV1,
            actions: { 'widgets.item.rename': { disabledSurfaces: ['agent'] } },
        } }));
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        const screen = await renderScreen(<ActionSettingsDetailContent actionId="widgets.item.rename" />);
        const prefix = 'settings-actions:action:widgets.item.rename:target:mcp:mode';
        // Inheriting: no way back to a default it is already on.
        expect(screen.findByTestId(`${prefix}:useDefault`)).toBeNull();
        await screen.pressByTestIdAsync(`${prefix}:allowed`);
        await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1).toMatchObject({
            actions: { 'widgets.item.rename': { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: { 'widgets.item.rename': ['mcp'] },
        }));
        // The boundary fixture records persisted bytes; remount reads those acknowledged bytes.
        await screen.update(<ActionSettingsDetailContent key="readback" actionId="widgets.item.rename" />);
        expect(screen.findByTestId(`${prefix}:allowed`)?.props.accessibilityState.checked).toBe(true);
        expect(screen.findByTestId(`${prefix}:useDefault`)).not.toBeNull();
    });

    it('renders tool exposure controls for eligible tool-backed integration surfaces', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const sessionAgentExposure = renderedProps(DropdownMenu).find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent:tool-exposure';
        });
        const mcpExposure = renderedProps(DropdownMenu).find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:mcp:tool-exposure';
        });
        const cliExposure = renderedProps(DropdownMenu).find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:cli:tool-exposure';
        });

        expect(sessionAgentExposure).toMatchObject({
            selectedId: 'default',
        });
        expect(mcpExposure).toMatchObject({
            selectedId: 'default',
        });
        expect(cliExposure).toMatchObject({
            selectedId: 'default',
        });
        expect((sessionAgentExposure?.items as Array<{ testID?: string }>).map((item) => item.testID)).toEqual([
            'settings-actions:action:review.start:target:agent:tool-exposure:default',
            'settings-actions:action:review.start:target:agent:tool-exposure:discoverable_only',
            'settings-actions:action:review.start:target:agent:tool-exposure:direct',
        ]);
        expect(renderedProps(DropdownMenu).some((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent_input_chips:tool-exposure';
        })).toBe(false);
        expect(await screen.findByTestId(
            'settings-actions:action:review.start:target:agent:tool-exposure:resolved:discoverable_only',
        )).toBeTruthy();
        // External MCP shares the agent surface's discoverable default (e1269dcdce).
        expect(await screen.findByTestId(
            'settings-actions:action:review.start:target:mcp:tool-exposure:resolved:discoverable_only',
        )).toBeTruthy();
    });

    it('persists direct tool exposure overrides and clears them when default is selected', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const sessionAgentExposure = renderedProps(DropdownMenu).find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent:tool-exposure';
        });
        expect(sessionAgentExposure).toBeTruthy();

        await React.act(async () => { (sessionAgentExposure?.onSelect as (itemId: string) => void)('direct'); });
        await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.actions['review.start']?.toolExposureModes?.agent).toBe('direct'));
        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);
        const resetSessionAgentExposure = renderedProps(DropdownMenu).find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent:tool-exposure';
        });
        expect(resetSessionAgentExposure).toBeTruthy();

        await React.act(async () => { (resetSessionAgentExposure?.onSelect as (itemId: string) => void)('default'); });
        await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.actions['review.start']?.toolExposureModes?.agent).toBeUndefined());
    });

    it('renders and persists session-agent spawn policy toggles for Create session', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="session.spawn_new" />);

        const directoryToggle = renderedProps(Switch).find((switchProps) =>
            switchProps.testID === 'settings-actions:session-spawn-policy:allowCustomDirectory',
        );
        expect(directoryToggle).toBeTruthy();
        expect(directoryToggle?.value).toBe(true);

        const onDirectoryToggleChange = directoryToggle?.onValueChange;
        expect(typeof onDirectoryToggleChange).toBe('function');
        await React.act(async () => { (onDirectoryToggleChange as (next: boolean) => void)(false); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentSpawnPolicyV1).toMatchObject({
            allowCustomDirectory: false, allowCrossMachine: false, allowEnvironmentVariables: false,
        }));
        const written = account.persistedSettings.sessionAgentSpawnPolicyV1;
        expect(written).not.toHaveProperty('allowedRoleIds');
        expect(written).not.toHaveProperty('allowedAgentTargetKeys');
        expect(account.persistedSettings.sessionAgentStartAllowListsV1).toMatchObject({ allowedRoleIds: null, allowedAgentTargetKeys: null });
    });

    it('restores the environment-variables policy toggle and writes it with the rest of the policy', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="session.spawn_new" />);

        const environmentToggle = renderedProps(Switch).find((switchProps) =>
            switchProps.testID === 'settings-actions:session-spawn-policy:allowEnvironmentVariables',
        );
        expect(environmentToggle?.value).toBe(false);
        await React.act(async () => { (environmentToggle?.onValueChange as (next: boolean) => void)(true); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentSpawnPolicyV1).toMatchObject({
            allowEnvironmentVariables: true, allowCrossMachine: false,
        }));
    });

    it('writes engine allow-lists only to their separate Account setting', async () => {
        account.replaceSettings(settingsParse({ ...account.persistedSettings,
            sessionAgentStartAllowListsV1: { v: 1, allowedRoleIds: ['builder'], allowedAgentTargetKeys: null },
        }));
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        const screen = await renderScreen(<ActionSettingsDetailContent actionId="session.spawn_new" />);
        await screen.pressByTestIdAsync('settings-actions:session-start-allow-lists:agents');
        const menu = renderedProps(DropdownMenu).find((entry) => entry.testID === 'settings-actions:session-start-allow-lists:agents:menu');
        expect(menu).toBeTruthy();
        const select = menu?.onSelect;
        if (typeof select !== 'function') throw new Error('allow-list selection unavailable');
        await React.act(async () => { select('none'); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionAgentStartAllowListsV1).toEqual({ v: 1, allowedRoleIds: ['builder'], allowedAgentTargetKeys: [] }));
        expect(account.persistedSettings.sessionAgentSpawnPolicyV1.allowEnvironmentVariables).toBe(false);
    });

    it('moves approval mode controls into the target text column on narrow mobile widths', async () => {
        capture.windowWidth = 390;
        const native = await import('react-native');
        const viewport = vi.spyOn(native, 'useWindowDimensions').mockReturnValue({
            width: 390, height: 844, scale: 2, fontScale: 1,
        });
        onTestFinished(() => viewport.mockRestore());
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const cliTarget = renderedProps(Item).find((item) =>
            item.testID === 'settings-actions:action:review.start:target:cli',
        );
        expect(cliTarget).toBeTruthy();
        expect(cliTarget?.rightElement).toBeFalsy();
        expect(cliTarget?.subtitleAccessory).toBeTruthy();
        expect(renderedProps(SegmentedTabBar).some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode'
            && bar.valueSource === 'inherited',
        )).toBe(true);
    });

    it('uses the action name as the route header title', async () => {
        const { ActionSettingsDetailView } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailView />);

        expect(capture.stackOptions?.headerTitle).toBe('Start review');
    });

    it('resolves an encoded qualified contributed id with API and trusted-plugin controls', async () => {
        capture.routeActionId = 'happier.inspector%2Factions%2Fself-check';
        daemonProjection.byMachineId = {
            'machine-a': {
                phase: 'ready',
                inputs: {
                    pluginProjectionById: {
                        'happier.inspector': {
                            pluginId: 'happier.inspector',
                            actions: [{
                                id: 'self-check',
                                title: 'Run Inspector self-check',
                                description: 'Checks the Inspector plugin.',
                                icon: null,
                                surfaces: ['ui'],
                                placementBindings: ['toolbar'],
                            }],
                        },
                    },
                },
            },
        };
        administrationTargetSelection.controller.select('machine-a');
        const { ActionSettingsDetailView } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailView />);

        expect(await screen.findByTestId(
            'settings-actions:action:happier.inspector/actions/self-check:summary',
        )).toBeTruthy();
        expect(renderedProps(Item).some((item) => (
            item.testID === 'settings-actions:action:happier.inspector/actions/self-check:target:api'
        ))).toBe(true);
        expect(renderedProps(Item).some((item) => (
            item.testID === 'settings-actions:action:happier.inspector/actions/self-check:target:plugin'
        ))).toBe(true);
        expect(renderedProps(Item).some((item) => (
            item.testID === 'settings-actions:action:happier.inspector/actions/self-check:target:contextual_ui'
        ))).toBe(true);
        for (const targetId of ['api', 'plugin'] as const) {
            const target = renderedProps(Item).find((item) => (
                item.testID === `settings-actions:action:happier.inspector/actions/self-check:target:${targetId}`
            ));
            const modeControl = renderedProps(SegmentedTabBar).find((bar) => (
                bar.testIDPrefix === `settings-actions:action:happier.inspector/actions/self-check:target:${targetId}:mode`
            ));
            expect(modeControl?.accessibilityLabel).toBe(target?.title);
            expect(modeControl?.valueSource).toBe('inherited');
            expect((modeControl?.tabs as Array<{ id: string }>).map((tab) => tab.id)).toEqual([
                'off',
                'ask_first',
                'allowed',
            ]);
        }
    });

    it('treats direct links to non-configurable runtime actions as invalid', async () => {
        // `devices.simulator.input.orientation` is statically-unbacked (no producer in stock scrcpy),
        // so it stays UNSURFACED / non-configurable — a direct link must be rejected. (The browser
        // diagnostics interaction verbs, incl. `eval`, are now executor-backed and configurable, so
        // they are no longer the canonical non-configurable example.)
        const { getActionSpec } = await import('@happier-dev/protocol');
        capture.routeActionId = 'devices.simulator.input.orientation';
        const { ActionSettingsDetailView } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailView />);

        expect(capture.stackOptions?.headerTitle).not.toBe(getActionSpec('devices.simulator.input.orientation').title);
        expect(renderedProps(Item).some((item) => item.testID === 'settings-actions:action:devices.simulator.input.orientation:summary')).toBe(false);
    });
});
