import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ops = vi.hoisted(() => ({
    sessionAllow: vi.fn(async (..._args: unknown[]) => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async (..._args: unknown[]) => {}),
    sessionDeny: vi.fn(async (..._args: unknown[]) => {}),
    sessionAbort: vi.fn(async (..._args: unknown[]) => {}),
}));

const logMock = vi.hoisted(() => ({
    log: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: ops.sessionAllow,
    sessionAllowWithPermissionUpdates: ops.sessionAllowWithPermissionUpdates,
    sessionDeny: ops.sessionDeny,
    sessionAbort: ops.sessionAbort,
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

async function renderPendingFooter() {
    const { PermissionFooter } = await import('../permissions/PermissionFooter');
    return renderScreen(React.createElement(PermissionFooter, {
        permission: { id: 'p1', status: 'pending' },
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

function findActionError(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.tree.root.findAllByProps({ testID: 'permission-footer.action-error' });
}

describe('PermissionFooter action error handling', () => {
    beforeEach(() => {
        ops.sessionAllow.mockReset();
        ops.sessionAllowWithPermissionUpdates.mockReset();
        ops.sessionDeny.mockReset();
        ops.sessionAbort.mockReset();
        logMock.log.mockReset();
    });

    it('shows retryable feedback and resets allow loading when approval fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        ops.sessionAllow
            .mockRejectedValueOnce(new Error('secret-provider-token'))
            .mockResolvedValueOnce(undefined);

        const screen = await renderPendingFooter();
        const allowButton = findButton(screen, 'permission-footer.allow');
        consoleError.mockClear();

        await pressTestInstanceAsync(allowButton, 'allow button');

        expect(findActionError(screen)).toHaveLength(1);
        expect(findActionError(screen)[0]?.findAllByType('Text' as any).map((node) => node.props.children).join(' ')).toContain('errors.operationFailed');
        expect(allowButton.props.disabled).toBe(false);
        expect(logMock.log).toHaveBeenCalledTimes(1);
        expect(String(logMock.log.mock.calls[0]?.[0] ?? '')).not.toContain('secret-provider-token');
        expect(consoleError).not.toHaveBeenCalled();

        await pressTestInstanceAsync(allowButton, 'allow button retry');

        expect(ops.sessionAllow).toHaveBeenCalledTimes(2);
        expect(findActionError(screen)).toHaveLength(0);
        consoleError.mockRestore();
    });

    it('shows retryable feedback and resets deny loading when deny fails', async () => {
        ops.sessionDeny
            .mockRejectedValueOnce(new Error('deny failed with sensitive details'))
            .mockResolvedValueOnce(undefined);

        const screen = await renderPendingFooter();
        const denyButton = findButton(screen, 'permission-footer.deny');

        await pressTestInstanceAsync(denyButton, 'deny button');

        expect(findActionError(screen)).toHaveLength(1);
        expect(denyButton.props.disabled).toBe(false);

        await pressTestInstanceAsync(denyButton, 'deny button retry');

        expect(ops.sessionDeny).toHaveBeenCalledTimes(2);
        expect(findActionError(screen)).toHaveLength(0);
    });

    it('shows retryable feedback and resets stop loading when abort fails', async () => {
        ops.sessionDeny.mockResolvedValue(undefined);
        ops.sessionAbort
            .mockRejectedValueOnce(new Error('abort failed with sensitive details'))
            .mockResolvedValueOnce(undefined);

        const screen = await renderPendingFooter();
        const stopButton = findButton(screen, 'permission-footer.stop');

        await pressTestInstanceAsync(stopButton, 'stop button');

        expect(findActionError(screen)).toHaveLength(1);
        expect(stopButton.props.disabled).toBe(false);

        await pressTestInstanceAsync(stopButton, 'stop button retry');

        expect(ops.sessionAbort).toHaveBeenCalledTimes(2);
        expect(findActionError(screen)).toHaveLength(0);
    });
});
