import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { renderScreen } from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executionRunDetailsSpy = vi.hoisted(() => vi.fn());
const messageDetailsSpy = vi.hoisted(() => vi.fn());
const overviewCardSpy = vi.hoisted(() => vi.fn());
const participantComposerSpy = vi.hoisted(() => vi.fn());

function createPassthroughComponentMock(typeName: string, spy?: (props: unknown) => void) {
    return (props: unknown) => {
        spy?.(props);
        return React.createElement(typeName);
    };
}

installSessionSubagentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: { children?: React.ReactNode }) =>
                React.createElement('View', props, children),
            Platform: {
                OS: 'web',
                select: (value: { web?: unknown; default?: unknown }) => value.web ?? value.default,
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => sessionState.session,
            useResolvedSessionMessageRouteId: () => sessionState.resolvedMessageId,
            useMessage: () => sessionState.message,
        });
    },
});

vi.mock('@/components/tools/shell/views/ToolFullView', () => ({
    ToolFullView: () => React.createElement('ToolFullView'),
}));

const sessionState: {
    session: {
        id: string;
        metadata: { flavor: string };
        accessLevel: 'view' | 'edit' | 'admin' | undefined;
        canApprovePermissions: boolean;
    };
    message: Message | null;
    resolvedMessageId: string;
} = {
    session: {
        id: 's1',
        metadata: { flavor: 'claude' },
        accessLevel: 'edit',
        canApprovePermissions: true,
    },
    message: null as Message | null,
    resolvedMessageId: 'tool-msg-1',
};

vi.mock('@/sync/store/hooks', () => ({
    useSessionMessages: () => ({ messages: [] }),
}));

const subagentsState: { subagents: readonly SessionSubagent[] } = { subagents: [] };

vi.mock('@/hooks/session/useSessionSubagents', () => ({
    useSessionSubagents: () => subagentsState,
}));

vi.mock('@/components/sessions/runs/details/SessionExecutionRunDetailsView', () => ({
    SessionExecutionRunDetailsView: createPassthroughComponentMock('SessionExecutionRunDetailsView', executionRunDetailsSpy),
}));

vi.mock('@/components/sessions/transcript/details/SessionMessageDetailsView', () => ({
    SessionMessageDetailsView: createPassthroughComponentMock('SessionMessageDetailsView', messageDetailsSpy),
}));

vi.mock('@/components/sessions/agents/details/SessionSubagentOverviewCard', () => ({
    SessionSubagentOverviewCard: createPassthroughComponentMock('SessionSubagentOverviewCard', overviewCardSpy),
}));

vi.mock('@/components/sessions/participants/composer/SessionParticipantComposer', () => ({
    SessionParticipantComposer: createPassthroughComponentMock('SessionParticipantComposer', participantComposerSpy),
}));

describe('SessionSubagentDetailsView', () => {
    it('renders transcript details for execution-run subagents when a tool transcript exists', async () => {
        const { SessionSubagentDetailsView } = await import('./SessionSubagentDetailsView');
        subagentsState.subagents = [{
            id: 'execution_run:run_1',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'Code review' },
            transcript: { toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1', toolId: 'toolu_1' },
            runRef: { runId: 'run_1', backendId: 'codex' },
            recipient: { kind: 'execution_run', runId: 'run_1' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        }];
        sessionState.message = {
            id: 'tool-msg-1',
            kind: 'tool-call',
            localId: null,
            tool: {
                id: 'toolu_1',
                name: 'SubAgentRun',
                state: 'running',
                input: {},
                result: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
                description: null,
            },
            children: [],
            createdAt: 1,
        } as Message;
        executionRunDetailsSpy.mockClear();
        messageDetailsSpy.mockClear();
        overviewCardSpy.mockClear();
        participantComposerSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionSubagentDetailsView
                    sessionId="s1"
                    scopeId="session:s1"
                    subagentId="execution_run:run_1"
                />)).tree;

        expect(tree).toBeTruthy();
        expect(messageDetailsSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                message: expect.objectContaining({
                    id: 'tool-msg-1',
                    kind: 'tool-call',
                }),
                showComposer: false,
            }),
        );
        expect(messageDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('presentation');
        expect(participantComposerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                recipient: expect.objectContaining({
                    kind: 'execution_run',
                    runId: 'run_1',
                }),
                extraActionChips: expect.arrayContaining([
                    expect.objectContaining({
                        key: 'execution-run-delivery',
                        controlId: 'delivery',
                        collapsedOptionsPopover: expect.objectContaining({
                            selectedOptionId: 'steer_if_supported',
                        }),
                    }),
                ]),
            }),
        );
        expect(overviewCardSpy).toHaveBeenCalledWith(expect.objectContaining({
            subagent: expect.objectContaining({
                id: 'execution_run:run_1',
                kind: 'execution_run',
            }),
        }));
        expect(executionRunDetailsSpy).not.toHaveBeenCalled();
    });

    it('falls back to execution-run details when no tool transcript route is available', async () => {
        const { SessionSubagentDetailsView } = await import('./SessionSubagentDetailsView');
        subagentsState.subagents = [{
            id: 'execution_run:run_1',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'Code review' },
            transcript: {},
            runRef: { runId: 'run_1', backendId: 'codex' },
            recipient: { kind: 'execution_run', runId: 'run_1' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        }];
        sessionState.message = null;
        executionRunDetailsSpy.mockClear();
        messageDetailsSpy.mockClear();
        overviewCardSpy.mockClear();
        participantComposerSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionSubagentDetailsView
                    sessionId="s1"
                    scopeId="session:s1"
                    subagentId="execution_run:run_1"
                />)).tree;

        expect(tree).toBeTruthy();
        expect(executionRunDetailsSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                runId: 'run_1',
                presentation: 'panel',
                showInfoCard: false,
                showSendComposer: false,
            }),
        );
        expect(messageDetailsSpy).not.toHaveBeenCalled();
    });

    it('renders message details for tool-backed subagents', async () => {
        const { SessionSubagentDetailsView } = await import('./SessionSubagentDetailsView');
        subagentsState.subagents = [{
            id: 'agent_team_member:qa-team:alpha',
            kind: 'agent_team_member',
            status: 'running',
            display: { title: 'alpha' },
            transcript: { toolMessageRouteId: 'tool-msg-1', toolId: 'toolu_1', sidechainId: 'toolu_1' },
            recipient: {
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            },
            capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
            timestamps: {},
        }];
        sessionState.message = {
            id: 'tool-msg-1',
            kind: 'tool-call',
            localId: null,
            tool: {
                id: 'toolu_1',
                name: 'Task',
                state: 'completed',
                input: {},
                result: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 1,
                description: null,
            },
            children: [],
            createdAt: 1,
        };
        executionRunDetailsSpy.mockClear();
        messageDetailsSpy.mockClear();
        overviewCardSpy.mockClear();
        participantComposerSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionSubagentDetailsView
                    sessionId="s1"
                    scopeId="session:s1"
                    subagentId="agent_team_member:qa-team:alpha"
                />)).tree;

        expect(tree).toBeTruthy();
        expect(messageDetailsSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                message: expect.objectContaining({
                    id: 'tool-msg-1',
                    kind: 'tool-call',
                }),
                showComposer: false,
            }),
        );
        expect(messageDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('presentation');
        expect(overviewCardSpy).toHaveBeenCalledWith(expect.objectContaining({
            subagent: expect.objectContaining({
                id: 'agent_team_member:qa-team:alpha',
                kind: 'agent_team_member',
            }),
        }));
        expect(participantComposerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                recipient: expect.objectContaining({
                    kind: 'agent_team_member',
                    teamId: 'qa-team',
                    memberId: 'alpha@qa-team',
                }),
            }),
        );
        expect(executionRunDetailsSpy).not.toHaveBeenCalled();
    });

    it('allows sending for owner sessions without an explicit access level', async () => {
        const { SessionSubagentDetailsView } = await import('./SessionSubagentDetailsView');
        const previousAccessLevel = sessionState.session.accessLevel;
        sessionState.session.accessLevel = undefined;
        subagentsState.subagents = [{
            id: 'execution_run:run_owner',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'Owner run' },
            transcript: { toolMessageRouteId: 'tool-msg-owner', sidechainId: 'toolu_owner', toolId: 'toolu_owner' },
            runRef: { runId: 'run_owner', backendId: 'claude' },
            recipient: { kind: 'execution_run', runId: 'run_owner' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        }];
        sessionState.message = {
            id: 'tool-msg-owner',
            kind: 'tool-call',
            localId: null,
            tool: {
                id: 'toolu_owner',
                name: 'SubAgentRun',
                state: 'running',
                input: {},
                result: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
                description: null,
            },
            children: [],
            createdAt: 1,
        } as Message;
        participantComposerSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionSubagentDetailsView
                    sessionId="s1"
                    scopeId="session:s1"
                    subagentId="execution_run:run_owner"
                />)).tree;

        expect(tree).toBeTruthy();
        expect(participantComposerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                canSendMessages: true,
                recipient: expect.objectContaining({
                    kind: 'execution_run',
                    runId: 'run_owner',
                }),
            }),
        );

        sessionState.session.accessLevel = previousAccessLevel;
    });
});
