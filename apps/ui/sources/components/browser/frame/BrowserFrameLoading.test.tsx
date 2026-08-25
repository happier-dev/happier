import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('BrowserFrameLoading', () => {
    it('presents its visible loading text as a polite live status across browser and native targets', async () => {
        const { BrowserFrameLoading } = await import('./BrowserFrameLoading');
        const screen = await renderScreen(<BrowserFrameLoading testID="browser-frame" />);

        expect(screen.findByTestId('browser-frame-loading')?.props).toMatchObject({
            accessibilityRole: 'text',
            accessibilityLiveRegion: 'polite',
            role: 'status',
            'aria-live': 'polite',
        });
        expect(screen.getTextContent()).toContain('common.loading');
    });

    it('names the host it is loading when the caller knows it', async () => {
        const { BrowserFrameLoading } = await import('./BrowserFrameLoading');
        const screen = await renderScreen(
            <BrowserFrameLoading testID="browser-frame" host="preview.happier.test" />,
        );

        // First paint says WHAT is loading; the spinner already says that it is loading. The host is
        // rendered verbatim rather than wrapped in a sentence, so it needs no translated string.
        expect(screen.getTextContent()).toContain('preview.happier.test');
        expect(screen.getTextContent()).not.toContain('common.loading');
    });
});
