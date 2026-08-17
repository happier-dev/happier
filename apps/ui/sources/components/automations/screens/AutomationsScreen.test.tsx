import React from 'react';
import { Platform } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createDeferred,
    findTestInstanceByTypeContainingText,
    flushHookEffects,
    invokeTestInstanceHandler,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function findClosestPressableAncestor(instance: ReactTestInstance): ReactTestInstance | null {
    let current = instance.parent;
    while (current) {
        if (String(current.type) === 'Pressable') return current;
        current = current.parent;
    }
    return null;
}

type AutomationListItem = Readonly<{
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
    trigger: {
        kind: 'schedule';
        schedule: { kind: 'cron' | 'interval'; everyMs: number | null; scheduleExpr: string | null; timezone: string | null };
    };
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

    it('keeps the hydrated automation list visible while the mount refresh is pending', async () => {
        const refresh = createDeferred<void>();
        syncSpies.refreshAutomations.mockImplementationOnce(() => refresh.promise);
        automationsState.list = [
            {
                id: 'a1',
                name: 'Nightly',
                description: null,
                enabled: true,
                trigger: {
                    kind: 'schedule',
                    schedule: { kind: 'interval', everyMs: 900_000, scheduleExpr: null, timezone: null },
                },
                nextRunAt: Date.now() + 60_000,
            },
        ];
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));

        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(1);
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Nightly')).toBeTruthy();

        refresh.resolve();
        await flushHookEffects();
    });

    it('shows an announced retryable error instead of an authoritative empty state after an initial refresh failure', async () => {
        syncSpies.refreshAutomations.mockRejectedValueOnce(new Error('network unavailable'));
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const errorState = screen.findAllByProps({ testID: 'automations-refresh-error' })
            .find((instance) => instance.props.role === 'alert');
        expect(errorState?.props.role).toBe('alert');
        expect(errorState?.props['aria-live']).toBe('assertive');
        expect(screen.findAllByType('SessionGettingStartedGuidance' as any)).toHaveLength(0);

        const retry = screen.findAllByProps({ testID: 'automations-refresh-error-action' })
            .find((instance) => typeof instance.props.onPress === 'function');
        if (!retry) throw new Error('Retry action was not found');
        await act(async () => {
            retry.props.onPress();
            await Promise.resolve();
        });
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(2);
    });

    it('keeps cached automations visible with an announced retry and disables stale mutations after refresh failure', async () => {
        machinesState.list = [{ id: 'm1' }];
        automationsState.list = [
            {
                id: 'a1',
                name: 'Nightly',
                description: null,
                enabled: true,
                trigger: {
                    kind: 'schedule',
                    schedule: { kind: 'interval', everyMs: 900_000, scheduleExpr: null, timezone: null },
                },
                nextRunAt: Date.now() + 60_000,
            },
        ];
        syncSpies.refreshAutomations.mockRejectedValueOnce(new Error('network unavailable'));
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Nightly')).toBeTruthy();
        const errorState = screen.findByProps({ testID: 'automations-stale-refresh-error' });
        expect(errorState.props.accessibilityRole).toBe('alert');
        expect(errorState.props.accessibilityLiveRegion).toBe('assertive');
        expect(screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle' }).props.disabled).toBe(true);
        expect(screen.findByType('Switch' as any).props.disabled).toBe(true);

        await pressTestInstanceAsync(screen.findByProps({ testID: 'automations-stale-refresh-retry' }));
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(2);
    });

    it('keeps list navigation semantic while its controls remain independent', async () => {
        automationsState.list = [
            {
                id: 'a1',
                name: 'Nightly',
                description: null,
                enabled: true,
                trigger: {
                    kind: 'schedule',
                    schedule: { kind: 'interval', everyMs: 900_000, scheduleExpr: null, timezone: null },
                },
                nextRunAt: Date.now() + 60_000,
            },
        ];

        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const runNow = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle' });
        expect(findClosestPressableAncestor(runNow)).toBeNull();

        const toggle = screen.findByType('Switch' as any);
        expect(toggle.props.accessibilityLabel).toContain('Nightly');
        expect(toggle.props.accessibilityLabel).toContain('automations.detail.pauseAutomation');
        invokeTestInstanceHandler(toggle, 'onValueChange', false);
        expect(syncSpies.pauseAutomation).toHaveBeenCalledWith('a1');

        const row = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Nightly');
        expect(row).toBeTruthy();
        expect(row?.props.accessibilityRole).toBe('button');
        expect(typeof row?.props.onPress).toBe('function');
        if (!row) throw new Error('Automation row was not found');
        await act(async () => {
            row.props.onPress();
        });
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalled();
        expect(routerPushSpy).toHaveBeenCalledWith('/automations/a1');
    });

    it('submits each list Run now action once while its request is pending', async () => {
        const runNow = createDeferred<void>();
        syncSpies.runAutomationNow.mockImplementationOnce(() => runNow.promise);
        automationsState.list = [
            {
                id: 'a1',
                name: 'Nightly',
                description: null,
                enabled: true,
                trigger: {
                    kind: 'schedule',
                    schedule: { kind: 'interval', everyMs: 900_000, scheduleExpr: null, timezone: null },
                },
                nextRunAt: Date.now() + 60_000,
            },
        ];
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const runNowButton = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle' });
        await act(async () => {
            runNowButton.props.onPress();
            runNowButton.props.onPress();
            await Promise.resolve();
        });

        expect(syncSpies.runAutomationNow).toHaveBeenCalledTimes(1);
        const pendingRunNowButton = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle' });
        expect(pendingRunNowButton.props.disabled).toBe(true);
        expect(pendingRunNowButton.props.accessibilityState).toEqual(expect.objectContaining({
            disabled: true,
            busy: true,
        }));

        await act(async () => {
            runNow.resolve();
            await runNow.promise;
        });
    });

    it('keeps the list Run now action at the canonical interactive target size', async () => {
        automationsState.list = [
            {
                id: 'a1',
                name: 'Nightly',
                description: null,
                enabled: true,
                trigger: {
                    kind: 'schedule',
                    schedule: { kind: 'interval', everyMs: 900_000, scheduleExpr: null, timezone: null },
                },
                nextRunAt: Date.now() + 60_000,
            },
        ];
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const runNow = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle' });
        const style = flattenStyle(runNow.props.style);
        const minimum = resolveMinimumInteractiveTargetSize(Platform.OS);
        expect(Math.max(Number(style.width ?? 0), Number(style.minWidth ?? 0))).toBeGreaterThanOrEqual(minimum);
        expect(Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0))).toBeGreaterThanOrEqual(minimum);
    });

});
