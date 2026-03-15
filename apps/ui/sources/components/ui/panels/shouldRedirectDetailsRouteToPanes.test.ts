import { describe, expect, it } from 'vitest';
import { shouldRedirectDetailsRouteToPanes } from './shouldRedirectDetailsRouteToPanes';

describe('shouldRedirectDetailsRouteToPanes', () => {
    it('returns true when multi-pane is enabled and the viewport can show details', () => {
        expect(shouldRedirectDetailsRouteToPanes({
            containerWidthPx: 1200,
            deviceType: 'tablet',
            multiPaneEnabled: true,
        })).toBe(true);
    });

    it('returns false when multi-pane is disabled', () => {
        expect(shouldRedirectDetailsRouteToPanes({
            containerWidthPx: 1400,
            deviceType: 'tablet',
            multiPaneEnabled: false,
        })).toBe(false);
    });

    it('returns false for phone device types', () => {
        expect(shouldRedirectDetailsRouteToPanes({
            containerWidthPx: 1600,
            deviceType: 'phone',
            multiPaneEnabled: true,
        })).toBe(false);
    });

    it('returns false for narrow viewports', () => {
        expect(shouldRedirectDetailsRouteToPanes({
            containerWidthPx: 800,
            deviceType: 'tablet',
            multiPaneEnabled: true,
        })).toBe(false);
    });
});
