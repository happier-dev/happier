import { describe, expect, it } from 'vitest';

import {
    resolveMultiPaneDeviceType,
    resolvePluginUiRuntimeFormFactor,
} from './resolveMultiPaneDeviceType';

describe('resolveMultiPaneDeviceType', () => {
    it('keeps phone-sized web in the existing multi-pane overlay layout mode', () => {
        expect(resolveMultiPaneDeviceType({ platform: 'web', deviceType: 'phone' })).toBe('tablet');
        expect(resolveMultiPaneDeviceType({ platform: 'web', deviceType: 'tablet' })).toBe('tablet');
    });

    it('keeps device type on native platforms', () => {
        expect(resolveMultiPaneDeviceType({ platform: 'ios', deviceType: 'phone' })).toBe('phone');
        expect(resolveMultiPaneDeviceType({ platform: 'android', deviceType: 'tablet' })).toBe('tablet');
    });

    it('preserves the observed form factor for plugin destination admission', () => {
        expect(resolvePluginUiRuntimeFormFactor({ deviceType: 'phone' })).toBe('phone');
        expect(resolvePluginUiRuntimeFormFactor({ deviceType: 'tablet' })).toBe('tablet');
    });
});
