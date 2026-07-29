import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturingLegendListMock, renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The Legend renderer (default transcript renderer) schedules landing verification through
// requestAnimationFrame; this suite's bare environment does not provide one.
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
        setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

const settingValues: Record<string, any> = {};
let renderedMessageViewProps: any[] = [];
let renderedMessageViewWithCommonProps: any[] = [];
let nestedToolSetExpanded: ((expanded: boolean) => void) | null = null;
let transcriptCollapsibleComponent: React.ComponentType<any> | null = null;
let rowMutationEvents: string[] = [];
let legendListDetached = false;
const capturingLegendListMock = createCapturingLegendListMock({
    resolveState: () => {
        rowMutationEvents.push('anchor-read');
        return {
            contentLength: 360,
            end: 1,
            isAtEnd: !legendListDetached,
            isNearEnd: !legendListDetached,
            isWithinMaintainScrollAtEndThreshold: !legendListDetached,
            positionAtIndex: (index: number) => index * 120,
            scroll: 20,
            scrollLength: 240,
            sizeAtIndex: () => 120,
            start: 0,
        };
    },
});

vi.mock('@legendapp/list/react-native', () => capturingLegendListMock.module);

function VisibleNestedToolContent() {
    rowMutationEvents.push('tool-visible');
    return React.createElement('VisibleNestedToolContent');
}

function NestedToolMessage(props: { messageId: string; createdAt: number }) {
    const [expanded, setExpanded] = React.useState(false);
    nestedToolSetExpanded = setExpanded;
    const TranscriptCollapsible = transcriptCollapsibleComponent;
    if (!TranscriptCollapsible) return null;
    return (
        <TranscriptCollapsible
            id={props.messageId}
            createdAt={props.createdAt}
            expanded={expanded}
        >
            <VisibleNestedToolContent />
        </TranscriptCollapsible>
    );
}

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
            FlatList: (props: any) => {
                const children = (props.data ?? []).map((item: any, index: number) =>
                    React.createElement(
                        React.Fragment,
                        { key: props.keyExtractor?.(item, index) ?? String(index) },
                        props.renderItem?.({ item, index }),
                    ),
                );
                return React.createElement('FlatList', props, children);
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => settingValues[key],
            useSessionForkSupportSource: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => null,
            useSessionWorkspacePath: () => null,
        });
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => false,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('@/components/sessions/transcript/ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
  MessageView: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageView', props);
  },
  MessageViewWithSessionCommon: (props: any) => {
    renderedMessageViewWithCommonProps.push(props);
    if (props.thinkingExpanded === true) {
      rowMutationEvents.push('thinking-visible');
    }
    if (props.message?.kind === 'tool-call') {
      return React.createElement(NestedToolMessage, {
        messageId: props.message.id,
        createdAt: props.message.createdAt,
      });
    }
    return React.createElement('MessageViewWithSessionCommon', props);
  },
}));

function getRenderedMessageProps(): any[] {
  return [...renderedMessageViewProps, ...renderedMessageViewWithCommonProps];
}

describe('TranscriptList (thinking expansion controlled)', () => {
  beforeEach(() => {
    resetTranscriptCommonModuleMockState();
    for (const k of Object.keys(settingValues)) delete settingValues[k];
    renderedMessageViewProps = [];
    renderedMessageViewWithCommonProps = [];
    nestedToolSetExpanded = null;
    transcriptCollapsibleComponent = null;
    rowMutationEvents = [];
    legendListDetached = false;
    capturingLegendListMock.state.reset();
  });

  it('controls inline thinking expansion via list-owned state', async () => {
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 1, text: 'think', isThinking: true };
    const normalMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };

    const { TranscriptList } = await import('./TranscriptList');
    await renderScreen(<TranscriptList
          sessionId="s1"
          datasetKey="public:s1:1"
          metadata={null}
          messages={[thinkingMessage as any, normalMessage as any]}
          interaction={{ canSendMessages: false, canApprovePermissions: false }}
        />);

    const firstThinkingProps = getRenderedMessageProps().find((p) => p?.message?.id === 't1');
    expect(firstThinkingProps?.thinkingExpanded).toBe(false);
    expect(typeof firstThinkingProps?.onThinkingExpandedChange).toBe('function');

    await act(async () => {
      firstThinkingProps.onThinkingExpandedChange(true);
    });

    const lastThinkingProps = [...getRenderedMessageProps()].reverse().find((p) => p?.message?.id === 't1');
    expect(lastThinkingProps?.thinkingExpanded).toBe(true);
  });

  it('renders messages through parent-provided transcript session common', async () => {
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';
    settingValues.sessionThinkingInlineChrome = 'plain';
    settingValues.transcriptStreamingSmoothingEnabled = false;
    settingValues.transcriptStreamingSettleDelayMs = 0;
    settingValues.transcriptStreamingPartialOutputEnabled = true;
    settingValues.transcriptStreamingMarkdownRenderingEnabled = false;
    settingValues.transcriptMessageTimestampDisplayMode = 'always';
    settingValues.sessionReplayEnabled = false;
    settingValues.sessionReplayStrategy = 'recent_messages';
    settingValues.sessionReplaySummaryRunnerV1 = null;
    settingValues.sessionReplayMaxSeedChars = 120_000;
    settingValues.toolViewTimelineChromeMode = 'cards';
    settingValues.transcriptToolCallsCollapsedPreviewCount = 1;
    settingValues.transcriptToolCallsGroupShowBackground = false;

    const message = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };

    const { TranscriptList } = await import('./TranscriptList');
    await renderScreen(<TranscriptList
      sessionId="s1"
      datasetKey="public:s1:1"
      metadata={null}
      messages={[message as any]}
      interaction={{ canSendMessages: false, canApprovePermissions: false }}
    />);

    expect(renderedMessageViewProps).toHaveLength(0);
    const renderedRowsForMessage = renderedMessageViewWithCommonProps.filter((p) => p?.message?.id === 'a1');
    expect(renderedRowsForMessage.length).toBeGreaterThan(0);
    expect(renderedRowsForMessage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ id: 'a1' }),
          messageDisplayCommon: expect.objectContaining({
            transcriptMessageTimestampDisplayMode: 'always',
          }),
          toolChromeCommon: expect.objectContaining({
            toolViewTimelineChromeMode: 'cards',
          }),
        }),
      ]),
    );
    expect(renderedMessageViewWithCommonProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forkCommon: expect.any(Object),
          messageDisplayCommon: expect.any(Object),
          toolChromeCommon: expect.any(Object),
          toolRouteCommon: expect.any(Object),
        }),
      ]),
    );
  });

  it('resets public row state when the logical dataset changes for the same session', async () => {
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';
    const thinkingMessage = {
      kind: 'agent-text',
      id: 't1',
      localId: null,
      createdAt: 1,
      text: 'think',
      isThinking: true,
    };

    const { TranscriptList } = await import('./TranscriptList');
    const screen = await renderScreen(<TranscriptList
      sessionId="same-session"
      datasetKey="public:same-session:1"
      metadata={null}
      messages={[thinkingMessage as any]}
      interaction={{ canSendMessages: false, canApprovePermissions: false }}
    />);
    const firstThinkingProps = getRenderedMessageProps().find((props) => props?.message?.id === 't1');
    await act(async () => {
      firstThinkingProps.onThinkingExpandedChange(true);
    });
    expect([...getRenderedMessageProps()].reverse().find((props) => props?.message?.id === 't1')?.thinkingExpanded).toBe(true);

    await screen.update(<TranscriptList
      sessionId="same-session"
      datasetKey="public:same-session:2"
      metadata={null}
      messages={[thinkingMessage as any]}
      interaction={{ canSendMessages: false, canApprovePermissions: false }}
    />);

    expect([...getRenderedMessageProps()].reverse().find((props) => props?.message?.id === 't1')?.thinkingExpanded).toBe(false);
    expect(capturingLegendListMock.state.props?.dataKey).toBe('public:same-session:2');
  });

  it('arms the renderer anchor before public thinking and nested tool rows become visible', async () => {
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';
    const thinkingMessage = {
      kind: 'agent-text',
      id: 'thinking-message',
      localId: null,
      createdAt: 1,
      text: 'think',
      isThinking: true,
    };
    const toolMessage = {
      kind: 'tool-call',
      id: 'tool-message',
      localId: null,
      createdAt: 2,
      tool: {
        name: 'Read',
        state: 'completed',
        input: {},
        createdAt: 2,
        startedAt: 2,
        completedAt: 3,
        description: null,
      },
      children: [],
    };
    transcriptCollapsibleComponent = (await import('./motion/TranscriptCollapsible')).TranscriptCollapsible;

    const { TranscriptList } = await import('./TranscriptList');
    await renderScreen(<TranscriptList
      sessionId="same-session"
      datasetKey="public:same-session:1"
      metadata={null}
      messages={[thinkingMessage as any, toolMessage as any]}
      interaction={{ canSendMessages: false, canApprovePermissions: false }}
    />);

    const detachFromTail = async () => {
      legendListDetached = true;
      await act(async () => {
        capturingLegendListMock.state.props?.onWheel?.({ deltaY: -1 });
      });
    };

    await detachFromTail();
    rowMutationEvents = [];
    const thinkingProps = [...getRenderedMessageProps()]
      .reverse()
      .find((props) => props?.message?.id === 'thinking-message');
    await act(async () => {
      thinkingProps.onThinkingExpandedChange(true);
    });
    expect(rowMutationEvents.indexOf('anchor-read')).toBeGreaterThanOrEqual(0);
    expect(rowMutationEvents.indexOf('anchor-read')).toBeLessThan(rowMutationEvents.indexOf('thinking-visible'));

    await detachFromTail();
    rowMutationEvents = [];
    expect(nestedToolSetExpanded).not.toBeNull();
    await act(async () => {
      nestedToolSetExpanded?.(true);
    });
    expect(rowMutationEvents.indexOf('anchor-read')).toBeGreaterThanOrEqual(0);
    expect(rowMutationEvents.indexOf('anchor-read')).toBeLessThan(rowMutationEvents.indexOf('tool-visible'));
  });
});
