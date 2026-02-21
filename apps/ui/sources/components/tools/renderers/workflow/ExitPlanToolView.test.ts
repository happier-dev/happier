import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllow = vi.fn();
const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const modalAlert = vi.fn();
const safeParsePlan = vi.fn();

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
    TextInput: 'TextInput',
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
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: { markdown: string }) => React.createElement('MarkdownView', props),
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('../../catalog', () => ({
    knownTools: {
        ExitPlanMode: {
            input: {
                safeParse: (...args: unknown[]) => safeParsePlan(...args),
            },
        },
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: (...args: any[]) => sessionAllow(...args),
    sessionDeny: (...args: any[]) => sessionDeny(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: any[]) => sendMessage(...args),
    },
}));

describe('ExitPlanToolView', () => {
    function makeRunningTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'ExitPlanMode',
            state: 'running',
            input: { plan: 'plan' },
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, overrides: Record<string, unknown> = {}) {
        const { ExitPlanToolView } = await import('./ExitPlanToolView');
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    ExitPlanToolView,
                    makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
                ),
            );
        });
        return tree!;
    }

    beforeEach(() => {
        sessionAllow.mockReset();
        sessionDeny.mockReset();
        sendMessage.mockReset();
        modalAlert.mockReset();
        safeParsePlan.mockReset();
        safeParsePlan.mockReturnValue({ success: true, data: { plan: 'plan' } });
    });

    it('approves via permission RPC and does not send a follow-up user message', async () => {
        sessionAllow.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.root.findByProps({ testID: 'exit-plan-approve' }).props.onPress();
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
        expect(sessionAllow).toHaveBeenCalledWith('s1', 'perm1');
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(collectHostText(tree)).toContain('tools.exitPlanMode.responded');
    });

    it('rejects via permission RPC and does not send a follow-up user message', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.root.findByProps({ testID: 'exit-plan-reject' }).props.onPress();
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith('s1', 'perm1');
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('requests changes via permission RPC with a reason', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.root.findByProps({ testID: 'exit-plan-request-changes' }).props.onPress();
        });

        await act(async () => {
            tree.root.findByProps({ testID: 'exit-plan-request-changes-input' }).props.onChangeText('Please change step 2');
        });

        await act(async () => {
            await tree.root.findByProps({ testID: 'exit-plan-request-changes-send' }).props.onPress();
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny.mock.calls[0]?.[5]).toBe('Please change step 2');
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('shows an error when requesting plan changes fails', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        sessionDeny.mockRejectedValueOnce(new Error('network'));

        try {
            const tree = await renderView(makeRunningTool());

            await act(async () => {
                await tree.root.findByProps({ testID: 'exit-plan-request-changes' }).props.onPress();
            });

            await act(async () => {
                tree.root.findByProps({ testID: 'exit-plan-request-changes-input' }).props.onChangeText('Please change step 2');
            });

            await act(async () => {
                await tree.root.findByProps({ testID: 'exit-plan-request-changes-send' }).props.onPress();
            });

            expect(modalAlert).toHaveBeenCalledWith('common.error', 'tools.exitPlanMode.requestChangesFailed');
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });

    it('shows an error when requesting changes is attempted without text', async () => {
        const tree = await renderView(makeRunningTool());
        await act(async () => {
            await tree.root.findByProps({ testID: 'exit-plan-request-changes' }).props.onPress();
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'exit-plan-request-changes-send' }).props.onPress();
        });

        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'tools.exitPlanMode.requestChangesEmpty');
    });

    it('does not mark as responded when approve is pressed without a permission id', async () => {
        const tree = await renderView(makeRunningTool({ permission: undefined }));

        await act(async () => {
            await tree.root.findByProps({ testID: 'exit-plan-approve' }).props.onPress();
        });

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'errors.missingPermissionId');

        const buttonsAfter = tree.root.findAllByType('TouchableOpacity' as any);
        expect(buttonsAfter.length).toBeGreaterThanOrEqual(2);
    });

    it('does not mark as responded when reject is pressed without a permission id', async () => {
        const tree = await renderView(makeRunningTool({ permission: undefined }));

        await act(async () => {
            await tree.root.findByProps({ testID: 'exit-plan-reject' }).props.onPress();
        });

        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'errors.missingPermissionId');

        const buttonsAfter = tree.root.findAllByType('TouchableOpacity' as any);
        expect(buttonsAfter.length).toBeGreaterThanOrEqual(2);
    });

    it('does not allow responding when canApprovePermissions is false', async () => {
        const tree = await renderView(makeRunningTool(), {
            interaction: {
                canSendMessages: true,
                canApprovePermissions: false,
                permissionDisabledReason: 'notGranted',
            },
        });

        expect(tree.root.findAllByProps({ testID: 'exit-plan-approve' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'exit-plan-reject' })).toHaveLength(0);

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);

        expect(collectHostText(tree)).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });

    it('falls back to <empty> when plan input schema parse fails', async () => {
        safeParsePlan.mockReturnValueOnce({ success: false });
        const tree = await renderView(makeRunningTool({ input: { unexpected: true } }));

        const markdownNode = tree.root.findByType('MarkdownView' as any);
        expect(markdownNode.props.markdown).toBe('<empty>');
    });
});
