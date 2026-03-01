import { describe, expect, it } from 'vitest';

import { resolveMultiPaneDeviceType } from './resolveMultiPaneDeviceType';

describe('resolveMultiPaneDeviceType', () => {
    it('forces tablet on web so multi-pane can use overlays', () => {
        expect(resolveMultiPaneDeviceType({ platform: 'web', deviceType: 'phone' })).toBe('tablet');
        expect(resolveMultiPaneDeviceType({ platform: 'web', deviceType: 'tablet' })).toBe('tablet');
    });

    it('keeps device type on native platforms', () => {
        expect(resolveMultiPaneDeviceType({ platform: 'ios', deviceType: 'phone' })).toBe('phone');
        expect(resolveMultiPaneDeviceType({ platform: 'android', deviceType: 'tablet' })).toBe('tablet');
    });
});
