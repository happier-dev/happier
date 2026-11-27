import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from "@happier-dev/session-core/messages";
import type { AgentState } from "@happier-dev/session-core/state";
import { collectHostText, makeToolCall, makeToolViewProps, standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit';


const sessionAllow = vi.fn();
const sessionAllowWithPermissionUpdates = vi.fn();
const sessionDeny = vi.fn();
const sendMessage = vi.fn();
let liveRequests: NonNullable<AgentState['requests']> = {};
let activeSource: ReturnType<typeof createTestSessionTranscriptSource>;

function setLivePlanRequest(id: string, tool = 'ExitPlanMode') {
    liveRequests = { [id]: { tool, arguments: { plan: 'plan' }, createdAt: 1 } };
}

async function retirePlanRequest() {
    await act(async () => {
        activeSource.update({ messages: [], reducerState: null, metadata: null, agentState: { requests: {} } });
    });
}
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Radix is the DOM boundary; alert registration, display and dismissal stay real.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
}));
// Only the vendor browser reveal adapter is replaced; the markdown view and tool catalog stay real.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));
const { ModalProvider } = await import('@/modal/ModalProvider');
const { WebAlertModal } = await import('@/modal/components/WebAlertModal');
const { ExitPlanToolView } = await import('./ExitPlanToolView');

function expectNoAlert(tree: renderer.ReactTestRenderer) {
    expect(tree.root.findAllByType(WebAlertModal)).toHaveLength(0);
}

function expectAlert(tree: renderer.ReactTestRenderer, message: string) {
    expect(tree.root.findAllByType(WebAlertModal).map(node => node.props.config))
        .toEqual([expect.objectContaining({ type: 'alert', title: 'common.error', message })]);
    expect(collectHostText(tree)).toContain(message);
}

async function pressAlertChoice(tree: renderer.ReactTestRenderer, label: string) {
    const choice = tree.root.findAll(node => typeof node.type === 'string'
        && node.props.testID?.startsWith('web-modal-button-')
        && node.props.accessibilityLabel?.includes(label));
    expect(choice).toHaveLength(1);
    await act(async () => choice[0].props.onPress());
    // The real provider retains the dismissed dialog through its exit motion.
    await vi.waitFor(async () => {
        await act(async () => {});
        expectNoAlert(tree);
    });
}

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
        activeSource = createTestSessionTranscriptSource({
            sessionId: 's1', serverId: typeof overrides.serverId === 'string' ? overrides.serverId : null,
            agentState: { requests: liveRequests },
            interaction: { canSendMessages: true, canApprovePermissions: true },
            actions: {
                respondToPermission: (params) => params.approved
                    ? params.updatedPermissions !== undefined ? sessionAllowWithPermissionUpdates(params) : sessionAllow(params)
                    : sessionDeny(params),
                answerUserAction: async () => {}, abort: async () => {}, submitMessage: (params) => sendMessage(params),
            },
        });
        return (await renderWithSessionTranscriptSource(React.createElement(ModalProvider, null, React.createElement(
            ExitPlanToolView, makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
        )), activeSource)).tree;
    }

    beforeEach(() => {
        sessionAllow.mockReset();
        sessionAllowWithPermissionUpdates.mockReset();
        sessionDeny.mockReset();
        sendMessage.mockReset();
        setLivePlanRequest('perm1');
    });
    afterEach(async () => { await standardCleanup(); });

    it.each(['missing', 'native-wrapper', 'same-id-question'] as const)('hides original plan actions for a %s request', async (request) => {
        liveRequests = request === 'missing' ? {} : {
            [request === 'native-wrapper' ? 'claude_dialog_choice_native' : 'perm1']: {
                tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [] }, createdAt: 1,
            },
        };
        const tree = await renderView(makeRunningTool());
        expect(tree.findAllByTestId('exit-plan-approve')).toHaveLength(0);
        expect(tree.findAllByTestId('exit-plan-reject')).toHaveLength(0);
        expect(tree.findAllByTestId('exit-plan-request-changes')).toHaveLength(0);
        expect(sessionAllow).not.toHaveBeenCalled();
        expect(sessionDeny).not.toHaveBeenCalled();
    });

    it.each(['approve', 'reject', 'request-changes'] as const)('does not dispatch stale %s after the source request retires', async (action) => {
        const tree = await renderView(makeRunningTool());
        if (action === 'request-changes') {
            await tree.pressByTestIdAsync('exit-plan-request-changes');
            await act(async () => { tree.changeTextByTestId('exit-plan-request-changes-input', 'Change the plan'); });
        }
        const button = tree.findByTestId(action === 'request-changes' ? 'exit-plan-request-changes-send' : `exit-plan-${action}`);
        expect(button).toBeTruthy();
        const onPress: () => unknown = button!.props.onPress;
        await retirePlanRequest();
        await act(async () => { await onPress(); });
        expect(sessionAllow).not.toHaveBeenCalled();
        expect(sessionDeny).not.toHaveBeenCalled();
        expect(tree.findAllByTestId('exit-plan-approve')).toHaveLength(0);
        expect(collectHostText(tree)).not.toContain('tools.exitPlanMode.responded');
    });

    it('does not dispatch an approval menu choice after the source request retires', async () => {
        const tree = await renderView(makeRunningTool());
        await tree.pressByTestIdAsync('exit-plan-approve-menu');
        await retirePlanRequest();
        await pressAlertChoice(tree, 'agentInput.permissionMode.acceptEdits');
        expect(sessionAllowWithPermissionUpdates).not.toHaveBeenCalled();
        expect(collectHostText(tree)).not.toContain('tools.exitPlanMode.responded');
    });

    it('reports a rejected native answer and permits an explicit retry', async () => {
        liveRequests = { perm1: { tool: 'ExitPlanMode', arguments: { plan: 'plan' }, createdAt: 1,
            nativeChoices: { requirementId: 'retry-plan', source: 'native-test', choices: [
                { id: 'retry', label: 'Approve', decision: 'approved', scope: 'once', response: { approved: true } },
            ] } } } as never;
        sessionDeny.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());
        await tree.pressByTestIdAsync('permission-footer.choice.retry');
        expectAlert(tree, 'errors.operationFailed errors.tryAgain');
        expect(collectHostText(tree)).not.toContain('tools.exitPlanMode.responded');
        await pressAlertChoice(tree, 'common.ok');
        await tree.pressByTestIdAsync('permission-footer.choice.retry');
        expect(sessionDeny).toHaveBeenCalledTimes(2);
        expect(collectHostText(tree)).toContain('tools.exitPlanMode.responded');
    });

    it('offers a native occurrence\'s own choices word for word instead of the plan controls', async () => {
        liveRequests = { perm1: { tool: 'ExitPlanMode', arguments: { plan: 'plan' }, createdAt: 1, nativeChoices: {
            requirementId: 'plan-7', source: 'native-test', choices: [
                { id: 'opaque:auto', label: 'Yes, and auto-accept edits', decision: 'approved', scope: 'session', response: { approved: true } },
                { id: 'opaque:manual', label: 'Yes, and manually approve edits', decision: 'approved', scope: 'once', response: { approved: true } },
                { id: 'opaque:keep', label: 'No, keep planning', decision: 'denied', scope: 'once', response: { approved: false } },
            ] } } } as never;
        const tree = await renderView(makeRunningTool());
        expect(tree.findAllByTestId('exit-plan-approve')).toHaveLength(0);
        expect(tree.findAllByTestId('exit-plan-approve-menu')).toHaveLength(0);
        const text = collectHostText(tree);
        for (const label of ['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning']) expect(text).toContain(label);
        await act(async () => { await tree.pressByTestIdAsync('permission-footer.choice.opaque:manual'); });
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'perm1', nativeChoice: { requirementId: 'plan-7', choiceId: 'opaque:manual' } });
        expect(sessionAllow).not.toHaveBeenCalled();
    });

    it('approves via permission RPC and does not send a follow-up user message', async () => {
        sessionAllow.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve');
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
        expect(sessionAllow).toHaveBeenCalledWith({ id: 'perm1', approved: true });
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(collectHostText(tree)).toContain('tools.exitPlanMode.responded');
    });

    it('shows proposed Task titles before the person approves the plan', async () => {
        const tree = await renderView(makeRunningTool({ input: {
            plan: 'A plan with two linked tasks.',
            tasks: [
                { id: 'prepare', title: 'Prepare the project' },
                { id: 'verify', title: 'Verify the result', blockedBy: ['prepare'], baseFromTaskId: 'prepare' },
            ],
        } }));
        expect(tree.findByTestId('exit-plan-approve')).toBeTruthy();
        expect(collectHostText(tree)).toEqual(expect.arrayContaining(['Prepare the project', 'Verify the result']));
    });

    it('keeps the request open and reports a malformed Task graph when the person approves', async () => {
        const tree = await renderView(makeRunningTool({ input: {
            plan: 'Fix an issue.',
            tasks: [{ id: 'fix', title: 'Fix the issue', blockedBy: ['fix'] }],
        } }));
        await tree.pressByTestIdAsync('exit-plan-approve');
        expect(sessionAllow).not.toHaveBeenCalled();
        expect(tree.findByTestId('exit-plan-request-changes')).toBeTruthy();
        expect(tree.root.findByType(WebAlertModal).props.config).toMatchObject({
            title: 'tools.names.todoList', message: 'errors.invalidFormat',
        });
    });

    it('approves with acceptEdits via approve options menu', async () => {
        sessionAllowWithPermissionUpdates.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve-menu');
        });

        await pressAlertChoice(tree, 'agentInput.permissionMode.acceptEdits');

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: 'perm1', approved: true, ...{
                mode: 'acceptEdits',
                updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            } })
        );
    });

    it('approves with bypassPermissions via approve options menu', async () => {
        sessionAllowWithPermissionUpdates.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve-menu');
        });

        await pressAlertChoice(tree, 'agentInput.permissionMode.badgeBypassAllPermissions');

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: 'perm1', approved: true, ...{
                mode: 'bypassPermissions',
                updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
            } })
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

        await pressAlertChoice(tree, 'customMode');

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: 'perm1', approved: true, ...{
                updatedPermissions: [providerSuggestion],
            } })
        );
    });

    it('rejects via permission RPC and does not send a follow-up user message', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-reject');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'perm1', approved: false });
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
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'perm1', approved: false, reason: 'Please change step 2' });
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('falls back to tool.id when approve is pressed before permission metadata is reattached', async () => {
        setLivePlanRequest('toolu_reconnect', 'ExitPlanMode');
        sessionAllow.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool({ id: 'toolu_reconnect', permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve');
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
        expect(sessionAllow).toHaveBeenCalledWith({ id: 'toolu_reconnect', approved: true });
        expectNoAlert(tree);
    });

    it('falls back to tool.id when reject is pressed before permission metadata is reattached', async () => {
        setLivePlanRequest('toolu_reconnect', 'exit_plan_mode');
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool({ id: 'toolu_reconnect', permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-reject');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'toolu_reconnect', approved: false });
        expectNoAlert(tree);
    });

    it('falls back to tool.id when requesting changes before permission metadata is reattached', async () => {
        setLivePlanRequest('toolu_reconnect', 'ExitPlanMode');
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
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'toolu_reconnect', approved: false, reason: 'Please change step 2' });
        expectNoAlert(tree);
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

            expectAlert(tree, 'tools.exitPlanMode.requestChangesFailed');
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
        expectAlert(tree, 'tools.exitPlanMode.requestChangesEmpty');
    });

    it('hides actions without any permission request id', async () => {
        const tree = await renderView(makeRunningTool({ id: undefined, permission: undefined }));
        expect(tree.findAllByTestId('exit-plan-approve')).toHaveLength(0);
        expect(tree.findAllByTestId('exit-plan-reject')).toHaveLength(0);
        expectNoAlert(tree);
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

    it('withdraws all plan decisions from a read-only source', async () => {
        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ExitPlanToolView, makeToolViewProps(makeRunningTool(), { sessionId: 's1' })),
            createTestSessionTranscriptSource(),
        );
        expect(screen.findAllByTestId('exit-plan-approve')).toHaveLength(0);
        expect(screen.findAllByTestId('exit-plan-reject')).toHaveLength(0);
        expect(sessionAllow).not.toHaveBeenCalled();
        expect(sessionDeny).not.toHaveBeenCalled();
    });

    it('shows a placeholder when no plan text is provided', async () => {
        const tree = await renderView(makeRunningTool({ input: {} }));
        const { MarkdownView } = await import('@/components/markdown/MarkdownView');
        expect(tree.findByType(MarkdownView).props.markdown).toBe('tools.exitPlanMode.planMissing');
    });

    it('shows a placeholder when plan input schema parse fails', async () => {
        const tree = await renderView(makeRunningTool({ input: { plan: 42 } }));
        const { MarkdownView } = await import('@/components/markdown/MarkdownView');
        expect(tree.findByType(MarkdownView).props.markdown).toBe('tools.exitPlanMode.planMissing');
    });
});
