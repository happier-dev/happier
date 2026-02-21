import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { PendingQueueIndicator } from './PendingQueueIndicator';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? null },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                divider: '#ddd',
                shadow: { color: '#000', opacity: 0.2 },
                input: { background: '#fff' },
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: { create: (input: any) => (typeof input === 'function' ? input({ colors: { shadow: { color: '#000', opacity: 0.2 } } }) : input) },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
}));

const modalShow = vi.fn();
vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: unknown[]) => modalShow(...args),
    },
}));

vi.mock('./PendingMessagesModal', () => ({
    PendingMessagesModal: 'PendingMessagesModal',
}));

function flattenTextChildren(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) {
        return value.flatMap((entry) => flattenTextChildren(entry));
    }
    return [];
}

async function renderIndicator(props: { sessionId: string; count: number; preview?: string }) {
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
        tree = renderer.create(React.createElement(PendingQueueIndicator, props));
    });
    return tree!;
}

describe('PendingQueueIndicator', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        modalShow.mockReset();
    });

    afterEach(async () => {
        await act(async () => {
            vi.clearAllTimers();
        });
        vi.useRealTimers();
    });

    it('renders null when count is 0', async () => {
        const tree = await renderIndicator({ sessionId: 's1', count: 0 });
        expect(tree.toJSON()).toBeNull();
        await act(async () => {
            tree.unmount();
        });
    });

    it('renders preview text after debounce and opens pending modal on press', async () => {
        const tree = await renderIndicator({
            sessionId: 's1',
            count: 2,
            preview: 'next up: hello',
        });

        await act(async () => {
            vi.advanceTimersByTime(250);
        });

        const textNodes = tree.root.findAllByType('Text');
        const renderedText = textNodes.flatMap((node) => flattenTextChildren(node.props.children));
        expect(renderedText.join(' ')).toContain('next up: hello');

        const indicatorButton = tree.root.findByType('Pressable');
        await act(async () => {
            indicatorButton.props.onPress?.();
        });

        expect(modalShow).toHaveBeenCalledTimes(1);
        await act(async () => {
            tree.unmount();
        });
    });

    it('constrains width to layout.maxWidth', async () => {
        const tree = await renderIndicator({ sessionId: 's1', count: 1 });

        await act(async () => {
            vi.advanceTimersByTime(250);
        });

        const views = tree.root.findAllByType('View');
        const hasMaxWidthContainer = views.some((node) => {
            const style = node.props.style;
            return style && style.maxWidth === 800 && style.width === '100%';
        });
        expect(hasMaxWidthContainer).toBe(true);

        const pressable = tree.root.findByType('Pressable') as ReactTestInstance;
        const styleFn = pressable.props.style as ((input: { pressed: boolean }) => { width?: string });
        expect(styleFn({ pressed: false }).width).toBe('100%');

        await act(async () => {
            tree.unmount();
        });
    });

    it('does not flicker pending UI for fast enqueue-to-dequeue transitions', async () => {
        const tree = await renderIndicator({ sessionId: 's1', count: 0 });
        expect(tree.toJSON()).toBeNull();

        await act(async () => {
            tree.update(React.createElement(PendingQueueIndicator, { sessionId: 's1', count: 1, preview: 'hello' }));
        });
        expect(tree.toJSON()).toBeNull();

        await act(async () => {
            vi.advanceTimersByTime(50);
            tree.update(React.createElement(PendingQueueIndicator, { sessionId: 's1', count: 0 }));
        });
        expect(tree.toJSON()).toBeNull();

        await act(async () => {
            tree.unmount();
        });
    });
});
