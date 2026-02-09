import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { select: (value: any) => value?.default ?? null },
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

describe('GitOperationsPanel', () => {
    it('shows which session currently owns the in-flight operation lock', async () => {
        const { GitOperationsPanel } = await import('./GitOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitOperationsPanel
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    gitOperationBusy={false}
                    hasGlobalOperationInFlight
                    inFlightGitOperation={{
                        id: 'lock-1',
                        startedAt: Date.now(),
                        sessionId: 'session-xyz987',
                        operation: 'push',
                    }}
                    gitOperationStatus={null}
                    commitAllowed
                    commitBlockedMessage={null}
                    pullAllowed
                    pullBlockedMessage={null}
                    pushAllowed
                    pushBlockedMessage={null}
                    onCreateCommit={vi.fn()}
                    onFetch={vi.fn()}
                    onPull={vi.fn()}
                    onPush={vi.fn()}
                    historyLoading={false}
                    historyEntries={[]}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                    operationLog={[]}
                />
            );
        });

        const textContent = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });

        expect(textContent.some((text) => text.includes('Running: push'))).toBe(true);
        expect(textContent.some((text) => text.includes('session sessio'))).toBe(true);
    });

    it('renders operation buttons and invokes callbacks', async () => {
        const { GitOperationsPanel } = await import('./GitOperationsPanel');
        const onFetch = vi.fn();
        const onPull = vi.fn();
        const onPush = vi.fn();
        const onCreateCommit = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitOperationsPanel
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    gitOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightGitOperation={null}
                    gitOperationStatus="Fetching from origin/main…"
                    commitAllowed
                    commitBlockedMessage={null}
                    pullAllowed
                    pullBlockedMessage={null}
                    pushAllowed
                    pushBlockedMessage={null}
                    onCreateCommit={onCreateCommit}
                    onFetch={onFetch}
                    onPull={onPull}
                    onPush={onPush}
                    historyLoading={false}
                    historyEntries={[]}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                    operationLog={[]}
                />
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        expect(pressables.length).toBeGreaterThanOrEqual(4);

        act(() => {
            pressables[0]!.props.onPress();
            pressables[1]!.props.onPress();
            pressables[2]!.props.onPress();
            pressables[3]!.props.onPress();
        });

        expect(onCreateCommit).toHaveBeenCalledTimes(1);
        expect(onFetch).toHaveBeenCalledTimes(1);
        expect(onPull).toHaveBeenCalledTimes(1);
        expect(onPush).toHaveBeenCalledTimes(1);
    });

    it('renders disabled operation hints when preflight blocks actions', async () => {
        const { GitOperationsPanel } = await import('./GitOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitOperationsPanel
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    gitOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightGitOperation={null}
                    gitOperationStatus={null}
                    commitAllowed={false}
                    commitBlockedMessage="Stage at least one file before committing."
                    pullAllowed={false}
                    pullBlockedMessage="Remote operations are unavailable while HEAD is detached."
                    pushAllowed={false}
                    pushBlockedMessage="Pull remote changes before pushing local commits."
                    onCreateCommit={vi.fn()}
                    onFetch={vi.fn()}
                    onPull={vi.fn()}
                    onPush={vi.fn()}
                    historyLoading={false}
                    historyEntries={[]}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                    operationLog={[]}
                />
            );
        });

        const textContent = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });
        const hasCommitHint = textContent.some((text) =>
            text.includes('Commit blocked: Stage at least one file before committing.')
        );
        const hasPullHint = textContent.some((text) =>
            text.includes('Pull blocked: Remote operations are unavailable while HEAD is detached.')
        );
        const hasPushHint = textContent.some((text) =>
            text.includes('Push blocked: Pull remote changes before pushing local commits.')
        );

        expect(hasCommitHint).toBe(true);
        expect(hasPullHint).toBe(true);
        expect(hasPushHint).toBe(true);
    });

    it('labels operation log entries with current vs other session origin', async () => {
        const { GitOperationsPanel } = await import('./GitOperationsPanel');
        const now = Date.now();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitOperationsPanel
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    gitOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightGitOperation={null}
                    gitOperationStatus={null}
                    commitAllowed
                    commitBlockedMessage={null}
                    pullAllowed
                    pullBlockedMessage={null}
                    pushAllowed
                    pushBlockedMessage={null}
                    onCreateCommit={vi.fn()}
                    onFetch={vi.fn()}
                    onPull={vi.fn()}
                    onPush={vi.fn()}
                    historyLoading={false}
                    historyEntries={[]}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                    operationLog={[
                        {
                            id: 'op-1',
                            sessionId: 'session-1',
                            operation: 'commit',
                            status: 'success',
                            timestamp: now,
                        },
                        {
                            id: 'op-2',
                            sessionId: 'session-abc12345',
                            operation: 'push',
                            status: 'failed',
                            timestamp: now,
                        },
                    ]}
                />
            );
        });

        const textContent = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });

        expect(textContent.some((text) => text.includes('this session'))).toBe(true);
        expect(textContent.some((text) => text.includes('session sessio'))).toBe(true);
    });

    it('shows a lock warning when another session owns the in-flight git operation', async () => {
        const { GitOperationsPanel } = await import('./GitOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitOperationsPanel
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-current"
                    hasConflicts={false}
                    gitOperationBusy={false}
                    hasGlobalOperationInFlight
                    inFlightGitOperation={{
                        id: 'op-1',
                        startedAt: Date.now(),
                        sessionId: 'session-abcdef',
                        operation: 'fetch',
                    }}
                    gitOperationStatus={null}
                    commitAllowed
                    commitBlockedMessage={null}
                    pullAllowed
                    pullBlockedMessage={null}
                    pushAllowed
                    pushBlockedMessage={null}
                    onCreateCommit={vi.fn()}
                    onFetch={vi.fn()}
                    onPull={vi.fn()}
                    onPush={vi.fn()}
                    historyLoading={false}
                    historyEntries={[]}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                    operationLog={[]}
                />
            );
        });

        const textContent = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });

        expect(textContent.some((text) => text.includes('locked by'))).toBe(true);
    });

    it('allows filtering operation log to this session only', async () => {
        const { GitOperationsPanel } = await import('./GitOperationsPanel');
        const now = Date.now();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitOperationsPanel
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    gitOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightGitOperation={null}
                    gitOperationStatus={null}
                    commitAllowed
                    commitBlockedMessage={null}
                    pullAllowed
                    pullBlockedMessage={null}
                    pushAllowed
                    pushBlockedMessage={null}
                    onCreateCommit={vi.fn()}
                    onFetch={vi.fn()}
                    onPull={vi.fn()}
                    onPush={vi.fn()}
                    historyLoading={false}
                    historyEntries={[]}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                    operationLog={[
                        {
                            id: 'op-1',
                            sessionId: 'session-1',
                            operation: 'commit',
                            status: 'success',
                            timestamp: now,
                        },
                        {
                            id: 'op-2',
                            sessionId: 'session-abcdef',
                            operation: 'push',
                            status: 'failed',
                            timestamp: now,
                        },
                    ]}
                />
            );
        });

        const beforeFilter = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });
        expect(beforeFilter.some((text) => text.includes('this session'))).toBe(true);
        expect(beforeFilter.some((text) => text.includes('session sessio'))).toBe(true);

        const pressables = tree!.root.findAllByType('Pressable' as any);
        const thisSessionFilter = pressables.find((node) => {
            const children = node.props.children;
            if (!children || typeof children !== 'object') return false;
            const label = (children as any).props?.children;
            return label === 'This session';
        });
        expect(thisSessionFilter).toBeTruthy();

        act(() => {
            thisSessionFilter!.props.onPress();
        });

        const afterFilter = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });

        expect(afterFilter.some((text) => text.includes('this session'))).toBe(true);
        expect(afterFilter.some((text) => text.includes('session sessio'))).toBe(false);
    });

    it('shows an empty-state message when this-session filter has no entries', async () => {
        const { GitOperationsPanel } = await import('./GitOperationsPanel');
        const now = Date.now();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitOperationsPanel
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f', surface: '#000', surfaceHigh: '#222' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    gitOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightGitOperation={null}
                    gitOperationStatus={null}
                    commitAllowed
                    commitBlockedMessage={null}
                    pullAllowed
                    pullBlockedMessage={null}
                    pushAllowed
                    pushBlockedMessage={null}
                    onCreateCommit={vi.fn()}
                    onFetch={vi.fn()}
                    onPull={vi.fn()}
                    onPush={vi.fn()}
                    historyLoading={false}
                    historyEntries={[]}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                    operationLog={[
                        {
                            id: 'op-2',
                            sessionId: 'session-abcdef',
                            operation: 'push',
                            status: 'failed',
                            timestamp: now,
                        },
                    ]}
                />
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        const thisSessionFilter = pressables.find((node) => {
            const children = node.props.children;
            if (!children || typeof children !== 'object') return false;
            const label = (children as any).props?.children;
            return label === 'This session';
        });
        expect(thisSessionFilter).toBeTruthy();
        act(() => {
            thisSessionFilter!.props.onPress();
        });

        const textContent = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });

        expect(textContent.some((text) => text.includes('No recent operations for this session.'))).toBe(true);
    });
});
