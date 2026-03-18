import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const automationState = vi.hoisted(() => ({
    automation: null as any,
}));

const machineState = vi.hoisted(() => ({
    machines: [] as Array<{ id: string }>,
}));

const runState = vi.hoisted(() => ({
    runs: [] as Array<{ id: string; state: string; scheduledAt: number; updatedAt: number; errorMessage?: string | null }>,
}));

const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    fetchAutomationRuns: vi.fn(async (_id: string) => {}),
    runAutomationNow: vi.fn(async (_id: string) => {}),
    pauseAutomation: vi.fn(async (_id: string) => {}),
    resumeAutomation: vi.fn(async (_id: string) => {}),
    deleteAutomation: vi.fn(async (_id: string) => {}),
    replaceAutomationAssignments: vi.fn(async (_id: string, _assignments: unknown) => {}),
}));

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => action(),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#777',
                text: '#111',
                groupped: { background: '#fff' },
                surface: '#fff',
                surfaceHigh: '#f7f7f7',
                surfaceHighest: '#eee',
                surfacePressedOverlay: '#f0f0f0',
                divider: '#ddd',
                warningCritical: '#f00',
                success: '#0a0',
                accent: { blue: '#0a84ff' },
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) =>
            factory({
                colors: {
                    textSecondary: '#777',
                    text: '#111',
                    groupped: { background: '#fff' },
                    surface: '#fff',
                    surfaceHigh: '#f7f7f7',
                    surfaceHighest: '#eee',
                    surfacePressedOverlay: '#f0f0f0',
                    divider: '#ddd',
                    warningCritical: '#f00',
                    success: '#0a0',
                    accent: { blue: '#0a84ff' },
                },
            }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy, replace: routerReplaceSpy }),
    useLocalSearchParams: () => ({ id: 'automation-1' }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: modalConfirmSpy,
        alert: modalAlertSpy,
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAutomation: () => automationState.automation,
    useAutomationRuns: () => runState.runs,
    useAllMachines: () => machineState.machines,
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement(
        'Pressable',
        props,
        React.createElement('Text', null, props.title ?? props.detail ?? props.subtitle ?? ''),
    ),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

function findPressableByText(tree: renderer.ReactTestRenderer, text: string) {
    const textNode = tree.root.find((node) => {
        if ((node.type as unknown) !== 'Text') return false;
        const children = node.props.children;
        if (typeof children === 'string') return children === text;
        if (Array.isArray(children)) return children.includes(text);
        return false;
    });
    let current: any = textNode;
    while (current && (current.type as unknown) !== 'Pressable') {
        current = current.parent;
    }
    if (!current) throw new Error(`Pressable with text "${text}" not found`);
    return current;
}

describe('AutomationDetailScreen', () => {
    beforeEach(() => {
        automationState.automation = {
            id: 'automation-1',
            name: 'Nightly',
            enabled: true,
            nextRunAt: null,
            schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null },
            assignments: [],
        };
        machineState.machines = [{ id: 'machine-1' }];
        runState.runs = [];
        routerPushSpy.mockReset();
        routerReplaceSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(true);
        modalAlertSpy.mockReset();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.fetchAutomationRuns.mockClear();
        syncSpies.runAutomationNow.mockClear();
        syncSpies.pauseAutomation.mockClear();
        syncSpies.resumeAutomation.mockClear();
        syncSpies.deleteAutomation.mockClear();
        syncSpies.replaceAutomationAssignments.mockClear();
    });

    it('routes to edit and deletes back to the automations list', async () => {
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<AutomationDetailScreen />);
        });
        await act(async () => {
            await Promise.resolve();
        });

        const edit = findPressableByText(tree!, 'automations.detail.editAutomation');
        await act(async () => {
            edit.props.onPress();
        });
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/automations/edit',
            params: { id: 'automation-1' },
        });

        const deleteRow = findPressableByText(tree!, 'automations.detail.deleteAutomation');
        await act(async () => {
            deleteRow.props.onPress();
        });
        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(syncSpies.deleteAutomation).toHaveBeenCalledWith('automation-1');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations');
    });
});
