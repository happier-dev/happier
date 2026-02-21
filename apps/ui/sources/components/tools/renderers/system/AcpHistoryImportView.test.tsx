import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, findPressableByText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllow = vi.fn();
const sessionDeny = vi.fn();
const modalAlert = vi.fn();

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: any[]) => modalAlert(...args),
    },
}));

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
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    AcpHistoryImportView,
                    makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
                ),
            );
        });
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

        const importButton = findPressableByText(tree, 'Import');
        expect(importButton).toBeTruthy();
        await act(async () => {
            await importButton!.props.onPress();
        });

        expect(sessionAllow).toHaveBeenCalledWith('s1', 'perm1');
        expect(sessionDeny).toHaveBeenCalledTimes(0);
    });

    it('skips import when Skip is pressed', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeTool());

        const skipButton = findPressableByText(tree, 'Skip');
        expect(skipButton).toBeTruthy();
        await act(async () => {
            await skipButton!.props.onPress();
        });

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledWith('s1', 'perm1', undefined, undefined, 'denied');
    });

    it('shows an error when import approval fails', async () => {
        sessionAllow.mockRejectedValueOnce(new Error('network-down'));
        const tree = await renderView(makeTool());

        const importButton = findPressableByText(tree, 'Import');
        expect(importButton).toBeTruthy();
        await act(async () => {
            await importButton!.props.onPress();
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

        const importButton = findPressableByText(tree, 'Import');
        const skipButton = findPressableByText(tree, 'Skip');
        expect(importButton).toBeTruthy();
        expect(skipButton).toBeTruthy();

        await act(async () => {
            await importButton!.props.onPress();
            await skipButton!.props.onPress();
        });

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(collectHostText(tree)).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });
});
