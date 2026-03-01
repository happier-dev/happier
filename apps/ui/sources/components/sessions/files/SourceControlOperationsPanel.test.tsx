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

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: any) => {
        if (key === 'files.sourceControlOperations.title') return 'Source control';
        if (key === 'files.sourceControlOperations.actorThisSession') return 'this session';
        if (key === 'files.sourceControlOperations.actorSession') return `session ${params?.sessionIdPrefix ?? ''}`;
        if (key === 'files.sourceControlOperations.running')
            return `Running: ${params?.operation ?? ''} · ${params?.actor ?? ''}`;
        if (key === 'files.sourceControlOperations.lockedBy')
            return `Source control operations are locked by ${params?.actor ?? ''}.`;
        if (key === 'files.sourceControlOperations.globalLock')
            return 'Operations are temporarily locked because another session is running a source control command.';
        if (key === 'files.sourceControlOperations.selection') {
            const count = Number(params?.count ?? 0);
            return count === 1 ? '1 file selected for the next commit.' : `${count} files selected for the next commit.`;
        }
        if (key === 'files.sourceControlOperations.clear') return 'Clear';
        if (key === 'files.sourceControlOperations.conflictsDetected')
            return 'Conflicts detected. Commit, pull, and push are blocked until conflicts are resolved.';
        if (key === 'files.sourceControlOperations.actions.fetch') return 'Fetch';
        if (key === 'files.sourceControlOperations.actions.pull') return 'Pull';
        if (key === 'files.sourceControlOperations.actions.push') return 'Push';
        if (key === 'files.sourceControlOperations.blockedHints.lock') return 'Lock';
        if (key === 'files.sourceControlOperations.blockedHints.commitBlocked') return 'Commit blocked';
        if (key === 'files.sourceControlOperations.blockedHints.pullBlocked') return 'Pull blocked';
        if (key === 'files.sourceControlOperations.blockedHints.pushBlocked') return 'Push blocked';
        if (key === 'files.sourceControlOperationsLog.title') return 'Recent operations';
        if (key === 'files.sourceControlOperationsLog.allSessions') return 'all sessions';
        if (key === 'files.sourceControlOperationsLog.thisSession') return 'this session';
        if (key === 'files.sourceControlOperationsLog.emptyThisSession') return 'No recent operations for this session.';
        return key;
    },
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

    it('hides remote actions when remote capabilities are not available', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: true, writeCommit: true, writeRemoteFetch: false, writeRemotePull: false, writeRemotePush: false }}
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
                    commitSelectionCount={0}
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any).map((node) => String(node.props.children ?? ''));
        expect(texts.some((value) => value === 'Fetch')).toBe(false);
        expect(texts.some((value) => value === 'Pull')).toBe(false);
        expect(texts.some((value) => value === 'Push')).toBe(false);
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

    it('renders an inline commit message composer when draft props are provided', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const onFetch = vi.fn();
        const onPull = vi.fn();
        const onPush = vi.fn();
        const onCreateCommit = vi.fn();
        const onCommitMessageDraftChange = vi.fn();
        const onCommitFromMessage = vi.fn();

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
                    commitMessageDraft="feat: inline"
                    onCommitMessageDraftChange={onCommitMessageDraftChange}
                    onCommitFromMessage={onCommitFromMessage}
                />
            );
        });

        const input = tree!.root.findByType('TextInput' as any);
        expect(input.props.value).toBe('feat: inline');

        const commitButton = tree!.root
            .findAllByType('Pressable' as any)
            .find((pressable) =>
                pressable.findAllByType('Text' as any).some((textNode) => textNode.props.children === 'Commit staged')
            );
        expect(commitButton).toBeTruthy();

        act(() => {
            commitButton!.props.onPress();
        });

        expect(onCommitFromMessage).toHaveBeenCalledTimes(1);
        expect(onCommitFromMessage).toHaveBeenCalledWith('feat: inline');
        expect(onCreateCommit).not.toHaveBeenCalled();
    });

    it('hides the commit action chip when hideCommitAction is enabled', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlOperationsPanel
                    hideCommitAction
                    backendLabel="Git"
                    commitActionLabel="Commit staged"
                    capabilities={{ readLog: false, writeCommit: true, writeRemoteFetch: true, writeRemotePull: true, writeRemotePush: true }}
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
                />
            );
        });

        const commitChip = tree!.root
            .findAllByType('Pressable' as any)
            .find((pressable) =>
                pressable.findAllByType('Text' as any).some((textNode) => textNode.props.children === 'Commit staged')
            );
        expect(commitChip).toBeFalsy();
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
                return typeof label === 'string' && label.toLowerCase() === 'this session';
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
                return typeof label === 'string' && label.toLowerCase() === 'this session';
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
