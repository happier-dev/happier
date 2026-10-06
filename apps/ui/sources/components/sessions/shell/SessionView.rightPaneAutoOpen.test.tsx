import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPendingMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

installDisconnectedServerSocketBoundary();
let pathname = '/session/s1';
const setParams = vi.fn();
const pendingRequests: string[] = [];
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let previousStorage: ReturnType<typeof storage.getState>;

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 1200, height: 800 }) });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: () => pathname, router: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), setParams } }).module;
    },
    storage: async importOriginal => importOriginal(),
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useFocusEffect: () => {}, useIsFocused: () => true };
});
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: React.PropsWithChildren<{ input?: React.ReactNode }>) => React.createElement('AgentContentView', props, props.input),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: { main?: React.ReactNode }) => React.createElement('AppPaneScopeHost', props, props.main),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({ ChatHeaderView: () => null }));
vi.mock('@/components/sessions/transcript/ChatList', () => ({ ChatList: () => React.createElement('ChatList') }));
vi.mock('@/components/sessions/agentInput', () => ({ AgentInput: () => null }));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({ SessionHeaderActionMenu: () => null }));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({ AttachmentFilePicker: () => null }));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({ VoiceSurface: () => null }));
vi.mock('@/components/ui/forms/Deferred', () => ({ Deferred: (props: React.PropsWithChildren) => props.children }));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({ EmptyMessages: () => React.createElement('EmptyMessages') }));
vi.mock('@/components/sessions/pending/PendingMessagesDragReorderList', () => ({ PendingMessagesDragReorderList: () => React.createElement('PendingMessagesDragReorderList') }));

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
const { storage } = await import('@/sync/domains/state/storage');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { SessionView } = await import('./SessionView');
let pane: ReturnType<typeof useAppPaneScope>;

function PaneProbe() {
    pane = useAppPaneScope(createSessionPaneScopeId('s1', account.home.id));
    return null;
}

function Wrapper({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={account.credentials}><AppPaneProvider><PaneProbe />{children}</AppPaneProvider></InjectedAuthProvider>;
}

async function renderSessionView(paneUrlState?: React.ComponentProps<typeof SessionView>['paneUrlState']) {
    return renderScreen(<SessionView id="s1" routeServerId={account.home.id} paneUrlState={paneUrlState} />, { wrapper: Wrapper });
}

describe('SessionView (right pane auto-open)', () => {
    beforeEach(async () => {
        pathname = '/session/s1';
        setParams.mockClear();
        pendingRequests.length = 0;
        previousStorage = storage.getState();
        await loadSyncSingletonForTests();
        account = await restoreServerAccountForTest({ serverUrl: 'https://session-right-pane.test', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v2/sessions/s1/pending' && (!init?.method || init.method === 'GET')) {
                pendingRequests.push(path);
                return Response.json({ pending: [] });
            }
            if (path === '/v1/sessions/s1/messages') return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
            return new Response('{}', { status: 404 });
        } });
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: account.home.id, active: true })]);
        storage.setState({ isDataReady: true });
        storage.getState().applyLocalSettings({ appPaneScopesV1: {}, sessionsRightPaneDefaultOpen: false, uiMultiPanePanelsEnabled: true }, { persist: false });
        pendingRequests.length = 0;
    });

    afterEach(async () => {
        await standardCleanup();
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        scmStatusSync.stop('s1', account.home.id);
        await account.dispose();
        storage.setState(previousStorage, true);
    });

    it('opens right pane on first visit when sessionsRightPaneDefaultOpen is enabled and no prior tab state exists', async () => {
        storage.getState().applyLocalSettings({ sessionsRightPaneDefaultOpen: true }, { persist: false });
        await renderSessionView();
        expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
    });

    it('does not force open right pane when the user previously interacted (activeTabId set)', async () => {
        storage.getState().applyLocalSettings({ sessionsRightPaneDefaultOpen: true }, { persist: false });
        const screen = await renderScreen(<React.Fragment />, { wrapper: Wrapper });
        await act(async () => { pane.setRightTab('git'); pane.closeRight(); });
        await screen.update(<SessionView id="s1" routeServerId={account.home.id} />);
        expect(pane.scopeState?.right).toMatchObject({ isOpen: false, activeTabId: 'git' });
    });

    it('does not open right pane when the setting is disabled', async () => {
        await renderSessionView();
        expect(pane.scopeState?.right?.isOpen ?? false).toBe(false);
    });

    it('keeps URL pane sync enabled when multi-pane setting is unset', async () => {
        // A missing persisted preference is normalized by the real LocalSettings owner.
        const { uiMultiPanePanelsEnabled: _removed, ...saved } = storage.getState().localSettings;
        const { LocalSettingsSchema } = await import('@/sync/domains/settings/localSettings');
        storage.setState({ localSettings: LocalSettingsSchema.parse(saved) });
        await renderSessionView({ rightTabId: 'git' });
        expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'git' });
    });

    it('disables URL pane sync while the browser is on the details route', async () => {
        pathname = '/session/s1/details';
        await renderSessionView({ rightTabId: 'git' });
        expect(pane.scopeState?.right?.isOpen ?? false).toBe(false);
        expect(setParams).not.toHaveBeenCalled();
    });

    it('re-fetches pending messages when the session view remounts with a pending queue rendered', async () => {
        const { PendingMessagesTranscriptBlock } = await import('@/components/sessions/pending/PendingMessagesTranscriptBlock');
        const content = <>
            <PendingMessagesTranscriptBlock sessionId="s1" pendingMessages={[createPendingMessageFixture({ id: 'p1', localId: 'p1', text: 'pending' })]} discardedMessages={[]} />
            <SessionView id="s1" routeServerId={account.home.id} />
        </>;
        const screen = await renderScreen(content, { wrapper: Wrapper });
        await waitForHomeGovernance(() => expect(pendingRequests).toHaveLength(1));
        expect(storage.getState().sessionPending.s1?.isLoaded).toBe(true);
        await screen.unmount();
        storage.setState({ sessionPending: {} });
        await renderScreen(content, { wrapper: Wrapper });
        await waitForHomeGovernance(() => expect(pendingRequests).toHaveLength(2));
        expect(storage.getState().sessionPending.s1?.isLoaded).toBe(true);
    });
});
