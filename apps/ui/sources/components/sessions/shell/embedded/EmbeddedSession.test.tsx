import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionMessagesFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storageStore';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { ChatList } from '@/components/sessions/transcript/ChatList';
import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import { PermissionFooter } from '@/components/tools/shell/permissions/PermissionFooter';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { SessionView } from '../SessionView';
import { EmbeddedSessionNewChat } from './EmbeddedSessionNewChat';
import { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import {
    EmbeddedSessionComposerPart, EmbeddedSessionProvider, EmbeddedSessionTranscriptPart,
    type SessionViewEmbeddedPresentation,
} from './EmbeddedSessionProvider';

// Only platform adapters and Metro's lazy module loader are replaced. All Session owners,
// stores, catalogs, transcript interaction and rendered controls run their production logic.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const CHAT = Object.freeze({ kind: 'embedded', composer: 'auto' } as const);
let previous: ReturnType<typeof storage.getState>;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;

installDisconnectedServerSocketBoundary();

// React's renderer can expose both memo's public wrapper and its underlying component.
// Count the rendered component once, rather than both nodes for one mounted owner.
function matchesComponent(component: unknown) {
    const renderedType = typeof component === 'object' && component !== null && 'type' in component
        ? component.type : component;
    return (node: ReactTestInstance) => node.type === renderedType;
}

function embedded(presentation: SessionViewEmbeddedPresentation = CHAT, children?: React.ReactNode) {
    return <EmbeddedSessionProvider
        target={{ kind: 'session', sessionId: 's1' }}
        serverId={account.home.id} presentation={presentation} surfaceFocused surfaceVisible
    >{children}</EmbeddedSessionProvider>;
}

function host(children: React.ReactNode) {
    return <InjectedAuthProvider credentials={account.credentials}>
        <AppPaneProvider>{children}</AppPaneProvider>
    </InjectedAuthProvider>;
}

/** The same rendered prompt boundary as a transcript row, consuming its actual mounted source. */
function PendingPrompt() {
    const source = useSessionTranscriptSource();
    const interaction = source.useInteraction();
    return <PermissionFooter
        sessionId={source.sessionId} serverId={source.serverId ?? undefined}
        permission={{ id: 'pending-read', status: 'pending' }}
        toolName="Read" toolInput={{ file_path: '/tmp/readme' }}
        canApprovePermissions={interaction.canApprovePermissions}
        disabledReason={interaction.permissionDisabledReason}
    />;
}

beforeEach(async () => {
    installShippedNativeFrameScheduler();
    await loadSyncSingletonForTests();
    previous = storage.getState();
    account = await restoreServerAccountForTest({
        serverUrl: 'https://embedded-session.test', accountId: 'account-1',
        request: async (url) => {
            const path = new URL(String(url)).pathname;
            const json = (value: unknown) => new Response(JSON.stringify(value));
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return json(createRootLayoutFeaturesResponse({ features: { sessions: { drafts: { enabled: false } } } }));
            }
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/sessions/s1/pending') return json({ pending: [] });
            if (path === '/v1/sessions/s1/messages') return json({ messages: [], hasMore: false, nextBeforeSeq: null });
            return new Response('{}', { status: 404 });
        },
    });
    storage.setState({ sessions: { s1: createSessionFixture({
        id: 's1', serverId: account.home.id, active: true,
        metadata: { path: '/tmp', homeDir: '/tmp', host: 'test-host', machineId: 'm1', flavor: 'codex' },
    }) }, sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: true }) } });
});
afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    resetSessionDraftRepositoryForTests();
    storage.setState(previous, true);
});

describe('EmbeddedSessionProvider', () => {
    it('restores the admitted new-chat draft across loading remounts without sharing it with another intent', async () => {
        const draftScope = { serverId: account.home.id, accountId: 'account-1' };
        const draftId = '00000000-0000-4000-8000-000000000001';
        const renderNewChat = (identity: string) => host(<EmbeddedSessionNewChat
            target={{ kind: 'new', creation: { draftId: identity, draftScope }, onCreate: async () => ({ sessionId: 'created' }) }}
            serverId={account.home.id} onCreated={() => {}}
        />);
        const screen = await renderScreen(renderNewChat(draftId));
        await act(async () => { screen.tree.changeTextByTestId('new-session-composer-input', 'Unsent embedded draft'); });
        expect(screen.tree.findHostByTestId('new-session-composer-input')?.props.value).toBe('Unsent embedded draft');
        await screen.update(host(<span>Loading</span>));
        expect(getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })?.document.composer.text.value).toBe('Unsent embedded draft');
        await screen.update(renderNewChat(draftId));
        expect(screen.tree.findHostByTestId('new-session-composer-input')?.props.value).toBe('Unsent embedded draft');
        await screen.update(host(<span>Loading</span>));
        await screen.update(renderNewChat('00000000-0000-4000-8000-000000000002'));
        expect(screen.tree.findHostByTestId('new-session-composer-input')?.props.value).toBe('');
    });
    it('renders the real transcript and composer without claiming a route pane', async () => {
        const screen = await renderScreen(host(embedded()));
        expect(screen.tree.findAll(matchesComponent(ChatList))).toHaveLength(1);
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(1);
        expect(screen.tree.findAll(matchesComponent(AppPaneScopeHost))).toHaveLength(0);
    });

    it('leaves the route pane mounted when a second presentation appears and disappears', async () => {
        const control: { setVisible?: (visible: boolean) => void } = {};
        function Presentations() {
            const [visible, setVisible] = React.useState(false);
            control.setVisible = setVisible;
            return host(<><SessionView id="s1" routeServerId={account.home.id} />{visible ? embedded() : null}</>);
        }
        const screen = await renderScreen(<Presentations />);
        const pane = screen.tree.find(matchesComponent(AppPaneScopeHost));
        await act(async () => control.setVisible?.(true));
        expect(screen.tree.findAll(matchesComponent(AppPaneScopeHost))).toEqual([pane]);
        expect(screen.tree.findAll(matchesComponent(ChatList))).toHaveLength(2);
        await act(async () => control.setVisible?.(false));
        expect(screen.tree.findAll(matchesComponent(AppPaneScopeHost))).toEqual([pane]);
    });

    it('renders one real transcript and composer for custom parts, suppressing duplicate claims', async () => {
        const screen = await renderScreen(host(embedded(CHAT, <>
            <EmbeddedSessionTranscriptPart testID="lead-transcript" />
            <EmbeddedSessionTranscriptPart testID="duplicate-transcript" />
            <EmbeddedSessionComposerPart testID="lead-composer" />
        </>)));
        expect(screen.tree.findAll(matchesComponent(ChatList))).toHaveLength(1);
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(1);
        expect(screen.tree.findAllHostsByTestId('lead-transcript')).toHaveLength(1);
        expect(screen.tree.findAllHostsByTestId('duplicate-transcript')).toHaveLength(0);
    });

    it.each([
        ['openSession', 'session.embedded.respondInSession'],
        ['readOnly', 'session.sharing.permissionApprovalsDisabledReadOnly'],
    ] as const)('renders a non-actionable prompt from the actual %s source', async (notice, message) => {
        const screen = await renderScreen(host(embedded(
            { kind: 'embedded', composer: 'none', readOnlyNotice: notice }, <PendingPrompt />,
        )));
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(0);
        expect(screen.getTextContent()).toContain(message);
        const prompt = screen.tree.findByType(PermissionFooter);
        expect(prompt.findAll((node) => typeof node.type === 'string'
            && (typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function')))
            .toHaveLength(0);
    });

    it('does not render a composer when Account Session access forbids input', async () => {
        storage.setState({ sessions: { s1: createSessionFixture({
            id: 's1', serverId: account.home.id, accessLevel: 'view',
        }) } });
        const screen = await renderScreen(host(embedded()));
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(0);
    });
});
