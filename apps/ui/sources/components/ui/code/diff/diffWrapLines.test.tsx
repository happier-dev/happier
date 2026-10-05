import * as React from 'react';
import { describe, expect, it } from 'vitest';
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
});
