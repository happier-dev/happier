import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    fetchAutomationRuns: vi.fn(async () => {}),
    runAutomationNow: vi.fn(async () => {}),
    pauseAutomation: vi.fn(async () => {}),
    resumeAutomation: vi.fn(async () => {}),
    deleteAutomation: vi.fn(async () => {}),
    replaceAutomationAssignments: vi.fn(async () => {}),
}));
const automationState = vi.hoisted(() => ({
    automation: {
        id: 'a1',
        name: 'Nightly',
        enabled: true,
        description: null as string | null,
        schedule: { kind: 'interval' as const, everyMs: 60_000, scheduleExpr: null as string | null, timezone: null as string | null },
        nextRunAt: null as number | null,
        assignments: [] as Array<{ machineId: string; enabled: boolean; priority: number }>,
    },
}));
const machinesState = vi.hoisted(() => ({
    list: [] as Array<{
        id: string;
        active?: boolean;
        activeAt?: number;
        revokedAt?: number | null;
        metadata?: { displayName?: string; host?: string; platform?: string };
    }>,
}));

installAutomationScreensCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: routerPushSpy, back: routerBackSpy, replace: routerReplaceSpy },
            params: { id: 'a1' },
        });
        return expoRouterMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                const labels: Record<string, string> = {
                    'automations.detail.runNowTitle': 'Run now',
                    'automations.detail.editAutomation': 'Edit automation',
                    'automations.detail.deleteAutomation': 'Delete automation',
                    'automations.detail.machineAssignmentsTitle': 'Machine assignments',
                    'status.online': 'online',
                    'status.offline': 'offline',
                };
                return labels[key] ?? key;
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(async () => {}),
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAutomation: () => automationState.automation,
            useAutomationRuns: () => [],
            useAllMachines: () => machinesState.list,
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#777',
                    text: '#111',
                    accent: { blue: '#0a84ff' },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) =>
        React.createElement(
            'Pressable',
            { onPress: props.onPress, accessibilityLabel: props.title, subtitle: props.subtitle },
            React.createElement('Text', null, props.title),
            props.rightElement ?? null,
        ),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

describe('AutomationDetailScreen', () => {
    beforeEach(() => {
        automationState.automation = {
            id: 'a1',
            name: 'Nightly',
            enabled: true,
            description: null,
            schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null },
            nextRunAt: null,
            assignments: [],
        };
        machinesState.list = [];
        routerPushSpy.mockReset();
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(true);
        syncSpies.deleteAutomation.mockClear();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.fetchAutomationRuns.mockClear();
        syncSpies.runAutomationNow.mockClear();
        syncSpies.replaceAutomationAssignments.mockClear();
    });

    it('blurs the active element before navigating to edit automation', async () => {
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const editButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Edit automation');
        await act(async () => {
            pressTestInstance(editButton, 'Edit automation');
        });

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/automations/edit',
            params: { id: 'a1' },
        });
    });

    it('updates machine assignments without forcing a full automations refresh', async () => {
        machinesState.list = [
            {
                id: 'm1',
                metadata: { displayName: 'Primary machine', host: 'primary.local', platform: 'macOS' },
            },
        ];

        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const refreshCallsBeforeToggle = syncSpies.refreshAutomations.mock.calls.length;

        const toggle = screen.findByType('Switch');
        await act(async () => {
            toggle.props.onValueChange(true);
        });

        expect(syncSpies.replaceAutomationAssignments).toHaveBeenCalledWith('a1', [
            { machineId: 'm1', enabled: true, priority: 0 },
        ]);
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(refreshCallsBeforeToggle);
    });

    it('queues a run-now action without immediately refetching automation runs', async () => {
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const fetchRunsCallsBeforeRunNow = syncSpies.fetchAutomationRuns.mock.calls.length;

        const runNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        await act(async () => {
            await pressTestInstance(runNowButton, 'Run now');
        });

        expect(syncSpies.runAutomationNow).toHaveBeenCalledWith('a1');
        expect(syncSpies.fetchAutomationRuns).toHaveBeenCalledTimes(fetchRunsCallsBeforeRunNow);
    });

    it('hides the machine-assignment warning once at least one machine is enabled', async () => {
        automationState.automation.assignments = [
            { machineId: 'm1', enabled: true, priority: 1 },
        ];
        machinesState.list = [
            {
                id: 'm1',
                metadata: { displayName: 'Primary machine', host: 'primary.local', platform: 'macOS' },
            },
        ];

        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const machineAssignmentsGroup = screen.findByProps({ title: 'Machine assignments' });

        expect(machineAssignmentsGroup.props.footer).toBeUndefined();
    });

    it('disambiguates duplicate machine rows with online state in the subtitle', async () => {
        const now = Date.now();
        machinesState.list = [
            {
                id: 'm1',
                active: true,
                activeAt: now,
                revokedAt: null,
                metadata: { displayName: 'Leeroys-MacBook-Pro', host: 'Leeroys-MacBook-Pro', platform: 'darwin' },
            },
            {
                id: 'm2',
                active: false,
                activeAt: now - 10 * 60_000,
                revokedAt: null,
                metadata: { displayName: 'Leeroys-MacBook-Pro', host: 'Leeroys-MacBook-Pro', platform: 'darwin' },
            },
        ];

        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const machineRows = screen.findAllByProps({ accessibilityLabel: 'Leeroys-MacBook-Pro' });

        expect(machineRows.map((node) => node.props.subtitle)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('online'),
                expect.stringContaining('offline'),
            ]),
        );
    });

    it('navigates to the automations list after deleting instead of relying on history back', async () => {
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));

        const deleteButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Delete automation');
        await act(async () => {
            await pressTestInstance(deleteButton, 'Delete automation');
        });

        expect(syncSpies.deleteAutomation).toHaveBeenCalledWith('a1');
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });
});
