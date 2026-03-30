import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    findTestInstanceByTypeContainingText,
    flushHookEffects,
    invokeTestInstanceHandler,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

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

const machinesState = vi.hoisted(() => ({
    list: [] as Array<{ id: string }>,
}));

const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    runAutomationNow: vi.fn(async (_id: string) => {}),
    pauseAutomation: vi.fn(async (_id: string) => {}),
    resumeAutomation: vi.fn(async (_id: string) => {}),
    deleteAutomation: vi.fn(async (_id: string) => {}),
}));

const routerPushSpy = vi.hoisted(() => vi.fn());
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

installAutomationScreensCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPushSpy },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalConfirmSpy,
                alert: modalAlertSpy,
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAutomations: () => automationsState.list,
            useAllMachines: () => machinesState.list,
        });
    },
});

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

vi.mock('@/components/ui/buttons/FAB', () => ({
    FAB: (props: any) => React.createElement('FAB', props),
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: (props: any) => React.createElement('SessionGettingStartedGuidance', props),
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

describe('AutomationsScreen', () => {
    beforeEach(() => {
        automationsState.list = [];
        machinesState.list = [];
        routerPushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
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
        machinesState.list = [];
    });

    it('shows machine setup guidance instead of the generic empty state when no machines are connected', async () => {
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(1);
        expect(screen.findAllByType('SessionGettingStartedGuidance' as any)).toHaveLength(1);
        expect(screen.findAllByType('FAB' as any)).toHaveLength(0);
    });

    it('shows generic empty state when machines are connected and links create action to New Session automation mode', async () => {
        machinesState.list = [{ id: 'm1' }];
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(1);
        expect(screen.findAllByType('SessionGettingStartedGuidance' as any)).toHaveLength(0);

        const createButton = screen.findByType('FAB' as any);
        expect(createButton.props.accessibilityLabel).toBe('automations.screen.createAutomationA11y');
        await pressTestInstanceAsync(createButton);

        expect(routerPushSpy).toHaveBeenCalledWith('/new?automation=1');
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

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const runNow = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle' });
        await pressTestInstanceAsync(runNow);
        expect(syncSpies.runAutomationNow).toHaveBeenCalledWith('a1');

        const toggle = screen.findByType('Switch' as any);
        invokeTestInstanceHandler(toggle, 'onValueChange', false);
        expect(syncSpies.pauseAutomation).toHaveBeenCalledWith('a1');

        const card = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Nightly');
        expect(card).toBeTruthy();
        // First press after a control interaction is ignored to prevent accidental navigation.
        await pressTestInstanceAsync(card);
        await pressTestInstanceAsync(card);
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalled();
        expect(routerPushSpy).toHaveBeenCalledWith('/automations/a1');
    });
});
