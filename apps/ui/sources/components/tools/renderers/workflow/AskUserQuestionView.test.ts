import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { changeTextTestInstance, findTestInstanceByTypeContainingText, invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const sessionAllowWithAnswers = vi.fn();
const modalAlert = vi.fn();
const openAttachedSessionTerminal = vi.fn();
const setWorkspaceTrust = vi.fn();
const setResumeChoice = vi.fn();
let supportsAnswersInPermission = true;
let attachedSessionTerminalAvailable = true;
let attachedSessionTerminalUnavailableReason: 'missing_machine' | 'terminal_disabled' | 'cli_update_required' | null = null;
let activeAskUserQuestionRequest: { tool: string; kind?: 'user_action'; source?: string } | null = null;
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
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => ({
                agentState: {
                    capabilities: { askUserQuestionAnswersInPermission: supportsAnswersInPermission },
                    requests: activeAskUserQuestionRequest
                        ? {
                            [activeAskUserQuestionRequestId]: {
                                tool: activeAskUserQuestionRequest.tool,
                                ...(activeAskUserQuestionRequest.kind ? { kind: activeAskUserQuestionRequest.kind } : {}),
                                ...(activeAskUserQuestionRequest.source ? { source: activeAskUserQuestionRequest.source } : {}),
                                arguments: {},
                                createdAt: 1,
                            },
                        }
                        : {},
                },
            }),
            useSettingMutable: (key: string) => [
                key === 'claudeUnifiedTerminalWorkspaceTrust' || key === 'claudeUnifiedTerminalResumeChoice'
                    ? 'ask_every_time'
                    : null,
                key === 'claudeUnifiedTerminalWorkspaceTrust'
                    ? setWorkspaceTrust
                    : key === 'claudeUnifiedTerminalResumeChoice'
                        ? setResumeChoice
                        : vi.fn(),
            ],
            storage: {
                getState: () => ({
                    sessions: {
                        s1: {
                            agentState: {
                                capabilities: { askUserQuestionAnswersInPermission: supportsAnswersInPermission },
                                requests: activeAskUserQuestionRequest
                                    ? {
                                        [activeAskUserQuestionRequestId]: {
                                            tool: activeAskUserQuestionRequest.tool,
                                            ...(activeAskUserQuestionRequest.kind ? { kind: activeAskUserQuestionRequest.kind } : {}),
                                            ...(activeAskUserQuestionRequest.source ? { source: activeAskUserQuestionRequest.source } : {}),
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

vi.mock('@/components/sessions/terminal/openAttachedSessionTerminal', () => ({
    useOpenAttachedSessionTerminal: () => ({
        available: attachedSessionTerminalAvailable,
        unavailableReason: attachedSessionTerminalUnavailableReason,
        open: (...args: any[]) => openAttachedSessionTerminal(...args),
    }),
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
        openAttachedSessionTerminal.mockReset();
        setWorkspaceTrust.mockReset();
        setResumeChoice.mockReset();
        supportsAnswersInPermission = true;
        attachedSessionTerminalAvailable = true;
        attachedSessionTerminalUnavailableReason = null;
        activeAskUserQuestionRequestId = 'toolu_1';
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
    });

    it('submits answers via permission approval without sending a follow-up user message', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'legacy-permission',
            answers: { 'Pick one': 'A' },
        });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('keeps native freeform input touches inside the field instead of bubbling to transcript keyboard dismissal', async () => {
        const screen = await renderView(makeFreeformTool());
        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        const stopPropagation = vi.fn();

        invokeTestInstanceHandler(
            input,
            'onTouchStart',
            { stopPropagation },
            'ask-user-question freeform touch start',
        );

        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('opens the attached Claude terminal without resolving the permission request', async () => {
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{
                    header: 'Claude dialog',
                    question: 'Open the terminal?',
                    multiSelect: false,
                    options: [],
                }],
            },
        }));

        const openTerminal = screen.findByProps({ testID: 'ask-user-question.open-claude-terminal' });
        expect(openTerminal).toBeTruthy();
        await pressTestInstanceAsync(openTerminal, 'Open Claude terminal');

        expect(openAttachedSessionTerminal).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
    });

    it('fails closed when the connected CLI cannot open an attached Claude terminal', async () => {
        attachedSessionTerminalAvailable = false;
        attachedSessionTerminalUnavailableReason = 'cli_update_required';
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{
                    header: 'Claude dialog',
                    question: 'Open the terminal?',
                    multiSelect: false,
                    options: [],
                }],
            },
        }));

        expect(screen.findAllByProps({ testID: 'ask-user-question.open-claude-terminal' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'ask-user-question.attached-terminal-unavailable' })).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'deps.ui.notAvailableUpdateCli')).toBeTruthy();
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
    });

    it('reports a missing machine target without suggesting a CLI update', async () => {
        attachedSessionTerminalAvailable = false;
        attachedSessionTerminalUnavailableReason = 'missing_machine';
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{ header: 'Claude dialog', question: 'Open the terminal?', multiSelect: false, options: [] }],
            },
        }));

        expect(findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'terminalEmbedded.errors.missingMachineTarget',
        )).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'deps.ui.notAvailableUpdateCli')).toBeUndefined();
    });

    it('does not suggest a CLI update when terminal navigation is blocked only by read-only access', async () => {
        attachedSessionTerminalAvailable = false;
        attachedSessionTerminalUnavailableReason = 'missing_machine';
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{
                    header: 'Claude dialog',
                    question: 'Open the terminal?',
                    multiSelect: false,
                    options: [],
                }],
            },
        }), {
            interaction: { canApprovePermissions: false, permissionDisabledReason: 'readOnly' },
        });

        expect(screen.findAllByProps({ testID: 'ask-user-question.attached-terminal-unavailable' })).toHaveLength(0);
        expect(findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'session.sharing.permissionApprovalsDisabledReadOnly',
        )).toBeTruthy();
    });

    it('keeps recognized choices answerable while explaining that the attached terminal is unavailable', async () => {
        attachedSessionTerminalAvailable = false;
        attachedSessionTerminalUnavailableReason = 'cli_update_required';
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{ choice: 'trust_once', label: 'Trust once', description: '' }],
                }],
            },
        }));

        expect(screen.findAllByProps({ testID: 'ask-user-question.open-claude-terminal' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'ask-user-question.attached-terminal-unavailable' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.submit' })).toBeTruthy();
    });

    it('keeps recognized dialog choices answerable while exposing attached-terminal navigation', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'recognized',
                    dialogId: 'trust_folder',
                    secondaryAction: 'open_terminal',
                },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{
                        choice: 'trust_always',
                        label: 'Trust and remember',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                            value: 'always_trust_happier_workspaces',
                        },
                    }],
                }],
            },
        }));

        expect(screen.findByProps({ testID: 'ask-user-question.open-claude-terminal' })).toBeTruthy();
        await chooseOptionAndSubmit(screen, 'Trust and remember');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'legacy-permission',
            answers: { 'How should Claude continue?': 'trust_always' },
        });
        expect(setWorkspaceTrust).toHaveBeenCalledWith('always_trust_happier_workspaces');
    });

    it('persists a remembered resume policy only after the canonical dialog answer succeeds', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'recognized',
                    dialogId: 'resume_choice',
                    secondaryAction: 'open_terminal',
                },
                questions: [{
                    header: 'Claude resume',
                    question: 'How should Claude resume this session?',
                    multiSelect: false,
                    options: [{
                        choice: 'always_resume_from_summary',
                        label: 'Always resume from summary',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalResumeChoice',
                            value: 'resume_from_summary',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Always resume from summary');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'legacy-permission',
            answers: { 'How should Claude resume this session?': 'always_resume_from_summary' },
        });
        expect(setResumeChoice).toHaveBeenCalledWith('resume_from_summary');
    });

    it('ignores a forged workspace-trust mutation without canonical request-source proof', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{
                        choice: 'trust_always',
                        label: 'Trust and remember',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                            value: 'always_trust_happier_workspaces',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Trust and remember');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'legacy-permission',
            answers: { 'How should Claude continue?': 'trust_always' },
        });
        expect(setWorkspaceTrust).not.toHaveBeenCalled();
    });

    it('ignores an unrecognized setting mutation while preserving the one-shot answer', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{
                        choice: 'trust_once',
                        label: 'Trust once',
                        description: '',
                        settingMutation: { settingId: 'arbitrarySetting', value: 'enabled' },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Trust once');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'legacy-permission',
            answers: { 'How should Claude continue?': 'trust_once' },
        });
        expect(setWorkspaceTrust).not.toHaveBeenCalled();
    });

    it('exposes stable testIDs for native E2E (Maestro)', async () => {
        const screen = await renderView(makeTool());

        expect(screen.findByProps({ testID: 'ask-user-question' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:1' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.submit' })).toBeTruthy();
    });

    it('falls back to tool.id when permission metadata is missing but the matching request is still active', async () => {
        activeAskUserQuestionRequestId = 'toolu_reconnect';
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({ id: 'toolu_reconnect', permission: undefined }));

        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_reconnect', {
            protocol: 'legacy-permission',
            answers: { 'Pick one': 'A' },
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

    it.each([
        ['STRUCTURED_QUESTION_INVALID', 'tools.askUserQuestion.submissionFailures.retry'],
        ['STRUCTURED_QUESTION_LEGACY_INVALID', 'tools.askUserQuestion.submissionFailures.retry'],
        ['STRUCTURED_QUESTION_LEGACY_AMBIGUOUS', 'tools.askUserQuestion.submissionFailures.retry'],
        ['STRUCTURED_QUESTION_RECEIVER_NOT_OWNER', 'tools.askUserQuestion.submissionFailures.reconnect'],
        ['RPC_METHOD_NOT_AVAILABLE', 'tools.askUserQuestion.submissionFailures.update'],
        ['RPC_METHOD_NOT_FOUND', 'tools.askUserQuestion.submissionFailures.update'],
    ])('keeps the pending answer selected and shows inline guidance for %s', async (rpcErrorCode, guidanceKey) => {
        sessionAllowWithAnswers.mockRejectedValueOnce(Object.assign(new Error('private server detail'), { rpcErrorCode }));

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
        expect(findTestInstanceByTypeContainingText(screen, 'Text', guidanceKey)).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' }).props.accessibilityState).toEqual({ selected: true });
        expect(screen.findByProps({ testID: 'ask-user-question.submit' }).props.disabled).toBe(false);
    });

    it('shows a safe generic error when permission approval fails without a public code', async () => {
        sessionAllowWithAnswers.mockRejectedValueOnce(new Error('boom'));

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'errors.failedToSendMessage');
    });

    it('uses permission approval when answers-in-permission capability is unavailable but the matching request is still active', async () => {
        supportsAnswersInPermission = false;
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'legacy-permission',
            answers: { 'Pick one': 'A' },
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
            protocol: 'legacy-permission',
            answers: { 'Which file should I inspect?': 'README.md' },
        });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('uses a provider-supplied freeform initial value as the editable answer', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const tool = makeFreeformTool();
        tool.input = {
            questions: [{
                question: 'Which file should I inspect?',
                header: 'File',
                multiSelect: false,
                options: [],
                freeform: { initialValue: 'src/index.ts' },
            }],
        };

        const screen = await renderView(tool);
        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        expect(input.props.value).toBe('src/index.ts');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeTruthy();
        expect(submit!.props.disabled).toBe(false);
        await pressTestInstanceAsync(submit!, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            protocol: 'legacy-permission',
            answers: { 'Which file should I inspect?': 'src/index.ts' },
        });
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
        expect(submitAfter!.props.disabled).toBe(true);

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });
});
