import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { PermissionFooter } from '../permissions/PermissionFooter';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'ios', select: <T,>(value: { ios?: T }) => value.ios },
    StyleSheet: { create: <T,>(styles: T) => styles },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: <T,>(styles: T) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                permissionButton: {
                    allow: { background: '#0f0' },
                    deny: { background: '#f00' },
                    allowAll: { background: '#00f' },
                },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: vi.fn(async () => {}),
    sessionDeny: vi.fn(async () => {}),
    sessionAbort: vi.fn(async () => {}),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => {}),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'codex',
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'codexDecision',
        yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
        yesForSessionKey: 'codex.permissions.yesForSession',
        stopAndExplainKey: 'codex.permissions.stopAndExplain',
    }),
}));

describe('PermissionFooter (codexDecision)', () => {
    it('shows a command summary line for codex decision approvals', () => {
        let tree: renderer.ReactTestRenderer | undefined;

        act(() => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'execute',
                    toolInput: { command: 'pwd' },
                    metadata: { flavor: 'codex' },
                }),
            );
        });

        const texts = tree?.root.findAllByType('Text') ?? [];
        const flattened = texts.flatMap((node) => {
            const child = node.props.children;
            return Array.isArray(child) ? child : [child];
        }).filter((entry): entry is string => typeof entry === 'string');

        expect(flattened).toContain('Run: pwd');
    });

    it('approves execpolicy amendment using the latest proposed_execpolicy_amendment payload', async () => {
        const { sessionAllow } = await import('@/sync/ops');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'execute',
                    toolInput: { proposed_execpolicy_amendment: ['allow', 'read'] },
                    metadata: { flavor: 'codex' },
                }),
            );
        });

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
