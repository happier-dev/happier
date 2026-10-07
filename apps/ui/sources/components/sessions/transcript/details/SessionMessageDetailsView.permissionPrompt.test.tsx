import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from "@happier-dev/session-core/messages";
import type { ParticipantRecipientV1, PendingRequestedActionV1 } from '@happier-dev/protocol';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from '../transcriptTestHelpers';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toolFullViewSpy = vi.fn();
const participantComposerSpy = vi.fn();
const participantTargetsState = vi.hoisted<{ value: SessionParticipantTarget[] }>(() => ({
    value: [],
}));
const autoRecipientState = vi.hoisted<{ value: ParticipantRecipientV1 | null }>(() => ({
    value: null,
}));
const recipientStateState = vi.hoisted<{
    value: {
        recipient: ParticipantRecipientV1 | null;
        executionRunRequestedAction: PendingRequestedActionV1;
        setManualRecipient: ReturnType<typeof vi.fn>;
        setExecutionRunRequestedAction: ReturnType<typeof vi.fn>;
    };
}>(() => ({
    value: {
        recipient: null,
        executionRunRequestedAction: { v: 1, kind: 'enqueue' },
        setManualRecipient: vi.fn(),
        setExecutionRunRequestedAction: vi.fn(),
    },
}));

installTranscriptCommonModuleMocks({
    // Permission interaction is derived by the app source from the real storage owner.
    storage: async (importOriginal) => importOriginal(),
});

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

vi.mock('@/components/sessions/model/useExternalSessionRuntime', () => ({
    useExternalSessionRuntime: () => ({
        externalSessionLink: null,
        status: null,
    }),
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

vi.mock('@/components/sessions/agentInput/routing/ExecutionRunRequestedActionChip', () => ({
    ExecutionRunRequestedActionChip: () => React.createElement('ExecutionRunRequestedActionChip'),
}));

vi.mock('@/components/tools/shell/views/ToolFullView', () => ({
    ToolFullView: (props: any) => {
        toolFullViewSpy(props);
        return React.createElement('ToolFullView', props);
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('SessionMessageDetailsView permission prompt fallback', () => {
    const session = createSessionFixture({
        id: 'session-1',
        serverId: 'home-b',
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
    });

    let previousState: ReturnType<typeof storage.getState>;
    beforeEach(() => {
        previousState = storage.getState();
        storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

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
            executionRunRequestedAction: { v: 1, kind: 'enqueue' },
            setManualRecipient: vi.fn(),
            setExecutionRunRequestedAction: vi.fn(),
        };
        participantComposerSpy.mockClear();

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(SessionMessageDetailsView, {
                    sessionId: 'session-1',
                    session,
                    message,
                }))).tree;

        expect(tree).toBeDefined();
        const { SessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
        expect(tree?.root.findAllByType(SessionTranscriptSourceProvider).map((root) => root.props.source)).toEqual([
            expect.objectContaining({ kind: 'app', sessionId: 'session-1', serverId: 'home-b' }),
        ]);
        expect(toolFullViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            forcePermissionFooterInTranscript: true,
            owningMessageId: 'message-1',
            serverId: 'home-b',
            interaction: expect.objectContaining({ canApprovePermissions: true }),
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
            executionRunRequestedAction: { v: 1, kind: 'send_now' },
            setManualRecipient: vi.fn(),
            setExecutionRunRequestedAction: vi.fn(),
        };
        participantComposerSpy.mockClear();

        await renderScreen(React.createElement(SessionMessageDetailsView, {
                    sessionId: 'session-1',
                    session,
                    message,
                }));

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
                    key: 'execution-run-requested-action',
                    controlId: 'delivery',
                    collapsedOptionsPopover: expect.objectContaining({
                        selectedOptionId: 'send_now',
                    }),
                }),
            ]),
        }));
    });
});

afterEach(() => {
    resetTranscriptCommonModuleMockState();
});
