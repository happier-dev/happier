// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { HappierSelectionTiles } from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

installWebLayoutBridge();

const options = [
    { id: 'phone', title: 'Add a phone', subtitle: 'Show a QR code' },
    { id: 'home', title: 'Add another Home', subtitle: 'Connect to a different Home' },
    { id: 'scan', title: 'Scan QR code', subtitle: 'Use a code from another device' },
] as const;

it.each([
    { width: 390, column: 358, stacked: true },
    { width: 1440, column: 672, stacked: false },
    { width: 1440, column: 358, stacked: true },
])('lands Devices options on their final tracks in a $column px column ($width px window)', async ({ width, column, stacked }) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const viewport = { width, height: 844 };
    try {
        await act(async () => root.render(
            <View style={{ width: column }}>
                <HappierSelectionTiles
                    variant="action"
                    accessibilityLabel="Devices"
                    listPresentation="page"
                    columnWidthPx={column}
                    theme={projectPluginUiTheme(lightTheme)}
                    options={options}
                    testIdPrefix="devices"
                    onPress={() => {}}
                    colors={{
                        tileBackground: 'white', tileBorder: 'gray', selection: 'black', glyph: 'black',
                        ring: 'black', previewBackground: 'white', actionBackground: 'white', actionBorderHovered: 'black',
                    }}
                    renderGlyph={() => null}
                    renderText={({ text }) => <Text>{text}</Text>}
                />
                <View testID="following-section" style={{ height: 20 }} />
            </View>,
        ));
        const first = await measureWebLayout(host, { viewport });
        const settled = await measureWebLayout(host, { viewport, settle: replay => act(replay) });
        for (const id of [...options.map(option => `devices:${option.id}`), 'following-section']) {
            expect(settled.rect(id).top, id).toBe(first.rect(id).top);
            expect(Math.abs(settled.rect(id).left - first.rect(id).left), id).toBeLessThan(1);
        }
        const phone = first.rect('devices:phone');
        const home = first.rect('devices:home');
        if (stacked) {
            expect(home.top).toBeGreaterThanOrEqual(phone.bottom);
            expect(home.left).toBe(phone.left);
        } else {
            expect(home.top).toBe(phone.top);
            expect(home.left).toBeGreaterThanOrEqual(phone.right);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
