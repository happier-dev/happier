import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';
import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    OS: 'web',
                    select: (value: any) => value?.web ?? value?.default ?? value?.ios ?? null,
                },
            }
    );
});

const updateFaviconWithNotification = vi.fn();
const resetFavicon = vi.fn();

vi.mock('@/utils/web/faviconGenerator', () => ({
    updateFaviconWithNotification: (...args: any[]) => updateFaviconWithNotification(...args),
    resetFavicon: (...args: any[]) => resetFavicon(...args),
}));

const storage = getStorage();
const initialStorageState = storage.getState();

function seedStorage(state: Pick<StorageState, 'sessions'> & Partial<Pick<StorageState, 'sessionMessages'>>): void {
    storage.setState({ sessions: state.sessions, sessionMessages: state.sessionMessages ?? {} });
}

function createPermissionViewer(): NonNullable<Session['viewer']> {
    return {
        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
        relevance: { relevant: true, reasons: ['followed_by_me'] },
        follow: { follows: true, notificationLevel: 'none' },
        notification: { level: 'none', source: 'preference' },
        attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' },
    };
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

function setGlobalWindow(value: any): void {
    Object.defineProperty(globalThis, 'window', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

function setGlobalDocument(value: any): void {
    Object.defineProperty(globalThis, 'document', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    storage.setState(initialStorageState, true);
    if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).window;
    }

    if (originalDocumentDescriptor) {
        Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).document;
    }
});

beforeEach(() => {
    storage.setState(initialStorageState, true);
});

describe('FaviconPermissionIndicator', () => {
    it('does not signal permissions for inactive sessions', async () => {
        setGlobalWindow({});
        setGlobalDocument({});

        seedStorage({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    presence: 'online',
                    active: false,
                    agentState: {
                        controlledByUser: null,
                        requests: { req1: { tool: 'Bash', arguments: {}, createdAt: 1 } },
                        completedRequests: null,
                    },
                }),
            },
        });

        const { FaviconPermissionIndicator } = await import('./FaviconPermissionIndicator');
        await renderScreen(<FaviconPermissionIndicator />);

        expect(updateFaviconWithNotification).not.toHaveBeenCalled();
        expect(resetFavicon).toHaveBeenCalled();
    });

    it('signals permissions from hydrated pending transcript state for active sessions', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        setGlobalWindow({});
        setGlobalDocument({});

        const permissionMessage = createToolCallMessageFixture({
            id: 'm-tool-1', createdAt: 100,
            tool: {
                id: 'req1', name: 'Bash', state: 'running', input: { command: 'ls' },
                createdAt: 100, startedAt: 100, completedAt: null, description: null,
                permission: { id: 'req1', status: 'pending', kind: 'permission' },
            },
        });
        seedStorage({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    presence: 'online',
                    active: true,
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                }),
            },
            sessionMessages: {
                s1: createSessionMessagesFixture({
                    isLoaded: true,
                    messageIdsOldestFirst: [permissionMessage.id],
                    messagesById: { [permissionMessage.id]: permissionMessage },
                }),
            },
        });

        const { FaviconPermissionIndicator } = await import('./FaviconPermissionIndicator');
        await renderScreen(<FaviconPermissionIndicator />);

        expect(updateFaviconWithNotification).toHaveBeenCalledTimes(1);
    });

    it('signals an unresolved projected permission after transient runtime freshness expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000_000));
        setGlobalWindow({});
        setGlobalDocument({});

        seedStorage({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    presence: 'online',
                    active: true,
                    activeAt: 0,
                    thinking: false,
                    thinkingAt: 0,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    pendingRequestObservedAt: 1,
                    viewer: createPermissionViewer(),
                    agentState: {
                        controlledByUser: null,
                        requests: { req1: { tool: 'Bash', arguments: {}, createdAt: 1 } },
                        completedRequests: null,
                    },
                }),
            },
            sessionMessages: {},
        });

        const { FaviconPermissionIndicator } = await import('./FaviconPermissionIndicator');
        await renderScreen(<FaviconPermissionIndicator />);

        expect(updateFaviconWithNotification).toHaveBeenCalledTimes(1);
    });

    it('does not reset while a projected permission remains unresolved', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        setGlobalWindow({});
        setGlobalDocument({});

        seedStorage({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    presence: 'online',
                    active: true,
                    activeAt: 1_000,
                    thinking: false,
                    thinkingAt: 0,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    pendingRequestObservedAt: 1_000,
                    viewer: createPermissionViewer(),
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                }),
            },
            sessionMessages: {},
        });

        const { FaviconPermissionIndicator } = await import('./FaviconPermissionIndicator');
        await renderScreen(<FaviconPermissionIndicator />);
        expect(updateFaviconWithNotification).toHaveBeenCalledTimes(1);
        resetFavicon.mockClear();

        await act(async () => {
            vi.setSystemTime(new Date(1_000 + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1));
            await vi.advanceTimersByTimeAsync(SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1);
        });

        expect(resetFavicon).not.toHaveBeenCalled();
    });
});
