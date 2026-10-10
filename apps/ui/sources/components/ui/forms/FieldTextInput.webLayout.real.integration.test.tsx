/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { installFormsCommonModuleMocks } from './formsTestHelpers';

const nativeHosts = vi.hoisted(() => ({
    View: undefined as React.ComponentType<React.ComponentProps<typeof import('react-native').View>> | undefined,
}));

installFormsCommonModuleMocks({
    reactNative: async () => {
        // RNW supplies the real web implementations of the React Native host contract.
        const nativeWeb = await vi.importActual<typeof import('react-native')>('react-native-web');
        return {
            ...nativeWeb,
            View: (props: React.ComponentProps<typeof nativeWeb.View>) => React.createElement(nativeHosts.View ?? nativeWeb.View, props),
        };
    },
    unistyles: async () => vi.importActual('react-native-unistyles'),
    text: async () => vi.importActual('@/text'),
});

const previousMatchMedia = window.matchMedia;
const previousOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
beforeAll(() => {
    // Media and Screen are browser boundaries; the installed styling engine stays real.
    window.matchMedia = (media) => Object.assign(new EventTarget(), {
        media, matches: media === '(prefers-color-scheme: light)', onchange: null,
        addListener: () => {}, removeListener: () => {},
    }) as MediaQueryList;
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
});
afterAll(() => {
    window.matchMedia = previousMatchMedia;
    if (previousOrientation) Object.defineProperty(screen, 'orientation', previousOrientation);
    else Reflect.deleteProperty(screen, 'orientation');
});

it('fits a narrow stacked field, fills a wide stacked row, and retains its inline field column', async () => {
    const nativeWeb = await vi.importActual<typeof import('react-native')>('react-native-web');
    const { StyleSheet, createUnistylesElement } = await import('react-native-unistyles');
    // Vitest does not run Unistyles' Babel host transform. Use its real adapter,
    // otherwise opaque registered CSS styles never reach the RNW elements.
    nativeHosts.View = createUnistylesElement(nativeWeb.View);
    const { View } = await import('react-native');
    const { darkTheme, lightTheme } = await import('@/theme');
    StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { initialTheme: 'light', CSSVars: true } });
    const portStyles = StyleSheet.create({ field: { width: 88 } });
    const { FieldTextInput } = await import('./FieldTextInput');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let existingBrowser: Browser | undefined;
    let existingPage: Page | undefined;
    try {
        const cdpUrl = process.env.HAPPIER_TEST_CHROMIUM_CDP_URL;
        if (cdpUrl) {
            const { chromium } = await import('playwright');
            existingBrowser = await chromium.connectOverCDP(cdpUrl);
            existingPage = await existingBrowser.newPage();
            await existingPage.setContent('<title>Existing browser page</title>');
        }
        await act(async () => root.render(<View>
            <View testID="registered-width-reference" style={portStyles.field} />
            {/* The 390px token modal leaves 226px inside its sheet row. */}
            <View testID="narrow-slot" style={{ width: 226 }}>
                <FieldTextInput testID="narrow-input" accessibilityLabel="Label" value="Personal token" onChangeText={() => {}} error="Choose a distinct label for this token" />
            </View>
            <View testID="wide-slot" style={{ width: 340 }}>
                <FieldTextInput testID="wide-input" accessibilityLabel="Notes" value="Personal token" onChangeText={() => {}} multiline />
            </View>
            <View style={{ flexDirection: 'row', alignSelf: 'flex-start' }}>
                <FieldTextInput testID="inline-input" accessibilityLabel="Name" value="Personal token" onChangeText={() => {}} />
            </View>
            <View testID="port-security-slot" style={{ width: 320, flexDirection: 'row', gap: 8 }}>
                <FieldTextInput testID="port-input" accessibilityLabel="Port" value="587" onChangeText={() => {}} style={portStyles.field} />
                <View testID="connection-security" style={{ width: 135, height: 34 }} />
            </View>
        </View>));
        const layout = await measureWebLayout(host, { viewport: { width: 390, height: 844 } });
        expect(layout.rect('registered-width-reference').width).toBeCloseTo(88, 0);
        const narrowSlot = layout.rect('narrow-slot');
        const narrowInput = layout.rect('narrow-input');
        const error = layout.rect('narrow-input.error');
        expect(narrowInput.right).toBeLessThanOrEqual(narrowSlot.right);
        expect(error.right).toBeLessThanOrEqual(narrowSlot.right);
        // The well keeps its trailing inset; it does not merely clip an oversized input.
        expect(narrowSlot.right - narrowInput.right).toBeCloseTo(9, 0);
        const wideSlot = layout.rect('wide-slot');
        expect(wideSlot.right - layout.rect('wide-input').right).toBeCloseTo(9, 0);
        // The existing shared column is 240px, including the well's border and insets.
        expect(layout.rect('inline-input').width).toBeCloseTo(218, 0);
        // An explicit Port width must not become the full slot and push security off-screen.
        const port = layout.rect('port-input');
        const security = layout.rect('connection-security');
        expect(port.width).toBeCloseTo(66, 0);
        expect(security.left).toBeGreaterThan(port.right);
        expect(security.right).toBeLessThanOrEqual(layout.rect('port-security-slot').right);
        // Measuring in a borrowed CDP browser must not close or navigate a page it did not create.
        if (existingPage) expect(await existingPage.title()).toBe('Existing browser page');
    } finally {
        await act(async () => root.unmount());
        host.remove();
        try {
            await existingPage?.close();
        } finally {
            await existingBrowser?.close();
        }
    }
});
