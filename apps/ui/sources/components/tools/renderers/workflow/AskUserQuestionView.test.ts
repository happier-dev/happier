import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { changeTextTestInstance, findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const sessionAllowWithAnswers = vi.fn();
const modalAlert = vi.fn();
let supportsAnswersInPermission = true;
let activeAskUserQuestionRequest: { tool: string; kind?: 'user_action' } | null = null;

installWorkflowRendererCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => modalAlert(...args),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({
                    sessions: {
                        s1: {
                            agentState: {
                                capabilities: { askUserQuestionAnswersInPermission: supportsAnswersInPermission },
                                requests: activeAskUserQuestionRequest
                                    ? {
                                        toolu_1: {
                                            tool: activeAskUserQuestionRequest.tool,
                                            ...(activeAskUserQuestionRequest.kind ? { kind: activeAskUserQuestionRequest.kind } : {}),
                                            arguments: {},
                                            createdAt: 1,
                                        },
                                    }
                                    : {},
                            },
                        },
                    },
                }),
            },
        });
    },
});

vi.mock('@/sync/ops', () => ({
    sessionDeny: (...args: any[]) => sessionDeny(...args),
    sessionAllowWithAnswers: (...args: any[]) => sessionAllowWithAnswers(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: any[]) => sendMessage(...args),
    },
}));

describe('AskUserQuestionView', () => {
    type Screen = Awaited<ReturnType<typeof renderScreen>>;

    function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [
                    {
                        header: 'Q1',
                        question: 'Pick one',
                        multiSelect: false,
                        options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
                    },
                ],
            },
            completedAt: null,
            permission: { id: 'toolu_1', status: 'pending' },
            ...overrides,
        });
    }

    function makeFreeformTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [
                    {
                        header: 'Q1',
                        question: 'Which file should I inspect?',
                        multiSelect: false,
                        options: [],
                    },
                ],
            },
            completedAt: null,
            permission: { id: 'toolu_1', status: 'pending' },
            ...overrides,
        });
    }

    function makeSuggestionsWithFreeformTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [
                    {
                        header: 'Q1',
                        question: 'What are you trying to achieve?',
                        multiSelect: false,
                        options: [{ label: 'Option A', description: '' }, { label: 'Option B', description: '' }],
                        freeform: { placeholder: 'Other (type below)', description: 'Type a different goal.' },
                    },
                ],
            },
            completedAt: null,
            permission: { id: 'toolu_1', status: 'pending' },
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, overrides: Record<string, unknown> = {}): Promise<Screen> {
        const { AskUserQuestionView } = await import('./AskUserQuestionView');
        return renderScreen(React.createElement(
            AskUserQuestionView,
            makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
        ));
    }

    function findPressableByLabel(screen: Screen, label: string) {
        return findTestInstanceByTypeContainingText(screen, 'TouchableOpacity', label);
    }

    async function pressPressableByLabel(screen: Screen, label: string) {
        const target = findPressableByLabel(screen, label);
        expect(target).toBeTruthy();
        await pressTestInstanceAsync(target, label);
    }

    async function chooseOptionAndSubmit(screen: Screen, optionLabel: string) {
        await pressPressableByLabel(screen, optionLabel);
        await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');
    }

    async function fillFreeformAndSubmit(screen: Screen, answer: string) {
        const input = screen.findByType('TextInput' as any);
        expect(input).toBeTruthy();
        await act(async () => {
            changeTextTestInstance(input, answer, 'ask-user-question freeform input');
        });

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeTruthy();
        expect(submit!.props.disabled).toBe(false);
        await pressTestInstanceAsync(submit, 'tools.askUserQuestion.submit');
    }

    beforeEach(() => {
        sessionDeny.mockReset();
        sendMessage.mockReset();
        sessionAllowWithAnswers.mockReset();
        modalAlert.mockReset();
        supportsAnswersInPermission = true;
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
    });

    it('submits answers via permission approval without sending a follow-up user message', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Pick one': 'A' });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('exposes stable testIDs for native E2E (Maestro)', async () => {
        const screen = await renderView(makeTool());

        expect(screen.findByProps({ testID: 'ask-user-question' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:1' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.submit' })).toBeTruthy();
    });

    it('does not allow answering when the permission id is missing', async () => {
        const screen = await renderView(makeTool({ permission: undefined }));

        const option = findPressableByLabel(screen, 'A');
        expect(option).toBeTruthy();
        await pressTestInstanceAsync(option, 'A');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('shows an error when permission approval fails', async () => {
        sessionAllowWithAnswers.mockRejectedValueOnce(new Error('boom'));

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'boom');
    });

    it('uses permission approval when answers-in-permission capability is unavailable but the matching request is still active', async () => {
        supportsAnswersInPermission = false;
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Pick one': 'A' });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('does not allow answering when the matching AskUserQuestion request is no longer active', async () => {
        supportsAnswersInPermission = true;
        activeAskUserQuestionRequest = null;

        const screen = await renderView(makeTool());

        const option = findPressableByLabel(screen, 'A');
        expect(option).toBeTruthy();
        await pressTestInstanceAsync(option, 'A');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();
        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('does not allow answering when canApprovePermissions is false', async () => {
        const screen = await renderView(
            makeTool(),
            {
                interaction: {
                    canSendMessages: true,
                    canApprovePermissions: false,
                    permissionDisabledReason: 'notGranted',
                },
            },
        );

        const option = findPressableByLabel(screen, 'A');
        expect(option).toBeTruthy();
        await pressTestInstanceAsync(option, 'A');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);

        const texts = screen.getTextContent();
        expect(texts).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });

    it('supports freeform questions with no options by submitting typed answers', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeFreeformTool());
        await fillFreeformAndSubmit(screen, 'README.md');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Which file should I inspect?': 'README.md' });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('supports suggestion questions that allow a typed freeform answer (options + freeform)', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeSuggestionsWithFreeformTool());

        const submitBefore = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submitBefore).toBeTruthy();
        expect(submitBefore!.props.disabled).toBe(true);

        const input = screen.findByType('TextInput' as any);
        await act(async () => {
            changeTextTestInstance(input, 'Custom goal, with commas', 'ask-user-question freeform input');
        });

        const submitAfter = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submitAfter).toBeTruthy();
        expect(submitAfter!.props.disabled).toBe(false);

        await pressTestInstanceAsync(submitAfter, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'What are you trying to achieve?': 'Custom goal, with commas' });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });
});
