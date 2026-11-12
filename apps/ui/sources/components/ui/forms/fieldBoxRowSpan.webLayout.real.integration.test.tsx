// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Text, View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

/**
 * A row-spanning select field in the room its row gives it (FIN-QA-LARGETEXT F5: a loop's item picker,
 * 55 px between its step arrows at large text, drew 132 px wide over the next arrow and past the screen).
 */
it('keeps a row-spanning field inside its row, however narrow the row is', async () => {
    const { HappierFieldBoxTrigger } = await import('@happier-dev/plugin-ui/presentation');
    const { resolveFieldBoxColors } = await import('./fieldBox');
    const theme = createThemeFixture();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
        <View style={{ flexDirection: 'row', width: 120 }}>
            <View testID="previous" style={{ width: 32, height: 32 }} />
            <View testID="slot" style={{ flex: 1, minWidth: 0 }}>
                <View testID="field">
                    <HappierFieldBoxTrigger colors={resolveFieldBoxColors(theme)} span="row"
                        trailing={<View style={{ width: 16, height: 16 }} />}>
                        <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>north</Text>
                    </HappierFieldBoxTrigger>
                </View>
            </View>
            <View testID="next" style={{ width: 32, height: 32 }} />
        </View>,
    ));
    const layout = await measureWebLayout(host, { viewport: { width: 400, height: 200 }, settle: replay => act(replay) });
    const slot = layout.rect('slot');
    expect(layout.rect('field').scrollWidth ?? 0).toBeLessThanOrEqual(Math.ceil(slot.width));
    expect(layout.rect('field').right).toBeLessThanOrEqual(layout.rect('next').left + 0.5);
});
