import * as React from 'react';
import Color from 'color';
import { StyleSheet } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionMessagesFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storageStore';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { ChatList } from '@/components/sessions/transcript/ChatList';
import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import { PermissionFooter } from '@/components/tools/shell/permissions/PermissionFooter';
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { SessionView } from '../SessionView';
import { EmbeddedSessionNewChat } from './EmbeddedSessionNewChat';
import { getSessionComposerDraftSnapshot, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionChat, SessionComposer, SessionProvider, SessionTranscript } from '@happier-dev/plugin-ui';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { renderPluginSessionPart } from '@/components/plugins/surfaces/PluginSessionPartHost';
import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import { useIsBeneathPluginSurfaceNestingBoundary } from '@/components/plugins/surfaces/pluginSurfaceNesting';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    EmbeddedSessionComposerPart, EmbeddedSessionProvider, EmbeddedSessionTranscriptPart,
    type SessionViewEmbeddedPresentation,
} from './EmbeddedSessionProvider';

// Only platform adapters, the external recycler and Metro's lazy module loader are replaced. All Session owners,
// stores, catalogs, transcript interaction and rendered controls run their production logic.
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    // The test renderer has no measured viewport. Render the native recycler's rows so the
    // approval assertion reaches the real ToolView rather than only the composer prompt.
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
        emitViewability: true, emitLoadDuringLayout: true }).module;
});
vi.mock('socket.io-client', async (importOriginal) => {
    const { createSocketIoClientBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    return createSocketIoClientBoundary(importOriginal);
});
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
    it.each([true, false])('honors the read-only plugin presentation for inactive Action approvals (%s)', async readOnly => {
        const session = storage.getState().sessions.s1!;
        const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, actionId: 'session.title.set',
            requestedSurface: 'ui', executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui',
                caller: { kind: 'host' }, serverId: account.home.id, sessionId: 's1',
                target: { kind: 'session', sessionId: 's1' }, actionId: 'session.title.set', requestId: 'title-request' },
            actionArgs: { sessionId: 's1', title: 'Investigation' }, summary: 'Name this investigation',
            origin: { kind: 'transcript_tool_call', sessionId: 's1', toolName: 'action_execute' } });
        const message = createToolCallMessageFixture({ id: 'tool-approval', tool: {
            ...createToolCallMessageFixture().tool, id: 'call-approval', name: 'mcp__happier__action_execute',
            input: { actionId: approval.actionId, input: approval.actionArgs },
        } });
        // This fixture publishes a hydrated Account; approval projections wait for that readiness.
        storage.setState({ isDataReady: true, settings: { ...storage.getState().settings, transcriptGroupingMode: 'linear',
                transcriptGroupToolCalls: false, toolViewTimelineChromeMode: 'cards' },
            sessions: { s1: { ...session, active: false } }, sessionMessages: {
            s1: createSessionMessagesFixture({ isLoaded: true, messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message } }),
        } });
        storage.getState().applyArtifacts([{ id: 'approval-embedded', title: approval.summary, isDecrypted: true,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            sourceServerId: account.home.id,
            header: buildApprovalRequestArtifactHeaderV1(approval, { legacyServerId: account.home.id }),
            body: JSON.stringify(approval),
        }]);
        const lifetime: ActiveServerAccountScopeLifetime = {
            scope: { serverId: account.home.id, accountId: 'account-1' },
            isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }),
        };
        const environment = projectHappierUiEnvironment(createPluginSurfaceContextFixture());
        const presentationHost = createPluginUiPrivatePresentationHost(undefined, {
            renderSessionPart: input => renderPluginSessionPart(input, { accountLifetime: lifetime, presented: true, focusEligible: true }),
        });
        const render = (readOnly: boolean) => host(
            <PluginUiHostPresentationScope environment={environment} presentationHost={presentationHost}>
                <SessionChat sessionId="s1" variant={readOnly ? 'transcript' : 'chat'} />
            </PluginUiHostPresentationScope>,
        );
        const screen = await renderScreen(render(readOnly));
        const tool = screen.tree.find(matchesComponent(ToolView));
        const controls = (testID: string) => tool.findAll(node => typeof node.type === 'string' && node.props.testID === testID);
        expect(controls('approval-prompt-card')).toHaveLength(1);
        if (readOnly) {
            expect(controls('approval-prompt-approve')).toHaveLength(0);
            expect(controls('approval-prompt-reject')).toHaveLength(0);
        } else {
            expect(controls('approval-prompt-approve')[0]?.props.disabled).toBe(false);
            expect(controls('approval-prompt-reject')[0]?.props.disabled).toBe(false);
        }
    });

    it.each([0, 1])('offers only granted native models when the frame has no owner metadata view (layout %s)', async (metadataLayoutVersion) => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const allowed = { agentTargetKey, providerConnectionId: null, modelId: 'gpt-6-luna' };
        const { projectComposerOptionsInputV1 } = await import('@happier-dev/protocol/embed');
        const metadata = { path: '/tmp', host: 'test-host', flavor: 'codex' };
        storage.setState({ sessions: { s1: createSessionFixture({
            id: 's1', serverId: account.home.id, active: true, ownerMetadataView: null,
            metadataLayoutVersion,
            metadata: metadataLayoutVersion === 1
                ? parseDecryptedSessionMetadata(projectSessionSharedMetadataV1({ metadata }), metadataLayoutVersion)
                : metadata,
            composerOptionsInput: projectComposerOptionsInputV1({ sessionModelsV1: {
                v: 1, agentId: 'codex', updatedAt: 1, currentModelId: 'gpt-6-luna',
                availableModels: [{ id: 'gpt-6-luna', name: 'Luna' }, { id: 'other-model', name: 'Other' }],
            } }),
        }) } });
        const screen = await renderScreen(host(embedded({ ...CHAT, modelPicker: true, allowedModels: [allowed] })));
        const input = screen.tree.findAll(matchesComponent(AgentInput))[0];
        expect(React.isValidElement(input.props.modelContentOverride)).toBe(true);
        const detail = await renderScreen(input.props.modelContentOverride);
        const allowedId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, null, allowed.modelId])}`;
        expect(detail.findByTestId(allowedId)).not.toBeNull();
        expect(detail.findByTestId(`model-picker-overlay-option:${JSON.stringify([agentTargetKey, null, 'other-model'])}`)).toBeNull();
        expect(detail.findByTestId('model-picker-overlay-option:automatic')).toBeNull();
        expect(detail.getTextContent()).not.toContain('agentInput.model.configureInCli');
        expect(detail.getTextContent()).not.toContain('agentInput.model.custom');
    });

    it('keeps the exact Home in Session parts rendered outside the plugin mount tree', async () => {
        const lifetime: ActiveServerAccountScopeLifetime = {
            scope: { serverId: account.home.id, accountId: 'account-1' },
            isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }),
        };
        const environment = projectHappierUiEnvironment(createPluginSurfaceContextFixture());
        // Details/header slots render outside the mount ancestry. The registered renderer must
        // carry its own exact mount facts, like the Host API and other bridged presentation facts.
        const presentationHost = createPluginUiPrivatePresentationHost(undefined, {
            renderSessionPart: input => renderPluginSessionPart(input, {
                accountLifetime: lifetime, presented: true, focusEligible: false,
            }),
        });
        const screen = await renderScreen(host(
            <PluginUiHostPresentationScope environment={environment} presentationHost={presentationHost}>
                <SessionChat sessionId="s1" />
            </PluginUiHostPresentationScope>,
        ));
        expect(screen.tree.findHostByTestId('embedded-session-unavailable')).toBeNull();
        expect(screen.tree.findAll(matchesComponent(ChatList))).toHaveLength(1);
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(1);
        expect(screen.tree.findByType(EmbeddedSessionProvider).props).toMatchObject({
            serverId: account.home.id, surfaceFocused: false, surfaceVisible: true,
        });
    });

    it('composes public plugin Session parts through the registered host into one real controller', async () => {
        const lifetime: ActiveServerAccountScopeLifetime = {
            scope: { serverId: account.home.id, accountId: 'account-1' },
            isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }),
        };
        const environment = projectHappierUiEnvironment(createPluginSurfaceContextFixture());
        function NestingProbe() {
            return React.createElement('PluginNestingProbe', { testID: 'plugin-nesting', beneath: useIsBeneathPluginSurfaceNestingBoundary() });
        }
        const render = (readOnly = false, focusEligible = true) => host(
            <PluginUiHostPresentationScope environment={environment} presentationHost={createPluginUiPrivatePresentationHost(undefined, {
                renderSessionPart: input => renderPluginSessionPart(input, { accountLifetime: lifetime, presented: true, focusEligible }),
            })}>
                <SessionProvider sessionId="s1" readOnly={readOnly}>
                    <SessionTranscript testID="plugin-transcript" />
                    <SessionTranscript testID="plugin-duplicate-transcript" />
                    <SessionComposer testID="plugin-composer" />
                    <SessionComposer testID="plugin-duplicate-composer" />
                    <NestingProbe />
                </SessionProvider>
            </PluginUiHostPresentationScope>
        );
        const screen = await renderScreen(render());
        expect(screen.tree.findAll(matchesComponent(ChatList))).toHaveLength(1);
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(1);
        expect(screen.tree.findAllHostsByTestId('plugin-transcript')).toHaveLength(1);
        expect(screen.tree.findAllHostsByTestId('plugin-duplicate-transcript')).toHaveLength(0);
        expect(screen.tree.findAllHostsByTestId('plugin-duplicate-composer')).toHaveLength(0);
        expect(screen.tree.findHostByTestId('plugin-nesting')?.props.beneath).toBe(true);
        const controller = screen.tree.findByType(EmbeddedSessionProvider);
        expect(controller.props).toMatchObject({ serverId: account.home.id,
            target: { kind: 'session', sessionId: 's1' }, surfaceFocused: true, surfaceVisible: true,
            presentation: { kind: 'embedded', composer: 'auto' } });
        expect(Object.keys(controller.props.presentation).sort()).toEqual(['composer', 'kind']);
        await screen.update(render(false, false));
        expect(screen.tree.findByType(EmbeddedSessionProvider)).toBe(controller);
        expect(screen.tree.findByType(EmbeddedSessionProvider).props).toMatchObject({ surfaceFocused: false, surfaceVisible: true });
        expect(screen.tree.findAll(matchesComponent(ChatList))).toHaveLength(1);
        await screen.update(render(true));
        expect(screen.tree.findAll(matchesComponent(ChatList))).toHaveLength(1);
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(0);
        expect(screen.tree.findByType(EmbeddedSessionProvider).props.presentation).toEqual({ kind: 'embedded', composer: 'none' });
    });

    it('renders public plugin Session fallback without registration and denies an unscoped host controller', async () => {
        const environment = projectHappierUiEnvironment(createPluginSurfaceContextFixture());
        const render = (registered: boolean) => host(
            <PluginUiHostPresentationScope environment={environment}
                presentationHost={createPluginUiPrivatePresentationHost(undefined,
                    registered ? { renderSessionPart: input => renderPluginSessionPart(input, {
                        accountLifetime: null, presented: true, focusEligible: true,
                    }) } : {})}>
                <SessionChat sessionId="s1" fallback={<span data-testid="plugin-session-fallback" />} />
            </PluginUiHostPresentationScope>
        );
        const screen = await renderScreen(render(false));
        expect(screen.tree.findHostByTestId('plugin-session-fallback')).not.toBeNull();
        expect(screen.tree.findAllByType(EmbeddedSessionProvider)).toHaveLength(0);
        await screen.update(render(true));
        expect(screen.tree.findHostByTestId('embedded-session-unavailable')).not.toBeNull();
        expect(screen.tree.findHostByTestId('plugin-session-fallback')).toBeNull();
        expect(screen.tree.findAllByType(EmbeddedSessionProvider)).toHaveLength(0);
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(0);
    });

    it('admits a spawn-only embed draft without an Account lifetime and restores it across loading remounts', async () => {
        // A new-chat child has only its admitted create target. Unlike an existing-session child,
        // it never establishes an embedSession Sync scope or Account-scoped draft transport.
        const draftScope = { serverId: 'https://spawn-only.example', accountId: 'account-1' };
        const draftId = '00000000-0000-4000-8000-000000000001';
        const renderNewChat = (identity: string) => host(<EmbeddedSessionNewChat
            target={{ kind: 'new', creation: { draftId: identity, draftScope }, onCreate: async () => ({ sessionId: 'created' }), onPresented: () => {} }}
            serverId={draftScope.serverId} onCreated={() => {}}
        />);
        const screen = await renderScreen(renderNewChat(draftId));
        await vi.waitFor(() => expect(screen.tree.findHostByTestId('new-session-composer-input')).not.toBeNull());
        expect(screen.tree.findHostByTestId('new-session-draft-loading')).toBeNull();
        await act(async () => { screen.tree.changeTextByTestId('new-session-composer-input', 'Unsent embedded draft'); });
        expect(screen.tree.findHostByTestId('new-session-composer-input')?.props.value).toBe('Unsent embedded draft');
        await screen.update(host(<span>Loading</span>));
        expect(getSessionComposerDraftSnapshot(draftScope, { kind: 'newSession', draftId })?.composer.text.value).toBe('Unsent embedded draft');
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

    it('asks what its host asks in an empty embedded composer, never the new-session question', async () => {
        const screen = await renderScreen(host(embedded({ ...CHAT, composerPlaceholder: 'Reply in this step…' })));
        expect(screen.tree.findAll(matchesComponent(AgentInput))[0]?.props.placeholder).toBe('Reply in this step…');
    });

    it('renders embedded composer Elements through the root material runtime', async () => {
        const { GlassMaterialRuntime } = await import('@/components/ui/glass/GlassMaterialRuntime');
        const { useSetGlassAtmosphereBehind } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        storage.setState({ settings: { ...storage.getState().settings, glassSurfaceMaterials: glassPresetMaterials('auto') } });
        function Backing() {
            const setAtmosphere = useSetGlassAtmosphereBehind();
            React.useEffect(() => { setAtmosphere('wallpaper'); }, [setAtmosphere]);
            return embedded();
        }
        const screen = await renderScreen(host(<GlassMaterialRuntime><Backing /></GlassMaterialRuntime>));
        const composer = screen.tree.findHostByTestId('agent-input-material-surface')!;
        const paint = StyleSheet.flatten(composer.props.style);
        expect(Color(paint.backgroundColor).alpha()).toBeCloseTo(glassPresetMaterials('auto').card.opacity, 2);
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(1);
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

    it('keeps nested controllers independent while suppressing duplicates within each controller', async () => {
        const screen = await renderScreen(host(embedded(CHAT, <>
            <EmbeddedSessionTranscriptPart testID="outer-transcript" />
            <EmbeddedSessionComposerPart testID="outer-composer" />
            {embedded(CHAT, <>
                <EmbeddedSessionTranscriptPart testID="inner-transcript" />
                <EmbeddedSessionTranscriptPart testID="inner-duplicate" />
                <EmbeddedSessionComposerPart testID="inner-composer" />
            </>)}
        </>)));
        expect(screen.tree.findAllHostsByTestId('outer-transcript')).toHaveLength(1);
        expect(screen.tree.findAllHostsByTestId('inner-transcript')).toHaveLength(1);
        expect(screen.tree.findAllHostsByTestId('inner-duplicate')).toHaveLength(0);
        expect(screen.tree.findAll(matchesComponent(ChatList))).toHaveLength(2);
        expect(screen.tree.findAll(matchesComponent(AgentInput))).toHaveLength(2);
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
