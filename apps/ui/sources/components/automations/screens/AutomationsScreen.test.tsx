import React from 'react';
import { Platform } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createCapturingLegendListMock,
    createDeferred,
    findTestInstanceByTypeContainingText,
    flushHookEffects,
    invokeTestInstanceHandler,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

const legendListMock = createCapturingLegendListMock({ renderItems: true });

// The canonical list testkit supplies the virtualized list boundary. Mocking
// the app abstraction keeps Vitest from parsing Legend's native distribution.
vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: legendListMock.module.LegendList,
}));

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
    triggers: ReadonlyArray<Readonly<{
        id: string;
        revision: number;
        enabled: boolean;
        createdAt: number;
        updatedAt: number;
        kind: 'schedule';
        schedule: { kind: 'cron' | 'interval'; everyMs: number | null; scheduleExpr: string | null; timezone: string | null };
        nextRunAt: number | null;
    }>>;
}>;

function createScheduleTrigger(input: Readonly<{
    id: string;
    nextRunAt?: number | null;
    everyMs?: number;
    enabled?: boolean;
}>) {
    return {
        id: input.id,
        revision: 1,
        enabled: input.enabled ?? true,
        createdAt: 1,
        updatedAt: 1,
        kind: 'schedule' as const,
        schedule: {
            kind: 'interval' as const,
            everyMs: input.everyMs ?? 900_000,
            scheduleExpr: null,
            timezone: null,
        },
        nextRunAt: input.nextRunAt ?? null,
    };
}

function createAutomationListItem(input: Readonly<{
    id?: string;
    name?: string;
    triggers?: AutomationListItem['triggers'];
}> = {}): AutomationListItem {
    const id = input.id ?? 'a1';
    return {
        id,
        name: input.name ?? 'Nightly',
        description: null,
        enabled: true,
        triggers: input.triggers ?? [createScheduleTrigger({
            id: `${id}-schedule-1`,
            nextRunAt: Date.now() + 60_000,
        })],
    };
}

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
        const { createLiveStorageStoreMock, createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: createLiveStorageStoreMock(() => ({
                profileScope: { serverId: 'server-1', accountId: 'account-1' },
            })),
            useActiveServerAccountScope: () => ({ serverId: 'server-1', accountId: 'account-1' }),
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

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => ({
        scope: { serverId: 'server-1', accountId: 'account-1' },
        isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }),
    }),
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

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                automation: '1',
                draftId: expect.any(String),
            },
        });
    });

    it('keeps the server-owned automation settings reachable before any machine is connected', async () => {
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const settings = screen.findByProps({ testID: 'automations-open-settings' });
        await pressTestInstanceAsync(settings);

        expect(routerPushSpy).toHaveBeenCalledWith('/automations/settings');
    });

    it('keeps the hydrated automation list visible while the mount refresh is pending', async () => {
        const refresh = createDeferred<void>();
        syncSpies.refreshAutomations.mockImplementationOnce(() => refresh.promise);
        automationsState.list = [createAutomationListItem()];
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));

        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(1);
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Nightly')).toBeTruthy();

        refresh.resolve();
        await flushHookEffects();
    });

    it('presents zero and multiple automatic triggers without selecting a primary trigger', async () => {
        machinesState.list = [{ id: 'm1' }];
        automationsState.list = [
            createAutomationListItem({ id: 'on-demand', name: 'On demand', triggers: [] }),
            createAutomationListItem({
                id: 'dual-cadence',
                name: 'Dual cadence',
                triggers: [
                    createScheduleTrigger({ id: 'dual-cadence-schedule-1', everyMs: 300_000 }),
                    createScheduleTrigger({ id: 'dual-cadence-schedule-2', everyMs: 3_600_000 }),
                ],
            }),
        ];
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const rendered = screen.getTextContent();
        expect(rendered).toContain('automations.list.noAutomaticTriggers');
        expect(rendered.match(/automations\.list\.interval/g)).toHaveLength(2);
        expect(screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: On demand' }))
            .toBeTruthy();
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
        automationsState.list = [createAutomationListItem()];
        syncSpies.refreshAutomations.mockRejectedValueOnce(new Error('network unavailable'));
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Nightly')).toBeTruthy();
        const errorState = screen.findByProps({ testID: 'automations-stale-refresh-error' });
        expect(errorState.props.accessibilityRole).toBe('alert');
        expect(errorState.props.accessibilityLiveRegion).toBe('assertive');
        expect(screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Nightly' }).props.disabled)
            .toBe(true);
        expect(screen.findByType('Switch' as any).props.disabled).toBe(true);

        await pressTestInstanceAsync(screen.findByProps({ testID: 'automations-stale-refresh-retry' }));
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(2);
    });

    it('keeps cached-row mutations locked while the authoritative refresh is still pending', async () => {
        machinesState.list = [{ id: 'm1' }];
        automationsState.list = [createAutomationListItem()];
        let releaseRefresh: (() => void) | null = null;
        syncSpies.refreshAutomations.mockImplementationOnce(() => new Promise<void>((resolve) => {
            releaseRefresh = resolve;
        }));
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        // Cached rows stay visible, but no mutation may act on them while the
        // owning read that would make them current is still in flight.
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Nightly')).toBeTruthy();
        expect(screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Nightly' }).props.disabled)
            .toBe(true);
        expect(screen.findByType('Switch' as any).props.disabled).toBe(true);

        await act(async () => {
            releaseRefresh?.();
        });
        await flushHookEffects();
        expect(screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Nightly' }).props.disabled)
            .toBe(false);
        expect(screen.findByType('Switch' as any).props.disabled).toBe(false);
    });

    it('hands a high-cardinality Account list to the canonical virtualized owner in bounded chunks', async () => {
        // This asserts that a high-cardinality catalog does not materialise one
        // group per definition; the virtualized owner decides what is mounted.
        automationsState.list = Array.from({ length: 200 }, (_unused, index) => createAutomationListItem({
            id: `a${index}`,
            name: `Automation ${index}`,
            triggers: [createScheduleTrigger({ id: `a${index}-schedule-1` })],
        }));

        const { AutomationsScreen } = await import('./AutomationsScreen');
        await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const listProps = legendListMock.state.props;
        expect(listProps, 'Expected the Account Automation list to render through the canonical virtualized list.')
            .not.toBeNull();
        const rows = listProps.data as ReadonlyArray<{ kind: string; automations?: readonly unknown[] }>;
        expect(rows.length).toBeGreaterThan(1);
        const total = rows.reduce((sum, row) => sum + (row.automations?.length ?? 0), 0);
        expect(total, 'Every matching Automation must remain reachable; chunking may not truncate the list.')
            .toBe(200);
        const largestChunk = rows.reduce((max, row) => Math.max(max, row.automations?.length ?? 0), 0);
        expect(largestChunk).toBeLessThanOrEqual(8);
    });

    it('keeps list navigation semantic while its controls remain independent', async () => {
        automationsState.list = [createAutomationListItem()];

        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const runNow = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Nightly' });
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
        automationsState.list = [createAutomationListItem()];
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const runNowButton = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Nightly' });
        await act(async () => {
            runNowButton.props.onPress();
            runNowButton.props.onPress();
            await Promise.resolve();
        });

        expect(syncSpies.runAutomationNow).toHaveBeenCalledTimes(1);
        const pendingRunNowButton = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Nightly' });
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
        automationsState.list = [createAutomationListItem()];
        const { AutomationsScreen } = await import('./AutomationsScreen');

        const screen = await renderScreen(React.createElement(AutomationsScreen));
        await flushHookEffects();

        const runNow = screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Nightly' });
        const style = flattenStyle(runNow.props.style);
        const minimum = resolveMinimumInteractiveTargetSize(Platform.OS);
        expect(Math.max(Number(style.width ?? 0), Number(style.minWidth ?? 0))).toBeGreaterThanOrEqual(minimum);
        expect(Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0))).toBeGreaterThanOrEqual(minimum);
    });

});
