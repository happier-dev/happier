import * as React from 'react';
import type { ComponentProps } from 'react';
import type {
    StyleProp,
    TextInputProps as RNTextInputProps,
    TextStyle,
} from 'react-native';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { Text, TextInput, type AppTextProps } from './Text';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Text: (props: Record<string, unknown>) => React.createElement('RNText', props, props.children as React.ReactNode),
        TextInput: (props: Record<string, unknown>) => React.createElement('RNTextInput', props, props.children as React.ReactNode),
    });
});

vi.mock('@happier-dev/plugin-ui/presentation', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/plugin-ui/presentation')>('@happier-dev/plugin-ui/presentation');
    return {
        ...actual,
        // A portable plugin primitive is not allowed to become an RN-style
        // escape hatch. The core adapter must apply its private native style.
        HappierText: ({ children }: { children?: React.ReactNode }) => React.createElement('PortableText', undefined, children),
    };
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('./uiFontScale', () => ({
    scaleTextStyle: (style: unknown) => style,
    scaleUnistylesTextStyleEntry: <T,>(entry: T) => entry,
}));

// Core Text keeps the complete native contract even though plugin-authored
// presentation styles intentionally remain portable.
expectTypeOf<StyleProp<TextStyle> | undefined>().toMatchTypeOf<AppTextProps['style']>();
expectTypeOf<ComponentProps<typeof TextInput>['style']>().toMatchTypeOf<RNTextInputProps['style']>();

describe('Text private native-style adapter', () => {
    it('applies core-only text styles and native props without broadening the portable primitive', async () => {
        const screen = await renderScreen(
            <Text
                accessibilityActions={[{ name: 'activate', label: 'Activate transcript row' }]}
                style={{ fontVariant: ['tabular-nums'] }}
                testID="core-text"
            >
                42
            </Text>,
        );

        const nativeText = screen.findByType('RNText' as never);
        if (!nativeText) {
            throw new Error('Expected the core Text adapter to render a native text host');
        }
        expect(nativeText.props.accessibilityActions).toEqual([
            { name: 'activate', label: 'Activate transcript row' },
        ]);
        expect(nativeText.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ fontVariant: ['tabular-nums'] }),
        ]));
    });
});
