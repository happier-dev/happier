import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { HeaderTitleWithAction } from './HeaderTitleWithAction';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: {
                    primary: 'theme-primary-text',
                },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('HeaderTitleWithAction', () => {
    it('uses themed title and loading indicator colors when explicit tint colors are absent', async () => {
        const screen = await renderScreen(
            <HeaderTitleWithAction
                title="Runs"
                actionLabel="Refresh"
                actionIconName="arrow-clockwise"
                actionLoading={true}
                onActionPress={vi.fn()}
            />,
        );

        const title = screen.findByProps({ accessibilityRole: 'header' });
        expect(flattenStyle(title.props.style).color).toBe('theme-primary-text');
        const spinner = screen.findByProps({ accessibilityRole: 'progressbar' });
        expect(flattenStyle(spinner.props.style).borderColor).toBe('theme-primary-text');
    });
});
