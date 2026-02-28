import { afterEach, describe, expect, it, vi } from 'vitest';

import { isWebMobileLikeQrScannerHost } from './webMobileHeuristics';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isWebMobileLikeQrScannerHost', () => {
    it('treats touch-enabled fine-pointer desktops as not mobile-like', () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: query.includes('pointer: fine') }),
        } as any);

        expect(isWebMobileLikeQrScannerHost({ width: 360, height: 800 })).toBe(false);
    });
});
