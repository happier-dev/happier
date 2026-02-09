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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: any[]) => modalAlert(...args),
    },
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                button: { primary: { background: '#00f', tint: '#fff' } },
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                input: { background: '#fff', placeholder: '#aaa', text: '#000' },
            },
        },
    }),
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
                s1: { agentState: { capabilities: { askUserQuestionAnswersInPermission: supportsAnswersInPermission } } },
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

    beforeEach(() => {
        sessionDeny.mockReset();
        sendMessage.mockReset();
        sessionAllowWithAnswers.mockReset();
        modalAlert.mockReset();
        supportsAnswersInPermission = true;
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

    it('shows an error when permission id is missing and does not submit', async () => {
        const tree = await renderView(makeTool({ permission: undefined }));
        await chooseOptionAndSubmit(tree, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'errors.missingPermissionId');
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

    it('falls back to deny+sendMessage when answers-in-permission capability is unavailable', async () => {
        supportsAnswersInPermission = false;
        sessionDeny.mockResolvedValueOnce(undefined);
        sendMessage.mockResolvedValueOnce(undefined);

        const tree = await renderView(makeTool());
        await chooseOptionAndSubmit(tree, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledWith('s1', 'toolu_1');
        expect(sendMessage).toHaveBeenCalledWith('s1', 'Q1: A');
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
});
