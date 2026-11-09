import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Static route/store imports reach the SDK before the runtime fixture's setup hook.
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { DeferredPromise } from './testUtils/deferredPromise';
import { createDeferredPromise } from './testUtils/deferredPromise';
import { measureScreenContentBottom, PublishBottomChromeHeight } from './testUtils/bottomChromeViewport';
import { SessionCockpitChromeRegistryProvider } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storageStore';
import {
  createSessionFixture,
  createSessionMessagesFixture,
  flushHookEffects,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});

// Supply the native recycler viewport, not a transcript/route implementation.
vi.mock('@legendapp/list/react-native', async importOriginal => {
  const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
  return (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({ original, emitViewability: true }).module;
});

let mockSession: any = null;
let mockMessage: any = null;
let mockMessagesById: Record<string, any> = {};
let mockCommittedMessages: any[] = [];
const toolFullViewSpy = vi.fn();
const deriveSessionParticipantTargetsMock = vi.fn<(..._args: unknown[]) => ReadonlyArray<SessionParticipantTarget>>(() => []);
const deriveAutoRecipientFromFocusedToolTranscriptMock = vi.fn<(..._args: unknown[]) => ParticipantRecipientV1 | null>(() => null);
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerCanGoBackSpy = vi.fn(() => false);
let sync: typeof import('@/sync/sync').sync;
let syncOnSessionVisibleSpy: MockInstance<typeof sync.onSessionVisible>;
let syncLoadOlderMessagesSpy: MockInstance<typeof sync.loadOlderMessages>;
let mockSearchParams: any = { id: 'session-1', messageId: 'message-1' };
let loadOlderDeferred: DeferredPromise<Response> | null = null;
let initialMessagesDeferred: DeferredPromise<Response> | null = null;
let olderHistoryAvailable = false;
let coldSource = false;
let sourceStatus = 200;
let sourceReads = 0;
let sourceSessionId = 'session-1';
const mockTheme = {
  colors: {
    chrome: { header: { background: '#000', foreground: '#fff' } },
    text: { primary: '#fff', secondary: '#aaa' },
  },
} as const;

installSessionRouteCommonModuleMocks({
  nativeNavigation: async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }),
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      TurboModuleRegistry: { get: () => ({}) },
      useWindowDimensions: () => ({ width: 1400, height: 900, scale: 1, fontScale: 1 }),
    });
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
      router: {
        back: routerBackSpy,
        push: vi.fn(),
        replace: routerReplaceSpy,
        setParams: vi.fn(),
        canGoBack: routerCanGoBackSpy,
      } as any,
    });
    return {
      ...routerMock.module,
      useLocalSearchParams: () => mockSearchParams,
      Stack: { Screen: () => null },
    };
  },
  unistyles: async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: mockTheme as any,
    });
  },
});

const runtime = installSessionPaneRuntimeTestHarness({
  sessionId: 'session-1',
  request: async (url, init) => {
    const address = new URL(String(url));
    if (coldSource && address.pathname === `/v2/sessions/${sourceSessionId}`) {
      sourceReads += 1;
      if (sourceStatus !== 200) return Response.json({ error: sourceStatus === 403 ? 'Forbidden' : 'Session not found' }, { status: sourceStatus });
      return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: sourceSessionId, active: false })));
    }
    if ((init?.method ?? 'GET') !== 'GET' || address.pathname !== '/v1/sessions/session-1/messages') return null;
    if (coldSource) return Response.json({ messages: [{
      id: 'source-answer', seq: 1, localId: null, sidechainId: null, createdAt: 1, updatedAt: 1,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'output', data: {
        type: 'assistant', uuid: 'source-answer-uuid', isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Exact inactive source answer' }] },
      } } } },
    }], hasMore: false, nextBeforeSeq: null });
    if (address.searchParams.has('beforeSeq') && loadOlderDeferred) return (await loadOlderDeferred.promise).clone();
    if (initialMessagesDeferred) return (await initialMessagesDeferred.promise).clone();
    return Response.json({ messages: [], hasMore: olderHistoryAvailable, nextBeforeSeq: olderHistoryAvailable ? 2 : null });
  },
});

vi.mock('@/components/ui/forms/Deferred', () => ({ Deferred: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/tools/shell/views/ToolFullView', () => ({
  ToolFullView: (props: any) => {
    toolFullViewSpy(props);
    return React.createElement(
      'ToolFullView',
      { testID: 'tool-full-view' },
      ...(props.messages ?? []).map((message: { id: string }) =>
        React.createElement('View', {
          key: message.id,
          testID: `tool-fullview-transcript-message-${message.id}`,
        }),
      ),
    );
  },
}));
vi.mock('@/components/tools/shell/presentation/ToolStatusIndicator', () => ({ ToolStatusIndicator: () => React.createElement('ToolStatusIndicator') }));
vi.mock('@/components/ui/text/Text', () => ({ Text: ({ children }: any) => React.createElement('Text', null, children) }));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) =>
    React.createElement(
      'AgentInput',
      { ...props, testID: 'session-composer-input' },
      React.createElement('Pressable', {
        testID: 'session-composer-send',
        onPress: props.onSend,
      }),
      (props.extraActionChips ?? []).map((chip: any, idx: number) =>
        React.createElement(React.Fragment, { key: String(chip?.key ?? idx) }, chip.render({})),
      ),
    ),
}));
vi.mock('@/components/autocomplete/suggestions', () => ({ getSuggestions: () => [] }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
vi.mock('@/sync/domains/session/participants/deriveSessionParticipantTargets', () => ({
  deriveAutoRecipientFromFocusedToolTranscript: deriveAutoRecipientFromFocusedToolTranscriptMock,
  deriveSessionParticipantTargets: deriveSessionParticipantTargetsMock,
}));
vi.mock('@/components/sessions/agentInput/routing/RecipientChip', () => ({
  RecipientChip: (props: any) => {
    return React.createElement('RecipientChip', {
      ...props,
      testID: 'agent-input-recipient-chip',
    });
  },
}));
vi.mock('@/sync/domains/input/participants/resolveParticipantRoutedSend', async () => {
  const actual = await vi.importActual<typeof import('@/sync/domains/input/participants/resolveParticipantRoutedSend')>(
    '@/sync/domains/input/participants/resolveParticipantRoutedSend',
  );
  return {
    ...actual,
    resolveParticipantRoutedSend: () => null,
  };
});

const {
  default: MessageScreen,
  createSessionMessageRouteStyles,
} = await import('@/app/(app)/session/[id]/message/[messageId]');
const { readInboxSessionTitle } = await import('@/components/inbox/sessionAttention/inboxSessionPrivacy');

describe('Session message route hydration', () => {
  beforeEach(async () => {
    ({ sync } = await import('@/sync/sync'));
    // Observe the real owner without replacing its admission, paging or attachment logic.
    syncOnSessionVisibleSpy = vi.spyOn(sync, 'onSessionVisible');
    syncLoadOlderMessagesSpy = vi.spyOn(sync, 'loadOlderMessages');
    mockSession = { id: 'session-1', accessLevel: 'edit', canApprovePermissions: false };
    mockMessage = null;
    mockMessagesById = {};
    mockCommittedMessages = [];
    loadOlderDeferred = null;
    initialMessagesDeferred = null;
    olderHistoryAvailable = false;
    coldSource = false;
    sourceStatus = 200;
    sourceReads = 0;
    sourceSessionId = 'session-1';
    mockSearchParams = { id: 'session-1', messageId: 'message-1' };
    routerBackSpy.mockClear();
    routerReplaceSpy.mockClear();
    routerCanGoBackSpy.mockClear();
    syncOnSessionVisibleSpy.mockClear();
    syncLoadOlderMessagesSpy.mockClear();
    toolFullViewSpy.mockClear();
    deriveSessionParticipantTargetsMock.mockReset();
    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReset();
    deriveSessionParticipantTargetsMock.mockReturnValue([]);
    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReturnValue(null);
  });

  afterEach(async () => {
    if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
      vi.clearAllTimers();
    }
    await standardCleanup();
    coldSource = false;
    loadOlderDeferred?.resolve(Response.json({ messages: [], hasMore: false, nextBeforeSeq: null }));
    initialMessagesDeferred?.resolve(Response.json({ messages: [], hasMore: false, nextBeforeSeq: null }));
    syncOnSessionVisibleSpy.mockRestore();
    syncLoadOlderMessagesSpy.mockRestore();
    vi.useRealTimers();
  });

  function applyMessageFixtures() {
    const defaults = createSessionFixture();
    storage.getState().applySessions([createSessionFixture({
      ...mockSession,
      serverId: runtime.serverId,
      metadata: { ...defaults.metadata, ...mockSession.metadata },
    })]);
    const messagesById = { ...mockMessagesById };
    for (const message of mockCommittedMessages) messagesById[message.id] = message;
    if (mockMessage) messagesById[mockMessage.id] = mockMessage;
    const messages = mockCommittedMessages.length > 0 ? mockCommittedMessages : Object.values(messagesById);
    const transcript = createSessionMessagesFixture({
      messagesById,
      messageIdsOldestFirst: messages.map(message => message.id),
      isLoaded: true,
      messagesVersion: (storage.getState().sessionMessages['session-1']?.messagesVersion ?? 0) + 1,
    });
    for (const message of Object.values(messagesById)) {
      if (message.kind === 'tool-call' && typeof message.tool.id === 'string') {
        transcript.reducerState.toolIdToMessageId.set(message.tool.id, message.id);
      }
    }
    storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, 'session-1': transcript } }));
  }

  async function renderMessageScreen(Screen: React.ComponentType<any>) {
    applyMessageFixtures();
    return renderScreen(<runtime.Wrapper><Screen /></runtime.Wrapper>);
  }

  it.each(['profile', 'canonical'] as const)('opens an inactive unlisted source in its transcript at the committed server message (%s Home)', async home => {
    coldSource = true;
    mockSearchParams = { id: 'session-1', serverId: home === 'canonical' ? runtime.serverIdentityId : runtime.serverId,
      messageId: 'server:source-answer' };
    storage.setState({ sessions: {}, sessionMessages: {}, sessionListRowsByServerId: {}, sessionListIndexByServerId: {} });
    const screen = await renderScreen(<runtime.Wrapper><MessageScreen /></runtime.Wrapper>);
    await waitForHomeGovernance(() => {
      expect(storage.getState().sessionMessages['session-1']?.isLoaded).toBe(true);
    });
    expect(storage.getState().sessions['session-1']?.active).toBe(false);
    expect(routerBackSpy).not.toHaveBeenCalled();
    expect(routerReplaceSpy).not.toHaveBeenCalled();
    const sourceMessageId = Object.values(storage.getState().sessionMessages['session-1']!.messagesById)
      .find(message => message.realID === 'source-answer')!.id;
    await waitForHomeGovernance(() => expect(screen.findAllByTestId(`transcript-message-${sourceMessageId}`)).toHaveLength(1));
    const { ChatList } = await import('@/components/sessions/transcript/ChatList');
    expect(screen.findByType(ChatList).props).toMatchObject({ jumpToSeq: 1, jumpToMessageId: 'server:source-answer' });
  });

  it.each([403, 404])('does not display a cached source after the exact Session read returns %s', async status => {
    coldSource = true;
    sourceStatus = status;
    // A definitive deletion must not be followed by resurrecting that same
    // immutable Session id in another case's synthetic Home.
    sourceSessionId = `withdrawn-source-${status}`;
    mockSearchParams = { id: sourceSessionId, serverId: runtime.serverId, messageId: 'cached-answer' };
    mockMessage = { kind: 'tool-call', id: 'cached-answer', seq: 1, localId: null, createdAt: 1,
      tool: { id: 'cached-call', name: 'Task', input: {}, result: null, state: 'completed' }, children: [] };
    storage.getState().applySessions([createSessionFixture({ id: sourceSessionId, serverId: runtime.serverId })]);
    storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, [sourceSessionId]: createSessionMessagesFixture({
      messageIdsOldestFirst: ['cached-answer'], messagesById: { 'cached-answer': mockMessage }, isLoaded: true,
    }) } }));
    const screen = await renderScreen(<runtime.Wrapper><MessageScreen /></runtime.Wrapper>);
    await waitForHomeGovernance(() => expect(sourceReads).toBeGreaterThan(0));
    await flushHookEffects({ cycles: 5, turns: 2 });
    expect(screen.findAllByTestId('session-invalid-link')).toHaveLength(1);
    expect(screen.findAllByTestId('tool-full-view')).toHaveLength(0);
    expect(screen.tree.findAll(node => node.props.testID?.startsWith('transcript-message-') && typeof node.type === 'string')).toHaveLength(0);
    expect(routerBackSpy).not.toHaveBeenCalled();
  });

  it('keeps the focused transcript viewport above measured bottom chrome as its height changes', async () => {
    mockMessage = {
      kind: 'tool-call', id: 'message-1', localId: null, createdAt: 1,
      tool: { id: 'task-1', name: 'Task', input: {}, result: null, state: 'completed' }, children: [],
    };
    const render = (height: number) => (
      <runtime.Wrapper><SessionCockpitChromeRegistryProvider>
        <PublishBottomChromeHeight height={height} />
        <MessageScreen />
      </SessionCockpitChromeRegistryProvider></runtime.Wrapper>
    );
    applyMessageFixtures();
    const screen = await renderScreen(render(94));
    for (const height of [94, 121, 0]) {
      await screen.update(render(height));
      // Native text/list measurement is outside this test; Yoga exercises the screen's real frame.
      const route = screen.findAllByType('View').find((node) => node.props.style?.flex === 1 && node.props.style?.minHeight === 0);
      expect(route).toBeTruthy();
      expect(measureScreenContentBottom(route!.props.style, 700)).toBe(700 - height);
    }
  });

  describe('names the Agent that asked a question a manager answered', () => {
    const openAnsweredQuestion = (answeredBy: unknown) => {
      mockSearchParams = { id: 'session-1', messageId: 'message-1' };
      mockSession = { id: 'session-1', accessLevel: 'edit', metadata: { name: 'Worker that asks' } };
      mockMessage = {
        kind: 'tool-call', id: 'message-1', localId: null, createdAt: 1, children: [],
        tool: {
          id: 'q1', name: 'AskUserQuestion', state: 'completed', result: null,
          input: { questions: [{ question: 'Record manager attribution?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] },
          permission: { id: 'q1', status: 'approved', answeredBy },
        },
      };
    };
    const headerAskedBy = () => (toolFullViewSpy.mock.calls.at(-1)?.[0].header as React.ReactElement<{ askedBy?: string | null }>).props.askedBy;

    it('passes the asking Session name to the page header when a manager Session answered the question', async () => {
      openAnsweredQuestion({ kind: 'session', sessionId: 'manager-1' });
      await renderMessageScreen(MessageScreen);
      // The page names the asker as the Inbox does: the Session's own title projection.
      const asker = storage.getState().sessions['session-1'];
      expect(asker).toBeDefined();
      expect(headerAskedBy()).toBe(readInboxSessionTitle(asker!, asker!.serverId ?? null));
    });

    it('adds no asker when the person answered it', async () => {
      openAnsweredQuestion({ kind: 'person' });
      await renderMessageScreen(MessageScreen);
      expect(headerAskedBy() ?? null).toBeNull();
    });
  });

  it('renders invalid link fallback when session id param is missing', async () => {
    mockSearchParams = { id: '', messageId: 'message-1' };
    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('session-invalid-link')).toHaveLength(1);
    expect(syncOnSessionVisibleSpy).not.toHaveBeenCalled();
  });

  it('keeps an exhausted message link unavailable on its route rather than navigating back', async () => {
    // The Home's real initial page explicitly ends this empty history. Pending
    // cursor retention is covered separately below through a held HTTP read.
    const screen = await renderMessageScreen(MessageScreen);
    await vi.waitFor(() => {
      expect(screen.findAllByTestId('session-invalid-link')).toHaveLength(1);
    }, { timeout: 5_000 });
    expect(routerReplaceSpy).not.toHaveBeenCalled();
    expect(routerBackSpy).not.toHaveBeenCalled();
  });

  it('keeps a stable tool route open when the route id resolves to a hydrated internal tool message id', async () => {

    mockSearchParams = { id: 'session-1', messageId: 'tool:call_1' };
    mockMessagesById = {
      'resolved-tool-message': {
        kind: 'tool-call',
        id: 'resolved-tool-message',
        localId: null,
        createdAt: 1,
        tool: { id: 'call_1', name: 'Task', input: {}, result: null, state: 'running' },
        children: [],
      },
    };

    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('tool-full-view')).toHaveLength(1);
    expect(routerReplaceSpy).not.toHaveBeenCalled();
    expect(routerBackSpy).not.toHaveBeenCalled();
  });

  it('filters ignored Claude teammate lifecycle events from the focused transcript route', async () => {

    mockSearchParams = { id: 'session-1', messageId: 'tool-msg-1' };
    // Agent behavior reads private owner metadata after the real Home hydration.
    mockSession = { id: 'session-1', accessLevel: 'owner', canApprovePermissions: false, metadata: { flavor: 'claude' } };
    mockMessage = {
      kind: 'tool-call',
      id: 'tool-msg-1',
      localId: null,
      createdAt: 1,
      tool: {
        id: 'toolu_beta',
        name: 'Agent',
        input: { name: 'beta' },
        result: null,
        state: 'completed',
      },
      children: [
        {
          kind: 'agent-text',
          id: 'meaningful',
          localId: null,
          createdAt: 2,
          text: 'Meaningful teammate output',
          meta: null,
        },
        {
          kind: 'agent-text',
          id: 'lifecycle-1',
          localId: null,
          createdAt: 3,
          text: '{"type":"idle_notification","from":"beta"}',
          meta: null,
        },
        {
          kind: 'agent-text',
          id: 'lifecycle-2',
          localId: null,
          createdAt: 4,
          text: '{"type":"shutdown_approved","from":"beta"}',
          meta: null,
        },
      ],
    };
    mockCommittedMessages = [
      {
        kind: 'tool-call',
        id: 'team-create',
        localId: null,
        createdAt: 0,
        tool: {
          name: 'AgentTeamCreate',
          input: { team_name: 'qa121482' },
          result: null,
          state: 'completed',
        },
        children: [],
      },
      mockMessage,
    ];

    deriveSessionParticipantTargetsMock.mockReturnValue([
      {
        key: 'agent_team_member:qa121482:beta@qa121482',
        displayLabel: 'beta',
        recipient: {
          kind: 'agent_team_member',
          teamId: 'qa121482',
          memberId: 'beta@qa121482',
          memberLabel: 'beta',
        },
      },
    ]);
    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReturnValue({
      kind: 'agent_team_member',
      teamId: 'qa121482',
      memberId: 'beta@qa121482',
      memberLabel: 'beta',
    });

    const screen = await renderMessageScreen(MessageScreen);

    expect(screen.findAllByTestId('tool-fullview-transcript-message-meaningful')).toHaveLength(1);
    expect(screen.findAllByTestId('tool-fullview-transcript-message-lifecycle-1')).toHaveLength(0);
    expect(screen.findAllByTestId('tool-fullview-transcript-message-lifecycle-2')).toHaveLength(0);
  });

  it('keeps waiting when older paging is not ready instead of redirecting away from the deep link', async () => {

    // A retained transcript can be loaded before this Account's initial HTTP
    // page establishes the real older cursor. Keep that network read pending.
    initialMessagesDeferred = createDeferredPromise<Response>();

    await renderMessageScreen(MessageScreen);
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(await sync.loadOlderMessages('session-1')).toMatchObject({ status: 'not_ready' });
    await vi.waitFor(() => {
      expect(syncLoadOlderMessagesSpy.mock.calls.length).toBeGreaterThan(1);
    });
    // A temporary pagination refusal is not proof the committed message is gone.
    await new Promise(resolve => setTimeout(resolve, 5_200));
    expect(routerReplaceSpy).not.toHaveBeenCalled();
    expect(routerBackSpy).not.toHaveBeenCalled();
  });

  it('does not crash when message kind changes between renders', async () => {

    mockMessage = {
      kind: 'user-text',
      id: 'message-1',
      localId: null,
      createdAt: 1,
      text: 'hello',
      meta: null,
    };

    const screen = await renderMessageScreen(MessageScreen);

    mockMessage = {
      kind: 'tool-call',
      id: 'message-1',
      localId: null,
      createdAt: 1,
      tool: { name: 'Task' },
      children: [],
    };

    applyMessageFixtures();
    await screen.update(<runtime.Wrapper><MessageScreen /></runtime.Wrapper>);
    await flushHookEffects({ cycles: 1, turns: 1 });
  });

  it('does not render the focused-tool composer when there are no participant targets', async () => {

    mockMessage = {
      kind: 'tool-call',
      id: 'message-1',
      localId: null,
      createdAt: 1,
      tool: { name: 'Task', input: {}, result: null, state: 'success' },
      children: [],
    };

    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('session-composer-input')).toHaveLength(0);
  });

  it('keeps the focused tool transcript container shrinkable so the sidechain list can measure on web', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const theme = (await createUnistylesMock({ theme: mockTheme })).useUnistyles().theme;
    const styles = createSessionMessageRouteStyles(theme);

    expect(styles.routeContent).toEqual(
      expect.objectContaining({
        flex: 1,
        minHeight: 0,
      }),
    );
    expect(styles.toolCallFullViewContainer).toEqual(
      expect.objectContaining({
        flex: 1,
        minHeight: 0,
      }),
    );
  });

  it('includes focused execution run target when auto-recipient resolves to execution run', async () => {

    mockMessage = {
      kind: 'tool-call',
      id: 'message-1',
      localId: null,
      createdAt: 1,
      tool: { name: 'SubAgentRun', input: { runId: 'run_auto_1' }, result: null, state: 'completed' },
      children: [],
    };

    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReturnValue(
      { kind: 'execution_run', runId: 'run_auto_1' } satisfies ParticipantRecipientV1,
    );

    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
    expect(screen.findByTestId('agent-input-recipient-chip')?.props.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'execution_run:run_auto_1',
          recipient: expect.objectContaining({ kind: 'execution_run', runId: 'run_auto_1' }),
        }),
      ]),
    );
  });

  it('includes focused broadcast target when auto-recipient resolves to agent-team broadcast', async () => {

    mockMessage = {
      kind: 'tool-call',
      id: 'message-1',
      localId: null,
      createdAt: 1,
      tool: { name: 'Task', input: {}, result: null, state: 'success' },
      children: [],
    };

    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReturnValue({
      kind: 'agent_team_broadcast',
      teamId: 'team-1',
    } satisfies ParticipantRecipientV1);

    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
    expect(screen.findByTestId('agent-input-recipient-chip')?.props.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'agent_team_broadcast:team-1',
          recipient: expect.objectContaining({ kind: 'agent_team_broadcast', teamId: 'team-1' }),
        }),
      ]),
    );
  });

  it('includes focused teammate target when auto-recipient resolves to agent-team member', async () => {

    mockMessage = {
      kind: 'tool-call',
      id: 'message-1',
      localId: null,
      createdAt: 1,
      tool: { name: 'Task', input: {}, result: null, state: 'success' },
      children: [],
    };

    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReturnValue({
      kind: 'agent_team_member',
      teamId: 'team-1',
      memberId: 'alpha@team-1',
      memberLabel: 'Alpha',
    } satisfies ParticipantRecipientV1);

    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
    expect(screen.findByTestId('agent-input-recipient-chip')?.props.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'agent_team_member:team-1:alpha@team-1',
          recipient: expect.objectContaining({
            kind: 'agent_team_member',
            teamId: 'team-1',
            memberId: 'alpha@team-1',
            memberLabel: 'Alpha',
          }),
        }),
      ]),
    );
  });

  it('does not render the focused-tool composer when the focused tool has no auto-recipient, even if other participant targets exist', async () => {

    mockMessage = {
      kind: 'tool-call',
      id: 'message-1',
      localId: null,
      createdAt: 1,
      tool: { name: 'SubAgentRun', input: { runId: 'run_ended_1' }, result: { status: 'succeeded' }, state: 'completed' },
      children: [],
    };

    deriveSessionParticipantTargetsMock.mockReturnValue([
      {
        key: 'agent_team_broadcast:team-1',
        displayLabel: 'Broadcast: team-1',
        recipient: { kind: 'agent_team_broadcast', teamId: 'team-1' },
      } satisfies SessionParticipantTarget,
    ]);
    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReturnValue(null);

    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('session-composer-input')).toHaveLength(0);
  });
});
