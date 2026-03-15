import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    View: (props: any) => React.createElement('View', props, props.children),
    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { textSecondary: '#666' } },
    }),
}));

describe('SessionPaneLazyLoader', () => {
    it('renders a visible loading fallback while the pane module is loading', async () => {
        const { SessionPaneLazyLoader } = await import('./SessionPaneLazyLoader');

        const never = new Promise<React.ComponentType<{ value: string }>>(() => {});

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SessionPaneLazyLoader
                    testID="lazy-pane"
                    load={() => never}
                    props={{ value: 'x' }}
                />,
            );
        });

        const textNodes = tree!.root.findAllByType('Text' as any);
        const hasLoading = textNodes.some((n) => String(n.props.children).includes('common.loading'));
        expect(hasLoading).toBe(true);
    });
});
