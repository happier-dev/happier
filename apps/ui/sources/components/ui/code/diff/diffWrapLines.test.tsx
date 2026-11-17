import * as React from 'react';
import { Dimensions } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import * as presentation from './diffPresentationStyle';

describe('effective diff wrapping', () => {
    it('keeps phone code readable while preserving the wider-pane preference', async () => {
        function Harness() {
            const wrap = presentation.useEffectiveDiffWrapLines(false);
            return <output>{String(wrap)}</output>;
        }
        const phone = await renderScreen(<SurfaceStateSizeProvider size="phone"><Harness /></SurfaceStateSizeProvider>);
        expect(phone.getTextContent()).toBe('true');
        const pane = await renderScreen(<SurfaceStateSizeProvider size="pane"><Harness /></SurfaceStateSizeProvider>);
        expect(pane.getTextContent()).toBe('false');
    });

    it('wraps on a phone screen whose container declares no size (a transcript tool card, an approval card)', async () => {
        function Harness() {
            const wrap = presentation.useEffectiveDiffWrapLines(false);
            return <output>{String(wrap)}</output>;
        }
        // The window is the platform boundary that makes the screen a phone.
        const window = vi.spyOn(Dimensions, 'get');
        try {
            window.mockReturnValue({ width: 390, height: 844, scale: 2, fontScale: 1 });
            expect((await renderScreen(<Harness />)).getTextContent()).toBe('true');
            window.mockReturnValue({ width: 1440, height: 1000, scale: 2, fontScale: 1 });
            expect((await renderScreen(<Harness />)).getTextContent()).toBe('false');
        } finally { window.mockRestore(); }
    });
});
