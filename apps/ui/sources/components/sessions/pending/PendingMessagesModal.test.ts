import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fetchPendingMessages = vi.fn();
const sendMessage = vi.fn();
const deletePendingMessage = vi.fn();
const discardPendingMessage = vi.fn();
const deleteDiscardedPendingMessage = vi.fn();
const sessionAbort = vi.fn();
const modalConfirm = vi.fn();
const modalAlert = vi.fn();

let sessionValue: any = null;

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSessionPendingMessages: () => ({
        isLoaded: true,
        messages: [
            { id: 'p1', text: 'hello', displayText: null, createdAt: 0, updatedAt: 0 },
        ],
        discarded: [],
    }),
    useSession: () => sessionValue,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchPendingMessages: (...args: any[]) => fetchPendingMessages(...args),
        sendMessage: (...args: any[]) => sendMessage(...args),
        deletePendingMessage: (...args: any[]) => deletePendingMessage(...args),
        discardPendingMessage: (...args: any[]) => discardPendingMessage(...args),
        updatePendingMessage: vi.fn(),
        restoreDiscardedPendingMessage: vi.fn(),
        deleteDiscardedPendingMessage: (...args: any[]) => deleteDiscardedPendingMessage(...args),
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionAbort: (...args: any[]) => sessionAbort(...args),
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: (...args: any[]) => modalConfirm(...args),
        alert: (...args: any[]) => modalAlert(...args),
        prompt: vi.fn(),
    },
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                surfaceHighest: '#eee',
                input: { background: '#fff' },
                button: {
                    // Match app theme shape: secondary has tint but no background.
                    secondary: { tint: '#000' },
                },
                box: {
                    // Match app theme shape: error (not danger).
                    error: { background: '#fdd', text: '#a00' },
                },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('PendingMessagesModal', () => {
    beforeEach(() => {
        fetchPendingMessages.mockReset();
        sendMessage.mockReset();
        deletePendingMessage.mockReset();
        discardPendingMessage.mockReset();
        deleteDiscardedPendingMessage.mockReset();
        sessionAbort.mockReset();
        modalConfirm.mockReset();
        modalAlert.mockReset();
        sessionValue = null;

        // The modal triggers a best-effort fetch on mount. Default it to a resolved promise so
        // call sites can safely attach `.catch(...)` without blowing up in tests.
        fetchPendingMessages.mockResolvedValue(undefined);
    });

    function findPressableByTestId(tree: renderer.ReactTestRenderer, testID: string): ReactTestInstance | undefined {
        return tree.root.findAllByType('Pressable').find((node) => node.props.testID === testID);
    }

    it('does not close the modal until abort+send+delete succeed', async () => {
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendMessage.mockResolvedValueOnce(undefined);
        deletePendingMessage.mockResolvedValueOnce(undefined);

        const onClose = vi.fn();
        const { PendingMessagesModal } = await import('./PendingMessagesModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesModal, { sessionId: 's1', onClose }));
        });

        const sendNow = findPressableByTestId(tree!, 'pendingMessages.sendNow:p1');
        expect(sendNow).toBeTruthy();

        await act(async () => {
            await sendNow!.props.onPress();
        });

        expect(sessionAbort).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);

        const abortOrder = sessionAbort.mock.invocationCallOrder[0]!;
        const sendOrder = sendMessage.mock.invocationCallOrder[0]!;
        const deleteOrder = deletePendingMessage.mock.invocationCallOrder[0]!;
        const closeOrder = onClose.mock.invocationCallOrder[0]!;

        expect(abortOrder).toBeLessThan(sendOrder);
        expect(sendOrder).toBeLessThan(deleteOrder);
        expect(deleteOrder).toBeLessThan(closeOrder);
    });

    it('offers steer-now while a steer-capable session is thinking and does not abort the turn', async () => {
        sessionValue = {
            thinking: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        modalConfirm.mockResolvedValueOnce(true);
        sendMessage.mockResolvedValueOnce(undefined);
        deletePendingMessage.mockResolvedValueOnce(undefined);

        const onClose = vi.fn();
        const { PendingMessagesModal } = await import('./PendingMessagesModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesModal, { sessionId: 's1', onClose }));
        });

        const steerNow = findPressableByTestId(tree!, 'pendingMessages.steerNow:p1');
        expect(steerNow).toBeTruthy();

        await act(async () => {
            await steerNow!.props.onPress();
        });

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders with app theme shape (no secondary background / no danger box)', async () => {
        const onClose = vi.fn();
        const { PendingMessagesModal } = await import('./PendingMessagesModal');

        await expect((async () => {
            await act(async () => {
                renderer.create(React.createElement(PendingMessagesModal, { sessionId: 's1', onClose }));
            });
        })()).resolves.toBeUndefined();
    });

    it('does not delete or close when send fails', async () => {
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendMessage.mockRejectedValueOnce(new Error('send failed'));

        const onClose = vi.fn();
        const { PendingMessagesModal } = await import('./PendingMessagesModal');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesModal, { sessionId: 's1', onClose }));
        });

        const sendNow = findPressableByTestId(tree!, 'pendingMessages.sendNow:p1');
        expect(sendNow).toBeTruthy();

        await act(async () => {
            await sendNow!.props.onPress();
        });

        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(onClose).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(1);
    });
});
