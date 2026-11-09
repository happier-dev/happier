import { describe, expect, it } from 'vitest';
import { StyleSheet } from 'react-native';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { lightTheme } from '@/theme';
import { createAppStackScreenOptions } from './createAppStackScreenOptions';

installPanelCommonModuleMocks();

describe('stack surface ownership', () => {
    it('gives the native navigation bar the same paper as its screen, even when chrome has a separate paint', () => {
        const theme = { ...lightTheme, colors: { ...lightTheme.colors, chrome: { ...lightTheme.colors.chrome,
            header: { ...lightTheme.colors.chrome.header, background: '#123456' },
        } } };
        const options = createAppStackScreenOptions({ theme, shouldUseCustomHeader: false, headerBackTitle: 'Back' });
        const headerBackground = StyleSheet.flatten(options.headerStyle)?.backgroundColor;
        expect(headerBackground).toBe(StyleSheet.flatten(options.contentStyle)?.backgroundColor);
        expect(headerBackground).not.toBe(theme.colors.chrome.header.background);
    });

    it('preserves the desktop overlay caller’s transparent content with its custom header', () => {
        const contentStyle = { backgroundColor: 'transparent' };
        const options = createAppStackScreenOptions({ theme: lightTheme, shouldUseCustomHeader: true,
            headerBackTitle: 'Back', contentStyle });
        expect(options.contentStyle).toBe(contentStyle);
        expect(options.header).toBeDefined();
    });
});
