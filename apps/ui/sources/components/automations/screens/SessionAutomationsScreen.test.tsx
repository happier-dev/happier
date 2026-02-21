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
    targetType: 'new_session' | 'existing_session';
    templateCiphertext: string;
}>;

const automationsState = vi.hoisted(() => ({
    list: [] as AutomationListItem[],
}));

const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    runAutomationNow: vi.fn(async (_id: string) => {}),
    pauseAutomation: vi.fn(async (_id: string) => {}),
    resumeAutomation: vi.fn(async (_id: string) => {}),
}));

const routerPushSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertSpy,
        confirm: vi.fn(),
        prompt: vi.fn(),
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

describe('SessionAutomationsScreen', () => {
    beforeEach(() => {
        automationsState.list = [];
        routerPushSpy.mockReset();
        modalAlertSpy.mockReset();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.runAutomationNow.mockClear();
        syncSpies.pauseAutomation.mockClear();
        syncSpies.resumeAutomation.mockClear();
    });

    afterEach(() => {
        automationsState.list = [];
    });

    it('filters to automations linked to the session', async () => {
        automationsState.list = [
            {
                id: 'a1',
                name: 'Linked',
                description: null,
                enabled: true,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null },
                nextRunAt: null,
                targetType: 'existing_session',
                templateCiphertext: JSON.stringify({
                    kind: 'happier_automation_template_encrypted_v1',
                    payloadCiphertext: 'cipher',
                    existingSessionId: 's1',
                }),
            },
            {
                id: 'a2',
                name: 'Other session',
                description: null,
                enabled: true,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null },
                nextRunAt: null,
                targetType: 'existing_session',
                templateCiphertext: JSON.stringify({
                    kind: 'happier_automation_template_encrypted_v1',
                    payloadCiphertext: 'cipher',
                    existingSessionId: 's2',
                }),
            },
        ];

        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionAutomationsScreen sessionId="s1" />);
        });
        await flushRender();

        const json = JSON.stringify(tree!.toJSON());
        expect(json).toContain('Linked');
        expect(json).not.toContain('Other session');
    });

    it('navigates to add automation for the session', async () => {
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionAutomationsScreen sessionId="s1" />);
        });
        await flushRender();

        const add = findPressableByText(tree!, 'Add automation');
        await act(async () => {
            add.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/automations/new');
    });
});
