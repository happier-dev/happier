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
});
