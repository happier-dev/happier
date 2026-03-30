import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import { act } from 'react-test-renderer';
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
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.fn<(sessionId: string) => string>();

let replayEnabled = true;
let copyButtonsVisible = true;
let sessionMetadata: any = { machineId: 'm1' };
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
      useSessionMessagesById: () => ({}),
      useSessionMessagesReducerState: () => ({} as any),
      storage: createStorageStoreMock({
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
      } as any),
    });
  },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
  MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({
  shouldShowMessageCopyButton: () => copyButtonsVisible,
}));

vi.mock('@/sync/ops', () => ({
  forkSession: (...args: any[]) => forkSessionSpy(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    submitMessage: vi.fn(),
    ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleSpy(sessionId),
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

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
  resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => resolveServerIdForSessionIdFromLocalCacheSpy(sessionId),
}));

describe('MessageView (fork button)', () => {
  beforeEach(() => {
    routerPushSpy.mockReset();
    forkSessionSpy.mockReset();
    ensureSessionVisibleSpy.mockReset();
    updateSessionDraftSpy.mockReset();
    patchSessionMetadataWithRetrySpy.mockReset();
    modalAlertSpy.mockReset();
    resolveServerIdForSessionIdFromLocalCacheSpy.mockReset();
    resolveServerIdForSessionIdFromLocalCacheSpy.mockImplementation(() => 'server-a');
    replayEnabled = true;
    copyButtonsVisible = true;
    sessionMetadata = { machineId: 'm1' };
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
    expect(flattened.pointerEvents).toBe('none');
  });

  it('does not pass pointerEvents prop on web transcript row containers', async () => {
    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm2', createdAt: 2, text: 'hello', isThinking: false, seq: 6 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    const actionContainer = getActionContainer(screen, 'm2');
    const rowContainer = findAncestor(actionContainer, (node: any) => typeof node.props?.onPointerEnter === 'function');
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
    expect(flattened.pointerEvents).toBe('auto');
    expect(flattened.zIndex).toBeUndefined();
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
    ensureSessionVisibleSpy.mockResolvedValueOnce(undefined);
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
    expect(routerPushSpy).toHaveBeenCalledWith('/session/child-1');
    expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('child-1');
    expect(updateSessionDraftSpy).toHaveBeenCalledWith('child-1', 'hi');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith(
      'child-1',
      expect.any(Function),
    );
  });

  it('waits for the child session to become visible before persisting forkInitialPromptV1', async () => {
    forkSessionSpy.mockResolvedValueOnce({ ok: true, childSessionId: 'child-1' });
    let resolveVisible: (() => void) | null = null;
    ensureSessionVisibleSpy.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveVisible = resolve;
    }));
    const { MessageView } = await import('./MessageView');

    const message: any = { kind: 'user-text', id: 'm1', createdAt: 1, text: 'hi', seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    expect(screen.findByTestId('transcript-message-fork:m1')).toBeTruthy();
    await screen.pressByTestIdAsync('transcript-message-fork:m1');

    expect(patchSessionMetadataWithRetrySpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveVisible?.();
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith(
      'child-1',
      expect.any(Function),
    );
  });

  it('renders fork button when replay is disabled but provider supports native fork-at-message', async () => {
    replayEnabled = false;
    sessionMetadata = { machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' };

    const { MessageView } = await import('./MessageView');
    const message: any = { kind: 'agent-text', id: 'm1', createdAt: 1, text: 'hi', isThinking: false, seq: 5 };

    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

    expect(screen.findByTestId('transcript-message-fork:m1')).toBeTruthy();
    expect(screen.findByTestId('transcript-message-fork:m1')?.props.accessibilityLabel).toBe('session.forking.forkFromMessageA11y');
  });

  it('still delegates fork when session metadata machineId is missing', async () => {
    sessionMetadata = {};
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

    const forkButton = screen.findByTestId('transcript-message-fork:m1');
    expect(forkButton).toBeTruthy();
    expect(screen.findAllByType('ActivityIndicator' as any)).toHaveLength(1);

    await act(async () => {
      resolveFork?.({ ok: true, childSessionId: 'child-loading' });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
  });
});
