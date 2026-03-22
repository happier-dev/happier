import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { PermissionFooter } from '../permissions/PermissionFooter';
import { renderScreen } from '@/dev/testkit';


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
        let tree: renderer.ReactTestRenderer | undefined;

        tree = (await renderScreen(React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'execute',
                    toolInput: { command: 'pwd' },
                    metadata: { flavor: 'codex' },
                }))).tree;

        const texts = tree?.root.findAllByType('Text') ?? [];
        const flattened = texts.flatMap((node) => {
            const child = node.props.children;
            return Array.isArray(child) ? child : [child];
        }).filter((entry): entry is string => typeof entry === 'string');

        expect(flattened).not.toContain('Run: pwd');
        expect(flattened).toContain('common.yes');
    });

    it('approves execpolicy amendment using the latest proposed_execpolicy_amendment payload', async () => {
        const { sessionAllow } = await import('@/sync/ops');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'execute',
                    toolInput: { proposed_execpolicy_amendment: ['allow', 'read'] },
                    metadata: { flavor: 'codex' },
                }))).tree;

        const buttons = tree.root.findAllByType('TouchableOpacity' as any);
        const execPolicyButton = buttons.find((btn) => {
            const texts = btn.findAllByType('Text' as any);
            return texts.some((t) => t.props.children === 'codex.permissions.yesAlwaysAllowCommand');
        });
        expect(execPolicyButton).toBeTruthy();

        await act(async () => {
            execPolicyButton!.props.onPress();
        });

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
