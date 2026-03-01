import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { DeferredPromise } from './testUtils/deferredPromise';
import { createDeferredPromise } from './testUtils/deferredPromise';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSession: any = null;
let mockMessagesLoaded = false;
let mockMessage: any = null;
const deriveSessionParticipantTargetsMock = vi.fn<(..._args: unknown[]) => ReadonlyArray<SessionParticipantTarget>>(() => []);
const deriveAutoRecipientFromFocusedToolTranscriptMock = vi.fn<(..._args: unknown[]) => ParticipantRecipientV1 | null>(() => null);
type SessionRecipientStateParams = Readonly<{ targets: readonly SessionParticipantTarget[]; autoRecipient: ParticipantRecipientV1 | null }>;
const useSessionRecipientStateMock = vi.fn((params: SessionRecipientStateParams) => ({
  recipient: params.autoRecipient,
  didManualOverride: false,
  setManualRecipient: () => {},
}));
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerCanGoBackSpy = vi.fn(() => false);
const syncOnSessionVisibleSpy = vi.fn();
let loadOlderDeferred: DeferredPromise<{ loaded: number; hasMore: boolean; status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight' }> | null = null;
const syncLoadOlderMessagesSpy = vi.fn(async (_sessionId: string) => {
  if (loadOlderDeferred) {
    return await loadOlderDeferred.promise;
  }
  return { loaded: 0, hasMore: false, status: 'no_more' as const };
});
let ensureSessionVisibleDeferred: DeferredPromise<void> | null = null;

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'session-1', messageId: 'message-1' }),
  useRouter: () => ({ back: routerBackSpy, replace: routerReplaceSpy, canGoBack: routerCanGoBackSpy }),
  Stack: { Screen: () => null },
}));

vi.mock('react-native', () => {
  const platform = {
    OS: 'node',
    select: (value: any) => value?.[platform.OS] ?? value?.default ?? value?.web ?? value?.ios ?? value?.android,
  };

  return {
    View: 'View',
    ActivityIndicator: 'ActivityIndicator',
    Platform: platform,
  };
});

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        textSecondary: '#aaa',
        header: { background: '#000', tint: '#fff' },
        text: '#fff',
      },
    },
  }),
  StyleSheet: { create: (value: any) => value },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => mockSession,
  useSessionTranscriptIds: () => ({ ids: [], isLoaded: mockMessagesLoaded }),
  useMessage: () => mockMessage,
  useSessionMessages: () => ({ messages: [], isLoaded: mockMessagesLoaded }),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    onSessionVisible: (sessionId: string) => syncOnSessionVisibleSpy(sessionId),
    ensureSessionVisibleForMessageRoute: async () => {
      if (!ensureSessionVisibleDeferred) {
        ensureSessionVisibleDeferred = createDeferredPromise<void>();
      }
      await ensureSessionVisibleDeferred.promise;
    },
    loadOlderMessages: (sessionId: string) => syncLoadOlderMessagesSpy(sessionId),
  },
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/forms/Deferred', () => ({ Deferred: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/tools/shell/views/ToolFullView', () => ({ ToolFullView: () => React.createElement('ToolFullView') }));
vi.mock('@/components/tools/shell/presentation/ToolHeader', () => ({ ToolHeader: () => React.createElement('ToolHeader') }));
vi.mock('@/components/tools/shell/presentation/ToolStatusIndicator', () => ({ ToolStatusIndicator: () => React.createElement('ToolStatusIndicator') }));
vi.mock('@/components/ui/text/Text', () => ({ Text: ({ children }: any) => React.createElement('Text', null, children) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/utils/sessions/deriveTranscriptInteraction', () => ({ deriveTranscriptInteraction: () => ({ canSendMessages: true, canApprovePermissions: false }) }));
vi.mock('@/components/sessions/agentInput', () => ({ AgentInput: () => React.createElement('AgentInput') }));
vi.mock('@/components/autocomplete/suggestions', () => ({ getSuggestions: () => [] }));
vi.mock('@/modal', () => ({ Modal: { alert: () => {} } }));
vi.mock('@/utils/system/fireAndForget', () => ({ fireAndForget: (fn: Promise<any>) => void fn }));
vi.mock('@/sync/domains/session/participants/deriveSessionParticipantTargets', () => ({
  deriveAutoRecipientFromFocusedToolTranscript: deriveAutoRecipientFromFocusedToolTranscriptMock,
  deriveSessionParticipantTargets: deriveSessionParticipantTargetsMock,
}));
vi.mock('@/components/sessions/agentInput/recipient/useSessionRecipientState', () => ({
  useSessionRecipientState: useSessionRecipientStateMock,
}));
vi.mock('@/components/sessions/agentInput/recipient/RecipientChip', () => ({ RecipientChip: () => React.createElement('RecipientChip') }));
vi.mock('@/sync/domains/input/participants/resolveParticipantRoutedSend', () => ({ resolveParticipantRoutedSend: () => null }));
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
    loadOlderDeferred = null;
    ensureSessionVisibleDeferred = null;
    routerBackSpy.mockClear();
    routerReplaceSpy.mockClear();
    routerCanGoBackSpy.mockClear();
    syncOnSessionVisibleSpy.mockClear();
    syncLoadOlderMessagesSpy.mockClear();
	    deriveSessionParticipantTargetsMock.mockReset();
	    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReset();
	    useSessionRecipientStateMock.mockReset();
	    deriveSessionParticipantTargetsMock.mockReturnValue([]);
	    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReturnValue(null);
	    useSessionRecipientStateMock.mockReturnValue({ recipient: null, didManualOverride: false, setManualRecipient: () => {} });
	  });

  it('does not navigate back until message backfill completes', async () => {
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<void>();
    ensureSessionVisibleDeferred.resolve();
    loadOlderDeferred = createDeferredPromise();

    await act(async () => {
      renderer.create(React.createElement(MessageScreen));
    });

    expect(syncOnSessionVisibleSpy).toHaveBeenCalledWith('session-1');
    expect(syncLoadOlderMessagesSpy).toHaveBeenCalledWith('session-1');
    expect(routerBackSpy).not.toHaveBeenCalled();

    await act(async () => {
      loadOlderDeferred!.resolve({ loaded: 0, hasMore: false, status: 'no_more' });
      await loadOlderDeferred!.promise;
    });

    expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
  });

  it('does not crash when message kind changes between renders', async () => {
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<void>();
    ensureSessionVisibleDeferred.resolve();

    mockMessage = {
      kind: 'user-text',
      id: 'm1',
      localId: null,
      createdAt: 1,
      text: 'hello',
      meta: null,
    };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(MessageScreen));
      await Promise.resolve();
    });

    mockMessage = {
      kind: 'tool-call',
      id: 'm1',
      localId: null,
      createdAt: 1,
      tool: { name: 'Task' },
      children: [],
    };

    await act(async () => {
      tree!.update(React.createElement(MessageScreen));
      await Promise.resolve();
    });
  });

  it('renders the focused-tool composer for Agent tool messages', async () => {
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<void>();
    ensureSessionVisibleDeferred.resolve();

    mockMessage = {
      kind: 'tool-call',
      id: 'm1',
      localId: null,
      createdAt: 1,
      tool: { name: 'Agent', input: {}, result: null, state: 'success' },
      children: [],
    };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(MessageScreen));
      await Promise.resolve();
    });

    expect(tree!.root.findAllByType('AgentInput')).toHaveLength(1);
  });

  it('includes focused execution run target when auto-recipient resolves to execution run', async () => {
    const { default: MessageScreen } = await import('@/app/(app)/session/[id]/message/[messageId]');

    ensureSessionVisibleDeferred = createDeferredPromise<void>();
    ensureSessionVisibleDeferred.resolve();

	    mockMessage = {
	      kind: 'tool-call',
	      id: 'm-run',
	      localId: null,
      createdAt: 1,
      tool: { name: 'SubAgentRun', input: { runId: 'run_auto_1' }, result: null, state: 'completed' },
	      children: [],
	    };

	    deriveAutoRecipientFromFocusedToolTranscriptMock.mockReturnValue({ kind: 'execution_run', runId: 'run_auto_1' } satisfies ParticipantRecipientV1);

	    await act(async () => {
	      renderer.create(React.createElement(MessageScreen));
	      await Promise.resolve();
	    });

    const firstCall = useSessionRecipientStateMock.mock.calls[0]?.[0];
    expect(firstCall?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'execution_run:run_auto_1',
          recipient: expect.objectContaining({ kind: 'execution_run', runId: 'run_auto_1' }),
        }),
      ]),
    );
  });
});
