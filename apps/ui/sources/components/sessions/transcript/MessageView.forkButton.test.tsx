import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const forkSessionSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn();
const updateSessionDraftSpy = vi.fn();
const modalAlertSpy = vi.fn();

let replayEnabled = true;
let copyButtonsVisible = true;
let sessionMetadata: any = { machineId: 'm1' };

vi.mock('react-native', async () => ({
  Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
  Dimensions: { get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }) },
  useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
  View: 'View',
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
  Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        success: '#0a0',
        text: '#111',
        textSecondary: '#555',
        tint: '#06f',
        card: '#fff',
        border: '#ddd',
        surfaceHighest: '#fff',
        divider: '#ddd',
        input: { background: '#f7f7f7' },
        userMessageBackground: '#eef',
        agentEventText: '#777',
        warning: '#f90',
      },
    },
  }),
  StyleSheet: {
    create: (input: any) => {
      const theme = {
        colors: {
          success: '#0a0',
          text: '#111',
          textSecondary: '#555',
          tint: '#06f',
          card: '#fff',
          border: '#ddd',
          surfaceHighest: '#fff',
          divider: '#ddd',
          input: { background: '#f7f7f7' },
          userMessageBackground: '#eef',
          agentEventText: '#777',
          warning: '#f90',
        },
      };
      return typeof input === 'function' ? input(theme, {}) : input;
    },
  },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
  MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({
  shouldShowMessageCopyButton: () => copyButtonsVisible,
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
  Modal: { alert: (...args: any[]) => modalAlertSpy(...args) },
}));

vi.mock('@/sync/ops', () => ({
  forkSession: (...args: any[]) => forkSessionSpy(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    submitMessage: vi.fn(),
    ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleSpy(sessionId),
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: (key: string) => {
    if (key === 'sessionReplayEnabled') return replayEnabled;
    if (key === 'sessionThinkingDisplayMode') return 'inline';
    if (key === 'toolViewTimelineChromeMode') return 'cards';
    return null;
  },
  useSession: () => ({
    id: 's1',
    seq: 1,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata: sessionMetadata,
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
  }),
  storage: {
    getState: () => ({
      updateSessionDraft: (...args: any[]) => updateSessionDraftSpy(...args),
    }),
  },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
  StructuredMessageBlock: () => null,
  renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
  extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
  LinkedWorkspaceFilesRow: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
  ToolView: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
  ToolTimelineRow: () => null,
}));

vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', () => ({
  ThinkingTimelineRow: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/structured/happierMetaEnvelope', () => ({
  parseHappierMetaEnvelope: () => null,
}));

vi.mock('@/sync/domains/attachments/attachmentsMessageMeta', () => ({
  AttachmentsMessageMetaV1Schema: { safeParse: () => ({ success: false }) },
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsMessageRow', () => ({
  AttachmentsMessageRow: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => false,
}));

describe('MessageView (fork button)', () => {
  beforeEach(() => {
    routerPushSpy.mockReset();
    forkSessionSpy.mockReset();
    ensureSessionVisibleSpy.mockReset();
    updateSessionDraftSpy.mockReset();
    modalAlertSpy.mockReset();
    replayEnabled = true;
    copyButtonsVisible = true;
    sessionMetadata = { machineId: 'm1' };
  });

  it('does not use pointerEvents prop on web when actions are hidden (prevents click interception)', async () => {
    copyButtonsVisible = false;
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const actionContainers = tree!.root.findAll(
      (node: any) => node.type === 'View' && node.props.accessibilityElementsHidden === true,
    );
    expect(actionContainers).toHaveLength(1);

    const actionContainer = actionContainers[0]!;
    expect(actionContainer.props.pointerEvents).toBeUndefined();

    const style = actionContainer.props.style;
    const flattened = Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean))
      : style;
    expect(flattened.pointerEvents).toBe('none');
  });

  it('does not pass pointerEvents prop on web transcript row containers', async () => {
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm2', createdAt: 2, text: 'hello', isThinking: false, seq: 6 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const webHoverContainers = tree!.root.findAll(
      (node: any) => node.type === 'View' && typeof node.props.onPointerEnter === 'function',
    );
    expect(webHoverContainers.length).toBeGreaterThan(0);
    for (const container of webHoverContainers) {
      expect(container.props.pointerEvents).toBeUndefined();
    }
  });

  it('keeps visible action controls interactive without forcing global overlay priority', async () => {
    copyButtonsVisible = true;
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const actionContainers = tree!.root.findAll(
      (node: any) => node.type === 'View' && node.props.accessibilityElementsHidden === false,
    );
    expect(actionContainers).toHaveLength(1);

    const actionContainer = actionContainers[0]!;
    expect(actionContainer.props.pointerEvents).toBeUndefined();

    const style = actionContainer.props.style;
    const flattened = Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean))
      : style;
    expect(flattened.pointerEvents).toBe('auto');
    expect(flattened.zIndex).toBeUndefined();
  });

  it('renders fork button left of copy when replay is enabled and message has seq', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const pressables = tree!.root.findAllByType('Pressable' as any);
    const a11y = pressables.map((p) => p.props.accessibilityLabel).filter(Boolean);
    expect(a11y).toContain('session.forking.forkFromMessageA11y');
    expect(a11y).toContain('common.copy');

    const forkIndex = a11y.indexOf('session.forking.forkFromMessageA11y');
    const copyIndex = a11y.indexOf('common.copy');
    expect(forkIndex).toBeGreaterThanOrEqual(0);
    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(forkIndex).toBeLessThan(copyIndex);
  });

  it('renders fork button for user-text messages (left of copy)', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const pressables = tree!.root.findAllByType('Pressable' as any);
    const a11y = pressables.map((p) => p.props.accessibilityLabel).filter(Boolean);
    expect(a11y).toContain('session.forking.forkFromMessageA11y');
    expect(a11y).toContain('common.copy');

    const forkIndex = a11y.indexOf('session.forking.forkFromMessageA11y');
    const copyIndex = a11y.indexOf('common.copy');
    expect(forkIndex).toBeGreaterThanOrEqual(0);
    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(forkIndex).toBeLessThan(copyIndex);
  });

  it('forks before a committed user message and restores it as a draft', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    ensureSessionVisibleSpy.mockResolvedValueOnce(undefined);
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const forkButton = tree!.root.findByProps({ testID: 'transcript-message-fork:m1' });
    await act(async () => {
      await forkButton.props.onPress();
    });

    expect(forkSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 's1',
      forkPoint: { type: 'seq', upToSeqInclusive: 4 },
    }));
    expect(routerPushSpy).toHaveBeenCalledWith('/session/child-1');
    expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('child-1');
    expect(updateSessionDraftSpy).toHaveBeenCalledWith('child-1', 'hi');
  });

  it('renders fork button when replay is disabled but provider supports native fork-at-message', async () => {
    replayEnabled = false;
    sessionMetadata = { machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' };

    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const pressables = tree!.root.findAllByType('Pressable' as any);
    const a11y = pressables.map((p) => p.props.accessibilityLabel).filter(Boolean);
    expect(a11y).toContain('session.forking.forkFromMessageA11y');
  });

  it('still delegates fork when session metadata machineId is missing', async () => {
    sessionMetadata = {};
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const forkButton = tree!.root.findByProps({ testID: 'transcript-message-fork:m1' });
    await act(async () => {
      await forkButton.props.onPress();
    });

    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(forkSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 's1',
      forkPoint: { type: 'seq', upToSeqInclusive: 5 },
      machineId: undefined,
    }));
  });

  it('shows a loader while fork request is in flight', async () => {
    let resolveFork: ((value: unknown) => void) | null = null;
    forkSessionSpy.mockReturnValueOnce(new Promise((resolve) => {
      resolveFork = resolve;
    }));

    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const forkButton = tree!.root.findByProps({ testID: 'transcript-message-fork:m1' });
    act(() => {
      void forkButton.props.onPress();
    });

    const loaders = tree!.root.findAllByType('ActivityIndicator' as any);
    expect(loaders.length).toBeGreaterThan(0);

    await act(async () => {
      resolveFork?.({ ok: true, childSessionId: 'child-loading' });
      await Promise.resolve();
    });
  });
});
