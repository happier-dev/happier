import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPaneLazyLoader } from './SessionPaneLazyLoader';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
                text: '#111',
                surface: '#fff',
            },
        },
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SessionPaneLazyLoader', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('keeps loading while a slow pane module is still pending and renders once it resolves', async () => {
        const LoadedPane = () => React.createElement('LoadedPane');
        let resolveLoad: ((value: React.ComponentType<Record<string, never>>) => void) | null = null;
        const load = vi.fn<() => Promise<React.ComponentType<Record<string, never>>>>(() => new Promise((resolve) => {
            resolveLoad = resolve;
        }));

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionPaneLazyLoader
                    testID="session-pane-loader"
                    load={load}
                    props={{}}
                />
            );
        });

        expect(JSON.stringify(tree.toJSON())).toContain('common.loading');
        expect(load).toHaveBeenCalledTimes(1);

        await act(async () => {
            await Promise.resolve();
        });

        expect(JSON.stringify(tree.toJSON())).toContain('common.loading');

        await act(async () => {
            resolveLoad?.(LoadedPane);
            await Promise.resolve();
        });

        expect(JSON.stringify(tree.toJSON())).toContain('LoadedPane');
    });

    it('shows retry UI after a rejected load and recovers when the user retries', async () => {
        const LoadedPane = () => React.createElement('LoadedPane');
        const load = vi.fn()
            .mockRejectedValueOnce(new Error('module load failed'))
            .mockResolvedValueOnce(LoadedPane);

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionPaneLazyLoader
                    testID="session-pane-loader"
                    load={load}
                    props={{}}
                />
            );
        });

        await act(async () => {
            await Promise.resolve();
        });

        expect(JSON.stringify(tree.toJSON())).toContain('common.error');
        expect(JSON.stringify(tree.toJSON())).toContain('common.retry');

        const retryButton = tree.root.findByType('Pressable');
        await act(async () => {
            retryButton.props.onPress();
            await Promise.resolve();
        });

        expect(load).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(tree.toJSON())).toContain('LoadedPane');
    });
});
