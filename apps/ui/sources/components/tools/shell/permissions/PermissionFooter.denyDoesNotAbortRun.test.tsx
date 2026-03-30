import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runtime = vi.hoisted(() => ({
    flavor: 'opencode' as 'claude' | 'codex' | 'opencode' | 'gemini',
    protocol: 'claude' as 'codexDecision' | 'claude',
    setProtocol(protocol: 'codexDecision' | 'claude', flavor: 'claude' | 'codex' | 'opencode' | 'gemini') {
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

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installPermissionShellCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            storage: { getState: () => sessionStore },
        });
    },
});

vi.mock('@/sync/ops', () => ({
    sessionAllow: vi.fn(async () => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async () => {}),
    sessionDeny: ops.sessionDeny,
    sessionAbort: ops.sessionAbort,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: syncMock.sendMessage,
    },
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
                stopKey: 'codex.permissions.stop',
            };
        }
        return {
            protocol: 'claude',
            yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
            yesForToolKey: 'claude.permissions.yesForTool',
            stopKey: 'claude.permissions.stop',
        };
    },
}));

describe('PermissionFooter deny action', () => {
    it.each([
        {
            name: 'claude protocol (non-codex prompt protocol)',
            protocol: 'claude' as const,
            flavor: 'claude' as const,
            toolName: 'Read',
            toolInput: { filepath: '/etc/hosts' },
        },
        {
            name: 'codex decision protocol (non-codex agent)',
            protocol: 'codexDecision' as const,
            flavor: 'opencode' as const,
            toolName: 'execute',
            toolInput: { command: 'pwd' },
        },
    ])('denies permission without aborting the run ($name)', async ({ protocol, flavor, toolName, toolInput }) => {
        runtime.setProtocol(protocol, flavor);
        ops.sessionDeny.mockClear();
        ops.sessionAbort.mockClear();
        sessionStore.updateSessionPermissionMode.mockClear();

        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName,
                    toolInput,
                    metadata: { flavor },
                }))).tree;

        const buttons = tree ? tree.findAllByType('TouchableOpacity') : [];
        const noButton = buttons.find((btn) => {
            const texts = btn
                .findAllByType('Text')
                .map((node) => String(node.props.children ?? ''))
                .join(' ');
            return texts.includes('common.no');
        });
        expect(noButton).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(noButton, 'common.no');
        });

        expect(ops.sessionDeny).toHaveBeenCalledTimes(1);
        expect(ops.sessionDeny.mock.calls[0]?.[4]).toBe('denied');
        expect(ops.sessionAbort).not.toHaveBeenCalled();
        expect(sessionStore.updateSessionPermissionMode).not.toHaveBeenCalled();
    });
});
