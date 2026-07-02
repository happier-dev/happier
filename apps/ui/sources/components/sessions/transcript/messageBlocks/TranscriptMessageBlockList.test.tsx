import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from '@/components/sessions/transcript/transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingValues: Record<string, unknown> = {};
let renderedMessageViewProps: any[] = [];
let renderedMessageViewWithCommonProps: any[] = [];

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
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

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViewProps.push(props);
        return React.createElement('MessageView', props);
    },
    MessageViewWithSessionCommon: (props: any) => {
        renderedMessageViewWithCommonProps.push(props);
        return React.createElement('MessageViewWithSessionCommon', props);
    },
}));

describe('TranscriptMessageBlockList', () => {
    beforeEach(() => {
        resetTranscriptCommonModuleMockState();
        for (const key of Object.keys(settingValues)) delete settingValues[key];
        renderedMessageViewProps = [];
        renderedMessageViewWithCommonProps = [];
    });

    it('renders message blocks through parent-provided transcript session common', async () => {
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

        const { TranscriptMessageBlockList } = await import('./TranscriptMessageBlockList');
        await renderScreen(
            <TranscriptMessageBlockList
                sessionId="s1"
                metadata={null}
                interaction={{ canSendMessages: false, canApprovePermissions: false }}
                messages={[{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'answer', isThinking: false } as any]}
            />,
        );

        expect(renderedMessageViewProps).toHaveLength(0);
        expect(renderedMessageViewWithCommonProps).toEqual([
            expect.objectContaining({
                message: expect.objectContaining({ id: 'a1' }),
                messageDisplayCommon: expect.objectContaining({
                    transcriptMessageTimestampDisplayMode: 'always',
                }),
                toolChromeCommon: expect.objectContaining({
                    toolViewTimelineChromeMode: 'cards',
                }),
            }),
        ]);
    });
});
