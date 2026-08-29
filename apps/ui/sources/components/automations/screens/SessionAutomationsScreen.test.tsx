import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createCapturingLegendListMock,
    createDeferred,
    findTestInstanceByTypeContainingText,
    flushHookEffects,
    pressTestInstance,
    renderScreen,
} from '@/dev/testkit';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';
import type { StorageState } from '@/sync/store/types';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const legendListMock = createCapturingLegendListMock({ renderItems: true });

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: any) => {
        const renderSlot = (slot: any) => {
            if (!slot) return null;
            return React.isValidElement(slot) ? slot : React.createElement(slot);
        };
        return React.createElement(
            React.Fragment,
            null,
            renderSlot(props.ListHeaderComponent),
            React.createElement(legendListMock.module.LegendList, {
                ...props,
                // Render the slots once outside the host test element. Passing
                // each same React element as both a host prop and a child makes
                // react-test-renderer's JSON graph circular and hides the
                // actual Session/Account assertions this suite owns.
                ListHeaderComponent: null,
                ListFooterComponent: null,
            }),
            renderSlot(props.ListFooterComponent),
        );
    },
}));

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
    lastRunAt: number | null;
    targetType: 'newSession' | 'existingSession' | 'executionRun';
    templateVersion: number;
    createdAt: number;
    updatedAt: number;
    assignments: ReadonlyArray<{ machineId: string; enabled: boolean; priority: number }>;
    detail: Readonly<{
        kind: 'unloaded';
        templateVersion: number;
    }> | Readonly<{
        kind: 'available';
        templateVersion: number;
        value: Readonly<{ templateCiphertext: string }>;
    }>;
    existingSessionId: string | null;
    linkedExistingSessionId: string | null;
}>;

function createScheduleDefinition(input: Readonly<{
    id: string;
    name: string;
    targetType: 'newSession' | 'existingSession';
    linkedExistingSessionId?: string | null;
    detail?: 'unloaded' | 'legacy';
    triggers?: AutomationListItem['triggers'];
}>): AutomationListItem {
    const templateVersion = 1;
    const triggers = input.triggers ?? [{
        id: `${input.id}-schedule-1`,
        revision: 1,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        kind: 'schedule' as const,
        schedule: { kind: 'interval' as const, everyMs: 60_000, scheduleExpr: null, timezone: null },
        nextRunAt: null,
    }];
    return {
        id: input.id,
        name: input.name,
        description: null,
        enabled: true,
        triggers,
        lastRunAt: null,
        targetType: input.targetType,
        templateVersion,
        createdAt: 1,
        updatedAt: 1,
        assignments: [],
        detail: input.detail === 'unloaded'
            ? { kind: 'unloaded', templateVersion }
            : { kind: 'available', templateVersion, value: { templateCiphertext: 'template' } },
        existingSessionId: input.linkedExistingSessionId ?? null,
        linkedExistingSessionId: input.linkedExistingSessionId ?? null,
    };
}

const automationsState = vi.hoisted(() => ({
    list: [] as AutomationListItem[],
}));
const sessionState = vi.hoisted(() => ({
    value: null as any,
}));
const storageState = vi.hoisted(() => ({
    value: {} as Partial<StorageState>,
}));
const settingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const activeAccountScopeState = vi.hoisted(() => ({
    value: { serverId: 'server-a', accountId: 'account-a' } as { serverId: string; accountId: string } | null,
}));
const translationCallState = vi.hoisted(() => ({
    keys: [] as string[],
}));
const hydrateReadyState = vi.hoisted(() => ({
    ready: true,
}));

const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    loadMoreAutomations: vi.fn(async () => ({ nextCursor: null })),
    refreshAutomationDefinitionDetail: vi.fn<(automationId: string) => Promise<void>>(
        async (_automationId) => {},
    ),
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

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
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
            useAutomationDefinitionNextCursor: () => null,
            useSession: () => sessionState.value,
            useSettings: () => settingsState.value,
            useActiveServerAccountScope: () => activeAccountScopeState.value,
            storage: Object.assign(
                ((selector?: (value: StorageState) => unknown) => (
                    typeof selector === 'function'
                        ? selector(storageState.value as StorageState)
                        : (storageState.value as StorageState)
                )),
                {
                    getState: () => storageState.value as StorageState,
                    getInitialState: () => storageState.value as StorageState,
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                },
            ),
        });
    },
    text: {
        translate: (key: string) => {
            translationCallState.keys.push(key);
            const labels: Record<string, string> = {
                'automations.session.emptyTitle': 'No automations yet',
                'automations.session.emptyBody': 'Create an automation to trigger work for this session.',
                'automations.session.addAutomation': 'Add automation',
                'automations.session.addEventAutomation': 'Add event automation',
                'common.actions': 'Actions',
                'common.error': 'Error',
                'automations.session.failedToLoad': 'Failed to load automations',
                'automations.list.moreTriggers': '+7 more',
                'sessionInfo.automationsTitle': 'Automations',
                'session.inactiveNotResumableNoticeTitle': 'This session can’t be resumed',
            };
            return labels[key] ?? key;
        },
    },
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => hydrateReadyState.ready
        ? { kind: 'available', sessionId }
        : { kind: 'loading', sessionId, reason: 'store-miss' },
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

function setStorageStateForSession(input: Readonly<{
    session: any;
    machines?: Record<string, unknown>;
    getProjectForSession?: (sessionId: string) => unknown;
}>) {
    const sessionId = String(input.session?.id ?? '');
    storageState.value = {
        sessions: sessionId ? { [sessionId]: input.session } : {},
        machines: (input.machines ?? {}) as StorageState['machines'],
        getProjectForSession: input.getProjectForSession as StorageState['getProjectForSession'] ?? (() => null),
    };
}

describe('SessionAutomationsScreen', () => {
    beforeEach(() => {
        legendListMock.state.reset();
        translationCallState.keys = [];
        automationsState.list = [];
        sessionState.value = {
            id: 's1',
            serverId: 'server-a',
            active: true,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
            },
        };
        settingsState.value = {};
        activeAccountScopeState.value = { serverId: 'server-a', accountId: 'account-a' };
        hydrateReadyState.ready = true;
        setStorageStateForSession({
            session: sessionState.value,
            machines: {
                m1: {
                    id: 'm1',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 's1'
                ? {
                    key: {
                        machineId: 'm1',
                        path: '/tmp/project',
                    },
                }
                : null,
        });
        routerPushSpy.mockReset();
        modalAlertSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.refreshAutomationDefinitionDetail.mockClear();
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
            createScheduleDefinition({
                id: 'a1',
                name: 'Linked',
                targetType: 'existingSession',
                linkedExistingSessionId: 's1',
            }),
            createScheduleDefinition({
                id: 'a2',
                name: 'Other session',
                targetType: 'existingSession',
                linkedExistingSessionId: 's2',
            }),
        ];

        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));

        const json = JSON.stringify(screen.tree.toJSON());
        expect(json).toContain('Linked');
        expect(json).not.toContain('Other session');
    });

    it('keeps linked hydrated automations visible while the mount refresh is pending', async () => {
        const refresh = createDeferred<void>();
        syncSpies.refreshAutomations.mockImplementationOnce(() => refresh.promise);
        automationsState.list = [createScheduleDefinition({
            id: 'a1',
            name: 'Linked',
            targetType: 'existingSession',
            linkedExistingSessionId: 's1',
        })];
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Linked')).toBeTruthy();
        expect(screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Linked' }).props.disabled)
            .toBe(true);
        expect(screen.findByType('Switch' as any).props.disabled).toBe(true);

        await act(async () => {
            refresh.resolve();
            await refresh.promise;
        });
        expect(screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Linked' }).props.disabled)
            .toBe(false);
        expect(screen.findByType('Switch' as any).props.disabled).toBe(false);
    });

    it('partitions private-detail completion by server-account scope', async () => {
        automationsState.list = [createScheduleDefinition({
            id: 'same-id',
            name: 'Account A automation',
            targetType: 'existingSession',
            detail: 'unloaded',
        })];
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushHookEffects();
        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(1);

        activeAccountScopeState.value = { serverId: 'server-a', accountId: 'account-b' };
        automationsState.list = [createScheduleDefinition({
            id: 'same-id',
            name: 'Account B automation',
            targetType: 'existingSession',
            detail: 'unloaded',
        })];
        await screen.update(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushHookEffects();

        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(2);
    });

    it('does not let an Account A private-detail failure retire Account B with the same definition id', async () => {
        syncSpies.refreshAutomationDefinitionDetail.mockRejectedValueOnce(new Error('Account A detail failed'));
        automationsState.list = [createScheduleDefinition({
            id: 'same-id',
            name: 'Account A automation',
            targetType: 'existingSession',
            detail: 'unloaded',
        })];
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushHookEffects();
        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(1);

        activeAccountScopeState.value = { serverId: 'server-a', accountId: 'account-b' };
        automationsState.list = [createScheduleDefinition({
            id: 'same-id',
            name: 'Account B automation',
            targetType: 'existingSession',
            detail: 'unloaded',
        })];
        await screen.update(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushHookEffects();

        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(2);
    });

    it('does not publish an Account A refresh failure into Account B for the same Session id', async () => {
        const accountARefresh = createDeferred<void>();
        syncSpies.refreshAutomations.mockImplementationOnce(() => accountARefresh.promise);
        automationsState.list = [createScheduleDefinition({
            id: 'same-id',
            name: 'Account A automation',
            targetType: 'existingSession',
            linkedExistingSessionId: 's1',
        })];
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        activeAccountScopeState.value = { serverId: 'server-a', accountId: 'account-b' };
        automationsState.list = [createScheduleDefinition({
            id: 'same-id',
            name: 'Account B automation',
            targetType: 'existingSession',
            linkedExistingSessionId: 's1',
        })];
        syncSpies.refreshAutomations.mockResolvedValueOnce();
        await screen.update(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushHookEffects();

        await act(async () => {
            accountARefresh.reject(new Error('late Account A failure'));
            await Promise.resolve();
        });
        expect(screen.findAllByProps({ testID: 'session-automations-stale-refresh-error' })).toHaveLength(0);
    });

    it('does not publish an Account A pause failure after Account B becomes current', async () => {
        const accountAPause = createDeferred<void>();
        syncSpies.pauseAutomation.mockImplementationOnce(() => accountAPause.promise);
        automationsState.list = [createScheduleDefinition({
            id: 'same-id',
            name: 'Account A automation',
            targetType: 'existingSession',
            linkedExistingSessionId: 's1',
        })];
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushHookEffects();
        act(() => {
            screen.findByType('Switch' as any).props.onValueChange(false);
        });
        expect(syncSpies.pauseAutomation).toHaveBeenCalledWith('same-id');

        activeAccountScopeState.value = { serverId: 'server-a', accountId: 'account-b' };
        automationsState.list = [createScheduleDefinition({
            id: 'same-id',
            name: 'Account B automation',
            targetType: 'existingSession',
            linkedExistingSessionId: 's1',
        })];
        await screen.update(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await act(async () => {
            accountAPause.reject(new Error('late Account A failure'));
            await Promise.resolve();
        });

        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('virtualizes a large linked catalog and bounds trigger subtitles without hiding definitions', async () => {
        automationsState.list = Array.from({ length: 200 }, (_unused, index) => createScheduleDefinition({
            id: `a${index}`,
            name: `Automation ${index}`,
            targetType: 'existingSession',
            linkedExistingSessionId: 's1',
            triggers: Array.from({ length: 10 }, (_trigger, triggerIndex) => ({
                id: `a${index}-schedule-${triggerIndex}`,
                revision: 1,
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
                kind: 'schedule' as const,
                schedule: { kind: 'interval' as const, everyMs: 60_000, scheduleExpr: null, timezone: null },
                nextRunAt: null,
            })),
        }));
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await flushHookEffects();

        const listProps = legendListMock.state.props;
        expect(listProps, 'Expected Session Automations to use the canonical virtualized list.').not.toBeNull();
        const rows = listProps.data as ReadonlyArray<{ kind: string; automations?: readonly unknown[] }>;
        expect(rows.reduce((sum, row) => sum + (row.automations?.length ?? 0), 0)).toBe(200);
        expect(rows.reduce((max, row) => Math.max(max, row.automations?.length ?? 0), 0)).toBeLessThanOrEqual(8);

        const firstAutomationRow = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Automation 0');
        expect(firstAutomationRow).toBeTruthy();
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain('+7 more');
    });

    it('shows an announced retryable error instead of a scoped empty state after the initial refresh fails', async () => {
        syncSpies.refreshAutomations.mockRejectedValueOnce(new Error('network unavailable'));
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const errorState = screen.findAllByProps({ testID: 'session-automations-refresh-error' })
            .find((instance) => instance.props.role === 'alert');
        expect(errorState?.props.role).toBe('alert');
        expect(errorState?.props['aria-live']).toBe('assertive');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('No automations yet');

        const retry = screen.findAllByProps({ testID: 'session-automations-refresh-error-action' })
            .find((instance) => typeof instance.props.onPress === 'function');
        if (!retry) throw new Error('Retry action was not found');
        await act(async () => {
            retry.props.onPress();
            await Promise.resolve();
        });
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(2);
    });

    it('keeps linked cached automations visible with an announced retry and disables stale mutations after refresh failure', async () => {
        automationsState.list = [createScheduleDefinition({
            id: 'a1',
            name: 'Linked',
            targetType: 'existingSession',
            linkedExistingSessionId: 's1',
        })];
        syncSpies.refreshAutomations.mockRejectedValueOnce(new Error('network unavailable'));
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Linked')).toBeTruthy();
        const errorState = screen.findByProps({ testID: 'session-automations-stale-refresh-error' });
        expect(errorState.props.accessibilityRole).toBe('alert');
        expect(errorState.props.accessibilityLiveRegion).toBe('assertive');
        expect(screen.findByProps({ accessibilityLabel: 'automations.detail.runNowTitle: Linked' }).props.disabled)
            .toBe(true);
        expect(screen.findByType('Switch' as any).props.disabled).toBe(true);

        await act(async () => {
            pressTestInstance(screen.findByProps({ testID: 'session-automations-stale-refresh-retry' }), 'Retry');
            await Promise.resolve();
        });
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(2);
    });

    it('resolves an unloaded existing-session definition before showing an empty list', async () => {
        let resolveDetail: (() => void) | undefined;
        const pendingDetail = new Promise<void>((resolve) => {
            resolveDetail = resolve;
        });
        syncSpies.refreshAutomationDefinitionDetail.mockImplementationOnce(() => pendingDetail);
        automationsState.list = [createScheduleDefinition({
            id: 'a1',
            name: 'Direct-only link',
            targetType: 'existingSession',
            detail: 'unloaded',
        })];
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await act(async () => {
            await Promise.resolve();
        });

        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledWith('a1');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('No automations yet');

        await act(async () => {
            resolveDetail?.();
            await pendingDetail;
        });
    });

    it('bounds concurrent private detail reads instead of fanning one request out per undisclosed definition', async () => {
        const undisclosedCount = 40;
        let inFlight = 0;
        let peakInFlight = 0;
        const gates: (() => void)[] = [];
        syncSpies.refreshAutomationDefinitionDetail.mockImplementation(async () => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            await new Promise<void>((resolve) => { gates.push(resolve); });
            inFlight -= 1;
        });
        automationsState.list = Array.from({ length: undisclosedCount }, (_unused, index) => (
            createScheduleDefinition({
                id: `u${index}`,
                name: `Undisclosed ${index}`,
                targetType: 'existingSession',
                detail: 'unloaded',
            })
        ));
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await act(async () => {
            await Promise.resolve();
        });

        const limit = loadSyncTuning().automationDefinitionDetailHydrationConcurrencyLimit;
        expect(peakInFlight).toBeLessThanOrEqual(limit);
        expect(peakInFlight).toBeGreaterThan(0);
        expect(syncSpies.refreshAutomationDefinitionDetail.mock.calls.length).toBeLessThanOrEqual(limit);

        // The positive twin. Bounding the fan-out must not silently drop work:
        // without this, a "fix" that simply truncated the queue to `limit`
        // would satisfy every assertion above.
        syncSpies.refreshAutomationDefinitionDetail.mockImplementation(async () => {});
        await act(async () => {
            for (const release of gates.splice(0, gates.length)) release();
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        });
        expect(syncSpies.refreshAutomationDefinitionDetail.mock.calls.length).toBe(undisclosedCount);
    });

    it('keeps a failed private detail read retryable instead of retiring the whole batch', async () => {
        syncSpies.refreshAutomationDefinitionDetail.mockImplementation(async (automationId: string) => {
            if (automationId === 'a1') throw new Error('offline');
        });
        automationsState.list = [
            createScheduleDefinition({
                id: 'a1',
                name: 'First undisclosed',
                targetType: 'existingSession',
                detail: 'unloaded',
            }),
            createScheduleDefinition({
                id: 'a2',
                name: 'Second undisclosed',
                targetType: 'existingSession',
                detail: 'unloaded',
            }),
        ];
        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await act(async () => {
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        });

        // The whole batch is still attempted: one rejection must not starve its peers.
        expect(syncSpies.refreshAutomationDefinitionDetail.mock.calls.map((call) => call[0]).sort())
            .toEqual(['a1', 'a2']);
        expect(screen.findByTestId('session-automations-stale-refresh-retry')).not.toBeNull();

        syncSpies.refreshAutomationDefinitionDetail.mockImplementation(async () => {});
        await screen.pressByTestIdAsync('session-automations-stale-refresh-retry');
        await act(async () => {
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        });

        // Only the failed key is re-admitted; the succeeded one stays retired.
        expect(syncSpies.refreshAutomationDefinitionDetail.mock.calls.slice(2).map((call) => call[0]))
            .toEqual(['a1']);
        expect(screen.findByTestId('session-automations-stale-refresh-retry')).toBeNull();

        // The positive twin: a resolved read must not re-arm the effect forever.
        await act(async () => {
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        });
        expect(syncSpies.refreshAutomationDefinitionDetail.mock.calls.length).toBe(3);
    });

    it('answers the session association without an account-wide private detail fan-out', async () => {
        const accountWideCount = 200;
        automationsState.list = Array.from({ length: accountWideCount }, (_unused, index) => (
            createScheduleDefinition({
                id: `a${index}`,
                name: `Automation ${index}`,
                targetType: 'existingSession',
                detail: 'unloaded',
                linkedExistingSessionId: index === 0 ? 's1' : `s-other-${index}`,
            })
        ));

        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));
        await act(async () => {
            await Promise.resolve();
        });

        // eslint-disable-next-line no-console
        console.log('[measure] private detail requests =', syncSpies.refreshAutomationDefinitionDetail.mock.calls.length, 'for', accountWideCount, 'account automations');
        expect(syncSpies.refreshAutomationDefinitionDetail).not.toHaveBeenCalled();
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Automation 0');
    });

    it('navigates to add automation for the session when the reachable target comes from project state', async () => {
        sessionState.value = {
            id: 's1',
            active: false,
            encryptionMode: 'plain',
            metadata: {
                path: '/tmp/project',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
            },
        };
        setStorageStateForSession({
            session: sessionState.value,
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
                        rootPath: '/tmp/project',
                    },
                }
                : null,
        });

        const { readMachineControlTargetForSession } = await import('@/sync/ops/sessionMachineTarget');
        expect(readMachineControlTargetForSession('s1')).toEqual(expect.objectContaining({ machineId: 'm-target' }));

        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));

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

    it('uses the machine-control target when explaining why a scoped session cannot add automations', async () => {
        sessionState.value = {
            id: 's1',
            active: true,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'claude',
            },
        };
        setStorageStateForSession({
            session: sessionState.value,
            machines: {},
            getProjectForSession: () => null,
        });

        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));

        const add = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Add automation');
        if (!add) {
            throw new Error('Add automation pressable was not found');
        }

        const json = JSON.stringify(screen.tree.toJSON());
        expect(add.props.accessibilityState?.disabled ?? add.props.disabled).toBe(true);
        expect(json).toContain('This session can’t be resumed');
        expect(json).not.toContain('automations.create.missingMachineId');
    });

    it('disables adding an automation when the session is not eligible for existing-session automations', async () => {
        sessionState.value = {
            id: 's1',
            active: true,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'not-a-real-agent',
            },
        };
        setStorageStateForSession({
            session: sessionState.value,
            machines: {
                m1: {
                    id: 'm1',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'mbp-host' },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 's1'
                ? {
                    key: {
                        machineId: 'm1',
                        path: '/tmp/project',
                    },
                }
                : null,
        });

        const { SessionAutomationsScreen } = await import('./SessionAutomationsScreen');

        const screen = await renderScreen(React.createElement(SessionAutomationsScreen, { sessionId: 's1' }));

        const add = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Add automation');
        if (!add) {
            throw new Error('Add automation pressable was not found');
        }

        expect(add.props.accessibilityState?.disabled ?? add.props.disabled).toBe(true);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('This session can’t be resumed');
    });
});
