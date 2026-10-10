import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StyleSheet } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { darkTheme } from '@/theme';

import { formatPluginUiDiagnosticMessage, PluginDiagnosticsSection } from './PluginDiagnosticsSection';

// Native rendering/style adapters are boundaries; the row, text and theme logic stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { darkTheme } = await import('@/theme');
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: darkTheme, rt: { themeName: 'dark', colorScheme: 'dark' } });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

function luminance(hex: string): number {
    const channels = hex.replace('#', '').match(/.{2}/g);
    if (!channels || channels.length !== 3) throw new Error(`Expected opaque RGB color: ${hex}`);
    const [r, g, b] = channels.map((value) => {
        const channel = Number.parseInt(value, 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('PluginDiagnosticsSection readable recovery evidence', () => {
    it('keeps selectable diagnostic body text readable on the dark row surface', async () => {
        const screen = await renderScreen(React.createElement(PluginDiagnosticsSection, {
            title: 'Registry diagnostics',
            diagnostics: [{ code: 'malformed_source', message: 'A configured source was refused.' }],
            testIDPrefix: 'diagnostics',
        }));
        const message = screen.findHostByTestId('diagnostics.malformed_source.0.message');
        expect(message).not.toBeNull();
        expect(message?.props.selectable).toBe(true);
        // React Native defaults an unstyled top-level Text to black. This is the
        // reproduced visibility failure, not an assertion of a particular token.
        const foreground = StyleSheet.flatten(message?.props.style)?.color ?? '#000000';
        const foregroundLuminance = luminance(foreground);
        const backgroundLuminance = luminance(darkTheme.colors.surface.base);
        const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
            / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
});

describe('formatPluginUiDiagnosticMessage', () => {
    it('presents targeted contribution admission identities and reason', () => {
        expect(formatPluginUiDiagnosticMessage({
            code: 'point_absent',
            message: 'Targeted contribution admission rejected.',
            details: {
                target: { pluginId: 'happier.channels', pointId: 'providers' },
                contributor: { pluginId: 'acme.discord', contributionId: 'discord' },
                protocol: { id: 'happier.channels/providers', version: 1 },
                reason: 'point_absent',
            },
        })).toBe(
            'Targeted contribution admission rejected.\n'
            + 'acme.discord/discord → happier.channels/providers · happier.channels/providers@1 · point_absent',
        );
    });
});
