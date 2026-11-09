/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture, createTestSessionTranscriptSource, installBrowserStorageLockBoundary, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { parseSessionFileDeepLinkAnchor } from '@/utils/url/sessionFileDeepLink';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { UserTextMessage } from '@happier-dev/session-core/messages';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// This journey presses the stage after its native opening animation completes.
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({ settleTimingCallbacks: true }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: () => '/search' }).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
// The vendor streaming renderer is not exercised by this file-reference journey.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in reference journey'); },
}));

// Warm the real route graph outside the per-behavior deadline, as in WorkspaceTabs.seam.
const production = await (async () => {
    const restore = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    const homes = await serveActionHomes({ homes: [{ key: 'warm', serverUrl: 'https://transcript-import.test',
        accountId: 'alice', currentAccount: true }], route: () => undefined });
    let disconnect: (() => Promise<unknown>) | undefined;
    try {
        disconnect = await homes.restoreActiveConnection();
        return await Promise.all([
            import('@/components/appShell/workspace/WorkspaceProvider'), import('@/components/appShell/panes/AppPaneProvider'),
            import('@/components/appShell/destinations/compactAppDestinationCatalog'), import('./StructuredReferencesRow'), import('@/sync/domains/state/storage'),
            import('../useTranscriptFileLinks'),
            import('@/components/sessions/files/turnChanges/TranscriptTurnChangesCard'), import('@/scm/scmStatusFiles'),
            import('@/utils/ui/toTestIdSafeValue'),
            import('../MessageView'),
            import('@/auth/context/AuthContext'), import('@/modal'),
        ]);
    } finally { try { await disconnect?.(); } finally { await homes.dispose(); restore(); } }
})();

let disposeHome: (() => Promise<void>) | undefined;
let disconnectHome: (() => Promise<unknown>) | undefined;
let restoreLocks: (() => void) | undefined;
let restorePortal: (() => void) | undefined;
afterEach(async () => {
    standardCleanup();
    try { await disconnectHome?.(); }
    finally {
        try { await disposeHome?.(); }
        finally { restoreLocks?.(); restorePortal?.(); restorePortal = undefined; }
    }
});

it('opens a transcript file through the canonical Action into the qualified session destination', async () => {
    restoreLocks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    const homes = await serveActionHomes({ homes: [
        { key: 'other', serverUrl: 'https://transcript-files-other.test', accountId: 'alice' },
        { key: 'home', serverUrl: 'https://transcript-files.test', accountId: 'alice', currentAccount: true },
    ], route: () => undefined });
    disposeHome = homes.dispose;
    disconnectHome = await homes.restoreActiveConnection();
    const [{ WorkspaceProvider }, { AppPaneProvider }, { resolveCompactAppDestinations }, { StructuredReferencesRow }, { storage }, { useTranscriptFileLinks },
        { TranscriptTurnChangesCard }, { scmFileStatusFromChange }, { toTestIdSafeValue }] = production;
    const initial = storage.getState();
    const scope = initial.profileScope!;
    const targetServerId = homes.homes.other!.id;
    expect(targetServerId).not.toBe(scope.serverId);
    storage.setState({ isDataReady: true, settings: { ...initial.settings, scmChangedFilesLayout: 'list' } });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    let navigation!: WorkspaceNavigationContextValue;
    let links!: ReturnType<typeof useTranscriptFileLinks>;
    function HookProbe() {
        links = useTranscriptFileLinks({ sessionId: 's1', serverId: targetServerId, workspacePath: '/repo', canOpenFiles: true });
        return null;
    }
    const source = createTestSessionTranscriptSource({ sessionId: 's1', serverId: targetServerId, workspacePath: '/repo', navigate: () => {
        throw new Error('File references must use the workspace Action, not source navigation');
    } });
    const rawPaths = ['src/100%25.ts', 'src/query?.ts', 'src/name#L4', ' leading /LICENSE ', ' '];
    const relativePaths = [
        { path: 'src\\windows.ts', expected: 'src/windows.ts' },
        { path: './src/dot.ts', expected: 'src/dot.ts' },
    ];
    const screen = await renderWithSessionTranscriptSource(<AppPaneProvider><WorkspaceProvider enabled catalog={catalog}>
        {owner => { navigation = owner; return <><HookProbe /><StructuredReferencesRow sessionId="s1" serverId={targetServerId}
            references={['src/a.ts', ...rawPaths, ...relativePaths.map(entry => entry.path)].map(path => ({ kind: 'file' as const, path }))} fileOpenEnabled />
            <TranscriptTurnChangesCard sessionId="s1" serverId={targetServerId} turnId="turn-4" fileOpenEnabled
                files={[scmFileStatusFromChange({ path: 'src/turn.ts', changeKind: 'modified', added: 1, removed: 1 })]}
                firstHunkAnchors={{ 'src/turn.ts': { kind: 'diffLine', side: 'after', startLine: 40, newLine: 40, oldLine: null } }} />
        </>; }}
    </WorkspaceProvider></AppPaneProvider>, source);
    try {
        await vi.waitFor(async () => { await act(async () => {}); expect(navigation.active || navigation.ownsRoute).toBe(true); });
        await screen.pressByTestIdAsync('linked-workspace-file:src/a.ts');
        await vi.waitFor(async () => {
            await act(async () => {});
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session',
                params: { id: 's1', serverId: targetServerId, details: 'file', path: 'src/a.ts', fileView: 'view' } });
        });
        for (const path of rawPaths) {
            await screen.pressByTestIdAsync(`linked-workspace-file:${path}`);
            await vi.waitFor(() => {
                const group = navigation.state.groups[navigation.state.focusedGroupId];
                expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                    serverId: targetServerId, path, fileView: 'view',
                } });
            });
        }
        for (const { path, expected } of relativePaths) {
            await screen.pressByTestIdAsync(`linked-workspace-file:${path}`);
            await vi.waitFor(() => {
                const group = navigation.state.groups[navigation.state.focusedGroupId];
                expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                    serverId: targetServerId, path: expected, fileView: 'view',
                } });
            });
        }
        await act(async () => { expect(links.openPath('/repo/src/absolute%25?name#L2.ts')).toBe(true); });
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: 'src/absolute%25?name#L2.ts', fileView: 'view',
            } });
        });
        await act(async () => { expect(links.openPath('/repo/ ')).toBe(true); });
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: ' ', fileView: 'view',
            } });
        });
        await act(async () => { expect(links.onMarkdownLinkPress('src/100%2525.ts#L7')).toBe(true); });
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            const target = navigation.state.tabs[group.activeTabId].target;
            expect(target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: 'src/100%25.ts',
            } });
            expect(parseSessionFileDeepLinkAnchor(target.params)).toEqual({ source: 'file',
                anchor: { kind: 'line', filePath: 'src/100%25.ts', line: 7 } });
        });
        await act(async () => { expect(links.onMarkdownLinkPress('src/range.ts:5-8')).toBe(true); });
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: 'src/range.ts', source: 'file', anchor: 'range', startLine: '5', endLine: '8',
            } });
        });
        await screen.pressByTestIdAsync('turn-changes-card:turn-4-toggle');
        await screen.pressByTestIdAsync(`scm-change-row-${toTestIdSafeValue('src/turn.ts')}`);
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: 'src/turn.ts', fileView: 'changes', source: 'diff', anchor: 'diffLine', startLine: '40',
                comparison: 'turnCheckpoint', turnId: 'turn-4',
            } });
        });
    } finally { await screen.unmount(); storage.setState(initial, true); }
});

it('keeps public file references inert without a workspace owner', async () => {
    const [, , , { StructuredReferencesRow }] = production;
    const source = createTestSessionTranscriptSource({ sessionId: 'public', navigate: null });
    const screen = await renderWithSessionTranscriptSource(<StructuredReferencesRow sessionId="public"
        references={[{ kind: 'file', path: 'src/private.ts' }]} fileOpenEnabled={false} />, source);
    try {
        const chip = screen.findByTestId('linked-workspace-file:src/private.ts');
        expect(chip?.props.onPress).toBeUndefined();
        expect(chip?.props.accessibilityRole).toBe('text');
    } finally { await screen.unmount(); }
});

it('opens rendered MessageView review anchors and tool video evidence through the qualified Action owner', async () => {
    restoreLocks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    const homes = await serveActionHomes({ homes: [
        { key: 'other', serverUrl: 'https://transcript-media-other.test', accountId: 'alice' },
        { key: 'home', serverUrl: 'https://transcript-media.test', accountId: 'alice', currentAccount: true },
    ], route: () => undefined });
    disposeHome = homes.dispose;
    disconnectHome = await homes.restoreActiveConnection();
    const [{ WorkspaceProvider }, { AppPaneProvider }, { resolveCompactAppDestinations }, , { storage }, , , , , { MessageView },
        { InjectedAuthProvider }, { ModalProvider }] = production;
    const initial = storage.getState();
    const targetServerId = homes.homes.other!.id;
    expect(targetServerId).not.toBe(initial.profileScope!.serverId);
    storage.setState({ isDataReady: true });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    const source = createTestSessionTranscriptSource({ sessionId: 's1', serverId: targetServerId, workspacePath: '/repo',
        interaction: deriveTranscriptInteraction({ kind: 'session', access: createSessionFixture().access, isSessionActive: true }),
        navigate: () => { throw new Error('Message file evidence must use the workspace Action'); },
    });
    const videoPath = '.happier/uploads/tools/t1/recording.webm';
    const anchor = { kind: 'diffLine', side: 'after', startLine: 12, newLine: 12, oldLine: null } as const;
    const message = { kind: 'user-text', id: 'review-media', localId: 'local-review-media', createdAt: 1, text: 'Review with video evidence',
        meta: {
            happier: { kind: 'review_comments.v1', payload: { sessionId: 's1', comments: [{
                id: 'review-jump', filePath: 'src/review.ts', source: 'diff', body: 'Review this change', createdAt: 1,
                anchor, snapshot: { selectedLines: ['const value = 1;'], beforeContext: [], afterContext: [] },
            }] } },
            happierMedia: { kind: 'session_media.v1', payload: { media: [{ id: 'recording', role: 'output', category: 'tool-artifact',
                mediaKind: 'video', mimeType: 'video/webm', name: 'recording.webm', path: videoPath, sizeBytes: 2048,
                origin: { source: 'tool-output' },
            }] } },
        },
    } satisfies UserTextMessage;
    const actionRuntime = await import('@/components/appShell/workspace/workspaceActionRuntime');
    let navigation!: WorkspaceNavigationContextValue;
    const screen = await renderWithSessionTranscriptSource(<InjectedAuthProvider credentials={null}><ModalProvider><AppPaneProvider><WorkspaceProvider enabled catalog={catalog}>
        {owner => { navigation = owner; return <MessageView message={message} metadata={null} sessionId="s1" serverId={targetServerId} />; }}
    </WorkspaceProvider></AppPaneProvider></ModalProvider></InjectedAuthProvider>, source);
    const actionObservation = vi.spyOn(actionRuntime, 'executeWorkspaceUiAction');
    restorePortal = installReactDomPortalBoundaryForTests().restore;
    try {
        await vi.waitFor(async () => { await act(async () => {}); expect(navigation.active || navigation.ownsRoute).toBe(true); });
        await screen.pressByTestIdAsync('review-comments-jump:review-jump');
        await vi.waitFor(async () => {
            await act(async () => {});
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            const target = navigation.state.tabs[group.activeTabId].target;
            expect(target).toMatchObject({ kind: 'session', params: { serverId: targetServerId, path: 'src/review.ts', fileView: 'changes' } });
            expect(parseSessionFileDeepLinkAnchor(target.params)).toEqual({ source: 'diff', anchor: { ...anchor, lineHash: undefined } });
        });
        expect(actionObservation.mock.results.some(result => result.type === 'return')).toBe(true);
        expect(navigation.active || navigation.ownsRoute).toBe(true);
        actionObservation.mockClear();
        await screen.pressByTestIdAsync(`message-session-media-inline-video:${videoPath}`);
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByTestId('media-stage')).not.toBeNull();
            for (let node = screen.findByTestId('media-stage-open-file'); node; node = node.parent) {
                if (node.props.testID === 'media-stage') break;
                expect(node.props.pointerEvents).not.toBe('none');
            }
        });
        expect(actionObservation).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('media-stage-open-file');
        const action = actionObservation.mock.results.at(-1);
        expect(action?.type).toBe('return');
        if (action?.type === 'return') expect(await action.value).toMatchObject({ ok: true });
        await vi.waitFor(async () => {
            await act(async () => {});
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            const target = navigation.state.tabs[group.activeTabId].target;
            expect(target).toMatchObject({ kind: 'session', params: { serverId: targetServerId, path: videoPath, fileView: 'view' } });
            expect(parseSessionFileDeepLinkAnchor(target.params)).toBeNull();
        });
    } finally { actionObservation.mockRestore(); await screen.unmount(); storage.setState(initial, true); }
});
