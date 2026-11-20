// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

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
    const { getStorage } = await import('@/sync/domains/state/storage');
    await act(async () => { getStorage().getState().applyLocalSettings({ uiFontScale: 1 }, { persist: false }); });
});

const TITLE = 'Fix settings modal remount when switching tabs between the editor and the preview';

/**
 * B1-LISTS-REVIEW-1120 F1: above a text size of 1.1 a work row's title may wrap to two lines (accessible wrapping);
 * its detail lines (lab ideas-1118-shell scene 7, Lines 2 and 3) start below the wrapped title, never over it. 1.3 is
 * the largest app text size (`UI_FONT_SCALE_PRESETS.xxlarge`); 1.5 is the review's case.
 */
it.each([
    [1.2, 1], [1.3, 1], [1.3, 2], [1.5, 1], [1.5, 2],
] as const)('starts the detail lines below a wrapped title at text size %s with %i detail line(s)', async (scale, lineCount) => {
    const { getStorage } = await import('@/sync/domains/state/storage');
    await act(async () => { getStorage().getState().applyLocalSettings({ uiFontScale: scale }, { persist: false }); });
    const { CollectionRowContent, CollectionRowLine, CollectionRowTitle } = await import('./CollectionRowContent');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const lines = Array.from({ length: lineCount }, (_, index) => ({
        key: `line-${index + 2}`,
        start: <CollectionRowLine testID={`line-${index + 2}`} density="compact" touchCompact textScale={scale}>Lift the draft into useSettingsDraft</CollectionRowLine>,
        end: <CollectionRowLine density="compact" touchCompact textScale={scale}>3/7</CollectionRowLine>,
    }));
    await act(async () => root!.render(
        <div style={{ width: 390 }}>
            <CollectionRowContent
                density="compact"
                touchCompact
                textScale={scale}
                identity={<div style={{ width: 16, height: 16 }} />}
                title={<CollectionRowTitle testID="title" density="compact" touchCompact textScale={scale}>{TITLE}</CollectionRowTitle>}
                lines={lines}
            />
        </div>,
    ));
    const layout = await measureWebLayout(host, { viewport: { width: 390, height: 600 }, settle: replay => act(replay) });
    const title = layout.rect('title');
    const first = layout.rect('line-2');
    expect(first.height).toBeGreaterThan(0);
    const { HAPPIER_COLLECTION_ROW_METRICS, resolveHappierCollectionRowLineMetrics } = await import('@happier-dev/plugin-ui/presentation');
    const { gap, minHeight } = HAPPIER_COLLECTION_ROW_METRICS.detailLine;
    const { lineHeight } = resolveHappierCollectionRowLineMetrics('compact', 'web', true);
    const bandHeight = Math.max(minHeight, Math.ceil(lineHeight * scale));
    const visualGap = first.top - title.bottom;
    expect(visualGap).toBeGreaterThanOrEqual(0);
    // The RNW fixture measures the text box inside its scaled, vertically centered detail band.
    // The first band's top must follow the wrapped title by exactly the shared gap.
    expect(visualGap - (bandHeight - first.height) / 2).toBeCloseTo(gap, 1);
});
