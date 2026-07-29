import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const forkSessionSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn();
const updateSessionDraftSpy = vi.fn();
const patchSessionMetadataWithRetrySpy = vi.fn();
const modalAlertSpy = vi.fn();
const resolvePreferredServerIdForSessionIdSpy = vi.fn<(sessionId: string) => string | undefined>();
const storageStoreRef = vi.hoisted(() => ({ current: null as any }));

let replayEnabled = true;
let copyButtonsVisible = true;
let sessionMetadata: any = { machineId: 'm1' };
let sessionForkSupportSource: any = { metadata: sessionMetadata };
let projectForSession: any = null;
let machinesState: Record<string, any> = {};

function flattenStyleProp(style: any): any {
  if (!style) return style;
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flattenStyleProp));
  }
  if (typeof style === 'object') return style;
  return {};
}

function getActionContainer(screen: any, messageId: string) {
  const forkButton = screen.findByTestId(`transcript-message-fork:${messageId}`);
  expect(forkButton).toBeTruthy();
  const actionContainer = findAncestor(forkButton, (node: any) => {
    const style = flattenStyleProp(node.props?.style);
    return (
      style?.position === 'absolute' &&
      style?.flexDirection === 'row' &&
      style?.justifyContent === 'flex-end'
    );
  });
  expect(actionContainer).toBeTruthy();
  return actionContainer!;
}

function getActionSlot(screen: any, messageId: string) {
  const actionSlot = screen.findByTestId(`transcript-message-actions:${messageId}`);
  expect(actionSlot).toBeTruthy();
  return actionSlot!;
}

function assertForkButtonPrecedesCopyButton(screen: any, messageId: string) {
  const forkButton = screen.findByTestId(`transcript-message-fork:${messageId}`);
  const copyButton = screen.findByTestId(`transcript-message-copy:${messageId}`);
  const actionContainer = getActionContainer(screen, messageId);

  expect(forkButton).toBeTruthy();
  expect(copyButton).toBeTruthy();
  expect(forkButton?.props.accessibilityLabel).toBe('session.forking.forkFromMessageA11y');
  expect(copyButton?.props.accessibilityLabel).toBe('common.copy');

  const actionNodes = actionContainer.findAll(
    (node: any) => typeof node.props?.testID === 'string' && node.props.testID.startsWith('transcript-message-'),
  );
  const actionTestIds = actionNodes.map((node: any) => node.props.testID);
  const forkIndex = actionTestIds.indexOf(`transcript-message-fork:${messageId}`);
  const copyIndex = actionTestIds.indexOf(`transcript-message-copy:${messageId}`);
  expect(forkIndex).toBeGreaterThanOrEqual(0);
  expect(copyIndex).toBeGreaterThanOrEqual(0);
  expect(forkIndex).toBeLessThan(copyIndex);
}

function findAncestor(instance: any, predicate: (node: any) => boolean) {
  let current = instance?.parent ?? null;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent ?? null;
  }
  return null;
}

function setHydratedForkChildSession(
  childSessionId: string,
  parentSessionId: string = 's1',
  includeForkMetadata: boolean = true,
) {
  storageStoreRef.current.getState().sessions[childSessionId] = {
    id: childSessionId,
    seq: 1,
    createdAt: 0,
    activeAt: 0,
    metadata: {
      path: '/tmp/project',
      host: 'localhost',
      ...(includeForkMetadata
        ? {
            forkV1: {
              v: 1,
              parentSessionId,
              parentCutoffSeqInclusive: 5,
              createdAtMs: 1,
              strategy: 'message',
            },
          }
        : {}),
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    updatedAt: 0,
    active: true,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
  };
}

installMessageViewCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Dimensions: { get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }) },
      useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
      Platform: {
        OS: 'web',
        select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
          options?.web ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
      },
      View: ({ children, style, ...props }: any) =>
        React.createElement('View', { ...props, style: flattenStyleProp(style) }, children),
      Text: 'Text',
      ActivityIndicator: 'ActivityIndicator',
      Pressable: 'Pressable',
    });
  },
  unistyles: async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
      translate: (key: string) => key,
    });
  },
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.alert.mockImplementation((...args: any[]) => modalAlertSpy(...args));
    return modalMock.module;
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock();
    routerMock.spies.push.mockImplementation((value: unknown) => routerPushSpy(value));
    return routerMock.module;
  },
  storage: async (importOriginal) => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const storageStore = createStorageStoreMock({
      sessions: {
        s1: {
          id: 's1',
          metadata: sessionMetadata,
          updatedAt: 0,
          active: true,
        },
      },
      machines: machinesState,
      getProjectForSession: (sessionId: string) => (sessionId === 's1' ? projectForSession : null),
      updateSessionDraft: (...args: any[]) => updateSessionDraftSpy(...args),
    } as any);
    storageStoreRef.current = storageStore;
    return createStorageModuleStub({
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
      useSessionForkSupportSource: () => sessionForkSupportSource,
      useSessionWorkspacePath: () => projectForSession?.key?.path ?? sessionMetadata?.path ?? null,
      useSessionMessagesById: () => ({}),
      useSessionMessagesReducerState: () => ({} as any),
      storage: storageStore,
    });
  },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
  MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/sessions/transcript/transcriptRowActionVisibility', () => ({
  shouldShowTranscriptRowActions: () => copyButtonsVisible,
  shouldShowTranscriptRowPinAction: () => copyButtonsVisible,
}));

vi.mock('@/sync/ops', () => ({
  forkSession: (...args: any[]) => forkSessionSpy(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    submitMessage: vi.fn(),
    ensureSessionVisibleForMessageRoute: (
      sessionId: string,
      options?: { forceRefresh?: boolean; serverId?: string },
    ) =>
      ensureSessionVisibleSpy(sessionId, options),
    patchSessionMetadataWithRetry: (...args: any[]) => patchSessionMetadataWithRetrySpy(...args),
  },
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

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

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: (sessionId: string) =>
    resolvePreferredServerIdForSessionIdSpy(sessionId),
}));

describe('MessageView (fork button)', () => {
  beforeEach(() => {
    routerPushSpy.mockReset();
    forkSessionSpy.mockReset();
    ensureSessionVisibleSpy.mockReset();
    updateSessionDraftSpy.mockReset();
    patchSessionMetadataWithRetrySpy.mockReset();
    modalAlertSpy.mockReset();
    resolvePreferredServerIdForSessionIdSpy.mockReset();
    resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-a');
    ensureSessionVisibleSpy.mockImplementation(async (sessionId: string) => {
      setHydratedForkChildSession(sessionId);
      return { kind: 'available', sessionId, serverId: 'server-a' };
    });
    replayEnabled = true;
    copyButtonsVisible = true;
    sessionMetadata = { machineId: 'm1' };
    sessionForkSupportSource = { metadata: sessionMetadata };
    projectForSession = null;
    machinesState = {};
  });

  afterEach(() => {
    standardCleanup();
  });

  it('does not use pointerEvents prop on web when actions are hidden (prevents click interception)', async () => {
    copyButtonsVisible = false;
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    const actionContainer = getActionContainer(screen, 'm1');
    expect(actionContainer.props.pointerEvents).toBeUndefined();

    const style = actionContainer.props.style;
    const flattened = flattenStyleProp(style);
    expect(flattened.pointerEvents).toBe('box-none');
    expect(flattenStyleProp(getActionSlot(screen, 'm1').props.style).pointerEvents).toBe('none');
  });

  it('does not pass pointerEvents prop on web transcript row containers', async () => {
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm2', createdAt: 2, text: 'hello', isThinking: false, seq: 6 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    const actionContainer = getActionContainer(screen, 'm2');
    const rowContainer = findAncestor(actionContainer, (node: any) => typeof node.props?.onHoverIn === 'function');
    expect(rowContainer).toBeTruthy();
    expect(rowContainer?.props.pointerEvents).toBeUndefined();
  });

  it('keeps visible action controls interactive without forcing global overlay priority', async () => {
    copyButtonsVisible = true;
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    const actionContainer = getActionContainer(screen, 'm1');
    expect(actionContainer.props.pointerEvents).toBeUndefined();

    const style = actionContainer.props.style;
    const flattened = flattenStyleProp(style);
    expect(flattened.pointerEvents).toBe('box-none');
    expect(flattened.zIndex).toBeUndefined();
    expect(flattenStyleProp(getActionSlot(screen, 'm1').props.style).pointerEvents).toBe('auto');
  });

  it('renders fork button left of copy when replay is enabled and message has seq', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    assertForkButtonPrecedesCopyButton(screen, 'm1');
  });

  it('renders fork button for user-text messages (left of copy)', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    assertForkButtonPrecedesCopyButton(screen, 'm1');
  });

  it.each([
    ['user', { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 }],
    ['agent', { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 }],
  ])('does not expose %s fork actions when the surface grant denies fork', async (_kind, message) => {
    const { MessageView } = await import('./MessageView');

    const screen = await renderScreen(
      <MessageView
        message={message as any}
        metadata={null}
        sessionId="s1"
        interaction={{
          canSendMessages: false,
          canApprovePermissions: false,
          permissionDisabledReason: 'public',
          disableToolNavigation: true,
          canFork: false,
        }}
      />,
    );

    expect(screen.findByTestId('transcript-message-fork:m1')).toBeNull();
    expect(forkSessionSpy).not.toHaveBeenCalled();
  });

  it('rechecks the current surface grant before a stale mounted fork handler can call the RPC', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };
    const allowedInteraction = {
      canSendMessages: true,
      canApprovePermissions: true,
      canFork: true,
    } as const;
    const deniedInteraction = {
      canSendMessages: false,
      canApprovePermissions: false,
      canFork: false,
      permissionDisabledReason: 'public',
      disableToolNavigation: true,
    } as const;

    const screen = await renderScreen(
      <MessageView message={message} metadata={null} sessionId="s1" interaction={allowedInteraction} />,
    );
    const stalePress = screen.findByTestId('transcript-message-fork:m1')?.props.onPress;
    expect(typeof stalePress).toBe('function');

    act(() => {
      screen.tree.update(
        <MessageView message={message} metadata={null} sessionId="s1" interaction={deniedInteraction} />,
      );
    });
    expect(screen.findByTestId('transcript-message-fork:m1')).toBeNull();

    await act(async () => {
      await stalePress();
    });
    expect(forkSessionSpy).not.toHaveBeenCalled();
  });

  it('renders the newly granted fork action in the first committed same-session render', async () => {
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };
    const deniedInteraction = {
      canSendMessages: false,
      canApprovePermissions: false,
      canFork: false,
      permissionDisabledReason: 'public',
      disableToolNavigation: true,
    } as const;
    const allowedInteraction = {
      canSendMessages: true,
      canApprovePermissions: true,
      canFork: true,
    } as const;
    const screen = await renderScreen(
      <MessageView message={message} metadata={null} sessionId="s1" interaction={deniedInteraction} />,
    );
    expect(screen.findByTestId('transcript-message-fork:m1')).toBeNull();

    await act(async () => {
      screen.tree.update(
        <MessageView message={message} metadata={null} sessionId="s1" interaction={allowedInteraction} />,
      );
    });
    expect(screen.tree.root.findAll(
      (node) => node.props?.testID === 'transcript-message-fork:m1' && typeof node.props?.onPress === 'function',
    )).toHaveLength(1);
  });

  it('keeps the committed fork grant authoritative through an abandoned same-session denied render', async () => {
    forkSessionSpy.mockResolvedValue({ ok: false, errorMessage: 'expected test stop' });
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };
    const allowedInteraction = {
      canSendMessages: true,
      canApprovePermissions: true,
      canFork: true,
    } as const;
    const deniedInteraction = {
      canSendMessages: false,
      canApprovePermissions: false,
      canFork: false,
      permissionDisabledReason: 'public',
      disableToolNavigation: true,
    } as const;
    const neverSettles = new Promise<never>(() => {});
    const SuspendAfterRow = (props: Readonly<{ shouldSuspend: boolean }>) => {
      if (props.shouldSuspend) throw neverSettles;
      return null;
    };
    const renderMessage = (interaction: typeof allowedInteraction | typeof deniedInteraction, shouldSuspend = false) => (
      <React.Suspense fallback={null}>
        <MessageView message={message} metadata={null} sessionId="s1" interaction={interaction} />
        <SuspendAfterRow shouldSuspend={shouldSuspend} />
      </React.Suspense>
    );
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(renderMessage(allowedInteraction), {
        unstable_isConcurrent: true,
      } as unknown as renderer.TestRendererOptions);
    });
    const stalePress = tree.root.find(
      (node) => node.props?.testID === 'transcript-message-fork:m1' && typeof node.props?.onPress === 'function',
    ).props.onPress;

    await act(async () => {
      React.startTransition(() => {
        tree.update(renderMessage(deniedInteraction, true));
      });
      await Promise.resolve();
    });

    await act(async () => {
      await stalePress();
    });
    expect(forkSessionSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.update(renderMessage(deniedInteraction));
    });
    expect(tree.root.findAll((node) => node.props?.testID === 'transcript-message-fork:m1')).toHaveLength(0);

    await act(async () => {
      tree.unmount();
    });
  });

  it('does not render fork button when message seq is 0 (uncommitted)', async () => {
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 0 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    expect(screen.findByTestId('transcript-message-fork:m1')).toBeNull();
  });

  it('forks before a committed user message and restores it as a draft', async () => {
    sessionMetadata = { machineId: 'm-stale', path: '/workspace/repo', homeDir: '/workspace' };
    projectForSession = {
      key: {
        machineId: 'm-target',
        path: '/workspace/repo',
      },
    };
    machinesState = {
      'm-target': {
        id: 'm-target',
        active: true,
        activeAt: 10,
        metadata: { host: 'workstation.local' },
      },
    };
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    expect(screen.findByTestId('transcript-message-fork:m1')).toBeTruthy();
    await screen.pressByTestIdAsync('transcript-message-fork:m1');

    expect(forkSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 's1',
      forkPoint: { type: 'seq', upToSeqInclusive: 5 },
      serverId: 'server-a',
    }));
    expect(routerPushSpy).toHaveBeenCalledWith('/session/child-1?serverId=server-a');
    expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('child-1', {
      forceRefresh: true,
      serverId: 'server-a',
    });
    expect(updateSessionDraftSpy).toHaveBeenCalledWith('child-1', 'hi');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith(
      'child-1',
      expect.any(Function),
      { serverId: 'server-a' },
    );
    expect(updateSessionDraftSpy.mock.invocationCallOrder[0]).toBeLessThan(
      ensureSessionVisibleSpy.mock.invocationCallOrder[0],
    );
    expect(ensureSessionVisibleSpy.mock.invocationCallOrder[0]).toBeLessThan(
      routerPushSpy.mock.invocationCallOrder[0],
    );
    expect(routerPushSpy.mock.invocationCallOrder[0]).toBeLessThan(
      patchSessionMetadataWithRetrySpy.mock.invocationCallOrder[0],
    );
  });

  it('waits for child visibility and fork metadata before navigating', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    let resolveVisible: (() => void) | null = null;
    let markVisibilityStarted: (() => void) | null = null;
    const visibilityStarted = new Promise<void>((resolve) => {
      markVisibilityStarted = resolve;
    });
    ensureSessionVisibleSpy.mockReturnValueOnce(new Promise((resolve) => {
      markVisibilityStarted?.();
      resolveVisible = () => resolve({ kind: 'available', sessionId: 'child-1', serverId: 'server-a' });
    }));
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    expect(screen.findByTestId('transcript-message-fork:m1')).toBeTruthy();
    act(() => {
      screen.pressByTestId('transcript-message-fork:m1');
    });

    await act(async () => {
      await visibilityStarted;
    });
    expect(patchSessionMetadataWithRetrySpy).not.toHaveBeenCalled();
    expect(routerPushSpy).not.toHaveBeenCalled();

    await act(async () => {
      setHydratedForkChildSession('child-1', 's1', false);
      resolveVisible?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await flushHookEffects({ cycles: 2, turns: 2 });
    });
    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(patchSessionMetadataWithRetrySpy).not.toHaveBeenCalled();

    await act(async () => {
      setHydratedForkChildSession('child-1');
      await new Promise((resolve) => setTimeout(resolve, 60));
      await flushHookEffects({ cycles: 2, turns: 2 });
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/session/child-1?serverId=server-a');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith(
      'child-1',
      expect.any(Function),
      { serverId: 'server-a' },
    );
  });

  it('does not navigate and surfaces the existing fork error when child hydration fails', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-missing' });
    ensureSessionVisibleSpy.mockResolvedValueOnce({
      kind: 'missing',
      sessionId: 'child-missing',
      serverId: 'server-a',
      cause: 'not_found',
    });
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
    await screen.pressByTestIdAsync('transcript-message-fork:m1');
    await act(async () => {
      await flushHookEffects({ cycles: 2, turns: 2 });
    });

    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(patchSessionMetadataWithRetrySpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'Created session is not available locally yet',
    );
  });

  it('awaits metadata persistence and surfaces its failure after navigation', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    patchSessionMetadataWithRetrySpy.mockRejectedValueOnce(new Error('metadata failed'));
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
    await screen.pressByTestIdAsync('transcript-message-fork:m1');
    await act(async () => {
      await flushHookEffects({ cycles: 2, turns: 2 });
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/session/child-1?serverId=server-a');
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'metadata failed');
  });

  it('renders fork button when replay is disabled but provider supports native fork-at-message', async () => {
    replayEnabled = false;
    sessionMetadata = { machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' };
    sessionForkSupportSource = { metadata: sessionMetadata };

    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

  const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    const forkButton = screen.findByTestId('transcript-message-fork:m1');
    expect(forkButton).toBeTruthy();
    expect(forkButton?.props.accessibilityLabel).toBe('session.forking.forkFromMessageA11y');
    const forkStyle = typeof forkButton?.props.style === 'function'
      ? forkButton.props.style({ pressed: false })
      : forkButton?.props.style;
    expect(flattenStyleProp(forkStyle).minWidth).toBeGreaterThanOrEqual(44);
    expect(flattenStyleProp(forkStyle).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('uses a physical 48dp Android target without overlapping hit slop', async () => {
    const { Platform } = await import('react-native');
    const previousPlatform = Platform.OS;
    (Platform as { OS: string }).OS = 'android';
    try {
      replayEnabled = false;
      sessionMetadata = { machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' };
      sessionForkSupportSource = { metadata: sessionMetadata };

      const { MessageView } = await import('./MessageView');
      const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };
      const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

      const forkButton = screen.findByTestId('transcript-message-fork:m1');
      const forkStyle = typeof forkButton?.props.style === 'function'
        ? forkButton.props.style({ pressed: false })
        : forkButton?.props.style;
      expect(flattenStyleProp(forkStyle).minWidth).toBeGreaterThanOrEqual(48);
      expect(flattenStyleProp(forkStyle).minHeight).toBeGreaterThanOrEqual(48);
      expect(forkButton?.props.hitSlop).toBeUndefined();
      await screen.unmount();
    } finally {
      (Platform as { OS: string }).OS = previousPlatform;
    }
  });

  it('still delegates fork when session metadata machineId is missing', async () => {
    sessionMetadata = {};
    sessionForkSupportSource = { metadata: sessionMetadata };
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    expect(screen.findByTestId('transcript-message-fork:m1')).toBeTruthy();
    await screen.pressByTestIdAsync('transcript-message-fork:m1');

    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(forkSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 's1',
      forkPoint: { type: 'seq', upToSeqInclusive: 5 },
      machineId: undefined,
      serverId: 'server-a',
    }));
  });

  it('uses the layout1 owner metadata view for the fork machine fallback', async () => {
    sessionMetadata = {};
    sessionForkSupportSource = {
      metadataLayoutVersion: 1,
      metadata: { machineId: 'shared-decoy-machine' },
      ownerMetadataView: { machineId: 'owner-machine' },
      serverId: 'server-a',
    };
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
    await screen.pressByTestIdAsync('transcript-message-fork:m1');

    expect(forkSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'owner-machine',
      serverId: 'server-a',
    }));
  });

  it('shows a loader while fork request is in flight', async () => {
    let resolveFork: ((value: unknown) => void) | null = null;
    forkSessionSpy.mockReturnValueOnce(new Promise((resolve) => {
      resolveFork = resolve;
    }));

    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    expect(screen.findByTestId('transcript-message-fork:m1')).toBeTruthy();
    act(() => {
      screen.pressByTestId('transcript-message-fork:m1');
    });
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    const forkButton = screen.findByTestId('transcript-message-fork:m1');
    expect(forkButton).toBeTruthy();
    if (!forkButton) throw new Error('expected fork button');
    expect(forkButton.findAll((node: any) => node.props?.accessibilityRole === 'progressbar').length).toBeGreaterThan(0);

    await act(async () => {
      resolveFork?.({ ok: true, childSessionId: 'child-loading' });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
  });
});
