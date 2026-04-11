import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, findPressableByText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSystemToolRendererCommonModuleMocks } from './systemToolRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllow = vi.fn();
const sessionDeny = vi.fn();
const modalAlert = vi.fn();

installSystemToolRendererCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => modalAlert(...args),
            },
        }).module;
    },
});

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: (...args: any[]) => sessionAllow(...args),
    sessionDeny: (...args: any[]) => sessionDeny(...args),
}));

describe('AcpHistoryImportView', () => {
    function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'AcpHistoryImport',
            state: 'running',
            input: {
                provider: 'acp',
                remoteSessionId: 'remote-1',
                localCount: 2,
                remoteCount: 4,
                localTail: [{ role: 'user', text: 'hello' }],
                remoteTail: [{ role: 'assistant', text: 'hi' }],
            },
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, overrides: Record<string, unknown> = {}) {
        const { AcpHistoryImportView } = await import('./AcpHistoryImportView');
        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(
                    AcpHistoryImportView,
                    makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
                ))).tree;
        return tree!;
    }

    beforeEach(() => {
        sessionAllow.mockReset();
        sessionDeny.mockReset();
        modalAlert.mockReset();
    });

    it('approves import when Import is pressed', async () => {
        sessionAllow.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeTool());

        const importButton = findPressableByText(tree, 'tools.acpHistoryImport.actions.import');
        expect(importButton).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(importButton!);
        });

        expect(sessionAllow).toHaveBeenCalledWith('s1', 'perm1');
        expect(sessionDeny).toHaveBeenCalledTimes(0);
    });

    it('falls back to tool.id when permission metadata is missing during reconnect recovery', async () => {
        sessionAllow.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeTool({ id: 'toolu_reconnect', permission: undefined }));

        const importButton = findPressableByText(tree, 'tools.acpHistoryImport.actions.import');
        expect(importButton).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(importButton!);
        });

        expect(sessionAllow).toHaveBeenCalledWith('s1', 'toolu_reconnect');
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('skips import when Skip is pressed', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeTool());

        const skipButton = findPressableByText(tree, 'tools.acpHistoryImport.actions.skip');
        expect(skipButton).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(skipButton!);
        });

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledWith('s1', 'perm1', undefined, undefined, 'denied');
    });

    it('shows an error when import approval fails', async () => {
        sessionAllow.mockRejectedValueOnce(new Error('network-down'));
        const tree = await renderView(makeTool());

        const importButton = findPressableByText(tree, 'tools.acpHistoryImport.actions.import');
        expect(importButton).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(importButton!);
        });

        expect(modalAlert).toHaveBeenCalledWith('common.error', 'network-down');
    });

    it('does not allow import/skip when canApprovePermissions is false', async () => {
        const tree = await renderView(makeTool(), {
            interaction: {
                canSendMessages: true,
                canApprovePermissions: false,
                permissionDisabledReason: 'notGranted',
            },
        });

        const importButton = findPressableByText(tree, 'tools.acpHistoryImport.actions.import');
        const skipButton = findPressableByText(tree, 'tools.acpHistoryImport.actions.skip');
        expect(importButton).toBeTruthy();
        expect(skipButton).toBeTruthy();

        await pressTestInstanceAsync(importButton!);
        await pressTestInstanceAsync(skipButton!);

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(collectHostText(tree)).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });
});
