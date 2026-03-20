import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const toolFullViewSpy = vi.fn();
const participantComposerSpy = vi.fn();
const participantTargetsState = vi.hoisted(() => ({
    value: [] as Array<any>,
}));
const autoRecipientState = vi.hoisted(() => ({
    value: null as any,
}));
const recipientStateState = vi.hoisted(() => ({
    value: {
        recipient: null as any,
        executionRunDelivery: 'prompt',
        setManualRecipient: vi.fn(),
        setExecutionRunDelivery: vi.fn(),
    },
}));

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        View: 'View',
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
            },
        },
    }),
    StyleSheet: {
        create: (value: any) => (typeof value === 'function' ? value({
            colors: {
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                surfaceHighest: '#fafafa',
                accent: {
                    indigo: '#5856D6',
                    orange: '#FF9500',
                    green: '#34C759',
                },
                success: '#34C759',
                warningCritical: '#FF3B30',
            },
        }) : value),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/session/useSessionRunningExecutionRuns', () => ({
    useSessionRunningExecutionRuns: () => [],
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: () => ({
        directSessionLink: null,
        status: null,
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useSessionMessages: () => ({ messages: [] }),
}));

vi.mock('@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey', () => ({
    deriveExecutionRunPollingRefreshKey: () => 'refresh',
}));

vi.mock('@/sync/domains/session/participants/shouldEnableExecutionRunPolling', () => ({
    shouldEnableExecutionRunPolling: () => false,
}));

vi.mock('@/sync/domains/session/participants/deriveSessionParticipantTargets', () => ({
    deriveSessionParticipantTargets: () => participantTargetsState.value,
    deriveAutoRecipientFromFocusedToolTranscript: () => autoRecipientState.value,
}));

vi.mock('@/sync/domains/session/subagents/visibleMessages/resolveSessionSubagentVisibleMessages', () => ({
    resolveSessionSubagentVisibleMessages: ({ focusedMessages }: any) => focusedMessages,
}));

vi.mock('@/components/sessions/agentInput/routing/useSessionRecipientState', () => ({
    useSessionRecipientState: () => recipientStateState.value,
}));

vi.mock('@/components/sessions/participants/composer/SessionParticipantComposer', () => ({
    SessionParticipantComposer: (props: any) => {
        participantComposerSpy(props);
        return React.createElement('SessionParticipantComposer');
    },
}));

vi.mock('@/components/sessions/agentInput/routing/RecipientChip', () => ({
    RecipientChip: () => React.createElement('RecipientChip'),
}));

vi.mock('@/components/sessions/agentInput/routing/ExecutionRunDeliveryChip', () => ({
    ExecutionRunDeliveryChip: () => React.createElement('ExecutionRunDeliveryChip'),
}));

vi.mock('@/components/tools/shell/views/ToolFullView', () => ({
    ToolFullView: (props: any) => {
        toolFullViewSpy(props);
        return React.createElement('ToolFullView', props);
    },
}));

vi.mock('@/utils/sessions/deriveTranscriptInteraction', () => ({
    deriveTranscriptInteraction: () => ({
        canSendMessages: true,
        canApprovePermissions: true,
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SessionMessageDetailsView permission prompt fallback', () => {
    const session: Session = {
        id: 'session-1',
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        accessLevel: 'edit',
        canApprovePermissions: true,
        metadata: { flavor: 'claude', path: '/tmp', host: 'localhost' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };

    const message: Message = {
        kind: 'tool-call',
        id: 'message-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'toolu_subagent_1',
            name: 'SubAgent',
            state: 'running',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'Subagent',
        },
        children: [
            {
                kind: 'tool-call',
                id: 'child-1',
                localId: null,
                createdAt: 2,
                tool: {
                    id: 'child-tool-1',
                    name: 'bash',
                    state: 'running',
                    input: { command: 'pwd' },
                    createdAt: 2,
                    startedAt: 2,
                    completedAt: null,
                    description: 'pwd',
                    permission: {
                        id: 'perm-1',
                        status: 'pending',
                    },
                },
                children: [],
            },
        ],
    };

    it('forces permission actions into the transcript when a subagent details view has no composer recipient', async () => {
        const { SessionMessageDetailsView } = await import('./SessionMessageDetailsView');
        participantTargetsState.value = [];
        autoRecipientState.value = null;
        recipientStateState.value = {
            recipient: null,
            executionRunDelivery: 'prompt',
            setManualRecipient: vi.fn(),
            setExecutionRunDelivery: vi.fn(),
        };
        participantComposerSpy.mockClear();

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(SessionMessageDetailsView, {
                    sessionId: 'session-1',
                    session,
                    message,
                }),
            );
        });

        expect(tree).toBeDefined();
        expect(toolFullViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            forcePermissionFooterInTranscript: true,
        }));
    });

    it('routes composer recipient and delivery chips through the shared routing control metadata', async () => {
        const { SessionMessageDetailsView } = await import('./SessionMessageDetailsView');
        participantTargetsState.value = [
            {
                key: 'member-1',
                displayLabel: 'Worker',
                recipient: { kind: 'agent_team_member', teamId: 'team-1', memberId: 'member-1' },
            },
            {
                key: 'run-1',
                displayLabel: 'Run 1',
                recipient: { kind: 'execution_run', runId: 'run-1' },
            },
        ];
        autoRecipientState.value = { kind: 'execution_run', runId: 'run-1' };
        recipientStateState.value = {
            recipient: { kind: 'execution_run', runId: 'run-1' },
            executionRunDelivery: 'interrupt',
            setManualRecipient: vi.fn(),
            setExecutionRunDelivery: vi.fn(),
        };
        participantComposerSpy.mockClear();

        await act(async () => {
            renderer.create(
                React.createElement(SessionMessageDetailsView, {
                    sessionId: 'session-1',
                    session,
                    message,
                }),
            );
        });

        expect(participantComposerSpy).toHaveBeenCalledWith(expect.objectContaining({
            extraActionChips: expect.arrayContaining([
                expect.objectContaining({
                    key: 'participants-recipient',
                    controlId: 'recipient',
                    collapsedOptionsPopover: expect.objectContaining({
                        selectedOptionId: 'run-1',
                    }),
                }),
                expect.objectContaining({
                    key: 'execution-run-delivery',
                    controlId: 'delivery',
                    collapsedOptionsPopover: expect.objectContaining({
                        selectedOptionId: 'interrupt',
                    }),
                }),
            ]),
        }));
    });
});
