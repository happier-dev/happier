import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { createReducer } from '@/sync/reducer/reducer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: { get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }) },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: vi.fn() },
        });
        return routerMock.module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'sessionThinkingInlinePresentation') return 'summary';
                    if (key === 'sessionThinkingInlineChrome') return 'plain';
                    if (key === 'sessionReplayEnabled') return false;
                    return null;
                },
                useSession: () => createSessionFixture({ id: 's1', active: true, metadata: { machineId: 'm1' } as any }),
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => createReducer(),
                storage: createStorageStoreMock({}),
                getStorage: () => createStorageStoreMock({}),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({
    shouldShowMessageCopyButton: () => true,
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', () => ({
    ThinkingTimelineRow: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionContext', () => ({
    useTranscriptMotion: () => ({ config: { preset: 'off', animateThinkingEnabled: false } }),
}));

vi.mock('@/components/sessions/transcript/events/TranscriptEventRow', () => ({
    TranscriptEventRow: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: () => null,
}));

vi.mock('@/sync/sync', () => ({
    sync: { submitMessage: vi.fn(), patchSessionMetadataWithRetry: vi.fn() },
}));

vi.mock('@/utils/url/sessionFileDeepLink', () => ({
    buildSessionFileDeepLink: () => '/session/s1',
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: any) => promise,
}));

vi.mock('@/sync/domains/messages/messageRouteIds', () => ({
    resolveMessageRouteIdForDisplay: () => null,
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
    LinkedWorkspaceFilesRow: () => null,
}));

vi.mock('@/sync/domains/attachments/attachmentsMessageMeta', () => ({
    AttachmentsMessageMetaV1Schema: { safeParse: () => ({ success: false }) },
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsMessageRow', () => ({
    AttachmentsMessageRow: () => null,
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsInlineImages', () => ({
    AttachmentsInlineImages: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({
    canForkFromMessage: () => false,
}));

vi.mock('@/sync/domains/sessionFork/forkFromMessageSemantics', () => ({
    resolveForkFromMessageSemantics: () => null,
}));

vi.mock('@/sync/domains/sessionFork/forkInitialPromptV1', () => ({
    writeForkInitialPromptV1: () => ({}),
}));

vi.mock('@/sync/ops', () => ({
    forkSession: vi.fn(),
}));

vi.mock('@/components/sessions/transcript/structured/happierMetaEnvelope', () => ({
    parseHappierMetaEnvelope: () => null,
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    getImageMimeTypeFromPath: () => null,
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    return {
        ...actual,
        normalizeVoiceAgentTurnTranscriptText: (text: string) => text,
    };
});

vi.mock('@/components/sessions/transcript/TranscriptRollbackActionButton', () => ({
    TranscriptRollbackActionButton: (props: any) => React.createElement('TranscriptRollbackActionButton', props),
}));

describe('MessageView (rollback button)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders rollback action for agent messages when rollbackAction is provided', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = { kind: 'agent-text', id: 'a1', createdAt: 1, text: 'hello', isThinking: false, seq: 2 };

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
                rollbackAction={{ target: { type: 'latest_turn' }, restoredDraftText: null }}
            />,
        );

        const rollbackButtons = screen.findAll(
            (node: any) => node.type === 'TranscriptRollbackActionButton' && node.props.testID === 'transcript-message-rollback:a1',
        );
        expect(rollbackButtons).toHaveLength(1);
    });
});
