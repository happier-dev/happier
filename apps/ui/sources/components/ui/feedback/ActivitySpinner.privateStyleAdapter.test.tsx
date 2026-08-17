import * as React from 'react';
import type { ComponentProps } from 'react';
import type { ActivityIndicatorProps as RNActivityIndicatorProps } from 'react-native';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ActivitySpinner, type ActivitySpinnerProps } from './ActivitySpinner';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: {
                    secondary: 'theme-secondary-text',
                },
            },
        },
    });
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@happier-dev/plugin-ui/presentation', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/plugin-ui/presentation')>('@happier-dev/plugin-ui/presentation');
    return {
        ...actual,
        // Private core transforms belong on the app's RN host, not a portable
        // plugin primitive with a widened style contract.
        HappierSpinner: ({ testID }: { testID?: string }) => React.createElement('PortableSpinner', { testID }),
    };
});

expectTypeOf<RNActivityIndicatorProps['style']>()
    .toMatchTypeOf<ActivitySpinnerProps['style']>();
expectTypeOf<ComponentProps<typeof ActivitySpinner>['style']>()
    .toMatchTypeOf<RNActivityIndicatorProps['style']>();

describe('ActivitySpinner private native-style adapter', () => {
    it('applies the ToolView-scale transform on the core web spinner host', async () => {
        const transform = [{ scaleX: 0.8 }, { scaleY: 0.8 }];
        const screen = await renderScreen(
            <ActivitySpinner testID="core-spinner" style={{ transform }} />,
        );

        const spinner = screen.findByTestId('core-spinner');
        if (!spinner) {
            throw new Error('Expected the core ActivitySpinner to render its web host');
        }
        expect(spinner.type).toBe('View');
        expect(spinner.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ transform }),
        ]));
    });
});
