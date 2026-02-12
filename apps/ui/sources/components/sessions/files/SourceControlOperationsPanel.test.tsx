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

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

describe('SourceControlOperationsPanel', () => {
    it('shows selected commit scope count and clear action', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const onClearCommitSelection = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f', surfaceHigh: '#222', surface: '#111' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
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
                    commitSelectionCount={2}
                    onClearCommitSelection={onClearCommitSelection}
                />
            );
        });

        const textContent = tree!.root.findAllByType('Text' as any).map((node) => {
            const value = node.props.children;
            if (Array.isArray(value)) {
                return value.join('');
            }
            return String(value);
        });
        expect(textContent.some((text) => text.includes('files selected for the next commit'))).toBe(true);

        const clearButton = tree!.root
            .findAllByType('Pressable' as any)
            .find((pressable) =>
                pressable.findAllByType('Text' as any).some((textNode) => textNode.props.children === 'Clear')
            );
        expect(clearButton).toBeTruthy();

        act(() => {
            clearButton!.props.onPress();
        });
        expect(onClearCommitSelection).toHaveBeenCalledTimes(1);
    });

    it('shows which session currently owns the in-flight operation lock', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight
                    inFlightScmOperation={{
                        id: 'lock-1',
                        startedAt: Date.now(),
                        sessionId: 'session-xyz987',
                        operation: 'push',
                    }}
                    scmOperationStatus={null}
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
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const onFetch = vi.fn();
        const onPull = vi.fn();
        const onPush = vi.fn();
        const onCreateCommit = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus="Fetching from origin/main…"
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

    it('hides write action buttons when capabilities are missing', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Unknown"
                    commitActionLabel="Commit"
                    capabilities={null}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
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

        expect(tree!.root.findAllByType('Pressable' as any).length).toBe(0);
    });

    it('renders conflict messaging that does not imply include/exclude actions are disabled', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
                    commitAllowed={false}
                    commitBlockedMessage="Resolve conflicts before committing."
                    pullAllowed={false}
                    pullBlockedMessage="Resolve conflicts before pulling."
                    pushAllowed={false}
                    pushBlockedMessage="Resolve conflicts before pushing."
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

        expect(textContent.some((text) => text.includes('Commit, pull, and push are blocked until conflicts are resolved.'))).toBe(true);
    });

    it('renders disabled operation hints when preflight blocks actions', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
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
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const now = Date.now();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
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
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-current"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight
                    inFlightScmOperation={{
                        id: 'op-1',
                        startedAt: Date.now(),
                        sessionId: 'session-abcdef',
                        operation: 'fetch',
                    }}
                    scmOperationStatus={null}
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

    it('shows a global lock hint when another session has a git operation in flight', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f', surface: '#000', surfaceHigh: '#222' } }}
                    currentSessionId="session-current"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight
                    inFlightScmOperation={{
                        id: 'op-lock',
                        startedAt: Date.now(),
                        sessionId: 'session-other',
                        operation: 'pull',
                    }}
                    scmOperationStatus={null}
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

        expect(
            textContent.some((text) =>
                text.includes('Operations are temporarily locked because another session is running a source control command.')
            )
        ).toBe(true);
    });

    it('allows filtering operation log to this session only', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const now = Date.now();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
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
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const now = Date.now();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f', surface: '#000', surfaceHigh: '#222' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
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

    it('renders recent git operations newest-first', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const now = Date.now();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f', surface: '#000', surfaceHigh: '#222' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
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
                            id: 'older',
                            sessionId: 'session-1',
                            operation: 'fetch',
                            status: 'success',
                            timestamp: now - 1_000,
                        },
                        {
                            id: 'newer',
                            sessionId: 'session-1',
                            operation: 'push',
                            status: 'success',
                            timestamp: now,
                        },
                    ]}
                />
            );
        });

        const operationTitles = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) return value.join('');
                return String(value);
            })
            .filter((text) => text.includes('· this session'));

        expect(operationTitles[0]).toContain('push');
        expect(operationTitles[1]).toContain('fetch');
    });

    it('renders source control heading and backend badge', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Sapling"
                    commitActionLabel="Commit changes"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa', warning: '#f90', textDestructive: '#f00', success: '#0a0', input: { background: '#111' }, textLink: '#09f', surface: '#000', surfaceHigh: '#222' } }}
                    currentSessionId="session-1"
                    hasConflicts={false}
                    scmOperationBusy={false}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    scmOperationStatus={null}
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
                if (Array.isArray(value)) return value.join('');
                return String(value);
            });

        expect(textContent.some((text) => text.includes('Source control'))).toBe(true);
        expect(textContent.some((text) => text.includes('SAPLING'))).toBe(true);
    });
});
