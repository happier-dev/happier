import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type {
    TranscriptForkCommon,
    TranscriptMessageDisplayCommon,
    TranscriptToolChromeCommon,
    TranscriptToolRouteCommon,
} from './transcriptSessionCommon';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'transcriptMessageTimestampDisplayMode') return 'never';
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'sessionThinkingInlinePresentation') return 'summary';
                    if (key === 'sessionThinkingInlineChrome') return 'plain';
                    if (key === 'toolViewTimelineChromeMode') return 'cards';
                    return null;
                },
                useSessionForkSupportSource: () => null,
                useSessionWorkspacePath: () => null,
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => ({} as any),
            },
        });
    },
});

const markdownRenderCounts = new Map<string, number>();

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => {
        const key = String(props.markdown ?? '');
        markdownRenderCounts.set(key, (markdownRenderCounts.get(key) ?? 0) + 1);
        return React.createElement('MarkdownView', props);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
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

vi.mock('@/components/sessions/attachments/messages/AttachmentsMessageRow', () => ({
    AttachmentsMessageRow: () => null,
}));

vi.mock('@/components/sessions/sessionMedia/SessionMediaInlineImages', () => ({
    SessionMediaInlineImages: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const messageDisplayCommon = {
    transcriptMessageTimestampDisplayMode: 'never',
    sessionThinkingDisplayMode: 'inline',
    sessionThinkingInlinePresentation: 'summary',
    sessionThinkingInlineChrome: 'plain',
    transcriptStreamingSmoothingEnabled: false,
    transcriptStreamingSettleDelayMs: 0,
    transcriptStreamingPartialOutputEnabled: true,
    transcriptStreamingMarkdownRenderingEnabled: false,
    transcriptMessageSelectionEnabled: true,
    transcriptMessageSendToSessionEnabled: false,
    debugInformationEnabled: false,
    workspacePath: null,
} satisfies TranscriptMessageDisplayCommon;

const forkCommon = {
    sessionReplayEnabled: false,
    sessionReplayStrategy: 'recent_messages',
    sessionReplaySummaryRunnerV1: null,
    sessionReplayMaxSeedChars: 120_000,
    agentSwitchingEnabled: false,
    sessionForkSupportSource: null,
    executionRunsEnabled: false,
} satisfies TranscriptForkCommon;

const toolChromeCommon = {
    toolViewTimelineChromeMode: 'cards',
    transcriptToolCallsGroupShowBackground: false,
    transcriptToolCallsCollapsedPreviewCount: 1,
} satisfies TranscriptToolChromeCommon;

const toolRouteCommon = {
    messagesById: {},
    reducerState: null,
} satisfies TranscriptToolRouteCommon;

const messageA = { kind: 'user-text', id: 'a1', localId: 'local-a1', createdAt: 1, text: 'message-a' } as const;
const messageB = { kind: 'user-text', id: 'b1', localId: 'local-b1', createdAt: 2, text: 'message-b' } as const;

describe('MessageView memoization (R3)', () => {
    beforeEach(() => {
        markdownRenderCounts.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        standardCleanup();
    });

    it('does not re-render messages when the parent re-renders with stable props, while selection updates still reach affected rows', async () => {
        vi.resetModules();
        const { MessageViewWithSessionCommon } = await import('./MessageView');
        const { TranscriptMessageSelectionProvider, useTranscriptSelectionActions } = await import('./messageSelection/TranscriptMessageSelectionContext');

        let bumpParent: (() => void) | null = null;
        let selectionActions: ReturnType<typeof useTranscriptSelectionActions> | null = null;

        function ActionsProbe() {
            selectionActions = useTranscriptSelectionActions();
            return null;
        }

        function Harness() {
            const [, setTick] = React.useState(0);
            bumpParent = () => setTick((tick) => tick + 1);
            return (
                <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['a1', 'b1']}>
                    <ActionsProbe />
                    <MessageViewWithSessionCommon
                        sessionId="s1"
                        metadata={null}
                        message={messageA as any}
                        messageDisplayCommon={messageDisplayCommon}
                        forkCommon={forkCommon}
                        toolChromeCommon={toolChromeCommon}
                        toolRouteCommon={toolRouteCommon}
                    />
                    <MessageViewWithSessionCommon
                        sessionId="s1"
                        metadata={null}
                        message={messageB as any}
                        messageDisplayCommon={messageDisplayCommon}
                        forkCommon={forkCommon}
                        toolChromeCommon={toolChromeCommon}
                        toolRouteCommon={toolRouteCommon}
                    />
                </TranscriptMessageSelectionProvider>
            );
        }

        await renderScreen(<Harness />);

        const countsAfterMount = {
            a: markdownRenderCounts.get('message-a') ?? 0,
            b: markdownRenderCounts.get('message-b') ?? 0,
        };
        expect(countsAfterMount.a).toBeGreaterThan(0);
        expect(countsAfterMount.b).toBeGreaterThan(0);

        // KEY R3 assertion: a parent re-render with byte-identical props (the FlashList
        // extraData/selectionVersion bump shape) must not re-render any message subtree.
        act(() => {
            bumpParent!();
        });
        expect(markdownRenderCounts.get('message-a')).toBe(countsAfterMount.a);
        expect(markdownRenderCounts.get('message-b')).toBe(countsAfterMount.b);

        // Selection reactivity must survive memoization: entering selection mode reaches
        // rows through their own store subscription, not through parent props.
        act(() => {
            selectionActions!.enter('a1');
        });
        const countsAfterEnter = {
            a: markdownRenderCounts.get('message-a') ?? 0,
            b: markdownRenderCounts.get('message-b') ?? 0,
        };
        expect(countsAfterEnter.a).toBeGreaterThan(countsAfterMount.a);

        // Toggling ANOTHER message must not re-render the unaffected row.
        act(() => {
            selectionActions!.toggle('b1');
        });
        expect(markdownRenderCounts.get('message-a')).toBe(countsAfterEnter.a);
        expect(markdownRenderCounts.get('message-b') ?? 0).toBeGreaterThan(countsAfterEnter.b);
    });
});
