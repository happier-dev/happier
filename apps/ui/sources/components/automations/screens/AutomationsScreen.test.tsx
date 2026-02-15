import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type AutomationListItem = Readonly<{
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
    schedule: { kind: 'cron' | 'interval'; everyMs: number | null; scheduleExpr: string | null };
    nextRunAt: number | null;
}>;

const automationsState = vi.hoisted(() => ({
    list: [] as AutomationListItem[],
}));

const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    runAutomationNow: vi.fn(async (_id: string) => {}),
    pauseAutomation: vi.fn(async (_id: string) => {}),
    resumeAutomation: vi.fn(async (_id: string) => {}),
    deleteAutomation: vi.fn(async (_id: string) => {}),
}));

const routerPushSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: '#fff' },
                text: '#111',
                textSecondary: '#777',
                surface: '#fff',
                surfaceHigh: '#f7f7f7',
                surfaceHighest: '#eee',
                surfacePressedOverlay: '#f0f0f0',
                divider: '#ddd',
                shadow: { color: '#000', opacity: 0.15 },
                fab: { background: '#0a84ff' },
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) =>
            factory({
                colors: {
                    groupped: { background: '#fff' },
                    text: '#111',
                    textSecondary: '#777',
                    surface: '#fff',
                    surfaceHigh: '#f7f7f7',
                    surfaceHighest: '#eee',
                    surfacePressedOverlay: '#f0f0f0',
                    divider: '#ddd',
                    shadow: { color: '#000', opacity: 0.15 },
                    fab: { background: '#0a84ff' },
                },
            }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: modalConfirmSpy,
        alert: modalAlertSpy,
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAutomations: () => automationsState.list,
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

async function flushRender(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.root.find((node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label);
}

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
    if (!current) {
        throw new Error(`Pressable with text "${text}" not found`);
    }
    return current;
}

describe('AutomationsScreen', () => {
    beforeEach(() => {
        automationsState.list = [];
        routerPushSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(true);
        modalAlertSpy.mockReset();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.runAutomationNow.mockClear();
        syncSpies.pauseAutomation.mockClear();
        syncSpies.resumeAutomation.mockClear();
        syncSpies.deleteAutomation.mockClear();
    });

    afterEach(() => {
        automationsState.list = [];
    });

    it('shows empty state and links create action to New Session automation mode', async () => {
        const { AutomationsScreen } = await import('./AutomationsScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<AutomationsScreen />);
        });
        await flushRender();

        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(tree!.toJSON())).toContain('No automations yet');

        const createButton = findPressableByLabel(tree!, 'Create automation');
        await act(async () => {
            createButton.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/new?automation=1&automationPicker=1');
    });

    it('runs an automation and toggles enabled state from row controls', async () => {
        automationsState.list = [
            {
                id: 'a1',
                name: 'Nightly',
                description: null,
                enabled: true,
                schedule: { kind: 'interval', everyMs: 900_000, scheduleExpr: null },
                nextRunAt: Date.now() + 60_000,
            },
        ];

        const { AutomationsScreen } = await import('./AutomationsScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<AutomationsScreen />);
        });
        await flushRender();

        const runNow = findPressableByLabel(tree!, 'Run automation now');
        await act(async () => {
            runNow.props.onPress();
        });
        expect(syncSpies.runAutomationNow).toHaveBeenCalledWith('a1');

        const toggle = tree!.root.find((node) => (node.type as unknown) === 'Switch');
        await act(async () => {
            toggle.props.onValueChange(false);
        });
        expect(syncSpies.pauseAutomation).toHaveBeenCalledWith('a1');

        const card = findPressableByText(tree!, 'Nightly');
        await act(async () => {
            card.props.onPress();
        });
        // First press after a control interaction is ignored to prevent accidental navigation.
        await act(async () => {
            card.props.onPress();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/automations/a1');
    });
});
