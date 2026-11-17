import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pressTestInstanceAsync } from '@/dev/testkit';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { HappyError } from '@/utils/errors/errors';
import { installPermissionShellCommonModuleMocks, createPermissionShellRenderer } from './permissionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ops = vi.hoisted(() => ({
    approve: vi.fn(async (..._args: unknown[]) => {}),
    approveWithUpdates: vi.fn(async (..._args: unknown[]) => {}),
    deny: vi.fn(async (..._args: unknown[]) => {}),
    abort: vi.fn(async (..._args: unknown[]) => {}),
}));
const readRequestOutcome = vi.hoisted(() => vi.fn(async (_requestId: string): Promise<'pending' | 'settled'> => 'pending'));
const renderScreen = createPermissionShellRenderer({ ...ops, readRequestOutcome });


const logMock = vi.hoisted(() => ({
    log: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));



installPermissionShellCommonModuleMocks({
    log: async () => ({ log: logMock }),
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
        });
    },
});

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'claude',
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        stopKey: 'claude.permissions.stop',
    }),
}));

const { PermissionFooter } = await import('../permissions/PermissionFooter');

async function renderPendingFooter(permissionId = 'p1') {
    return renderScreen(React.createElement(PermissionFooter, {
        permission: { id: permissionId, status: 'pending' },
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        metadata: { flavor: 'claude' },
    }));
}

function findButton(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): ReactTestInstance {
    const button = screen.findByProps({ testID });
    expect(button).toBeTruthy();
    return button;
}

function textOf(node: ReactTestInstance | undefined): string {
    return node ? node.children.map((child) => typeof child === 'string' ? child : textOf(child)).join('') : '';
}

// Host nodes: the shared state line forwards its testID through composite layers.
function findActionError(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAllHostsByTestId('permission-footer.action-error');
}

function makeUnknown() {
    return new HappyError('The outcome is unknown', false, { code: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
}

describe('PermissionFooter action error handling', () => {
    beforeEach(() => {
        ops.approve.mockReset();
        ops.approveWithUpdates.mockReset();
        ops.deny.mockReset();
        ops.abort.mockReset();
        logMock.log.mockReset();
        readRequestOutcome.mockReset();
        readRequestOutcome.mockResolvedValue('pending');
    });

    it('shows retryable feedback and resets allow loading when approval fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        ops.approve
            .mockRejectedValueOnce(new Error('secret-provider-token'))
            .mockResolvedValueOnce(undefined);

        const screen = await renderPendingFooter();
        const allowButton = findButton(screen, 'permission-footer.allow');
        consoleError.mockClear();

        await pressTestInstanceAsync(allowButton, 'allow button');

        expect(findActionError(screen)).toHaveLength(1);
        expect(textOf(findActionError(screen)[0])).toContain('errors.operationFailed');
        expect(allowButton.props.disabled).toBe(false);
        expect(logMock.log).toHaveBeenCalledTimes(1);
        expect(String(logMock.log.mock.calls[0]?.[0] ?? '')).not.toContain('secret-provider-token');
        expect(consoleError).not.toHaveBeenCalled();

        await pressTestInstanceAsync(allowButton, 'allow button retry');

        expect(ops.approve).toHaveBeenCalledTimes(2);
        expect(findActionError(screen)).toHaveLength(0);
        consoleError.mockRestore();
    });

    it('shows retryable feedback and resets deny loading when deny fails', async () => {
        ops.deny
            .mockRejectedValueOnce(new Error('deny failed with sensitive details'))
            .mockResolvedValueOnce(undefined);

        const screen = await renderPendingFooter();
        const denyButton = findButton(screen, 'permission-footer.deny');

        await pressTestInstanceAsync(denyButton, 'deny button');

        expect(findActionError(screen)).toHaveLength(1);
        expect(denyButton.props.disabled).toBe(false);

        await pressTestInstanceAsync(denyButton, 'deny button retry');

        expect(ops.deny).toHaveBeenCalledTimes(2);
        expect(findActionError(screen)).toHaveLength(0);
    });

    it('shows retryable feedback and resets stop loading when stop delivery fails', async () => {
        ops.deny
            .mockRejectedValueOnce(new Error('abort failed with sensitive details'))
            .mockResolvedValueOnce(undefined);

        const screen = await renderPendingFooter();
        const stopButton = findButton(screen, 'permission-footer.stop');

        await pressTestInstanceAsync(stopButton, 'stop button');

        expect(findActionError(screen)).toHaveLength(1);
        expect(stopButton.props.disabled).toBe(false);

        await pressTestInstanceAsync(stopButton, 'stop button retry');

        expect(ops.deny).toHaveBeenCalledTimes(2);
        expect(findActionError(screen)).toHaveLength(0);
    });

    describe('when the result of an answer is lost (RPC_OUTCOME_UNKNOWN)', () => {
        // The Action front door rethrows the typed RPC code on `code`; a raw RPC rejection carries `rpcErrorCode`.
        const outcomeUnknownShapes = {
            'Action front door': () => new HappyError('The outcome is unknown', false, { code: RPC_ERROR_CODES.OUTCOME_UNKNOWN }),
            'raw RPC rejection': () => new RpcError('The outcome is unknown', RPC_ERROR_CODES.OUTCOME_UNKNOWN),
        };

        it.each(Object.entries(outcomeUnknownShapes))('withholds both decisions instead of inviting a resend (%s)', async (label, makeError) => {
            ops.approve.mockRejectedValueOnce(makeError());
            const screen = await renderPendingFooter(`p-unknown-withheld-${label}`);
            const allowButton = findButton(screen, 'permission-footer.allow');

            await pressTestInstanceAsync(allowButton, 'allow button');

            expect(screen.tree.root.findAllByProps({ testID: 'permission-footer.answer-unconfirmed' })).not.toHaveLength(0);
            expect(findActionError(screen)).toHaveLength(0);
            expect(findButton(screen, 'permission-footer.allow').props.disabled).toBe(true);
            expect(findButton(screen, 'permission-footer.deny').props.disabled).toBe(true);
            expect(findButton(screen, 'permission-footer.stop').props.disabled).toBe(true);

            await pressTestInstanceAsync(allowButton, 'allow button resend');
            await pressTestInstanceAsync(findButton(screen, 'permission-footer.deny'), 'deny button');
            expect(ops.approve).toHaveBeenCalledTimes(1);
            expect(ops.deny).not.toHaveBeenCalled();
        });

        it('shows the same state in a second footer for the request and fresh controls for a new request', async () => {
            ops.approve.mockRejectedValueOnce(makeUnknown());
            const first = await renderPendingFooter('p-unknown-shared');
            await pressTestInstanceAsync(findButton(first, 'permission-footer.allow'), 'allow button');

            const second = await renderPendingFooter('p-unknown-shared');
            expect(findButton(second, 'permission-footer.allow').props.disabled).toBe(true);

            const other = await renderPendingFooter('p-unknown-other');
            expect(findButton(other, 'permission-footer.allow').props.disabled).toBe(false);
        });

        async function renderUnknownFooter(permissionId: string) {
            ops.approve.mockRejectedValueOnce(makeUnknown()).mockResolvedValueOnce(undefined);
            const screen = await renderPendingFooter(permissionId);
            await pressTestInstanceAsync(findButton(screen, 'permission-footer.allow'), 'allow button');
            return screen;
        }
        const unconfirmedNotices = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            screen.findAllHostsByTestId('permission-footer.answer-unconfirmed');

        it('asks for the exact request and offers answering again once the read says it is still waiting', async () => {
            const screen = await renderUnknownFooter('p-unknown-pending');

            await pressTestInstanceAsync(findButton(screen, 'permission-footer.check-again'), 'check again');

            expect(readRequestOutcome).toHaveBeenCalledExactlyOnceWith('p-unknown-pending');
            expect(unconfirmedNotices(screen)).toHaveLength(0);
            expect(findButton(screen, 'permission-footer.allow').props.disabled).toBe(false);
        });

        it('keeps a settled request non-answerable: the source publishes the Session and the card, not the check, ends the state', async () => {
            readRequestOutcome.mockResolvedValueOnce('settled');
            const screen = await renderUnknownFooter('p-unknown-settled');

            await pressTestInstanceAsync(findButton(screen, 'permission-footer.check-again'), 'check again');

            expect(readRequestOutcome).toHaveBeenCalledExactlyOnceWith('p-unknown-settled');
            expect(findButton(screen, 'permission-footer.allow').props.disabled, 'a settled exact read must not offer another answer').toBe(true);
            await pressTestInstanceAsync(findButton(screen, 'permission-footer.allow'), 'allow after settled check');
            expect(ops.approve).toHaveBeenCalledTimes(1);
        });

        it('keeps the answer withheld, and says the check failed, when the read fails or cannot tell', async () => {
            const screen = await renderUnknownFooter('p-unknown-unreadable');
            readRequestOutcome.mockRejectedValueOnce(new Error('The Session does not say whether the request is still waiting'));

            await pressTestInstanceAsync(findButton(screen, 'permission-footer.check-again'), 'check again (unreadable)');

            expect(unconfirmedNotices(screen)).toHaveLength(1);
            expect(screen.getTextContent()).toContain('errors.permissionCheckAgainFailed');
            expect(findButton(screen, 'permission-footer.allow').props.disabled).toBe(true);
            await pressTestInstanceAsync(findButton(screen, 'permission-footer.allow'), 'allow while unconfirmed');
            expect(ops.approve).toHaveBeenCalledTimes(1);

            await pressTestInstanceAsync(findButton(screen, 'permission-footer.check-again'), 'check again');
            expect(unconfirmedNotices(screen)).toHaveLength(0);
        });
    });
});
