// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

const NAME = 'NLDW4-5-40-40 is short on memory';

/**
 * A narrow Inbox row in a phone sheet at a large text size (FIN-QA-LARGETEXT F9): beside its mark and ⋯ the
 * title had 42 px, so a Machine name broke inside the word and stopped at two lines.
 */
it.each([[161, true], [420, false]] as const)('gives a %spx row\'s title its readable width (stacked: %s)', async (width, stacked) => {
    // The app loads the transcript registry before the Work row (the test unistyles mock creates styles eagerly).
    await import('@/components/sessions/transcript/structured/structuredMessageRegistry');
    const { InboxWorkRow } = await import('./InboxWorkRow');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
        <View testID="sheet" style={{ width }}>
            <InboxWorkRow testID="row" title={NAME} facts={['Memory']} narrow onPress={() => {}}
                mark={<View testID="mark" style={{ width: 18, height: 18 }} />}
                trailingAccessory={<View testID="more" style={{ width: 28, height: 28 }} />} />
        </View>,
    ));
    const layout = await measureWebLayout(host, { viewport: { width: 480, height: 400 }, settle: replay => act(replay) });
    const sheet = layout.rect('sheet');
    const title = layout.rect('row.summary:title');
    const more = layout.rect('more');
    expect(title.clipped ?? false).toBe(false);
    expect(more.right).toBeLessThanOrEqual(sheet.right + 0.5);
    if (stacked) {
        // The name runs under the mark at the row's width, and the ⋯ closes the mark's line above it.
        expect(title.top).toBeGreaterThanOrEqual(layout.rect('mark').bottom - 0.5);
        expect(title.width).toBeGreaterThan(width / 2);
        expect(more.bottom).toBeLessThanOrEqual(title.top + 0.5);
    } else {
        // A row with room keeps the mark, the name and the ⋯ on one line.
        expect(title.left).toBeGreaterThanOrEqual(layout.rect('mark').right);
        expect(title.right).toBeLessThanOrEqual(more.left);
    }
});
