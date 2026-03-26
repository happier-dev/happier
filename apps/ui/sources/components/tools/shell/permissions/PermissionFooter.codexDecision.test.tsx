import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: vi.fn(async () => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async () => {}),
    sessionDeny: vi.fn(async () => {}),
    sessionAbort: vi.fn(async () => {}),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => {}),
    },
}));

installPermissionShellCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
        });
    },
});

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'codex',
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'codexDecision',
        yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
        yesForSessionKey: 'codex.permissions.yesForSession',
        stopKey: 'codex.permissions.stop',
    }),
}));

describe('PermissionFooter (codexDecision)', () => {
    it('does not repeat the request summary (the tool UI already shows it)', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'execute',
            toolInput: { command: 'pwd' },
            metadata: { flavor: 'codex' },
        }));

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Run: pwd')).toBeUndefined();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'common.yes')).toBeTruthy();

        // Stable locators for Maestro flows.
        expect(screen.findByProps({ testID: 'permission-footer.allow' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'permission-footer.deny' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'permission-footer.stop' })).toBeTruthy();
    });

    it('approves execpolicy amendment using the latest proposed_execpolicy_amendment payload', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const { sessionAllow } = await import('@/sync/ops');

        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'execute',
            toolInput: { proposed_execpolicy_amendment: ['allow', 'read'] },
            metadata: { flavor: 'codex' },
        }));

        const execPolicyButton = findTestInstanceByTypeContainingText(
            screen.tree,
            'TouchableOpacity',
            'codex.permissions.yesAlwaysAllowCommand',
        );
        expect(execPolicyButton).toBeTruthy();

        await pressTestInstanceAsync(execPolicyButton, 'execpolicy approval button');

        expect(sessionAllow).toHaveBeenCalledWith(
            's1',
            'p1',
            undefined,
            undefined,
            'approved_execpolicy_amendment',
            { command: ['allow', 'read'] },
        );
    });
});
