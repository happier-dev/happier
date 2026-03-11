import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, collectNodeText, findPressableByText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const sessionAllowWithAnswers = vi.fn();
const modalAlert = vi.fn();
let supportsAnswersInPermission = true;
let activeAskUserQuestionRequest: { tool: string; kind?: 'user_action' } | null = null;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: any[]) => modalAlert(...args),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/sync/ops', () => ({
    sessionDeny: (...args: any[]) => sessionDeny(...args),
    sessionAllowWithAnswers: (...args: any[]) => sessionAllowWithAnswers(...args),
}));

vi.mock('@/sync/domains/state/storage', () => ({
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
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: any[]) => sendMessage(...args),
    },
}));

describe('AskUserQuestionView', () => {
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

    async function renderView(tool: ToolCall, overrides: Record<string, unknown> = {}) {
        const { AskUserQuestionView } = await import('./AskUserQuestionView');
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    AskUserQuestionView,
                    makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
                ),
            );
        });
        return tree!;
    }

    async function chooseOptionAndSubmit(tree: renderer.ReactTestRenderer, optionLabel: string) {
        const option = tree.root.findAllByType('TouchableOpacity' as any).find((node) => {
            const labels = node.findAllByType('Text').flatMap((textNode) => collectNodeText(textNode));
            return labels.includes(optionLabel);
        });
        expect(option).toBeTruthy();
        await act(async () => {
            option!.props.onPress();
        });

        const submit = tree.root.findAllByType('TouchableOpacity' as any).find((node) => {
            const labels = node.findAllByType('Text').flatMap((textNode) => collectNodeText(textNode));
            return labels.includes('tools.askUserQuestion.submit');
        });
        expect(submit).toBeTruthy();
        await act(async () => {
            await submit!.props.onPress();
        });
    }

    async function fillFreeformAndSubmit(tree: renderer.ReactTestRenderer, answer: string) {
        const input = tree.root.findByType('TextInput' as any);
        await act(async () => {
            input.props.onChangeText(answer);
        });

        const submit = findPressableByText(tree, 'tools.askUserQuestion.submit');
        expect(submit).toBeTruthy();
        expect(submit!.props.disabled).toBe(false);
        await act(async () => {
            await submit!.props.onPress();
        });
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

        const tree = await renderView(makeTool());
        await chooseOptionAndSubmit(tree, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Pick one': 'A' });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('does not allow answering when the permission id is missing', async () => {
        const tree = await renderView(makeTool({ permission: undefined }));

        const option = findPressableByText(tree, 'A');
        expect(option).toBeTruthy();
        await act(async () => {
            await option!.props.onPress();
        });

        const submit = findPressableByText(tree, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('shows an error when permission approval fails', async () => {
        sessionAllowWithAnswers.mockRejectedValueOnce(new Error('boom'));

        const tree = await renderView(makeTool());
        await chooseOptionAndSubmit(tree, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'boom');
    });

    it('uses permission approval when answers-in-permission capability is unavailable but the matching request is still active', async () => {
        supportsAnswersInPermission = false;
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const tree = await renderView(makeTool());
        await chooseOptionAndSubmit(tree, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Pick one': 'A' });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('does not allow answering when the matching AskUserQuestion request is no longer active', async () => {
        supportsAnswersInPermission = true;
        activeAskUserQuestionRequest = null;

        const tree = await renderView(makeTool());

        const option = findPressableByText(tree, 'A');
        expect(option).toBeTruthy();
        await act(async () => {
            await option!.props.onPress();
        });

        const submit = findPressableByText(tree, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();
        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('does not allow answering when canApprovePermissions is false', async () => {
        const tree = await renderView(
            makeTool(),
            {
                interaction: {
                    canSendMessages: true,
                    canApprovePermissions: false,
                    permissionDisabledReason: 'notGranted',
                },
            },
        );

        const option = findPressableByText(tree, 'A');
        expect(option).toBeTruthy();
        await act(async () => {
            await option!.props.onPress();
        });

        const submit = findPressableByText(tree, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);

        const texts = collectHostText(tree);
        expect(texts).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });

    it('supports freeform questions with no options by submitting typed answers', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const tree = await renderView(makeFreeformTool());
        await fillFreeformAndSubmit(tree, 'README.md');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Which file should I inspect?': 'README.md' });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('supports suggestion questions that allow a typed freeform answer (options + freeform)', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const tree = await renderView(makeSuggestionsWithFreeformTool());

        const submitBefore = findPressableByText(tree, 'tools.askUserQuestion.submit');
        expect(submitBefore).toBeTruthy();
        expect(submitBefore!.props.disabled).toBe(true);

        const input = tree.root.findByType('TextInput' as any);
        await act(async () => {
            input.props.onChangeText('Custom goal, with commas');
        });

        const submitAfter = findPressableByText(tree, 'tools.askUserQuestion.submit');
        expect(submitAfter).toBeTruthy();
        expect(submitAfter!.props.disabled).toBe(false);

        await act(async () => {
            await submitAfter!.props.onPress();
        });

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'What are you trying to achieve?': 'Custom goal, with commas' });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });
});
