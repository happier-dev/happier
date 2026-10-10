/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import Color from 'color';

import { installFormsCommonModuleMocks } from './formsTestHelpers';

installFormsCommonModuleMocks({
    reactNative: async () => vi.importActual('react-native-web'),
    unistyles: async () => vi.importActual('react-native-unistyles'),
});

it('updates a mounted field on an adaptive media change without a resize or unrelated render', async () => {
    let mode: 'light' | 'dark' = 'dark';
    const queries = new Map<string, MediaQueryList>();
    const previousMatchMedia = window.matchMedia;
    const previousOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
    // Browser media and Screen are genuine platform boundaries. Deliver both matching and
    // nonmatching change events, as a real dark→light preference change does.
    window.matchMedia = (media) => {
        const existing = queries.get(media);
        if (existing) return existing;
        const target = new EventTarget();
        const query = Object.assign(target, {
            media,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
        });
        Object.defineProperty(query, 'matches', {
            get: () => media === `(prefers-color-scheme: ${mode})`,
        });
        const result = query as MediaQueryList;
        queries.set(media, result);
        return result;
    };
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        const { StyleSheet, UnistylesRuntime } = await import('react-native-unistyles');
        const { darkTheme, lightTheme } = await import('@/theme');
        StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { adaptiveThemes: true, CSSVars: true } });
        const { FieldTextInput } = await import('./FieldTextInput');
        await act(async () => root.render(<FieldTextInput testID="theme-field" accessibilityLabel="Name" value="Draft" onChangeText={() => {}} />));
        const input = host.querySelector<HTMLInputElement>('[data-testid="theme-field"]');
        if (!input) throw new Error('Missing real field input');
        expect(UnistylesRuntime.themeName).toBe('dark');
        expect(getComputedStyle(input).color).toBe(Color(darkTheme.colors.text.primary).rgb().string());

        await act(async () => {
            mode = 'light';
            for (const query of queries.values()) {
                if (!query.media.startsWith('(prefers-color-scheme:')) continue;
                const event = new Event('change');
                Object.defineProperties(event, {
                    matches: { value: query.matches },
                    media: { value: query.media },
                });
                query.dispatchEvent(event);
            }
        });

        expect(UnistylesRuntime.themeName).toBe('light');
        expect(getComputedStyle(input).color).toBe(Color(lightTheme.colors.text.primary).rgb().string());
        expect(input.value).toBe('Draft');
    } finally {
        await act(async () => root.unmount());
        host.remove();
        window.matchMedia = previousMatchMedia;
        if (previousOrientation) Object.defineProperty(screen, 'orientation', previousOrientation);
        else Reflect.deleteProperty(screen, 'orientation');
    }
});
