import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { collectHostText, findPressableByText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { createTestSessionTranscriptSource, pressTestInstanceAsync, renderWithSessionTranscriptSource } from '@/dev/testkit';
import { installSystemToolRendererCommonModuleMocks } from './systemToolRendererTestHelpers';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';


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

describe('AcpHistoryImportView', () => {
    it('removes the preview clamp and decorates the full role-prefixed text for Find', async () => {
        const { AcpHistoryImportView } = await import('./AcpHistoryImportView');
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['history', { blocks: [{ id: 'tool-history-remote-0', sourceRanges: [{ start: 11, end: 17, current: true }] }] }]]));
        const screen = await renderWithSessionTranscriptSource(
            <TranscriptFindProvider store={store}><AcpHistoryImportView {...makeToolViewProps(makeTool({ input: { remoteTail: [{ role: 'assistant', text: 'needle' }] } }), { sessionId: 's1', messageId: 'history' })} /></TranscriptFindProvider>,
            createTestSessionTranscriptSource({ sessionId: 's1' }),
        );
        const highlighted = screen.tree.findAllHostsByTestId('find-match-current');
        expect(highlighted).toHaveLength(1);
        expect(highlighted[0].props.children).toBe('needle');
        expect(screen.tree.findAllByType('Text').filter((node) => node.props.numberOfLines === 2)).toHaveLength(0);
    });
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
        tree = (await renderWithSessionTranscriptSource(React.createElement(
                    AcpHistoryImportView,
                    makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
                ), createTestSessionTranscriptSource({
                    sessionId: 's1', serverId: typeof overrides.serverId === 'string' ? overrides.serverId : null,
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                    actions: {
                        respondToPermission: (params) => params.approved ? sessionAllow(params) : sessionDeny(params),
                        answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {},
                    },
                }))).tree;
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

        expect(sessionAllow).toHaveBeenCalledWith({ id: 'perm1', approved: true });
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

        expect(sessionAllow).toHaveBeenCalledWith({ id: 'toolu_reconnect', approved: true });
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
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'perm1', approved: false, decision: 'denied' });
    });

    it('delivers both decisions through the mounted source', async () => {
        sessionAllow.mockResolvedValueOnce(undefined);
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeTool(), { serverId: 'home-b' });

        await act(async () => {
            await pressTestInstanceAsync(findPressableByText(tree, 'tools.acpHistoryImport.actions.import')!);
            await pressTestInstanceAsync(findPressableByText(tree, 'tools.acpHistoryImport.actions.skip')!);
        });

        expect(sessionAllow).toHaveBeenCalledWith({ id: 'perm1', approved: true }
        );
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'perm1', approved: false, decision: 'denied' }
        );
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

    it('refuses both decisions without source actions even when the caller grants approval', async () => {
        const { AcpHistoryImportView } = await import('./AcpHistoryImportView');
        const screen = await renderWithSessionTranscriptSource(
            React.createElement(AcpHistoryImportView, makeToolViewProps(makeTool(), {
                sessionId: 's1', interaction: { canSendMessages: true, canApprovePermissions: true },
            })), createTestSessionTranscriptSource(),
        );
        await pressTestInstanceAsync(findPressableByText(screen.tree, 'tools.acpHistoryImport.actions.import')!);
        await pressTestInstanceAsync(findPressableByText(screen.tree, 'tools.acpHistoryImport.actions.skip')!);
        expect(sessionAllow).not.toHaveBeenCalled();
        expect(sessionDeny).not.toHaveBeenCalled();
    });
});
