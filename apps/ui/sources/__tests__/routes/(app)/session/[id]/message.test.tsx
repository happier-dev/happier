import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { DeferredPromise } from './testUtils/deferredPromise';
import { createDeferredPromise } from './testUtils/deferredPromise';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import {
  flushHookEffects,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

let mockSession: any = null;
let mockMessagesLoaded = false;
let mockMessage: any = null;
let mockMessagesById: Record<string, any> = {};
let mockResolvedRouteMessageId: string | null = null;
let mockCommittedMessages: any[] = [];
type RouteEnsureResult =
  | Readonly<{ kind: 'available'; sessionId: string; serverId?: string }>
  | Readonly<{ kind: 'missing'; sessionId: string; serverId?: string; cause: 'not_found' }>;
function createAvailableRouteResult(sessionId: string, serverId?: string): RouteEnsureResult {
  return serverId ? { kind: 'available', sessionId, serverId } : { kind: 'available', sessionId };
}
function createMissingRouteResult(sessionId: string, serverId?: string): RouteEnsureResult {
  return serverId
    ? { kind: 'missing', sessionId, serverId, cause: 'not_found' }
    : { kind: 'missing', sessionId, cause: 'not_found' };
}
const toolFullViewSpy = vi.fn();
const deriveSessionParticipantTargetsMock = vi.fn<(..._args: unknown[]) => ReadonlyArray<SessionParticipantTarget>>(() => []);
const deriveAutoRecipientFromFocusedToolTranscriptMock = vi.fn<(..._args: unknown[]) => ParticipantRecipientV1 | null>(() => null);
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerCanGoBackSpy = vi.fn(() => false);
const syncOnSessionVisibleSpy = vi.fn();
const ensureSessionVisibleForMessageRouteSpy = vi.fn(
  async (_sessionId: string, _options?: { serverId?: string }) => {
    if (!ensureSessionVisibleDeferred) {
      ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    }
    return await ensureSessionVisibleDeferred.promise;
  },
);
let mockSearchParams: any = { id: 'session-1', messageId: 'message-1' };
let loadOlderDeferred: DeferredPromise<{ loaded: number; hasMore: boolean; status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight' }> | null = null;
const syncLoadOlderMessagesSpy = vi.fn(async (_sessionId: string) => {
  if (loadOlderDeferred) {
    return await loadOlderDeferred.promise;
  }
  return { loaded: 0, hasMore: false, status: 'no_more' as const };
});
let ensureSessionVisibleDeferred: DeferredPromise<RouteEnsureResult> | null = null;
const mockTheme = {
  colors: {
    header: { background: '#000', tint: '#fff' },
    text: {
      primary: '#fff',
      secondary: '#aaa',
    },
  },
} as const;

installSessionRouteCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      TurboModuleRegistry: { get: () => ({}) },
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
  storageModule: async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
      importOriginal,
      overrides: {
        storage: {
          subscribe: () => () => {},
          getState: () => ({
            sessions: {},
            sessionListViewDataByServerId: {},
          }),
        } as any,
        useSession: () => mockSession,
        useSessionTranscriptIds: () => ({ ids: [], isLoaded: mockMessagesLoaded }),
        useSessionServerId: () => mockSession?.serverId ?? (typeof mockSearchParams?.serverId === 'string' ? mockSearchParams.serverId : null),
        useMessage: (_sessionId: string, messageId: string) => mockMessagesById[messageId] ?? mockMessage,
        useResolvedSessionMessageRouteId: (_sessionId: string, _routeMessageId: string) => mockResolvedRouteMessageId,
        // Boundary fixture: this route only needs falsy local settings while preserving the hook signature.
        useLocalSetting: (<K extends keyof LocalSettings>(_name: K) =>
          false as unknown as LocalSettings[K]) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
      },
    });
  },
});

vi.mock('@/sync/store/hooks', () => ({
  useSessionMessages: () => ({ messages: mockCommittedMessages, isLoaded: mockMessagesLoaded }),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    onSessionVisible: (sessionId: string) => syncOnSessionVisibleSpy(sessionId),
    ensureSessionVisibleForMessageRoute: (sessionId: string, options?: { serverId?: string }) =>
      ensureSessionVisibleForMessageRouteSpy(sessionId, options),
    loadOlderMessages: (sessionId: string) => syncLoadOlderMessagesSpy(sessionId),
  },
}));

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
vi.mock('@/components/tools/shell/presentation/ToolHeader', () => ({ ToolHeader: () => React.createElement('ToolHeader') }));
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
vi.mock('@/utils/system/fireAndForget', () => ({ fireAndForget: (fn: Promise<any>) => void fn }));
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
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunSend: async () => ({ ok: true }),
  sessionExecutionRunList: async () => ({ runs: [] }),
  isExecutionRunNotRunningSendError: () => false,
}));

describe('Session message route hydration', () => {
  beforeEach(() => {
    mockSession = { id: 'session-1', accessLevel: 'edit', canApprovePermissions: false };
    mockMessagesLoaded = true;
    mockMessage = null;
    mockMessagesById = {};
    mockResolvedRouteMessageId = null;
    mockCommittedMessages = [];
    loadOlderDeferred = null;
    ensureSessionVisibleDeferred = null;
    ensureSessionVisibleForMessageRouteSpy.mockClear();
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

  afterEach(() => {
    if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
      vi.clearAllTimers();
    }
    standardCleanup();
    vi.useRealTimers();
  });

  async function renderMessageScreen(Screen: React.ComponentType<any>) {
    return renderScreen(React.createElement(Screen));
  }

  it('renders invalid link fallback when session id param is missing', async () => {
    mockSearchParams = { id: '', messageId: 'message-1' };
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');
    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('session-invalid-link')).toHaveLength(1);
    expect(syncOnSessionVisibleSpy).not.toHaveBeenCalled();
  });

  it('renders invalid link fallback when hydration completes but the session is still missing', async () => {
    mockSession = null;
    mockMessagesLoaded = false;
    ensureSessionVisibleForMessageRouteSpy.mockImplementation(async (sessionId: string, options?: { serverId?: string }) =>
      createMissingRouteResult(sessionId, options?.serverId),
    );

    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');
    const screen = await renderMessageScreen(MessageScreen);
    await flushHookEffects({ cycles: 2, turns: 2 });

    expect(screen.findAllByTestId('session-invalid-link')).toHaveLength(1);
  });

  it('does not navigate back until message backfill completes', async () => {
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));
    loadOlderDeferred = createDeferredPromise();
    mockSearchParams = { id: 'session-1', messageId: 'message-1', serverId: 'server-b' };

    const screen = await renderMessageScreen(MessageScreen);
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(syncOnSessionVisibleSpy).toHaveBeenCalledWith('session-1');
    expect(syncLoadOlderMessagesSpy).toHaveBeenCalledWith('session-1');
    expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
    expect(routerBackSpy).not.toHaveBeenCalled();

    loadOlderDeferred!.resolve({ loaded: 0, hasMore: false, status: 'no_more' });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?serverId=server-b');
  });

  it('keeps a stable tool route open when the route id resolves to a hydrated internal tool message id', async () => {
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));
    mockSearchParams = { id: 'session-1', messageId: 'tool:call_1' };
    mockResolvedRouteMessageId = 'resolved-tool-message';
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
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));
    mockSearchParams = { id: 'session-1', messageId: 'tool-msg-1' };
    mockSession = { id: 'session-1', accessLevel: 'edit', canApprovePermissions: false, metadata: { flavor: 'claude' } };
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
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));
    syncLoadOlderMessagesSpy.mockImplementation(async () => ({ loaded: 0, hasMore: true, status: 'not_ready' as const }));

    await renderMessageScreen(MessageScreen);
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(routerReplaceSpy).not.toHaveBeenCalled();
    expect(routerBackSpy).not.toHaveBeenCalled();
  });

  it('does not crash when message kind changes between renders', async () => {
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));

    mockMessage = {
      kind: 'user-text',
      id: 'm1',
      localId: null,
      createdAt: 1,
      text: 'hello',
      meta: null,
    };

    const screen = await renderMessageScreen(MessageScreen);

    mockMessage = {
      kind: 'tool-call',
      id: 'm1',
      localId: null,
      createdAt: 1,
      tool: { name: 'Task' },
      children: [],
    };

    await screen.update(React.createElement(MessageScreen));
    await flushHookEffects({ cycles: 1, turns: 1 });
  });

  it('does not render the focused-tool composer when there are no participant targets', async () => {
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));

    mockMessage = {
      kind: 'tool-call',
      id: 'm1',
      localId: null,
      createdAt: 1,
      tool: { name: 'Task', input: {}, result: null, state: 'success' },
      children: [],
    };

    const screen = await renderMessageScreen(MessageScreen);
    expect(screen.findAllByTestId('session-composer-input')).toHaveLength(0);
  });

  it('keeps the focused tool transcript container shrinkable so the sidechain list can measure on web', async () => {
    const { createSessionMessageRouteStyles } = await import('@/app/(app)/session/[id]/message/[messageId]');

    const styles = createSessionMessageRouteStyles(mockTheme);

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
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));

    mockMessage = {
      kind: 'tool-call',
      id: 'm-run',
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
    expect(screen.findAllByTestId('agent-input-delivery-chip')).toHaveLength(1);
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
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));

    mockMessage = {
      kind: 'tool-call',
      id: 'm-broadcast',
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
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));

    mockMessage = {
      kind: 'tool-call',
      id: 'm-agent',
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
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<RouteEnsureResult>();
    ensureSessionVisibleDeferred.resolve(createAvailableRouteResult('session-1'));

    mockMessage = {
      kind: 'tool-call',
      id: 'm-tool',
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
