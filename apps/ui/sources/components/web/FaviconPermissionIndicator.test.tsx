import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';

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

let storageSnapshot: any = null;
const readStorageSnapshot = () => storageSnapshot;

vi.mock('@/sync/domains/state/storage', async () => {
    const React = await import('react');
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const listeners = new Set<() => void>();
    const store = Object.assign(
        ((selector?: (value: any) => unknown) => {
            return React.useSyncExternalStore(
                (listener) => {
                    listeners.add(listener);
                    return () => {
                        listeners.delete(listener);
                    };
                },
                () => (typeof selector === 'function' ? selector(storageSnapshot) : storageSnapshot),
                () => (typeof selector === 'function' ? selector(storageSnapshot) : storageSnapshot),
            );
        }) as any,
        {
            getState: () => storageSnapshot,
            getInitialState: () => storageSnapshot,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    );
    return createStorageModuleStub({
        storage: store,
    } as any);
});

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
    vi.useRealTimers();
    vi.clearAllMocks();
    storageSnapshot = null;
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

beforeEach(async () => {
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(readStorageSnapshot as any);
});

describe('FaviconPermissionIndicator', () => {
    it('does not signal permissions for inactive sessions', async () => {
        setGlobalWindow({});
        setGlobalDocument({});

        storageSnapshot = {
            sessions: {
                s1: {
                    id: 's1',
                    presence: 'online',
                    active: false,
                    agentState: {
                        controlledByUser: null,
                        requests: { req1: { tool: 'Bash', arguments: {}, createdAt: 1 } },
                        completedRequests: null,
                    },
                },
            },
        };

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

        storageSnapshot = {
            sessions: {
                s1: {
                    id: 's1',
                    presence: 'online',
                    active: true,
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                },
            },
            sessionMessages: {
                s1: {
                    messages: [
                        {
                            kind: 'tool-call',
                            id: 'm-tool-1',
                            localId: null,
                            createdAt: 100,
                            children: [],
                            tool: {
                                id: 'req1',
                                name: 'Bash',
                                state: 'running',
                                input: { command: 'ls' },
                                createdAt: 100,
                                permission: {
                                    id: 'req1',
                                    status: 'pending',
                                    kind: 'permission',
                                },
                            },
                        },
                    ],
                },
            },
        };

        const { FaviconPermissionIndicator } = await import('./FaviconPermissionIndicator');
        await renderScreen(<FaviconPermissionIndicator />);

        expect(updateFaviconWithNotification).toHaveBeenCalledTimes(1);
    });

    it('signals an unresolved projected permission after transient runtime freshness expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000_000));
        setGlobalWindow({});
        setGlobalDocument({});

        storageSnapshot = {
            sessions: {
                s1: {
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
                    agentState: {
                        controlledByUser: null,
                        requests: { req1: { tool: 'Bash', arguments: {}, createdAt: 1 } },
                        completedRequests: null,
                    },
                },
            },
            sessionMessages: {},
        };

        const { FaviconPermissionIndicator } = await import('./FaviconPermissionIndicator');
        await renderScreen(<FaviconPermissionIndicator />);

        expect(updateFaviconWithNotification).toHaveBeenCalledTimes(1);
    });

    it('does not reset while a projected permission remains unresolved', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        setGlobalWindow({});
        setGlobalDocument({});

        storageSnapshot = {
            sessions: {
                s1: {
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
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                },
            },
            sessionMessages: {},
        };

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
