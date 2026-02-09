import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (fn: any) => fn({ colors: { userMessageBackground: '#eee' } }) },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { background: '#fff' },
                textSecondary: '#666',
                userMessageBackground: '#eee',
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: 'MarkdownView',
}));

const modalShow = vi.fn();
vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: any[]) => modalShow(...args),
    },
}));

vi.mock('./PendingMessagesModal', () => ({
    PendingMessagesModal: 'PendingMessagesModal',
}));

describe('PendingUserTextMessageView', () => {
    beforeEach(() => {
        modalShow.mockReset();
    });

    function makePendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
        return {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            text: 'hello',
            rawRecord: {},
            ...overrides,
        };
    }

    it('renders a badge with a pending count when there are other pending messages', async () => {
        const { PendingUserTextMessageView } = await import('./PendingUserTextMessageView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PendingUserTextMessageView, {
                    sessionId: 's1',
                    otherPendingCount: 2,
                    message: makePendingMessage(),
                }),
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        expect(pressables.some((p) => p.props.accessibilityLabel === 'Pending (+2)')).toBe(true);
        expect(tree!.root.findByType('MarkdownView' as any).props.markdown).toBe('hello');
    });

    it('uses the base pending label when there are no other queued messages', async () => {
        const { PendingUserTextMessageView } = await import('./PendingUserTextMessageView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PendingUserTextMessageView, {
                    sessionId: 's1',
                    otherPendingCount: 0,
                    message: makePendingMessage(),
                }),
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        expect(pressables.some((p) => p.props.accessibilityLabel === 'Pending')).toBe(true);
    });

    it('prefers displayText over text when rendering markdown preview', async () => {
        const { PendingUserTextMessageView } = await import('./PendingUserTextMessageView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PendingUserTextMessageView, {
                    sessionId: 's1',
                    otherPendingCount: 1,
                    message: makePendingMessage({
                        text: 'raw text',
                        displayText: 'display text',
                    }),
                }),
            );
        });

        expect(tree!.root.findByType('MarkdownView' as any).props.markdown).toBe('display text');
    });

    it('opens PendingMessagesModal for the current session when the badge is pressed', async () => {
        const { PendingUserTextMessageView } = await import('./PendingUserTextMessageView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PendingUserTextMessageView, {
                    sessionId: 'session-42',
                    otherPendingCount: 2,
                    message: makePendingMessage(),
                }),
            );
        });

        const badge = tree!.root.findAllByType('Pressable' as any)[0];
        await act(async () => {
            badge.props.onPress();
        });

        expect(modalShow).toHaveBeenCalledTimes(1);
        expect(modalShow).toHaveBeenCalledWith({
            component: 'PendingMessagesModal',
            props: { sessionId: 'session-42' },
        });
    });
});
