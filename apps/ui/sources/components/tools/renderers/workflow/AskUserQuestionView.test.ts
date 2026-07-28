import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { createSessionFixture, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { changeTextTestInstance, findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';
import { STRUCTURED_QUESTION_LIMITS } from '@happier-dev/protocol';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const sessionAllowWithAnswers = vi.fn();
const modalAlert = vi.fn();
let supportsAnswersInPermission = true;
let structuredQuestionAnswersV1Supported = true;
let activeAskUserQuestionRequest: { tool: string; kind?: 'user_action' } | null = null;
let activeAskUserQuestionRequestId = 'toolu_1';

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
        const { createStorageModuleStub, createStorageStoreStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: createStorageStoreStub(() => ({
                sessions: {
                    s1: createSessionFixture({
                        id: 's1',
                        agentState: {
                            capabilities: {
                                askUserQuestionAnswersInPermission: supportsAnswersInPermission,
                                ...(structuredQuestionAnswersV1Supported
                                    ? { structuredQuestionAnswersV1Supported: true as const }
                                    : {}),
                            },
                            requests: activeAskUserQuestionRequest
                                ? {
                                    [activeAskUserQuestionRequestId]: {
                                        tool: activeAskUserQuestionRequest.tool,
                                        ...(activeAskUserQuestionRequest.kind ? { kind: activeAskUserQuestionRequest.kind } : {}),
                                        arguments: {},
                                        createdAt: 1,
                                    },
                                }
                                : {},
                        },
                    }),
                },
            })),
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
        structuredQuestionAnswersV1Supported = true;
        activeAskUserQuestionRequestId = 'toolu_1';
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
    });

    it('submits answers via permission approval without sending a follow-up user message', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'structured-question-v1',
            structuredAnswersV1: { 'Pick one': ['A'] },
        });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('treats the snake-case AskUserQuestion alias as the same active request during submit revalidation', async () => {
        activeAskUserQuestionRequest = { tool: 'ask_user_question', kind: 'user_action' };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool());

        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'structured-question-v1',
            structuredAnswersV1: { 'Pick one': ['A'] },
        });
    });

    it('renders the human label for a completed canonical option value', async () => {
        const screen = await renderView(makeTool({
            state: 'completed',
            completedAt: 2,
            input: {
                questions: [{
                    header: 'Q1',
                    question: 'Pick one',
                    multiSelect: false,
                    options: [{ value: 'opaque-wire-id', label: 'Human A', description: '' }],
                }],
            },
            result: {
                structuredAnswersV1: { 'Pick one': ['opaque-wire-id'] },
            },
        }));

        expect(screen.getTextContent()).toContain('Human A');
        expect(screen.getTextContent()).not.toContain('opaque-wire-id');
    });

    it('exposes stable testIDs for native E2E (Maestro)', async () => {
        const screen = await renderView(makeTool());

        expect(screen.findByProps({ testID: 'ask-user-question' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:1' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.submit' })).toBeTruthy();
    });

    it('caps multi-select choices at the shared answer limit with visible guidance', async () => {
        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    header: 'Q1',
                    question: 'Pick many',
                    multiSelect: true,
                    options: Array.from(
                        { length: STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion + 1 },
                        (_, index) => ({ label: `Option ${index}`, description: '' }),
                    ),
                }],
            },
        }));

        for (let index = 0; index < STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion; index += 1) {
            await pressPressableByLabel(screen, `Option ${index}`);
        }

        expect(screen.findByProps({
            testID: `ask-user-question.option:0:${STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion}`,
        })?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('tools.askUserQuestion.selectionLimit');

        await pressPressableByLabel(screen, 'Option 0');
        expect(screen.findByProps({
            testID: `ask-user-question.option:0:${STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion}`,
        })?.props.disabled).toBe(false);
        expect(screen.getTextContent()).not.toContain('tools.askUserQuestion.selectionLimit');
    });

    it('falls back to tool.id when permission metadata is missing but the matching request is still active', async () => {
        activeAskUserQuestionRequestId = 'toolu_reconnect';
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({ id: 'toolu_reconnect', permission: undefined }));

        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_reconnect', {
            protocol: 'structured-question-v1',
            structuredAnswersV1: { 'Pick one': ['A'] },
        });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('does not allow answering when no permission request id is available', async () => {
        const screen = await renderView(makeTool({ id: undefined, permission: undefined }));

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
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'structured-question-v1',
            structuredAnswersV1: { 'Pick one': ['A'] },
        });
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
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'structured-question-v1',
            structuredAnswersV1: { 'Which file should I inspect?': ['README.md'] },
        });
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
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'structured-question-v1',
            structuredAnswersV1: { 'What are you trying to achieve?': ['Custom goal, with commas'] },
        });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('bounds freeform input with the protocol-owned string limit', async () => {
        const screen = await renderView(makeSuggestionsWithFreeformTool());
        expect(screen.findByType('TextInput' as any).props.maxLength).toBe(16_384);
    });

    it('keeps malformed older-CLI questions render-safe and disables submission with guidance', async () => {
        const malformed = makeTool({
            input: {
                questions: [{
                    header: ' ',
                    question: undefined as any,
                    multiSelect: false,
                    options: [{ label: 'A', description: '' }],
                }],
            },
        });
        const screen = await renderView(malformed);

        expect(screen.getTextContent()).toContain('errors.failedToSendMessage');
        expect(findPressableByLabel(screen, 'tools.askUserQuestion.submit')).toBeUndefined();
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
    });

    it('keeps a non-object older-CLI question entry render-safe and non-interactive', async () => {
        const screen = await renderView(makeTool({ input: { questions: [null as any] } }));
        expect(screen.getTextContent()).toContain('errors.failedToSendMessage');
        expect(findPressableByLabel(screen, 'tools.askUserQuestion.submit')).toBeUndefined();
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
    });

    it.each([
        ['a null option', { questions: [{ header: 'Q1', question: 'Pick one', multiSelect: false, options: [null] }] }],
        [
            'too many questions',
            {
                questions: Array.from(
                    { length: STRUCTURED_QUESTION_LIMITS.maxQuestions + 1 },
                    (_, index) => ({ header: `Q${index}`, question: `Question ${index}`, multiSelect: false, options: [] }),
                ),
            },
        ],
    ])('keeps older-CLI input with %s bounded and render-safe', async (_name, input) => {
        const screen = await renderView(makeTool({ input: input as any }));
        expect(screen.getTextContent()).toContain('errors.failedToSendMessage');
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
    });

    it.each(['RPC_METHOD_NOT_AVAILABLE', 'RPC_METHOD_NOT_FOUND'])(
        'shows CLI update guidance after a modern %s failure while preserving the pending form',
        async (errorCode) => {
            sessionAllowWithAnswers.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { rpcErrorCode: errorCode }));
            const screen = await renderView(makeTool());
            await chooseOptionAndSubmit(screen, 'A');

            expect(screen.getTextContent()).toContain('deps.ui.notAvailableUpdateCli');
            expect(modalAlert).not.toHaveBeenCalled();
            expect(findPressableByLabel(screen, 'tools.askUserQuestion.submit')?.props.disabled).toBe(false);
        },
    );
});
