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
const sessionState = vi.hoisted(() => ({
    value: null as any,
}));
const getStateSpy = vi.hoisted(() => vi.fn());
const settingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const hydrateReadyState = vi.hoisted(() => ({
    ready: true,
}));

const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    runAutomationNow: vi.fn(async (_id: string) => {}),
    pauseAutomation: vi.fn(async (_id: string) => {}),
    resumeAutomation: vi.fn(async (_id: string) => {}),
    getSessionEncryptionKeyBase64ForResume: vi.fn((_sessionId: string) => null),
}));

const routerPushSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
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
    useSession: () => sessionState.value,
    useSettings: () => settingsState.value,
    storage: {
        getState: () => getStateSpy(),
    },
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => hydrateReadyState.ready,
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
        sessionState.value = {
            id: 's1',
            active: true,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm1',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        settingsState.value = {};
        hydrateReadyState.ready = true;
        getStateSpy.mockImplementation(() => ({
            sessions: {
                s1: sessionState.value,
            },
            getProjectForSession: () => null,
        }));
        routerPushSpy.mockReset();
        modalAlertSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.runAutomationNow.mockClear();
        syncSpies.pauseAutomation.mockClear();
        syncSpies.resumeAutomation.mockClear();
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockClear();
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
            tree = renderer.create(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        });
        await flushRender();

        const json = JSON.stringify(tree!.toJSON());
        expect(json).toContain('Linked');
        expect(json).not.toContain('Other session');
    });

    it('navigates to add automation for the session when the reachable target comes from project state', async () => {
        sessionState.value = {
            id: 's1',
            active: false,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm-stale',
                path: '/tmp/project',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        getStateSpy.mockImplementation(() => ({
            sessions: {
                s1: sessionState.value,
            },
            machines: {
                'm-target': {
                    id: 'm-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 's1'
                ? {
                    key: {
                        machineId: 'm-target',
                        path: '/tmp/project',
                    },
                }
                : null,
        }));

        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        });
        await flushRender();

        const add = findPressableByText(tree!, 'Add automation');
        expect(add.props.accessibilityState?.disabled ?? add.props.disabled).not.toBe(true);
        await act(async () => {
            add.props.onPress();
        });

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/automations/new');
    });

    it('disables adding an automation when the session is not eligible for existing-session automations', async () => {
        sessionState.value = {
            id: 's1',
            active: true,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm1',
                flavor: 'pi',
                piSessionId: 'pi-session-1',
            },
        };

        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        });
        await flushRender();

        const add = findPressableByText(tree!, 'Add automation');

        expect(add.props.accessibilityState?.disabled ?? add.props.disabled).toBe(true);
        expect(JSON.stringify(tree!.toJSON())).toContain('This session can’t be resumed');
    });
});
