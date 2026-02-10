import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { PermissionFooter } from '../permissions/PermissionFooter';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runtime = vi.hoisted(() => ({
    flavor: 'opencode' as 'codex' | 'opencode',
    protocol: 'claude' as 'codexDecision' | 'claude',
    setProtocol(protocol: 'codexDecision' | 'claude', flavor: 'codex' | 'opencode') {
        this.protocol = protocol;
        this.flavor = flavor;
    },
}));

const ops = vi.hoisted(() => ({
    sessionDeny: vi.fn(async (..._args: unknown[]) => {}),
    sessionAbort: vi.fn(async (..._args: unknown[]) => {}),
}));

const sessionStore = vi.hoisted(() => ({
    updateSessionPermissionMode: vi.fn((..._args: unknown[]) => {}),
}));

const syncMock = vi.hoisted(() => ({
    sendMessage: vi.fn(async (..._args: unknown[]) => {}),
}));

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
    sessionDeny: ops.sessionDeny,
    sessionAbort: ops.sessionAbort,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: syncMock.sendMessage,
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => sessionStore },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => runtime.flavor,
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => {
        if (runtime.protocol === 'codexDecision') {
            return {
                protocol: 'codexDecision',
                yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
                yesForSessionKey: 'codex.permissions.yesForSession',
                stopAndExplainKey: 'codex.permissions.stopAndExplain',
            };
        }
        return {
            protocol: 'claude',
            yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
            yesForToolKey: 'claude.permissions.yesForTool',
            noTellAgentKey: 'claude.permissions.stopAndExplain',
        };
    },
}));

describe('PermissionFooter stop action', () => {
    it.each([
        {
            name: 'codex decision protocol',
            protocol: 'codexDecision' as const,
            flavor: 'codex' as const,
            toolName: 'execute',
            toolInput: { command: 'pwd' },
            shouldSendFollowupPrompt: false,
            shouldAbortRun: false,
            expectedDecision: 'denied' as const,
        },
        {
            name: 'codex decision protocol on non-codex agent',
            protocol: 'codexDecision' as const,
            flavor: 'opencode' as const,
            toolName: 'bash',
            toolInput: { command: 'pwd' },
            shouldSendFollowupPrompt: true,
            shouldAbortRun: true,
            expectedDecision: 'abort' as const,
        },
        {
            name: 'non-codex protocol',
            protocol: 'claude' as const,
            flavor: 'opencode' as const,
            toolName: 'Read',
            toolInput: { filepath: '/etc/hosts' },
            shouldSendFollowupPrompt: true,
            shouldAbortRun: true,
            expectedDecision: 'abort' as const,
        },
    ])('Stop denies permission and handles run control for $name', async ({ protocol, flavor, toolName, toolInput, shouldSendFollowupPrompt, shouldAbortRun, expectedDecision }) => {
        runtime.setProtocol(protocol, flavor);
        ops.sessionDeny.mockClear();
        ops.sessionAbort.mockClear();
        syncMock.sendMessage.mockClear();
        sessionStore.updateSessionPermissionMode.mockClear();

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName,
                    toolInput,
                    metadata: { flavor },
                }),
            );
        });

        const buttons = tree?.root.findAllByType('TouchableOpacity') ?? [];
        const stopButton = buttons.at(-1);
        expect(stopButton).toBeTruthy();

        await act(async () => {
            await stopButton?.props.onPress?.();
        });

        expect(ops.sessionDeny).toHaveBeenCalledTimes(1);
        expect(ops.sessionDeny.mock.calls[0]?.[4]).toBe(expectedDecision);
        if (shouldAbortRun) {
            expect(ops.sessionAbort).toHaveBeenCalledTimes(1);
        } else {
            expect(ops.sessionAbort).not.toHaveBeenCalled();
        }
        expect(sessionStore.updateSessionPermissionMode).toHaveBeenCalledTimes(1);
        expect(sessionStore.updateSessionPermissionMode).toHaveBeenCalledWith('s1', 'read-only');
        if (shouldSendFollowupPrompt) {
            expect(syncMock.sendMessage).toHaveBeenCalledTimes(1);
            expect(sessionStore.updateSessionPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(
                syncMock.sendMessage.mock.invocationCallOrder[0],
            );
            expect(syncMock.sendMessage.mock.calls[0]?.[0]).toBe('s1');
            expect(String(syncMock.sendMessage.mock.calls[0]?.[1] ?? '')).toMatch(/explain/i);
        } else {
            expect(syncMock.sendMessage).not.toHaveBeenCalled();
        }
    });
});
