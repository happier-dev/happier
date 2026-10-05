import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

const settings = vi.hoisted(() => ({ fontScale: 1.3 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The in-app font preference is device-local storage, outside the text owner.
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => settings.fontScale }));

afterEach(() => {
    settings.fontScale = 1.3;
    vi.unstubAllGlobals();
    standardCleanup();
    vi.resetModules();
});

async function renderTextHosts(platform: 'web' | 'ios', disabled = false) {
    const { Platform } = await import('react-native');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    const { Text, TextInput } = await import('./Text');
    return renderScreen(<>
        <Text testID="text" disableUiFontScaling={disabled} style={{ fontSize: 14, lineHeight: 20 }}>Label</Text>
        <TextInput testID="input" disableUiFontScaling={disabled} style={{ fontSize: 14, lineHeight: 20 }} value="Value" />
    </>);
}

describe('Text metric scaling ownership', () => {
    it('lets web CSS scale text and field metrics once', async () => {
        const screen = await renderTextHosts('web');
        for (const id of ['text', 'input']) {
            expect(flattenTestStyle(screen.findByTestId(id)!.props.style)).toMatchObject({ fontSize: 14, lineHeight: 20 });
        }
    });

    it('scales native text and fields in the adapter while preserving Dynamic Type', async () => {
        const screen = await renderTextHosts('ios');
        for (const id of ['text', 'input']) {
            expect(flattenTestStyle(screen.findByTestId(id)!.props.style)).toMatchObject({ fontSize: 18.2, lineHeight: 26 });
        }
        expect(screen.findByTestId('text')!.props.allowFontScaling).toBe(true);
    });

    it('opts special web text and fields out of the global CSS scale', async () => {
        const screen = await renderTextHosts('web', true);
        for (const id of ['text', 'input']) {
            const host = screen.findByTestId(id)!;
            expect(host.props['data-happier-ui-font-scaling']).toBe('disabled');
            expect(flattenTestStyle(host.props.style)).toMatchObject({ fontSize: 14, lineHeight: 20 });
        }
    });

    it('keeps the iOS web field at a 16px effective minimum even with small text', async () => {
        settings.fontScale = 0.8;
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
        const screen = await renderTextHosts('web');
        // The web CSS owner applies 0.8 after Unistyles compiles this base value.
        expect(flattenTestStyle(screen.findByTestId('input')!.props.style).fontSize).toBe(20);
    });
});
