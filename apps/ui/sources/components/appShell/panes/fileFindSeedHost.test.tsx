import { replacePersistentUiStateForTest, PersistedPaneScopesSchema } from '@/dev/testkit/harness/persistentUiState';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFileViewerFindModel } from '@/components/workspaces/files/details/useFileViewerFind';
import { openChatWithFindSeed } from './fileFindSeedHandoff';
import type { FileFindSeedHostInput } from './fileFindSeedHost';
import type { TranscriptFindCorpus, TranscriptFindModel } from '@/components/sessions/transcript/find/useTranscriptFind';
import { clearActiveUnsavedChangesGuard, runGuardedNavigation, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { renderScreen: renderWithoutAuth } = await import('@/dev/testkit');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { act } = await import('react-test-renderer');
const { getStorage } = await import('@/sync/domains/state/storage');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const findSeedHosts = await import('./fileFindSeedHost');
const { FileFindSeedHost } = findSeedHosts;
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { TranscriptFindSurface } = await import('@/components/sessions/transcript/find/TranscriptFindSurface');
const { useTranscriptFind } = await import('@/components/sessions/transcript/find/useTranscriptFind');
const { createReadOnlySessionTranscriptSource } = await import('@/components/sessions/transcript/source/readOnlySessionTranscriptSource');
const { buildChatListItems } = await import('@/components/sessions/chatListItems');
const { makeExternalSessionHistoricalImportLocalId } = await import('@happier-dev/protocol/sessions/external/historicalImportIdentity');
const initialState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';

function AccountBoundary({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={connection?.credentials ?? null}>{children}</InjectedAuthProvider>;
}
function renderScreen(element: React.ReactElement) {
    return renderWithoutAuth(element, { wrapper: AccountBoundary });
}

const destination = { host: 'project' as const, id: 'project-a', path: 'src/a.ts',
    scope: { serverId: '', machineId: 'machine-a', rootPath: '/repo' } };
const seed = { query: 'needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: 'src/a.ts' } };

beforeEach(async () => {
    serverId = await homes.addHome({ name: 'Find Home', serverUrl: 'https://file-find-home.test', accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://file-find-home.test', accountId: 'account-a', request: homes.request });
    getStorage().setState({ profileScope: { serverId, accountId: 'account-a' } });
    (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse({})), getStorage().getState().applyLocalSettings({ }));
    destination.scope.serverId = serverId;
});
afterEach(async () => {
    clearActiveUnsavedChangesGuard();
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    getStorage().setState(initialState, true);
});

function Stage(props: Readonly<{ value?: typeof seed }>) {
    const handoff = useAppPaneContext().fileFindSeedHandoff;
    const value = props.value ?? seed;
    React.useLayoutEffect(() => {
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        handoff.stage({ ...destination, accountId: 'account-a' }, value, authority);
    }, [handoff, value]);
    return null;
}

function Host(props: Readonly<{ tabId: string; focused: boolean }>) {
    return <DestinationInstanceHost tabId={props.tabId} ref={{ kind: 'project', params: { workspaceRefId: 'project-a' } }}
        pathname="/projects/project-a" focused={props.focused} visible navigation={{ push() {}, replace() {}, back() {} }}>
        <FileFindSeedHost destination={destination} active>{(handoff) => React.createElement('FindSeedProbe', { tabId: props.tabId, ...handoff })}</FileFindSeedHost>
    </DestinationInstanceHost>;
}

describe('file Find destination memory', () => {
    it('retains an addressed chat launch while its destination suspends before content is ready', async () => {
        const waiting = createDeferred<void>();
        let suspended = false;
        function Content(input: import('./fileFindSeedHost').ChatFindSeedHostInput) {
            if (suspended) throw waiting.promise;
            return React.createElement('ChatSeedProbe', input);
        }
        function StageChat() {
            const pane = useAppPaneContext();
            React.useEffect(() => {
                const authority = captureActiveServerAccountScopeLifetime();
                if (!authority) throw new Error('Expected real Account lifetime');
                pane.fileFindSeedHandoff.stageChat({ sessionId: 'chat-a', serverId, accountId: 'account-a' },
                    { query: 'hydrating needle', options: seed.options, target: { kind: 'route-message-id', routeMessageId: 'loaded-row' } }, authority);
            }, [pane.fileFindSeedHandoff]);
            return null;
        }
        function Journey({ tick, sessionId = 'chat-a' }: { tick: number; sessionId?: string }) {
            return <AppPaneProvider><StageChat /><React.Suspense fallback={<></>}>
                <DestinationInstanceHost tabId="selected" ref={{ kind: 'session', params: { id: sessionId, serverId } }}
                    pathname={`/session/${sessionId}`} focused visible navigation={{ push() {}, replace() {}, back() {} }}>
                    <findSeedHosts.ChatFindSeedHost sessionId={sessionId} serverId={serverId} active>{input => <Content {...input} key={tick} />}</findSeedHosts.ChatFindSeedHost>
                </DestinationInstanceHost>
            </React.Suspense></AppPaneProvider>;
        }
        const screen = await renderScreen(<Journey tick={0} />);
        expect(screen.root.findByType('ChatSeedProbe').props.findSeed?.query).toBe('hydrating needle');
        suspended = true;
        await screen.update(<Journey tick={1} />);
        suspended = false;
        await act(async () => { waiting.resolve(); });
        expect(screen.root.findByType('ChatSeedProbe').props.findSeed?.query).toBe('hydrating needle');
        await screen.update(<Journey tick={1} sessionId="different-chat" />);
        expect(screen.root.findByType('ChatSeedProbe').props.findSeed).toBeNull();
        await screen.update(<Journey tick={1} />);
        expect(screen.root.findByType('ChatSeedProbe').props.findSeed).toBeNull();
    });
    it.each([
        { name: 'first link', retained: false, synchronous: false, guardDecision: null },
        { name: 'prelinked reopen', retained: true, synchronous: false, guardDecision: null },
        { name: 'synchronous prelinked reopen', retained: true, synchronous: true, guardDecision: null },
        { name: 'guarded prelinked reopen', retained: true, synchronous: true, guardDecision: 'discard' },
        { name: 'cancelled guarded reopen', retained: true, synchronous: true, guardDecision: 'keepEditing' },
    ] as const)('seeds $name after destination navigation and keeps Find through transcript hydration', async ({ retained, synchronous, guardDecision }) => {
        getStorage().setState(state => ({ settings: { ...state.settings, keyboardShortcutsV2Enabled: false } }));
        const realID = makeExternalSessionHistoricalImportLocalId({ agentId: 'claude', remoteSessionId: 'native-chat', directItemId: 'matched-item' });
        const message = { kind: 'user-text' as const, id: 'loaded-row', realID, localId: null, createdAt: 1, seq: 1, text: 'violet harbor lantern' };
        const history = { isLoaded: true, hasOlder: false, isLoadingOlder: false };
        let corpus: TranscriptFindCorpus = { messages: [message], history };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'linked-chat', serverId, ...corpus,
            reducerState: null, metadata: null, agentState: null });
        let model!: TranscriptFindModel;
        const hydration = createDeferred<void>();
        let suspended = false;
        function HydratingRows() {
            if (suspended) throw hydration.promise;
            return null;
        }
        function Transcript() {
            model = useTranscriptFind({ readCorpus: () => corpus, loadPage: null,
                jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {} });
            return <TranscriptFindSurface model={model} source={source} sessionId="linked-chat" serverId={serverId}
                viewportRef={{ current: null }} items={buildChatListItems({ messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message }, pendingMessages: [] })} loadedMessages={[message]}
                publishCorpus={next => { corpus = next; }} measureMessage={() => null} contentHeight={0}>
                <HydratingRows />
            </TranscriptFindSurface>;
        }
        let launch!: () => Promise<void>;
        let navigate!: () => void | Promise<void>;
        let commitNavigation!: () => void;
        function Launch() {
            const pane = useAppPaneContext();
            launch = () => openChatWithFindSeed({ handoff: pane.fileFindSeedHandoff,
                authority: pane.fileFindSeedAccountBindings.get(serverId),
                destination: { sessionId: 'linked-chat', serverId: connection!.home.id },
                seed: { query: 'violet harbor lantern', target: { kind: 'native-message', agentId: 'claude', remoteSessionId: 'native-chat', sourceItemId: 'matched-item' } },
                open: () => navigate() });
            return null;
        }
        function Journey({ mounted, destinationInstance = 'linked-tab' }: { mounted: boolean; destinationInstance?: string }) {
            const [navigationCommitted, setNavigationCommitted] = React.useState(false);
            commitNavigation = () => setNavigationCommitted(true);
            return <AppPaneProvider><Launch />{mounted ? <DestinationInstanceHost tabId="linked-tab"
                ref={{ kind: 'session', params: { id: 'linked-chat', serverId } }} pathname="/session/linked-chat"
                focused visible navigation={{ push() {}, replace() {}, back() {} }}>
                <React.Suspense key={navigationCommitted ? 'reopened-linked-tab' : destinationInstance} fallback={<></>}><Transcript /></React.Suspense>
            </DestinationInstanceHost> : null}</AppPaneProvider>;
        }
        const screen = await renderScreen(<Journey mounted={retained} />);
        const previousModel = retained ? model : null;
        const navigation = createDeferred<void>();
        const decision = createDeferred<UnsavedChangesDecision>();
        const requestDecision = vi.fn(() => decision.promise);
        if (guardDecision) setActiveUnsavedChangesGuard({ isDirtyRef: { current: true },
            requestDecision, tag: 'native-find-reopen' });
        navigate = guardDecision ? () => {
            // The production workspace router intentionally returns void while
            // its canonical guard settles the requested departure.
            const guarded = runGuardedNavigation(() => { commitNavigation(); });
            if (guarded !== true) void guarded;
        } : synchronous ? () => { commitNavigation(); } : () => navigation.promise;
        try {
            // A retained copy of this Session can still be mounted until navigation
            // commits the destination selected by the new Open operation.
            let opening!: Promise<void>;
            await act(async () => { opening = launch(); });
            if (!synchronous) await screen.update(<Journey mounted destinationInstance="reopened-linked-tab" />);
            await act(async () => { navigation.resolve(); if (guardDecision) decision.resolve(guardDecision); await opening; });
            await act(async () => { await model.settled(); });
            if (guardDecision) expect(requestDecision).toHaveBeenCalledTimes(1);
            if (guardDecision === 'keepEditing') {
                expect(model).toBe(previousModel);
                expect(model.getSnapshot()).toMatchObject({ open: false, query: '' });
                expect(screen.findByTestId('transcript-find')).toBeNull();
                await screen.update(<Journey mounted destinationInstance="cancelled-reopen" />);
                expect(model.getSnapshot()).toMatchObject({ open: false, query: '' });
                return;
            }
            expect(model.getSnapshot()).toMatchObject({ open: true, query: message.text, status: { kind: 'results', current: 1, total: 1 } });
            expect(screen.findByTestId('transcript-find')).not.toBeNull();
            expect(model.rowStore.getSnapshot(message.id)?.blocks[0]?.sourceRanges).toEqual([{ start: 0, end: message.text.length, current: true }]);
            if (previousModel) expect(previousModel.query).toBe('');
            suspended = true;
            await screen.update(<Journey mounted destinationInstance="reopened-linked-tab" />);
            suspended = false;
            await act(async () => { hydration.resolve(); });
            expect(model.getSnapshot()).toMatchObject({ open: true, query: message.text, status: { kind: 'results', current: 1, total: 1 } });
            expect(screen.findByTestId('transcript-find')).not.toBeNull();
        } finally { await screen.unmount(); model?.dispose(); }
    });
    it.each(['synchronous push', 'asynchronous navigation'])('discards a chat launch when %s fails before the host mounts', async (navigation) => {
        let open!: () => Promise<void>;
        const chatSeed = { query: 'failed needle', options: seed.options,
            target: { kind: 'route-message-id' as const, routeMessageId: 'imported-row' } };
        function Launch() {
            const handoff = useAppPaneContext().fileFindSeedHandoff;
            open = () => openChatWithFindSeed({ handoff, destination: { sessionId: 'chat-a', serverId },
                seed: chatSeed, authority: captureActiveServerAccountScopeLifetime(),
                open: () => {
                    if (navigation === 'synchronous push') throw new Error('Navigation failed');
                    return Promise.reject(new Error('Navigation failed'));
                },
            });
            return null;
        }
        function ReopenedChat() {
            return <DestinationInstanceHost tabId="reopened" ref={{ kind: 'session', params: { sessionId: 'chat-a' } }}
                pathname="/session/chat-a" focused visible navigation={{ push() {}, replace() {}, back() {} }}>
                <findSeedHosts.ChatFindSeedHost sessionId="chat-a" serverId={serverId} active>{(input) => React.createElement('ChatSeedProbe', input)}</findSeedHosts.ChatFindSeedHost>
            </DestinationInstanceHost>;
        }
        const screen = await renderScreen(<AppPaneProvider><Launch /></AppPaneProvider>);
        await expect(open()).rejects.toThrow('Navigation failed');
        await screen.update(<AppPaneProvider><Launch /><ReopenedChat /></AppPaneProvider>);
        expect(screen.root.findByType('ChatSeedProbe').props.findSeed).toBeNull();
    });
    it.each(['session', 'project'] as const)('lands the %s travelling query in the real file matcher after content loads', async (host) => {
        const addressed = { ...destination, host, id: `${host}-a` };
        const addressedSeed = { ...seed, target: { ...seed.target, anchor: { kind: 'fileLine' as const, startLine: 2 } } };
        function StageAddressed() {
            const handoff = useAppPaneContext().fileFindSeedHandoff;
            React.useLayoutEffect(() => {
                const authority = captureActiveServerAccountScopeLifetime();
                if (!authority) throw new Error('Expected real Account lifetime');
                handoff.stage({ ...addressed, accountId: 'account-a' }, addressedSeed, authority);
            }, [handoff]);
            return null;
        }
        function Consumer(props: FileFindSeedHostInput & { loaded: boolean }) {
            const latest = React.useRef(props.loaded);
            latest.current = props.loaded;
            const model = React.useMemo(() => createFileViewerFindModel(() => ({ path: addressed.path,
                mode: 'file', text: latest.current ? 'needle\n😀 needle' : null })), []);
            const snapshot = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
            React.useEffect(() => {
                if (props.findSeed && model.applySeed(props.findSeed)) props.consumeFindSeed();
            }, [model, props.loaded, props.findSeed, props.consumeFindSeed]);
            return React.createElement('FileFindResult', { snapshot, pendingSeed: props.findSeed });
        }
        function Journey(props: { loaded: boolean }) {
            const ref: React.ComponentProps<typeof DestinationInstanceHost>['ref'] = host === 'session'
                ? { kind: 'session' as const, params: { sessionId: addressed.id } }
                : { kind: 'project' as const, params: { workspaceRefId: addressed.id } };
            return <AppPaneProvider><StageAddressed />
                <DestinationInstanceHost tabId="addressed" ref={ref} pathname={`/${host}/${addressed.id}`}
                    focused visible navigation={{ push() {}, replace() {}, back() {} }}>
                    <FileFindSeedHost destination={addressed} active>{(input) => <Consumer {...input} loaded={props.loaded} />}</FileFindSeedHost>
                </DestinationInstanceHost>
            </AppPaneProvider>;
        }
        const screen = await renderScreen(<Journey loaded={false} />);
        expect(screen.root.findByType('FileFindResult').props.pendingSeed).toEqual(addressedSeed);
        expect(screen.root.findByType('FileFindResult').props.snapshot.open).toBe(false);
        await screen.update(<Journey loaded />);
        const result = screen.root.findByType('FileFindResult').props;
        expect(result.pendingSeed).toBeNull();
        expect(result.snapshot.query).toBe('needle');
        expect(result.snapshot.status).toEqual({ kind: 'results', current: 2, total: 2, coverage: 'complete' });
        expect(result.snapshot.lineRanges.get('f:2')).toEqual([{ start: 3, end: 9, current: true }]);
    });
    it('hands a chat query to only its focused Home and Session, and discards it when that destination closes', async () => {
        const chatSeed = { query: 'historic needle', options: seed.options, target: { kind: 'route-message-id' as const, routeMessageId: 'local:imported-row' } };
        function StageChat() {
            const handoff = useAppPaneContext().fileFindSeedHandoff;
            React.useLayoutEffect(() => {
                const authority = captureActiveServerAccountScopeLifetime();
                if (!authority) throw new Error('Expected real Account lifetime');
                handoff.stageChat({ sessionId: 'chat-a', serverId, accountId: 'account-a' }, chatSeed, authority);
            }, [handoff]);
            return null;
        }
        function ChatHost(props: Readonly<{ tabId: string; serverId: string; focused: boolean }>) {
            return <DestinationInstanceHost tabId={props.tabId} ref={{ kind: 'session', params: { sessionId: 'chat-a' } }}
                pathname="/session/chat-a" focused={props.focused} visible navigation={{ push() {}, replace() {}, back() {} }}>
                <findSeedHosts.ChatFindSeedHost sessionId="chat-a" serverId={props.serverId} active>{(input) => React.createElement('ChatSeedProbe', { tabId: props.tabId, ...input })}</findSeedHosts.ChatFindSeedHost>
            </DestinationInstanceHost>;
        }
        const screen = await renderScreen(<AppPaneProvider><StageChat /><ChatHost tabId="wrong-home" serverId="home-b" focused /><ChatHost tabId="hidden" serverId={serverId} focused={false} /><ChatHost tabId="selected" serverId={serverId} focused /></AppPaneProvider>);
        const probes = screen.root.findAllByType('ChatSeedProbe');
        expect(probes.map(probe => probe.props.findSeed)).toEqual([null, null, chatSeed]);
        await screen.update(<AppPaneProvider><StageChat /></AppPaneProvider>);
        await screen.update(<AppPaneProvider><StageChat /><ChatHost tabId="reopened" serverId={serverId} focused /></AppPaneProvider>);
        expect(screen.root.findByType('ChatSeedProbe').props.findSeed).toBeNull();
    });
    it('acknowledges only the seed that the destination received, never a replacement seed', async () => {
        const screen = await renderScreen(<AppPaneProvider><Stage /><Host tabId="selected" focused /></AppPaneProvider>);
        const staleAcknowledge = screen.root.findByType('FindSeedProbe').props.consumeFindSeed;
        const replacement = { ...seed, query: 'second needle' };
        await screen.update(<AppPaneProvider><Stage value={replacement} /><Host tabId="selected" focused /></AppPaneProvider>);
        await act(async () => { staleAcknowledge(); });
        expect(screen.root.findByType('FindSeedProbe').props.findSeed).toEqual(replacement);
        await act(async () => { screen.root.findByType('FindSeedProbe').props.consumeFindSeed(); });
        expect(screen.root.findByType('FindSeedProbe').props.findSeed).toBeNull();
    });
    it('seeds only the focused exact destination once and discards it when that destination closes', async () => {
        const screen = await renderScreen(<AppPaneProvider><Stage /><Host tabId="hidden" focused={false} /><Host tabId="selected" focused /></AppPaneProvider>);
        const [hidden, selected] = screen.root.findAllByType('FindSeedProbe');
        expect(hidden.props.findSeed).toBeNull();
        expect(selected.props.findSeed).toEqual(seed);
        await screen.update(<AppPaneProvider><Stage /><Host tabId="hidden" focused={false} /></AppPaneProvider>);
        await screen.update(<AppPaneProvider><Stage /><Host tabId="selected" focused /></AppPaneProvider>);
        expect(screen.root.findByType('FindSeedProbe').props.findSeed).toBeNull();
    });
});
