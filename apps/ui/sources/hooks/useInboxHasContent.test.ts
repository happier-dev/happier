import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { storage } from '@/sync/storageStore';
import { useInboxHasContent } from './useInboxHasContent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockUpdateAvailable = false;
let mockHasUnread = false;

vi.mock('./useUpdates', () => ({
    useUpdates: () => ({
        updateAvailable: mockUpdateAvailable,
        isChecking: false,
        checkForUpdates: async () => {},
        reloadApp: async () => {},
    }),
}));

vi.mock('./useChangelog', () => ({
    useChangelog: () => ({
        hasUnread: mockHasUnread,
        latestVersion: 0,
        markAsRead: () => {},
    }),
}));

const originalDevFlag = (globalThis as any).__DEV__;

describe('useInboxHasContent', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        (globalThis as any).__DEV__ = true;
        mockUpdateAvailable = false;
        mockHasUnread = false;
        storage.setState({ friends: {}, feedItems: [] } as any);
    });

    afterEach(() => {
        if (tree) {
            act(() => {
                tree?.unmount();
            });
            tree = null;
        }
        (globalThis as any).__DEV__ = originalDevFlag;
        storage.setState({ friends: {}, feedItems: [] } as any);
    });

    it('returns true when there are feed items', () => {
        storage.setState({
            friends: {},
            feedItems: [{ id: 'f1' } as any],
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        act(() => {
            tree = renderer.create(React.createElement(Test));
        });

        expect(latest).toBe(true);
    });

    it('returns true when there are pending outgoing friend requests', () => {
        storage.setState({
            friends: {
                u1: { id: 'u1', status: 'requested' },
            },
            feedItems: [],
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        act(() => {
            tree = renderer.create(React.createElement(Test));
        });

        expect(latest).toBe(true);
    });

    it('returns false when there is no actionable content', () => {
        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        act(() => {
            tree = renderer.create(React.createElement(Test));
        });

        expect(latest).toBe(false);
    });

    it('returns true when changelog has unread entries', () => {
        mockHasUnread = true;

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        act(() => {
            tree = renderer.create(React.createElement(Test));
        });

        expect(latest).toBe(true);
    });
});
