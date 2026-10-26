import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createPartialStorageModuleMock, renderScreen, standardCleanup } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createReducer } from '@/sync/reducer/reducer';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

let toolChromeMode: 'cards' | 'activity_feed' = 'cards';
const renderedToolViewProps: any[] = [];
const renderedToolTimelineRowProps: any[] = [];
const routerPushSpy = vi.fn();

function createApprovalRequestsFixture(): readonly OpenApprovalArtifactForSession[] {
    return [{
        artifact: {
            id: 'approval-1',
            header: { title: 'Approval', kind: 'approval_request.v1' },
            title: 'Approval',
            sessions: ['s1'],
            headerVersion: 1,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            isDecrypted: true,
        },
        approval: {
            v: 1,
            status: 'open',
            createdAtMs: 1,
            updatedAtMs: 1,
            createdBy: { surface: 'session_agent', sessionId: 's1' },
            requestedSurface: 'session_agent',
            actionId: 'session.list',
            actionArgs: {},
            summary: 'List sessions',
        },
    }];
}

installMessageViewCommonModuleMocks({
    reactNative: async () =>
        createReactNativeWebMock({
            Dimensions: {
                get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        }),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: routerPushSpy },
        });
        return routerMock.module;
    },
    storage: async (importOriginal) =>
        await createPartialStorageModuleMock(importOriginal, {
            useSetting: (key: string) => {
                if (key === 'sessionThinkingDisplayMode') return 'inline';
                if (key === 'toolViewTimelineChromeMode') return toolChromeMode;
                return null;
            },
            useSession: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => createReducer(),
        }),
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => {
        renderedToolViewProps.push(props);
        return React.createElement('ToolView', props);
    },
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => {
        renderedToolTimelineRowProps.push(props);
        return React.createElement('ToolTimelineRow', props);
    },
}));

vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({
    shouldShowTranscriptRowActions: () => false,
    shouldShowTranscriptRowPinAction: () => false,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        submitMessage: vi.fn(),
    },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: (params: any) => (
        params?.message?.meta?.happier ? React.createElement('StructuredNode') : null
    ),
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

afterEach(() => {
    toolChromeMode = 'cards';
    renderedToolViewProps.length = 0;
    renderedToolTimelineRowProps.length = 0;
    standardCleanup();
});

describe('MessageView (tool timeline chrome mode)', () => {
    it('passes a stable server route id to ToolTimelineRow when the message is already persisted', async () => {
        toolChromeMode = 'activity_feed';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'internal-1',
            realID: 'server-msg-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'call_read_1',
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(renderedToolTimelineRowProps).toHaveLength(1);
        expect(renderedToolTimelineRowProps[0]!.messageId).toBe('server:server-msg-1');
    });

    it('renders ToolTimelineRow when toolViewTimelineChromeMode is activity_feed', async () => {
        toolChromeMode = 'activity_feed';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'm1',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(renderedToolTimelineRowProps).toHaveLength(1);
        expect(renderedToolViewProps).toHaveLength(0);
    });

    it('forwards approval requests to ToolTimelineRow when toolViewTimelineChromeMode is activity_feed', async () => {
        toolChromeMode = 'activity_feed';
        const { MessageView } = await import('./MessageView');
        const approvalRequests = createApprovalRequestsFixture();

        const message: any = {
            kind: 'tool-call',
            id: 'm1',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'session_list',
                state: 'running',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
                description: null,
                result: null,
            },
            children: [],
        };

        await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" approvalRequests={approvalRequests} />);

        expect(renderedToolTimelineRowProps).toHaveLength(1);
        expect(renderedToolTimelineRowProps[0]!.approvalRequests).toBe(approvalRequests);
    });

    it('passes a stable server route id to ToolView when the message is already persisted', async () => {
        toolChromeMode = 'cards';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'internal-1',
            realID: 'server-msg-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'call_read_1',
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(renderedToolViewProps).toHaveLength(1);
        expect(renderedToolViewProps[0]!.messageId).toBe('server:server-msg-1');
    });


    it('renders ToolView when toolViewTimelineChromeMode is cards', async () => {
        toolChromeMode = 'cards';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'm1',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);

        expect(renderedToolViewProps).toHaveLength(1);
        expect(renderedToolTimelineRowProps).toHaveLength(0);
        // Standalone transcript tool cards keep their intrinsic margin: not embedded.
        expect(renderedToolViewProps[0]!.embedded).toBeFalsy();
    });

    it('marks ToolView embedded when rendered inside a tool-calls group so grouped rows stay flush', async () => {
        toolChromeMode = 'cards';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'm1',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        await renderScreen(
            <MessageView message={message} metadata={null} sessionId="s1" layoutContext="tool_calls_group" />,
        );

        expect(renderedToolViewProps).toHaveLength(1);
        expect(renderedToolViewProps[0]!.embedded).toBe(true);
    });

    it('forwards approval requests to ToolView when toolViewTimelineChromeMode is cards', async () => {
        toolChromeMode = 'cards';
        const { MessageView } = await import('./MessageView');
        const approvalRequests = createApprovalRequestsFixture();

        const message: any = {
            kind: 'tool-call',
            id: 'm1',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'session_list',
                state: 'running',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
                description: null,
                result: null,
            },
            children: [],
        };

        await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" approvalRequests={approvalRequests} />);

        expect(renderedToolViewProps).toHaveLength(1);
        expect(renderedToolViewProps[0]!.approvalRequests).toBe(approvalRequests);
    });

    it('does not reserve a tool header action slot when tool pin identity facts are unavailable', async () => {
        toolChromeMode = 'cards';
        const { MessageView } = await import('./MessageView');
        const onToggleToolPin = vi.fn();

        const message: any = {
            kind: 'tool-call',
            id: 'm1',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
                onToggleToolPin={onToggleToolPin}
            />,
        );

        expect(renderedToolViewProps).toHaveLength(1);
        expect(renderedToolViewProps[0]!.headerAction).toBeNull();
    });

    it('renders a pin action for structured activity-feed tool rows that suppress tool chrome', async () => {
        toolChromeMode = 'activity_feed';
        const { MessageView } = await import('./MessageView');
        const onToggleToolPin = vi.fn();

        const message: any = {
            kind: 'tool-call',
            id: 'tool-structured-1',
            localId: null,
            createdAt: 1,
            seq: 12,
            transcriptBlockIndex: 2,
            meta: { happier: { kind: 'activity_feed.v1', payload: {} } },
            tool: {
                id: 'call_read_1',
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={null}
                sessionId="s1"
                onToggleToolPin={onToggleToolPin}
            />,
        );

        expect(renderedToolTimelineRowProps).toHaveLength(0);
        screen.pressByTestId('transcript-tool-call-pin:tool-structured-1');

        expect(onToggleToolPin).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            seq: 12,
            transcriptBlockIndex: 2,
            routeMessageId: 'tool:call_read_1',
            role: 'tool',
        }));
    });
});
