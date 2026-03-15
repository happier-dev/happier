import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { PermissionFooter } from '../permissions/PermissionFooter';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ops = vi.hoisted(() => ({
    sessionAllow: vi.fn(async () => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async () => {}),
    sessionDeny: vi.fn(async () => {}),
    sessionAbort: vi.fn(async () => {}),
}));

const sessionStore = vi.hoisted(() => ({
    updateSessionPermissionMode: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
    Alert: { alert: vi.fn() },
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
    sessionAllow: ops.sessionAllow,
    sessionAllowWithPermissionUpdates: ops.sessionAllowWithPermissionUpdates,
    sessionDeny: ops.sessionDeny,
    sessionAbort: ops.sessionAbort,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => {}),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => sessionStore },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

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

describe('PermissionFooter (Claude permission updates)', () => {
    beforeEach(() => {
        ops.sessionAllow.mockClear();
        ops.sessionAllowWithPermissionUpdates.mockClear();
        ops.sessionDeny.mockClear();
        ops.sessionAbort.mockClear();
        sessionStore.updateSessionPermissionMode.mockClear();
    });

    it('approves allow-all-edits using updatedPermissions setMode', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'Edit',
                    toolInput: { file_path: 'a.ts' },
                    metadata: { flavor: 'opencode' },
                }),
            );
        });

        const buttons = tree.root.findAllByType('TouchableOpacity' as any);
        const allowAllEditsButton = buttons.find((btn) => {
            const texts = btn.findAllByType('Text' as any);
            return texts.some((t) => t.props.children === 'claude.permissions.yesAllowAllEdits');
        });
        expect(allowAllEditsButton).toBeTruthy();

        await act(async () => {
            allowAllEditsButton!.props.onPress();
        });

        expect(ops.sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(ops.sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(
            's1',
            'p1',
            expect.objectContaining({
                mode: 'acceptEdits',
                updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            }),
        );
    });

    it('approves allow-for-session using updatedPermissions addRules', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'Bash',
                    toolInput: { command: 'pwd' },
                    metadata: { flavor: 'opencode' },
                }),
            );
        });

        const buttons = tree.root.findAllByType('TouchableOpacity' as any);
        const allowForToolButton = buttons.find((btn) => {
            const texts = btn.findAllByType('Text' as any);
            return texts.some((t) => t.props.children === 'claude.permissions.yesForTool');
        });
        expect(allowForToolButton).toBeTruthy();

        await act(async () => {
            allowForToolButton!.props.onPress();
        });

        expect(ops.sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(ops.sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(
            's1',
            'p1',
            expect.objectContaining({
                allowedTools: ['Bash(pwd)'],
                updatedPermissions: [
                    {
                        type: 'addRules',
                        behavior: 'allow',
                        destination: 'session',
                        rules: [{ toolName: 'Bash', ruleContent: 'pwd' }],
                    },
                ],
            }),
        );
    });

    it('approves allow-command-name using stripped shell prelude', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'Bash',
                    toolInput: {
                        command:
                            'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_SETUP_TOKEN; pwd',
                    },
                    metadata: { flavor: 'opencode' },
                }),
            );
        });

        const buttons = tree.root.findAllByType('TouchableOpacity' as any);

        const commandNameButton = buttons.find((btn) => {
            const texts = btn.findAllByType('Text' as any);
            const joined = texts
                .map((t) => {
                    const c = t.props.children;
                    if (Array.isArray(c)) return c.join('');
                    return typeof c === 'string' ? c : '';
                })
                .join(' ');
            return joined.includes('claude.permissions.yesForCommandName');
        });

        expect(commandNameButton).toBeTruthy();

        await act(async () => {
            commandNameButton!.props.onPress();
        });

        expect(ops.sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(ops.sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(
            's1',
            'p1',
            expect.objectContaining({
                allowedTools: ['Bash(pwd:*)'],
                updatedPermissions: [
                    {
                        type: 'addRules',
                        behavior: 'allow',
                        destination: 'session',
                        rules: [{ toolName: 'Bash', ruleContent: 'pwd:*' }],
                    },
                ],
            }),
        );
    });
});
