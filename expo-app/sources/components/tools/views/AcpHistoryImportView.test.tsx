import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

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

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                button: { primary: { background: '#00f', tint: '#fff' } },
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
                surfaceHigh: '#eee',
                surfaceHighest: '#f3f3f3',
            },
        },
    }),
}));

vi.mock('../ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: (...args: any[]) => sessionAllow(...args),
    sessionDeny: (...args: any[]) => sessionDeny(...args),
}));

describe('AcpHistoryImportView', () => {
    beforeEach(() => {
        sessionAllow.mockReset();
        sessionDeny.mockReset();
        modalAlert.mockReset();
    });

    it('does not allow import/skip when canApprovePermissions is false', async () => {
        const { AcpHistoryImportView } = await import('./AcpHistoryImportView');

        const tool: ToolCall = {
            name: 'AcpHistoryImport',
            state: 'running',
            input: { provider: 'acp' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: { id: 'perm1', status: 'pending' },
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(AcpHistoryImportView, {
                    tool,
                    sessionId: 's1',
                    metadata: null,
                    messages: [],
                    interaction: { canSendMessages: true, canApprovePermissions: false, permissionDisabledReason: 'notGranted' },
                }),
            );
        });

        await act(async () => {
            const touchables = tree!.root.findAllByType('TouchableOpacity' as any);
            expect(touchables.length).toBeGreaterThanOrEqual(2);
            await touchables[0].props.onPress();
            await touchables[1].props.onPress();
        });

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
    });
});

