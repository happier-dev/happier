import * as React from 'react';
import { AppState } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';

import { createReactNativeAppStateEmitter, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { createSessionListQueryHomeController } from '@/sync/domains/session/listing/sessionListQueryController';
import {
    invalidateSessionListQueryHome,
    subscribeSessionListQueryHomeInvalidation,
} from '@/sync/domains/session/listing/sessionListQueryInvalidation';

import {
    resolveSessionAttentionReminderDeadline,
    resolveSessionAttentionReminderRefreshPlan,
    useSessionAttentionReminderRefresh,
} from './sessionAttentionReminderScheduler';

describe('SessionAttentionReminderRuntime', () => {
    it('refreshes each changed Home list once when several reminders become due together', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const reminders = [
            { address: { serverId: 'home-a', sessionId: 'first' }, remindAt: 2_000 },
            { address: { serverId: 'home-a', sessionId: 'second' }, remindAt: 2_000 },
            { address: { serverId: 'home-a', sessionId: 'same-id' }, remindAt: 2_000 },
            { address: { serverId: 'home-b', sessionId: 'same-id' }, remindAt: 2_000 },
        ];
        const pageReads = new Map<string, number>();
        const query = SessionListQueryV1Schema.parse({
            v: 1, storage: 'active', includeInactive: false, scope: 'my_work',
            attention: 'needs_my_attention', audiences: [], tagIds: [],
        });
        const controllers = new Map(['home-a', 'home-b', 'home-c'].map((serverId) => [
            serverId,
            createSessionListQueryHomeController({
                serverId,
                // The network boundary returns the exact due membership; invalidation
                // and replacement scheduling use the real production owners.
                fetchPage: async () => {
                    pageReads.set(serverId, (pageReads.get(serverId) ?? 0) + 1);
                    return {
                        sessionIds: reminders.filter((reminder) => (
                            reminder.address.serverId === serverId && reminder.remindAt <= Date.now()
                        )).map((reminder) => reminder.address.sessionId),
                        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                        current: true, source: 'v2' as const,
                    };
                },
            }),
        ] as const));
        const unsubscribe = subscribeSessionListQueryHomeInvalidation(() => controllers);
        let connectedByServerId: Readonly<Record<string, boolean>> = {
            'home-a': true, 'home-b': true, 'home-c': true,
        };
        const refreshed: SessionAddress[] = [];
        const refreshSession = async (address: SessionAddress) => {
            refreshed.push(address);
            return { kind: 'available' as const, sessionId: address.sessionId };
        };
        const refreshReminderInventory = async () => ({ kind: 'loaded' as const });

        try {
            await Promise.all([...controllers.values()].map((controller) => controller.update({
                query, selected: true, online: true, supported: true,
            })));
            pageReads.clear();
            const hook = await renderHook(() => useSessionAttentionReminderRefresh({
                connectedByServerId, invalidateSessionListQueryHome, refreshReminderInventory,
                refreshSession, reminders,
            }));
            expect(pageReads.size).toBe(0);

            await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

            expect(refreshed).toEqual(reminders.map((reminder) => reminder.address));
            expect(controllers.get('home-a')?.getSnapshot().addresses.map((address) => address.sessionId))
                .toEqual(['first', 'second', 'same-id']);
            expect(controllers.get('home-b')?.getSnapshot().addresses)
                .toEqual([{ serverId: 'home-b', sessionId: 'same-id' }]);
            expect(Object.fromEntries(pageReads)).toEqual({ 'home-a': 1, 'home-b': 1 });

            connectedByServerId = { ...connectedByServerId };
            await hook.rerender();
            expect(refreshed).toHaveLength(reminders.length);
            expect(Object.fromEntries(pageReads)).toEqual({ 'home-a': 1, 'home-b': 1 });
        } finally {
            unsubscribe();
            for (const controller of controllers.values()) controller.dispose();
        }
    });

    it('leaves retryable hydration eligible on the next owner wake without polling or repeating successful hydration', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        let hydrated = false;
        let attempts = 0;
        const hook = await renderHook(() => useSessionAttentionReminderRefresh({
            connectedByServerId: { 'home-a': true },
            invalidateSessionListQueryHome: async () => undefined,
            refreshReminderInventory: async () => ({ kind: 'retryable_failure' as const }),
            refreshSession: async () => {
                attempts += 1;
                if (attempts === 1) return { kind: 'retryable_failure' as const, sessionId: 's1', cause: 'network' as const };
                hydrated = true;
                return { kind: 'available' as const, sessionId: 's1' };
            },
            reminders: [{ address: { serverId: 'home-a', sessionId: 's1' }, remindAt: 1_000 }],
        }));
        expect(hydrated).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(attempts).toBe(1);
        await hook.rerender();
        expect(hydrated).toBe(true);
        await hook.rerender();
        expect(attempts).toBe(2);
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('schedules a persisted reminder independently of durable attention standing', () => {
        expect(resolveSessionAttentionReminderDeadline('home-a', {
            sessionId: 'session-a',
            standing: false,
            remindAt: 2_000,
            updatedAt: 1,
        })).toEqual({
            address: { serverId: 'home-a', sessionId: 'session-a' },
            remindAt: 2_000,
        });
    });

    it('selects every due qualified Session and only the nearest future deadline', () => {
        expect(resolveSessionAttentionReminderRefreshPlan({
            nowMs: 2_000,
            reminders: [
                { address: { serverId: 'home-b', sessionId: 'same-session' }, remindAt: 2_000 },
                { address: { serverId: 'home-a', sessionId: 'same-session' }, remindAt: 2_500 },
                { address: { serverId: 'home-c', sessionId: 'later-session' }, remindAt: 4_000 },
            ],
        })).toEqual({
            due: [{ address: { serverId: 'home-b', sessionId: 'same-session' }, remindAt: 2_000 }],
            nextDeadlineAt: 2_500,
        });
    });

    it('wakes at the nearest deadline and refreshes the exact Home-qualified Session', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const refreshSession = vi.fn(async (address: SessionAddress) => ({ kind: 'available' as const, ...address }));
        const invalidateSessionListQueryHome = vi.fn(async (_serverId: string) => undefined);

        await renderHook(() => useSessionAttentionReminderRefresh({
            connectedByServerId: { 'home-a': true, 'home-b': true },
            invalidateSessionListQueryHome,
            refreshReminderInventory: async () => ({ kind: 'loaded' as const }),
            refreshSession,
            reminders: [
                { address: { serverId: 'home-a', sessionId: 'same-session' }, remindAt: 3_000 },
                { address: { serverId: 'home-b', sessionId: 'same-session' }, remindAt: 2_000 },
            ],
        }));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(999);
        });
        expect(refreshSession).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(refreshSession).toHaveBeenCalledWith({ serverId: 'home-b', sessionId: 'same-session' });
        expect(refreshSession).not.toHaveBeenCalledWith({ serverId: 'home-a', sessionId: 'same-session' });
        expect(invalidateSessionListQueryHome).toHaveBeenCalledWith('home-b');
        expect(invalidateSessionListQueryHome).not.toHaveBeenCalledWith('home-a');
    });

    it('retries a due reminder when its Home reconnects and when the app returns to foreground', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        const appState = createReactNativeAppStateEmitter('active');
        const restoreAppState = appState.install(AppState);
        const refreshSession = vi.fn(async (address: SessionAddress) => ({ kind: 'available' as const, ...address }));
        let connectedByServerId: Readonly<Record<string, boolean>> = { 'home-a': false };

        try {
            const hook = await renderHook(() => useSessionAttentionReminderRefresh({
                connectedByServerId,
                invalidateSessionListQueryHome: async () => undefined,
                refreshReminderInventory: async () => ({ kind: 'loaded' as const }),
                refreshSession,
                reminders: [{ address: { serverId: 'home-a', sessionId: 'session-a' }, remindAt: 1_000 }],
            }));

            expect(refreshSession).not.toHaveBeenCalled();

            connectedByServerId = { 'home-a': true };
            await hook.rerender();
            expect(refreshSession).toHaveBeenCalledTimes(1);

            connectedByServerId = { 'home-a': false };
            await hook.rerender();
            connectedByServerId = { 'home-a': true };
            await hook.rerender();
            expect(refreshSession).toHaveBeenCalledTimes(2);

            await act(async () => {
                appState.emit('background');
                appState.emit('active');
                await Promise.resolve();
            });
            expect(refreshSession).toHaveBeenCalledTimes(3);
        } finally {
            restoreAppState();
        }
    });

    it('loads reminder inventories for all known Homes on mount, retries on reconnect, and on foreground re-reads only Homes without a live connection', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        const appState = createReactNativeAppStateEmitter('active');
        const restoreAppState = appState.install(AppState);
        const refreshReminderInventory = vi.fn(async (_serverId: string) => ({ kind: 'loaded' as const }));
        let connectedByServerId: Readonly<Record<string, boolean>> = {
            'home-a': true,
            'home-b': false,
        };

        try {
            const hook = await renderHook(() => useSessionAttentionReminderRefresh({
                connectedByServerId,
                invalidateSessionListQueryHome: async () => undefined,
                refreshReminderInventory,
                refreshSession: async (address) => ({ kind: 'available', ...address }),
                reminders: [],
            }));

            await act(async () => Promise.resolve());
            expect(refreshReminderInventory).toHaveBeenCalledTimes(2);
            expect(refreshReminderInventory).toHaveBeenCalledWith('home-a');
            expect(refreshReminderInventory).toHaveBeenCalledWith('home-b');

            connectedByServerId = { 'home-a': true, 'home-b': true };
            await hook.rerender();
            await act(async () => Promise.resolve());
            expect(refreshReminderInventory).toHaveBeenCalledTimes(3);
            expect(refreshReminderInventory).toHaveBeenLastCalledWith('home-b');

            // Both Homes stayed connected while away: their organization changes arrived on the socket.
            await act(async () => {
                appState.emit('background');
                appState.emit('active');
                await Promise.resolve();
            });
            expect(refreshReminderInventory).toHaveBeenCalledTimes(3);

            // A Home with no live connection has no push path, so foreground is its refresh point.
            connectedByServerId = { 'home-a': true, 'home-b': false };
            await hook.rerender();
            await act(async () => Promise.resolve());
            expect(refreshReminderInventory).toHaveBeenCalledTimes(4);
            await act(async () => {
                appState.emit('background');
                appState.emit('active');
                await Promise.resolve();
            });
            expect(refreshReminderInventory).toHaveBeenCalledTimes(5);
            expect(refreshReminderInventory).toHaveBeenLastCalledWith('home-b');
        } finally {
            restoreAppState();
        }
    });

    it('does not mark an inventory refresh loaded when the credential is unavailable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        const refreshReminderInventory = vi.fn(async () => ({ kind: 'retryable_failure' as const }));
        const appState = createReactNativeAppStateEmitter('active');
        const restoreAppState = appState.install(AppState);

        try {
            const hook = await renderHook(() => useSessionAttentionReminderRefresh({
                connectedByServerId: { 'home-a': true },
                invalidateSessionListQueryHome: async () => undefined,
                refreshReminderInventory,
                refreshSession: async (address) => ({ kind: 'available', ...address }),
                reminders: [],
            }));

            await act(async () => Promise.resolve());
            expect(refreshReminderInventory).toHaveBeenCalledTimes(1);

            await hook.rerender();
            await act(async () => Promise.resolve());
            expect(refreshReminderInventory).toHaveBeenCalledTimes(2);

            await act(async () => {
                appState.emit('background');
                appState.emit('active');
                await Promise.resolve();
            });
            expect(refreshReminderInventory).toHaveBeenCalledTimes(3);
        } finally {
            restoreAppState();
        }
    });

    it('cancels a scheduled wake when the persisted reminder is cleared', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const refreshSession = vi.fn(async (address: SessionAddress) => ({ kind: 'available' as const, ...address }));
        const invalidateSessionListQueryHome = vi.fn(async (_serverId: string) => undefined);
        let reminders = [{ address: { serverId: 'home-a', sessionId: 'session-a' }, remindAt: 2_000 }];
        const hook = await renderHook(() => useSessionAttentionReminderRefresh({
            connectedByServerId: { 'home-a': true },
            invalidateSessionListQueryHome,
            refreshReminderInventory: async () => ({ kind: 'loaded' as const }),
            refreshSession,
            reminders,
        }));

        reminders = [];
        await hook.rerender();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(invalidateSessionListQueryHome).not.toHaveBeenCalled();
        expect(refreshSession).not.toHaveBeenCalled();
    });

    it('tracks delimiter-bearing Home and Session pairs independently across reconnect', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        const first = { serverId: 'https://home.example/a', sessionId: 'b:c' };
        const second = { serverId: 'https://home.example/a:b', sessionId: 'c' };
        const refreshSession = vi.fn(async (address: SessionAddress) => ({ kind: 'available' as const, ...address }));
        let connectedByServerId: Readonly<Record<string, boolean>> = {
            [first.serverId]: true,
            [second.serverId]: true,
        };
        const reminders = [
            { address: first, remindAt: 1_000 },
            { address: second, remindAt: 1_000 },
        ];

        const hook = await renderHook(() => useSessionAttentionReminderRefresh({
            connectedByServerId,
            invalidateSessionListQueryHome: async () => undefined,
            refreshReminderInventory: async () => ({ kind: 'loaded' as const }),
            refreshSession,
            reminders,
        }));
        await act(async () => Promise.resolve());
        expect(refreshSession).toHaveBeenCalledTimes(2);

        connectedByServerId = { [first.serverId]: false, [second.serverId]: true };
        await hook.rerender();
        connectedByServerId = { [first.serverId]: true, [second.serverId]: true };
        await hook.rerender();
        await act(async () => Promise.resolve());

        expect(refreshSession).toHaveBeenCalledTimes(3);
        expect(refreshSession.mock.calls.filter(([address]) => address.serverId === first.serverId)).toHaveLength(2);
        expect(refreshSession.mock.calls.filter(([address]) => address.serverId === second.serverId)).toHaveLength(1);
    });
});
