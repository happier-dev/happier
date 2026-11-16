import * as React from 'react';
import type { ComponentProps } from 'react';
import type {
    StyleProp,
    TextInputProps as RNTextInputProps,
    TextStyle,
} from 'react-native';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { FontFamilies, Typography } from '@/constants/Typography';
import { BUNDLED_FONTS } from '@/constants/bundledFonts';
import { lightTheme, darkTheme, type Theme } from '@/theme';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';

import { Text, TextInput, type AppTextProps } from './Text';

const native = vi.hoisted(() => ({ themes: null as Record<'light' | 'dark', Theme> | null,
    current: 'light' as 'light' | 'dark', listeners: new Set<() => void>() }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        Text: (props: Record<string, unknown>) => React.createElement('RNText', props, props.children as React.ReactNode),
        TextInput: (props: Record<string, unknown>) => React.createElement('RNTextInput', props, props.children as React.ReactNode),
    });
});

// Unistyles owns native theme delivery; retain real typography and text adaptation below it.
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const base = await createUnistylesMock();
    const publish = () => { for (const listener of native.listeners) listener(); };
    return { ...base,
        useUnistyles: () => ({ ...base.useUnistyles(), theme: React.useSyncExternalStore(
            listener => { native.listeners.add(listener); return () => { native.listeners.delete(listener); }; },
            () => native.themes?.[native.current] ?? base.useUnistyles().theme,
        ) }),
        UnistylesRuntime: { ...base.UnistylesRuntime,
            getTheme: (mode: 'light' | 'dark') => native.themes?.[mode],
            updateTheme: (mode: 'light' | 'dark', update: (theme: Theme) => Theme) => {
                if (native.themes) { native.themes[mode] = update(native.themes[mode]); publish(); }
            },
            setTheme: (mode: 'light' | 'dark') => { if (native.current !== mode) { native.current = mode; publish(); } },
        },
    };
});
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

afterEach(() => { standardCleanup(); native.themes = null; native.current = 'light'; });

// Core Text keeps the complete native contract even though plugin-authored
// presentation styles intentionally remain portable.
expectTypeOf<StyleProp<TextStyle> | undefined>().toMatchTypeOf<AppTextProps['style']>();
expectTypeOf<ComponentProps<typeof TextInput>['style']>().toMatchTypeOf<RNTextInputProps['style']>();

describe('Text private native-style adapter', () => {
    it('repaints mounted default text and fields with the selected bundled family while retaining explicit mono and logo faces', async () => {
        native.themes = { light: lightTheme, dark: darkTheme };
        const screen = await renderScreen(<>
            <Text testID="default">Default</Text>
            <Text testID="weighted" style={Typography.default('semiBold')}>Weighted</Text>
            <TextInput testID="field" variant="body" emphasis="semiBold" value="Value" />
            <Text testID="mono" style={Typography.mono()}>Code</Text>
            <Text testID="logo" style={Typography.logo()}>Brand</Text>
        </>);
        expect(flattenTestStyle(screen.findByTestId('default')!.props.style).fontFamily).toBe(FontFamilies.default.regular);
        await act(async () => {
            applyThemeRuntimeSelection({ themePreference: 'light', platform: 'ios', systemTheme: 'light', style: null,
                recordBreadcrumb: () => {}, setSystemBackgroundColor: () => {},
                themeProfiles: { activeProfileIds: { light: 'typeface', dark: null }, profiles: [{
                    schemaVersion: 1, id: 'typeface', name: 'Typeface', createdAt: 'now', updatedAt: 'now',
                    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
                    style: { fontFamily: BUNDLED_FONTS.spaceMono.faces.regular.family },
                }] },
            });
        });
        expect(flattenTestStyle(screen.findByTestId('default')!.props.style).fontFamily).toBe(BUNDLED_FONTS.spaceMono.faces.regular.family);
        for (const id of ['weighted', 'field']) {
            expect(flattenTestStyle(screen.findByTestId(id)!.props.style).fontFamily).toBe(BUNDLED_FONTS.spaceMono.faces.regular.family);
        }
        expect(flattenTestStyle(screen.findByTestId('mono')!.props.style).fontFamily).toBe(FontFamilies.mono.regular);
        expect(flattenTestStyle(screen.findByTestId('logo')!.props.style).fontFamily).toBe(FontFamilies.logo.bold);
    });
    it('passes core-only native props and style entries to the native text host', async () => {
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
