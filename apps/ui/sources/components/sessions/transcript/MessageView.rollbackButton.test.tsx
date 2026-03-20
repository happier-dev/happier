import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => ({
    Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
    Dimensions: { get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
    View: 'View',
    ActivityIndicator: 'ActivityIndicator',
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                success: '#0a0',
                textSecondary: '#555',
                userMessageBackground: '#eef',
                agentEventText: '#777',
                surface: '#fff',
                border: '#ddd',
                divider: '#ddd',
                overlay: { text: '#fff', scrimStrong: 'rgba(0,0,0,0.7)' },
                shadow: { color: '#000' },
                input: { background: '#f7f7f7' },
                warning: '#f90',
                text: '#111',
                tint: '#06f',
                card: '#fff',
                surfaceHigh: '#f5f5f5',
                surfaceHighest: '#fff',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => (typeof input === 'function' ? input({ colors: { userMessageBackground: '#eef' } }, {}) : input),
    },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'sessionThinkingDisplayMode') return 'inline';
        if (key === 'sessionThinkingInlinePresentation') return 'summary';
        if (key === 'sessionThinkingInlineChrome') return 'plain';
        if (key === 'sessionReplayEnabled') return false;
        return null;
    },
    useSession: () => ({ id: 's1', active: true, metadata: { machineId: 'm1' } }),
    useSessionMessagesById: () => ({}),
    useSessionMessagesReducerState: () => ({}),
    storage: { getState: () => ({ updateSessionDraft: vi.fn() }) },
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

vi.mock('@happier-dev/agents', () => ({
    normalizeVoiceAgentTurnTranscriptText: (text: string) => text,
}));

vi.mock('@/components/sessions/transcript/TranscriptRollbackActionButton', () => ({
    TranscriptRollbackActionButton: (props: any) => React.createElement('TranscriptRollbackActionButton', props),
}));

describe('MessageView (rollback button)', () => {
    beforeEach(() => {
        // no shared state
    });

    it('renders rollback action for agent messages when rollbackAction is provided', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = { kind: 'agent-text', id: 'a1', createdAt: 1, text: 'hello', isThinking: false, seq: 2 };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <MessageView
                    message={message}
                    metadata={null}
                    sessionId="s1"
                    rollbackAction={{ target: { type: 'latest_turn' }, restoredDraftText: null }}
                />,
            );
        });

        const rollbackButtons = tree!.root.findAll(
            (node: any) => node.type === 'TranscriptRollbackActionButton' && node.props.testID === 'transcript-message-rollback:a1',
        );
        expect(rollbackButtons).toHaveLength(1);
    });
});
