// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ScrollView, View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { ReviewCommentInlineComposer } from '@/components/ui/code/reviewComments/ReviewCommentInlineComposer';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { FileChangesBody } from './FileChangesRegions';
import type { FileChangesReview } from './useFileChangesReview';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Device classification is a platform boundary; the browser measures a phone viewport below.
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useDeviceType: () => 'phone' as const,
}));

const noop = () => {};

it.each([0, 84])('keeps the last inline comment actions above the review bar with %i px of bottom chrome', async (chromeHeight) => {
    installWebLayoutBridge();
    // Presentation input: no review operations run in this geometry regression.
    const review = {
        status: 'ready', unifiedDiff: '@@ -1 +1 @@\n-before\n+after\n',
        reviewUnits: [], hunks: {}, keyboard: {},
        controller: {
            strip: { current: 1, total: 1, fileComplete: false },
            previous: noop, next: noop, keepCurrentAndAdvance: noop, discardCurrent: noop,
            followReadingLine: noop, currentHunk: null,
        },
    } as unknown as FileChangesReview;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <SessionCockpitBottomChromeHeightContext.Provider value={chromeHeight}>
                <View style={{ height: 844 }}>
                    <FileChangesBody review={review} keyboardActive={false}>
                        {() => (
                            <ScrollView testID="diff-scroll" style={{ flex: 1, minHeight: 0 }}>
                                <View style={{ height: 1200 }} />
                                <ReviewCommentInlineComposer value="Please review this line" onChange={noop} onSave={noop} onCancel={noop} />
                            </ScrollView>
                        )}
                    </FileChangesBody>
                </View>
            </SessionCockpitBottomChromeHeightContext.Provider>,
        ));
        // Focusing the last control uses the browser's normal scroll-to-end behavior, without
        // compensating for the review bar or inventing extra scroll space in the test.
        const layout = await measureWebLayout(host, {
            viewport: { width: 390, height: 844 },
            focusedTestId: 'review-comment-composer-save',
            settle: (replay) => act(replay),
        });
        const barTop = Math.min(layout.rect('review-bar-discard').top, layout.rect('review-bar-keep').top);
        for (const id of ['review-comment-composer-save', 'review-comment-composer-cancel']) {
            const button = layout.rect(id);
            expect.soft(button.bottom, `${id} must clear the review actions`).toBeLessThanOrEqual(barTop);
            expect.soft(button.receivesPointer, `${id} must receive its own centre tap`).toBe(true);
        }
        expect(layout.rect('review-bar-keep').receivesPointer).toBe(true);
        expect(layout.rect('review-bar-keep').bottom).toBeLessThanOrEqual(844 - chromeHeight);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
