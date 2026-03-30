import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const store = Object.assign(
        ((selector?: (value: any) => unknown) => (typeof selector === 'function' ? selector(storageSnapshot) : storageSnapshot)) as any,
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
});
