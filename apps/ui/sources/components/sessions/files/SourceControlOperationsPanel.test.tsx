import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { findTestInstanceByTypeWithProps, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installSessionFilesCommonModuleMocks } from './sessionFilesTestHelpers';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionFilesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                select: (value: any) => value?.default ?? null,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: any) => {
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
        });
    },
});

describe('SourceControlOperationsPanel', () => {
    it('shows selected commit scope count and clear action', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const onClearCommitSelection = vi.fn();

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        expect(screen.getTextContent()).toContain('files selected for the next commit');

        const clearButton = findTestInstanceByTypeWithProps(screen.tree, 'Pressable', { onPress: onClearCommitSelection });
        expect(clearButton).toBeTruthy();

        act(() => {
            pressTestInstance(clearButton, 'clear commit selection action');
        });
        expect(onClearCommitSelection).toHaveBeenCalledTimes(1);
    });

    it('hides remote actions when remote capabilities are not available', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const textContent = screen.getTextContent();
        expect(textContent).not.toContain('Fetch');
        expect(textContent).not.toContain('Pull');
        expect(textContent).not.toContain('Push');
    });

    it('shows which session currently owns the in-flight operation lock', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const textContent = screen.getTextContent();

        expect(textContent).toContain('Running: push');
        expect(textContent).toContain('session sessio');
    });

    it('renders operation buttons and invokes callbacks', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const onFetch = vi.fn();
        const onPull = vi.fn();
        const onPush = vi.fn();
        const onCreateCommit = vi.fn();

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const commitButton = findTestInstanceByTypeWithProps(screen.tree, 'Pressable', { onPress: onCreateCommit });
        const fetchButton = findTestInstanceByTypeWithProps(screen.tree, 'Pressable', { onPress: onFetch });
        const pullButton = findTestInstanceByTypeWithProps(screen.tree, 'Pressable', { onPress: onPull });
        const pushButton = findTestInstanceByTypeWithProps(screen.tree, 'Pressable', { onPress: onPush });

        expect(commitButton).toBeTruthy();
        expect(fetchButton).toBeTruthy();
        expect(pullButton).toBeTruthy();
        expect(pushButton).toBeTruthy();

        act(() => {
            pressTestInstance(commitButton, 'create commit action');
            pressTestInstance(fetchButton, 'fetch action');
            pressTestInstance(pullButton, 'pull action');
            pressTestInstance(pushButton, 'push action');
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

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const input = screen.findByTestId('scm-commit-message');
        expect(input?.props.value).toBe('feat: inline');

        screen.pressByTestId('scm-commit-submit');

        expect(onCommitFromMessage).toHaveBeenCalledTimes(1);
        expect(onCommitFromMessage).toHaveBeenCalledWith('feat: inline');
        expect(onCreateCommit).not.toHaveBeenCalled();
    });

    it('hides the commit action chip when hideCommitAction is enabled', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        expect(screen.getTextContent()).not.toContain('Commit staged');
    });

    it('hides write action buttons when capabilities are missing', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const textContent = screen.getTextContent();
        expect(textContent).not.toContain('Fetch');
        expect(textContent).not.toContain('Pull');
        expect(textContent).not.toContain('Push');
    });

    it('renders conflict messaging that does not imply include/exclude actions are disabled', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        expect(screen.getTextContent()).toContain('Commit, pull, and push are blocked until conflicts are resolved.');
    });

    it('renders disabled operation hints when preflight blocks actions', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
        />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('Commit blocked');
        expect(textContent).toContain('Stage at least one file before committing.');
        expect(textContent).toContain('Pull blocked');
        expect(textContent).toContain('Remote operations are unavailable while HEAD is detached.');
        expect(textContent).toContain('Push blocked');
        expect(textContent).toContain('Pull remote changes before pushing local commits.');
    });

    it('labels operation log entries with current vs other session origin', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const now = Date.now();

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('this session');
        expect(textContent).toContain('session sessio');
    });

    it('shows a lock warning when another session owns the in-flight git operation', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        expect(screen.getTextContent()).toContain('locked by');
    });

    it('shows a global lock hint when another session has a git operation in flight', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        expect(screen.getTextContent()).toContain('Operations are temporarily locked because another session is running a source control command.');
    });

    it('allows filtering operation log to this session only', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const now = Date.now();

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        expect(screen.getTextContent()).toContain('this session');
        expect(screen.getTextContent()).toContain('session sessio');

        const thisSessionFilter = screen.findByProps({ children: 'this session' }).parent;
        expect(thisSessionFilter).toBeTruthy();

        act(() => {
            pressTestInstance(thisSessionFilter, 'this session filter');
        });

        expect(screen.getTextContent()).toContain('this session');
        expect(screen.getTextContent()).not.toContain('session sessio');
    });

    it('shows an empty-state message when this-session filter has no entries', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const now = Date.now();

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const thisSessionFilter = screen.findByProps({ children: 'this session' }).parent;
        expect(thisSessionFilter).toBeTruthy();
        act(() => {
            pressTestInstance(thisSessionFilter, 'this session filter');
        });

        expect(screen.getTextContent()).toContain('No recent operations for this session.');
    });

    it('renders recent git operations newest-first', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');
        const now = Date.now();

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const textContent = screen.getTextContent();
        expect(textContent.indexOf('push · this session')).toBeLessThan(textContent.indexOf('fetch · this session'));
    });

    it('renders source control heading and backend badge', async () => {
        const { SourceControlOperationsPanel } = await import('./SourceControlOperationsPanel');

        const screen = await renderScreen(<SourceControlOperationsPanel
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
                />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('Source control');
        expect(textContent).toContain('SAPLING');
    });
});
