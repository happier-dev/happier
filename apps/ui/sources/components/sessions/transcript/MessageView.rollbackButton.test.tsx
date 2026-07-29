import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { createReducer } from '@/sync/reducer/reducer';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return messageViewRollbackTestState.platformOS;
                },
                select: (options: any) => options?.[messageViewRollbackTestState.platformOS] ?? options?.default ?? options?.native ?? options?.web,
            },
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
        const modalMock = createModalModuleMock();
        messageViewRollbackTestState.modalMock = modalMock;
        return modalMock.module;
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
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'sessionThinkingInlinePresentation') return 'summary';
                    if (key === 'sessionThinkingInlineChrome') return 'plain';
                    if (key === 'sessionReplayEnabled') return false;
                    return null;
                } }),
                useSession: () => createSessionFixture({ id: 's1', active: true, metadata: { machineId: 'm1' } as any }),
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => createReducer(),
                storage: createStorageStoreMock({}),
                getStorage: () => createStorageStoreMock({}),
            },
        });
    },
});

const messageViewRollbackTestState = vi.hoisted(() => ({
    platformOS: 'web',
    modalMock: null as null | ReturnType<typeof import('@/dev/testkit/mocks/modal').createModalModuleMock>,
}));
const contextMenuPropsSpy = vi.fn();
const executeSpy = vi.fn();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/sessions/transcript/transcriptRowActionVisibility', () => ({
    shouldShowTranscriptRowActions: () => true,
    shouldShowTranscriptRowPinAction: () => true,
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

vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: any) => {
        contextMenuPropsSpy(props);
        return React.createElement('ContextMenu', props);
    },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: (actionId: unknown, input: unknown, ctx: unknown) => executeSpy(actionId, input, ctx),
    }),
}));

describe('MessageView (rollback button)', () => {
    afterEach(() => {
        messageViewRollbackTestState.platformOS = 'web';
        messageViewRollbackTestState.modalMock?.spies.show?.mockReset();
        contextMenuPropsSpy.mockReset();
        executeSpy.mockReset();
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

    it('passes checkpoint code rollback evidence from MessageView into the rollback button', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = { kind: 'agent-text', id: 'a1', createdAt: 1, text: 'hello', isThinking: false, seq: 2 };

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
                rollbackAction={{
                    target: { type: 'latest_turn' },
                    restoredDraftText: null,
                    checkpointCodeRollback: {
                        conversationRollbackSupported: true,
                        turnId: 'turn-1',
                        cwd: '/repo',
                        expectedStartRef: 'refs/happier/checkpoints/czE/turn-start/turn-1',
                        expectedFinalRef: 'refs/happier/checkpoints/czE/turn-final/turn-1',
                    },
                } as any}
            />,
        );

        const rollbackButtons = screen.findAll(
            (node: any) => node.type === 'TranscriptRollbackActionButton' && node.props.testID === 'transcript-message-rollback:a1',
        );
        expect(rollbackButtons[0]?.props.checkpointCodeRollback).toMatchObject({
            conversationRollbackSupported: true,
            turnId: 'turn-1',
            cwd: '/repo',
            expectedStartRef: 'refs/happier/checkpoints/czE/turn-start/turn-1',
            expectedFinalRef: 'refs/happier/checkpoints/czE/turn-final/turn-1',
        });
    });

    it('routes native context-menu rollback through the checkpoint dialog/action path when checkpoint evidence is present', async () => {
        messageViewRollbackTestState.platformOS = 'ios';
        executeSpy
            .mockResolvedValueOnce({ ok: true, result: { ok: true } })
            .mockResolvedValueOnce({ ok: true, result: { status: 'applied' } });
        messageViewRollbackTestState.modalMock?.spies.show?.mockImplementationOnce(({ props }: any) => props?.onConfirm?.({
            mode: 'conversation_and_code_without_stash',
            backupMode: 'happier_checkpoint_only',
        }));

        const { MessageView } = await import('./MessageView');

        const message: any = { kind: 'agent-text', id: 'a1', createdAt: 1, text: 'hello', isThinking: false, seq: 2 };

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="session-1"
                rollbackAction={{
                    target: { type: 'latest_turn' },
                    restoredDraftText: null,
                    checkpointCodeRollback: {
                        conversationRollbackSupported: true,
                        turnId: 'turn-1',
                        cwd: '/repo',
                        expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                        expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                    },
                }}
            />,
        );

        const longPressTargets = screen.findAll((node: any) => node.type === 'Pressable' && typeof node.props.onLongPress === 'function');
        expect(longPressTargets.length).toBeGreaterThan(0);
        await act(async () => {
            longPressTargets[0]?.props.onLongPress();
        });
        const contextMenuProps = contextMenuPropsSpy.mock.calls.at(-1)?.[0];
        expect(contextMenuProps?.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'rollback' }),
        ]));

        await act(async () => {
            await contextMenuProps.onSelect('rollback');
        });

        expect(messageViewRollbackTestState.modalMock?.spies.show).toHaveBeenCalled();
        expect(executeSpy).toHaveBeenNthCalledWith(1, 'session.rollback', expect.any(Object), expect.any(Object));
        expect(executeSpy).toHaveBeenNthCalledWith(
            2,
            'session.checkpoint_code_rollback',
            expect.objectContaining({
                codeMode: 'code_only_without_stash',
                codeOnlyTranscriptDivergenceConfirmed: true,
            }),
            expect.any(Object),
        );

        await screen.unmount();
    });
});
