import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import {
    installWorkflowRendererCommonModuleMocks,
    resetWorkflowRendererCommonModuleMockState,
} from './workflowRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllow = vi.fn();
const sessionAllowWithPermissionUpdates = vi.fn();
const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const modalAlert = vi.fn();
const safeParsePlan = vi.fn();

installWorkflowRendererCommonModuleMocks({
    modal: () =>
        import('@/dev/testkit/mocks/modal').then(({ createModalModuleMock }) =>
            createModalModuleMock({
                spies: {
                    alert: (...args: any[]) => modalAlert(...args),
                },
            }).module,
        ),
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: { markdown: string }) => React.createElement('MarkdownView', props),
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
    sessionAllowWithPermissionUpdates: (...args: any[]) => sessionAllowWithPermissionUpdates(...args),
    sessionDeny: (...args: any[]) => sessionDeny(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: any[]) => sendMessage(...args),
    },
}));

describe('ExitPlanToolView', () => {
    let ExitPlanToolView: React.ComponentType<any>;

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
        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(
                    ExitPlanToolView,
                    makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
                ))).tree;
        return tree!;
    }

    beforeAll(async () => {
        ({ ExitPlanToolView } = await import('./ExitPlanToolView'));
    });

    beforeEach(() => {
        resetWorkflowRendererCommonModuleMockState();
        sessionAllow.mockReset();
        sessionAllowWithPermissionUpdates.mockReset();
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
            await tree.pressByTestIdAsync('exit-plan-approve');
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
        expect(sessionAllow).toHaveBeenCalledWith('s1', 'perm1');
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(collectHostText(tree)).toContain('tools.exitPlanMode.responded');
    });

    it('approves with acceptEdits via approve options menu', async () => {
        sessionAllowWithPermissionUpdates.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve-menu');
        });

        const buttons = modalAlert.mock.calls.at(-1)?.[2] as Array<{ text?: string; onPress?: () => void }> | undefined;
        const acceptEdits = buttons?.find((b) => typeof b.text === 'string' && b.text.includes('agentInput.permissionMode.acceptEdits'));
        expect(acceptEdits?.onPress).toBeTypeOf('function');

        await act(async () => {
            acceptEdits!.onPress!();
        });

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(
            's1',
            'perm1',
            expect.objectContaining({
                mode: 'acceptEdits',
                updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            }),
        );
    });

    it('approves with bypassPermissions via approve options menu', async () => {
        sessionAllowWithPermissionUpdates.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve-menu');
        });

        const buttons = modalAlert.mock.calls.at(-1)?.[2] as Array<{ text?: string; onPress?: () => void }> | undefined;
        const bypassPermissions = buttons?.find((b) => typeof b.text === 'string' && b.text.includes('agentInput.permissionMode.badgeBypassAllPermissions'));
        expect(bypassPermissions?.onPress).toBeTypeOf('function');

        await act(async () => {
            bypassPermissions!.onPress!();
        });

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(
            's1',
            'perm1',
            expect.objectContaining({
                mode: 'bypassPermissions',
                updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
            }),
        );
    });

    it('surfaces provider setMode suggestions as additional approve options', async () => {
        sessionAllowWithPermissionUpdates.mockResolvedValueOnce(undefined);
        const providerSuggestion = { type: 'setMode', mode: 'customMode', destination: 'session' };
        const tree = await renderView(
            makeRunningTool({
                permission: { id: 'perm1', status: 'pending', suggestions: [providerSuggestion] } as any,
            }),
        );

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve-menu');
        });

        const buttons = modalAlert.mock.calls.at(-1)?.[2] as Array<{ text?: string; onPress?: () => void }> | undefined;
        const customModeButton = buttons?.find((b) => typeof b.text === 'string' && b.text.includes('customMode'));
        expect(customModeButton?.onPress).toBeTypeOf('function');

        await act(async () => {
            customModeButton!.onPress!();
        });

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(
            's1',
            'perm1',
            expect.objectContaining({
                updatedPermissions: [providerSuggestion],
            }),
        );
    });

    it('rejects via permission RPC and does not send a follow-up user message', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-reject');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith('s1', 'perm1');
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('requests changes via permission RPC with a reason', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes');
        });

        await act(async () => {
            tree.changeTextByTestId('exit-plan-request-changes-input', 'Please change step 2');
        });

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes-send');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny.mock.calls[0]?.[5]).toBe('Please change step 2');
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('falls back to tool.id when approve is pressed before permission metadata is reattached', async () => {
        sessionAllow.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool({ id: 'toolu_reconnect', permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve');
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
        expect(sessionAllow).toHaveBeenCalledWith('s1', 'toolu_reconnect');
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('falls back to tool.id when reject is pressed before permission metadata is reattached', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool({ id: 'toolu_reconnect', permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-reject');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith('s1', 'toolu_reconnect');
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('falls back to tool.id when requesting changes before permission metadata is reattached', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool({ id: 'toolu_reconnect', permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes');
        });

        await act(async () => {
            tree.changeTextByTestId('exit-plan-request-changes-input', 'Please change step 2');
        });

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes-send');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith('s1', 'toolu_reconnect', undefined, undefined, undefined, 'Please change step 2');
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('shows an error when requesting plan changes fails', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        sessionDeny.mockRejectedValueOnce(new Error('network'));

        try {
            const tree = await renderView(makeRunningTool());

            await act(async () => {
                await tree.pressByTestIdAsync('exit-plan-request-changes');
            });

            await act(async () => {
                tree.changeTextByTestId('exit-plan-request-changes-input', 'Please change step 2');
            });

            await act(async () => {
                await tree.pressByTestIdAsync('exit-plan-request-changes-send');
            });

            expect(modalAlert).toHaveBeenCalledWith('common.error', 'tools.exitPlanMode.requestChangesFailed');
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });

    it('shows an error when requesting changes is attempted without text', async () => {
        const tree = await renderView(makeRunningTool());
        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes');
        });
        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes-send');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'tools.exitPlanMode.requestChangesEmpty');
    });

    it('does not mark as responded when approve is pressed without any permission request id', async () => {
        const tree = await renderView(makeRunningTool({ id: undefined, permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve');
        });

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'errors.missingPermissionId');

        const buttonsAfter = tree.findAllByType('TouchableOpacity' as any);
        expect(buttonsAfter.length).toBeGreaterThanOrEqual(2);
    });

    it('does not mark as responded when reject is pressed without any permission request id', async () => {
        const tree = await renderView(makeRunningTool({ id: undefined, permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-reject');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledWith('common.error', 'errors.missingPermissionId');

        const buttonsAfter = tree.findAllByType('TouchableOpacity' as any);
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

        expect(tree.findAllByTestId('exit-plan-approve')).toHaveLength(0);
        expect(tree.findAllByTestId('exit-plan-reject')).toHaveLength(0);

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);

        expect(collectHostText(tree)).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });

    it('shows a placeholder when no plan text is provided', async () => {
        safeParsePlan.mockReturnValueOnce({ success: true, data: {} });
        const tree = await renderView(makeRunningTool({ input: {} }));

        const markdownNode = tree.findByType('MarkdownView' as any);
        expect(markdownNode.props.markdown).toBe('tools.exitPlanMode.planMissing');
    });

    it('shows a placeholder when plan input schema parse fails', async () => {
        safeParsePlan.mockReturnValueOnce({ success: false });
        const tree = await renderView(makeRunningTool({ input: { unexpected: true } }));

        const markdownNode = tree.findByType('MarkdownView' as any);
        expect(markdownNode.props.markdown).toBe('tools.exitPlanMode.planMissing');
    });
});
