import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionFooter } from '../permissions/PermissionFooter';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Text: 'Text',
            TouchableOpacity: 'TouchableOpacity',
            ActivityIndicator: 'ActivityIndicator',
            Alert: {
                alert: vi.fn(),
            },
            Platform: {
                OS: 'ios',
                select: <T,>(value: { ios?: T }) => value.ios,
            },
            StyleSheet: {
                create: <T,>(styles: T) => styles,
            },
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
});
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
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
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'execute',
            toolInput: { command: 'pwd' },
            metadata: { flavor: 'codex' },
        }));

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Run: pwd')).toBeUndefined();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'common.yes')).toBeTruthy();
    });

    it('approves execpolicy amendment using the latest proposed_execpolicy_amendment payload', async () => {
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
