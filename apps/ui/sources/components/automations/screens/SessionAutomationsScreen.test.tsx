import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';


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

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

installAutomationScreensCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                confirm: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPushSpy },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAutomations: () => automationsState.list,
            useSession: () => sessionState.value,
            useSettings: () => settingsState.value,
            storage: {
                getState: () => getStateSpy(),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                const labels: Record<string, string> = {
                    'automations.session.emptyTitle': 'No automations yet',
                    'automations.session.emptyBody': 'Create an automation to trigger work for this session.',
                    'automations.session.addAutomation': 'Add automation',
                    'common.actions': 'Actions',
                    'common.error': 'Error',
                    'automations.session.failedToLoad': 'Failed to load automations',
                    'sessionInfo.automationsTitle': 'Automations',
                    'session.inactiveNotResumableNoticeTitle': 'This session can’t be resumed',
                };
                return labels[key] ?? key;
            },
        });
    },
});

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

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushRender();

        const json = JSON.stringify(screen.tree.toJSON());
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

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushRender();

        const add = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Add automation');
        if (!add) {
            throw new Error('Add automation pressable was not found');
        }
        expect(add.props.accessibilityState?.disabled ?? add.props.disabled).not.toBe(true);
        await act(async () => {
            pressTestInstance(add, 'Add automation');
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

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushRender();

        const add = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Add automation');
        if (!add) {
            throw new Error('Add automation pressable was not found');
        }

        expect(add.props.accessibilityState?.disabled ?? add.props.disabled).toBe(true);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('This session can’t be resumed');
    });
});
