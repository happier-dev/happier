import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import {
    createReactiveStorageStoreMock,
    createSessionFixture,
    findTestInstanceByTypeContainingText,
    makeToolCall,
    makeToolViewProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllowWithAnswers = vi.fn();
const request = {
    tool: 'AskUserQuestion',
    kind: 'user_action' as const,
    arguments: {},
    createdAt: 1,
};
const storageStore = createReactiveStorageStoreMock({
    sessions: {
        s1: createSessionFixture({
            id: 's1',
            agentState: {
                capabilities: {},
                requests: { toolu_1: request },
            },
        }),
    },
});

installWorkflowRendererCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({ storage: storageStore });
    },
});

vi.mock('@/sync/ops', () => ({
    sessionAllowWithAnswers: (...args: unknown[]) => sessionAllowWithAnswers(...args),
}));

describe('AskUserQuestionView capability reactivity', () => {
    beforeEach(() => {
        sessionAllowWithAnswers.mockReset();
        storageStore.setState((state) => ({
            sessions: {
                ...state.sessions,
                s1: {
                    ...state.sessions.s1,
                    agentState: {
                        ...state.sessions.s1.agentState,
                        capabilities: {},
                        requests: { toolu_1: request },
                    },
                },
            },
        }));
    });

    it('recovers an unsafe selection when structured-answer support arrives without remounting', async () => {
        const { AskUserQuestionView } = await import('./AskUserQuestionView');
        const tool: ToolCall = makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [{
                    header: 'Q1',
                    question: 'Pick one',
                    multiSelect: false,
                    options: [{ label: 'Washington, D.C.\nRemote', description: '' }],
                }],
            },
            permission: { id: 'toolu_1', status: 'pending' },
        });
        const screen = await renderScreen(React.createElement(
            AskUserQuestionView,
            makeToolViewProps(tool, { sessionId: 's1' }),
        ));

        const option = findTestInstanceByTypeContainingText(screen, 'TouchableOpacity', 'Washington, D.C.\nRemote');
        expect(option).toBeTruthy();
        await pressTestInstanceAsync(option, 'unsafe option');

        const blockedSubmit = screen.findByTestId('ask-user-question.submit');
        expect(blockedSubmit?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('deps.ui.notAvailableUpdateCli');

        await act(async () => {
            storageStore.setState((state) => ({
                sessions: {
                    ...state.sessions,
                    s1: {
                        ...state.sessions.s1,
                        agentState: {
                            ...state.sessions.s1.agentState,
                            capabilities: { structuredQuestionAnswersV1Supported: true },
                        },
                    },
                },
            }));
        });

        const enabledSubmit = screen.findByTestId('ask-user-question.submit');
        expect(enabledSubmit?.props.disabled).toBe(false);
        expect(screen.getTextContent()).not.toContain('deps.ui.notAvailableUpdateCli');

        await act(async () => {
            storageStore.setState((state) => ({
                sessions: {
                    ...state.sessions,
                    s1: {
                        ...state.sessions.s1,
                        agentState: {
                            ...state.sessions.s1.agentState,
                            capabilities: {},
                        },
                    },
                },
            }));
        });
        expect(screen.findByTestId('ask-user-question.submit')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('deps.ui.notAvailableUpdateCli');

        await act(async () => {
            storageStore.setState((state) => ({
                sessions: {
                    ...state.sessions,
                    s1: {
                        ...state.sessions.s1,
                        agentState: {
                            ...state.sessions.s1.agentState,
                            capabilities: { structuredQuestionAnswersV1Supported: true },
                        },
                    },
                },
            }));
        });

        await pressTestInstanceAsync(screen.findByTestId('ask-user-question.submit'), 'modern submit');
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'structured-question-v1',
            structuredAnswersV1: { 'Pick one': ['Washington, D.C.\nRemote'] },
        });
    });

    it('stops offering submission when the live request disappears', async () => {
        storageStore.setState((state) => ({
            sessions: {
                ...state.sessions,
                s1: {
                    ...state.sessions.s1,
                    agentState: {
                        ...state.sessions.s1.agentState,
                        capabilities: { structuredQuestionAnswersV1Supported: true },
                    },
                },
            },
        }));
        const { AskUserQuestionView } = await import('./AskUserQuestionView');
        const tool = makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [{
                    header: 'Q1',
                    question: 'Pick one',
                    multiSelect: false,
                    options: [{ label: 'Safe answer', description: '' }],
                }],
            },
            permission: { id: 'toolu_1', status: 'pending' },
        });
        const screen = await renderScreen(React.createElement(
            AskUserQuestionView,
            makeToolViewProps(tool, { sessionId: 's1' }),
        ));

        const option = findTestInstanceByTypeContainingText(screen, 'TouchableOpacity', 'Safe answer');
        await pressTestInstanceAsync(option, 'safe option');
        expect(screen.findByTestId('ask-user-question.submit')?.props.disabled).toBe(false);

        await act(async () => {
            storageStore.setState((state) => ({
                sessions: {
                    ...state.sessions,
                    s1: {
                        ...state.sessions.s1,
                        agentState: {
                            ...state.sessions.s1.agentState,
                            requests: {},
                        },
                    },
                },
            }));
        });

        expect(screen.findByTestId('ask-user-question.submit')).toBeNull();
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
    });
});
