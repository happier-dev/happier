// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { buildLogIndexV1 } from '@happier-dev/forge-ci/runtime';
import { createWebListDomHarness } from '@/dev/testkit/legend/webListDomHarness';
import { NativeLogLines } from './MachineServiceLogs';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const boundary = await createUnistylesMock();
    return { ...boundary, StyleSheet: { ...boundary.StyleSheet, create: (input: unknown) => {
        // Model Unistyles 3's web create/removeInlineStyles boundary, including styles from this caller.
        const computed = (boundary.StyleSheet.create as (input: unknown) => Record<string, unknown>)(input);
        return Object.fromEntries(Object.entries(computed).map(([name, value]) => [name,
            value && typeof value === 'object' ? Object.defineProperties({ unistyles_test: {} },
                Object.fromEntries(Object.entries(value).map(([key, item]) => [key, { value: item, enumerable: false }]))) : value,
        ]));
    } } };
});

describe('native log page web viewport', () => {
    const harness = createWebListDomHarness({
        // Legend cell → focus-retention wrapper → RNW LogLine View, as on the service page.
        rowSelector: '[data-testid="log-viewport"] .legend-list-content-container > div > div > div > div',
        rowHeight: 26,
        height: HAPPIER_PAGE_METRICS.readingClipHeightPx,
    });

    it('keeps the real NativeLogLines caller bounded and padded inside an auto-height page section', async () => {
        const index = buildLogIndexV1({ sourceKey: 'service-log', positionBasis: 'page', log: {
            logId: 'service-log', startLine: 1, startByte: 0, complete: true, continuation: null,
            text: Array.from({ length: 74 }, (_, i) => `service output ${i}`).join('\n'),
        } });
        await act(async () => harness.root.render(
            <div style={{ display: 'flex', flexDirection: 'column' }}>
                <NativeLogLines testID="log-viewport" lines={index.lines} getLineRanges={() => []} revealedLine={null} />
            </div>,
        ));
        await harness.flush();
        const viewport = harness.container.querySelector<HTMLElement>('[data-testid="log-viewport"]')!;
        expect(window.getComputedStyle(viewport).maxHeight).toBe(`${HAPPIER_PAGE_METRICS.readingClipHeightPx}px`);
        const content = viewport.querySelector<HTMLElement>('.legend-list-content-container')!;
        expect(Number.parseFloat(window.getComputedStyle(content).paddingTop)).toBeGreaterThan(0);
        expect(Number.parseFloat(window.getComputedStyle(content).paddingBottom)).toBeGreaterThan(0);
    });
});
