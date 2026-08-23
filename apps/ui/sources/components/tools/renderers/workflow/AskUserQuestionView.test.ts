import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import {
    changeTextTestInstance,
    createDeferred,
    findTestInstanceByTypeContainingText,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const sessionAllowWithAnswers = vi.fn();
const modalAlert = vi.fn();
const openAttachedSessionTerminal = vi.fn();
const useSettingMutable = vi.fn(() => [null, vi.fn()]);
const machinePluginSettingsSet = vi.fn();
const resolvePreferredServerIdForSessionId = vi.fn(() => 'server-a');
const getServerProfileById = vi.fn((_serverId: string) => ({ serverIdentityId: 'srv_server_a' }));
const scopedPluginSettingsRead = vi.fn();
const scopedPluginSettingsWrite = vi.fn();
const resolveScopedPluginSettingsServerIdentity = vi.fn((_serverId: string): string | null => 'srv_server_a');
const activeAccountLifetime = vi.hoisted(() => Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose(): void {} }),
}));
let attachedSessionTerminalAvailable = true;
let attachedSessionTerminalUnavailableReason: 'missing_machine' | 'terminal_disabled' | 'cli_update_required' | null = null;
let supportsAnswersInPermission = true;
let activeAskUserQuestionRequest: { tool: string; kind?: 'user_action'; source?: string } | null = null;
let activeAskUserQuestionRequestId = 'toolu_1';
const askUserQuestionSessionState = vi.hoisted(() => ({
    current: null as Record<string, unknown> | null,
}));

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
            useSettingMutable,
            storage: {
                getState: () => ({
                    sessions: {
                        s1: askUserQuestionSessionState.current ?? {
                            metadata: { machineId: 'machine-1' },
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

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machinePluginSettingsSet: (...args: unknown[]) => machinePluginSettingsSet(...args),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => resolvePreferredServerIdForSessionId(),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: (serverId: string) => getServerProfileById(serverId),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime,
}));

vi.mock('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime', () => ({
    scopedPluginSettingsAdapter: {
        read: (...args: unknown[]) => scopedPluginSettingsRead(...args),
        write: (...args: unknown[]) => scopedPluginSettingsWrite(...args),
    },
    resolveScopedPluginSettingsServerIdentity: (serverId: string) => (
        resolveScopedPluginSettingsServerIdentity(serverId)
    ),
}));

vi.mock('@/components/sessions/terminal/openAttachedSessionTerminal', () => ({
    useOpenAttachedSessionTerminal: () => ({
        available: attachedSessionTerminalAvailable,
        unavailableReason: attachedSessionTerminalUnavailableReason,
        open: (...args: unknown[]) => openAttachedSessionTerminal(...args),
    }),
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
        openAttachedSessionTerminal.mockReset();
        useSettingMutable.mockClear();
        machinePluginSettingsSet.mockReset();
        machinePluginSettingsSet.mockResolvedValue({
            supported: true,
            snapshot: {
                protocolVersion: 1,
                pluginId: 'claude',
                scope: { kind: 'daemon' },
                revision: '1',
                values: {
                    claudeUnifiedTerminalWorkspaceTrust: 'always_trust_happier_workspaces',
                },
                redactedKeys: [],
            },
        });
        resolvePreferredServerIdForSessionId.mockClear();
        getServerProfileById.mockReset();
        getServerProfileById.mockReturnValue({ serverIdentityId: 'srv_server_a' });
        scopedPluginSettingsRead.mockReset();
        scopedPluginSettingsRead.mockResolvedValue({
            status: 'ready',
            snapshot: {
                scope: { kind: 'daemon' },
                target: {
                    kind: 'daemon',
                    machineId: 'machine-1',
                    serverId: 'server-a',
                    serverIdentityId: 'srv_server_a',
                },
                revision: { kind: 'daemon', value: '1' },
                values: {},
            },
        });
        scopedPluginSettingsWrite.mockReset();
        scopedPluginSettingsWrite.mockResolvedValue({
            status: 'ready',
            snapshot: {
                scope: { kind: 'daemon' },
                target: {
                    kind: 'daemon',
                    machineId: 'machine-1',
                    serverId: 'server-a',
                    serverIdentityId: 'srv_server_a',
                },
                revision: { kind: 'daemon', value: '2' },
                values: {
                    claudeUnifiedTerminalWorkspaceTrust: 'always_trust_happier_workspaces',
                },
            },
        });
        resolveScopedPluginSettingsServerIdentity.mockReset();
        resolveScopedPluginSettingsServerIdentity.mockReturnValue('srv_server_a');
        attachedSessionTerminalAvailable = true;
        attachedSessionTerminalUnavailableReason = null;
        supportsAnswersInPermission = true;
        activeAskUserQuestionRequestId = 'toolu_1';
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
        askUserQuestionSessionState.current = null;
    });

    it('submits answers via permission approval without sending a follow-up user message', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Pick one': ['A'] });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('exposes question choices and submit progress with their current accessible state', async () => {
        const approval = createDeferred<void>();
        sessionAllowWithAnswers.mockImplementationOnce(() => approval.promise);

        const screen = await renderView(makeTool());
        const option = screen.findByProps({ testID: 'ask-user-question.option:0:0' });
        const submitBeforeSelection = screen.findByProps({ testID: 'ask-user-question.submit' });

        expect(option.props.accessibilityRole).toBe('radio');
        expect(option.props.accessibilityState).toEqual({ checked: false, disabled: false });
        expect(submitBeforeSelection.props.accessibilityState).toEqual({ disabled: true, busy: false });

        await pressTestInstanceAsync(option, 'A');

        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' }).props.accessibilityState)
            .toEqual({ checked: true, disabled: false });
        const submit = screen.findByProps({ testID: 'ask-user-question.submit' });
        expect(submit.props.accessibilityState).toEqual({ disabled: false, busy: false });

        await act(async () => {
            submit.props.onPress();
        });

        expect(screen.findByProps({ testID: 'ask-user-question.submit' }).props.accessibilityState)
            .toEqual({ disabled: true, busy: true });
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' }).props.accessibilityState)
            .toEqual({ checked: true, disabled: true });

        approval.resolve();
        await act(async () => {
            await approval.promise;
        });
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(1);
    });

    it('labels freeform answers with the question they answer', async () => {
        const screen = await renderView(makeFreeformTool());
        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });

        expect(input.props.accessibilityLabel).toBe('Which file should I inspect?');
        expect(input.props.accessibilityState).toEqual({ disabled: false });
    });

    it('submits canonical multiple-choice answers by stable question and choice ids while allowing optional omissions', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                title: 'Implementation choices',
                questions: [
                    {
                        id: 'components',
                        question: 'Which components should change?',
                        required: true,
                        selection: 'multiple',
                        options: [
                            { id: 'api, gateway', label: 'API, gateway', description: 'Update the API gateway.' },
                            { id: 'ui', label: 'UI', description: 'Update the UI.' },
                        ],
                    },
                    {
                        id: 'notes',
                        question: 'Anything else?',
                        required: false,
                        selection: 'text',
                        presentation: {
                            inputMode: 'singleLine',
                            placeholder: 'Optional notes',
                            whitespace: 'trim',
                            allowEmpty: false,
                        },
                    },
                ],
            },
        }));

        const firstChoice = screen.findByProps({ testID: 'ask-user-question.option:0:0' });
        expect(firstChoice.props.accessibilityRole).toBe('checkbox');
        expect(firstChoice.props.accessibilityState).toEqual({ checked: false, disabled: false });

        await pressPressableByLabel(screen, 'API, gateway');
        await pressPressableByLabel(screen, 'UI');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeTruthy();
        expect(submit!.props.disabled).toBe(false);
        await pressTestInstanceAsync(submit, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            components: ['api, gateway', 'ui'],
        });
    });

    it('honors canonical text presentation and preserves whitespace and commas', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    id: 'notes',
                    question: 'Add implementation notes',
                    required: true,
                    selection: 'text',
                    presentation: {
                        inputMode: 'multiLine',
                        placeholder: 'Type notes',
                        whitespace: 'preserve',
                        allowEmpty: false,
                    },
                }],
            },
        }));

        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        expect(input.props.multiline).toBe(true);
        expect(input.props.placeholder).toBe('Type notes');
        await act(async () => {
            changeTextTestInstance(input, '  first, second  ', 'canonical question text input');
        });
        await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            notes: ['  first, second  '],
        });
    });

    it('submits canonical custom single-choice answers unchanged under the question id', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    id: 'goal',
                    question: 'What are you trying to achieve?',
                    required: true,
                    selection: 'single',
                    options: [{ id: 'ship', label: 'Ship it' }],
                    allowCustom: true,
                }],
            },
        }));

        await fillFreeformAndSubmit(screen, 'Custom goal, with commas');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            goal: ['Custom goal, with commas'],
        });
    });

    it('preserves selected choices and one custom value in a canonical multiple-choice answer array', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    id: 'components',
                    question: 'Which components should change?',
                    required: true,
                    selection: 'multiple',
                    options: [
                        { id: 'api, gateway', label: 'API, gateway' },
                        { id: 'ui', label: 'UI' },
                    ],
                    allowCustom: true,
                }],
            },
        }));

        await pressPressableByLabel(screen, 'API, gateway');
        await pressPressableByLabel(screen, 'UI');
        await fillFreeformAndSubmit(screen, 'Custom, other');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            components: ['api, gateway', 'ui', 'Custom, other'],
        });
    });

    it('opens a terminal-only dialog without resolving the permission request', async () => {
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{ header: 'Claude dialog', question: 'Open terminal?', multiSelect: false, options: [] }],
            },
        }));

        const action = screen.findByProps({ testID: 'ask-user-question.open-claude-terminal' });
        await pressTestInstanceAsync(action, 'Open Claude terminal');

        expect(openAttachedSessionTerminal).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
    });

    it('replaces an optionless terminal-notice prompt with the host notice copy', async () => {
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{ header: 'Claude dialog', question: 'Open terminal?', multiSelect: false, options: [] }],
            },
        }));

        expect(findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'tools.askUserQuestion.claudeDialogNotice.header',
        )).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'tools.askUserQuestion.claudeDialogNotice.question',
        )).toBeTruthy();
        // The raw TUI prompt text never reaches the user.
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'Open terminal?')).toBeUndefined();
    });

    it('leaves a terminal-notice prompt that still offers choices on its own copy', async () => {
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
                    question: 'Trust this folder?',
                    multiSelect: false,
                    options: [{ label: 'Yes', description: '' }],
                }],
            },
        }));

        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'Trust this folder?')).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'tools.askUserQuestion.claudeDialogNotice.question',
        )).toBeUndefined();
    });

    it('explains when a terminal-only dialog cannot open an attached terminal', async () => {
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
                questions: [{ header: 'Claude dialog', question: 'Open terminal?', multiSelect: false, options: [] }],
            },
        }));

        expect(screen.findAllByProps({ testID: 'ask-user-question.open-claude-terminal' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'ask-user-question.attached-terminal-unavailable' })).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'deps.ui.notAvailableUpdateCli')).toBeTruthy();
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
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

    it('fails closed on workspace-trust persistence without canonical request-source proof', async () => {
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

        expect(screen.findByProps({ testID: 'ask-user-question.open-claude-terminal' })).toBeTruthy();
        await chooseOptionAndSubmit(screen, 'Trust and remember');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', {
            'How should Claude continue?': ['trust_always'],
        });
        expect(machinePluginSettingsSet).not.toHaveBeenCalled();
        expect(useSettingMutable).not.toHaveBeenCalledWith('claudeUnifiedTerminalWorkspaceTrust');
    });

    it('persists recognized workspace trust when the live request has canonical source proof', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        askUserQuestionSessionState.current = {
            serverId: 'server-a',
            metadataLayoutVersion: 1,
            metadata: { machineId: 'shared-decoy-machine' },
            ownerMetadataView: { machineId: 'machine-1' },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        source: 'claude_unified_terminal_dialog_choice',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
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
            'How should Claude continue?': ['trust_always'],
        });
        expect(scopedPluginSettingsRead).toHaveBeenCalledWith({
            pluginId: 'claude',
            scope: { kind: 'daemon' },
            target: {
                kind: 'daemon',
                machineId: 'machine-1',
                serverId: 'server-a',
                serverIdentityId: 'srv_server_a',
            },
            fields: [{ key: 'claudeUnifiedTerminalWorkspaceTrust', redacted: false }],
        });
        expect(scopedPluginSettingsWrite).toHaveBeenCalledWith({
            pluginId: 'claude',
            fieldId: 'claudeUnifiedTerminalWorkspaceTrust',
            mutation: { kind: 'set', value: 'always_trust_happier_workspaces' },
            expectedRevision: { kind: 'daemon', value: '1' },
            scope: { kind: 'daemon' },
            target: {
                kind: 'daemon',
                machineId: 'machine-1',
                serverId: 'server-a',
                serverIdentityId: 'srv_server_a',
            },
            fields: [{ key: 'claudeUnifiedTerminalWorkspaceTrust', redacted: false }],
        });
        expect(machinePluginSettingsSet).not.toHaveBeenCalled();
        expect(resolvePreferredServerIdForSessionId).not.toHaveBeenCalled();
        expect(useSettingMutable).not.toHaveBeenCalledWith('claudeUnifiedTerminalWorkspaceTrust');
    });

    it('persists a remembered resume policy through the same scoped plugin settings owner', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        askUserQuestionSessionState.current = {
            serverId: 'server-a',
            metadataLayoutVersion: 1,
            ownerMetadataView: { machineId: 'machine-1' },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        source: 'claude_unified_terminal_dialog_choice',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'resume_choice', secondaryAction: 'open_terminal' },
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
            'How should Claude resume this session?': ['always_resume_from_summary'],
        });
        expect(scopedPluginSettingsRead).toHaveBeenCalledWith({
            pluginId: 'claude',
            scope: { kind: 'daemon' },
            target: {
                kind: 'daemon',
                machineId: 'machine-1',
                serverId: 'server-a',
                serverIdentityId: 'srv_server_a',
            },
            fields: [{ key: 'claudeUnifiedTerminalResumeChoice', redacted: false }],
        });
        expect(scopedPluginSettingsWrite).toHaveBeenCalledWith({
            pluginId: 'claude',
            fieldId: 'claudeUnifiedTerminalResumeChoice',
            mutation: { kind: 'set', value: 'resume_from_summary' },
            expectedRevision: { kind: 'daemon', value: '1' },
            scope: { kind: 'daemon' },
            target: {
                kind: 'daemon',
                machineId: 'machine-1',
                serverId: 'server-a',
                serverIdentityId: 'srv_server_a',
            },
            fields: [{ key: 'claudeUnifiedTerminalResumeChoice', redacted: false }],
        });
    });

    it('fails closed when workspace trust has no portable server identity', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        askUserQuestionSessionState.current = {
            serverId: 'server-a',
            metadataLayoutVersion: 1,
            ownerMetadataView: { machineId: 'machine-1' },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        source: 'claude_unified_terminal_dialog_choice',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        resolveScopedPluginSettingsServerIdentity.mockReturnValue(null);
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

        expect(scopedPluginSettingsWrite).not.toHaveBeenCalled();
        expect(modalAlert).toHaveBeenCalledWith(
            'common.error',
            'Unable to persist Claude workspace trust without an exact server target.',
        );
    });

    it('does not fall back to layout1 shared metadata for workspace-trust persistence', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        askUserQuestionSessionState.current = {
            metadataLayoutVersion: 1,
            metadata: { machineId: 'shared-decoy-machine' },
            ownerMetadataView: null,
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        source: 'claude_unified_terminal_dialog_choice',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
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

        expect(machinePluginSettingsSet).not.toHaveBeenCalled();
        expect(modalAlert).toHaveBeenCalledWith(
            'common.error',
            'Unable to persist Claude workspace trust without a session machine.',
        );
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
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_reconnect', { 'Pick one': ['A'] });
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
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Pick one': ['A'] });
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
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Which file should I inspect?': ['README.md'] });
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
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'What are you trying to achieve?': ['Custom goal, with commas'] });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });
});
