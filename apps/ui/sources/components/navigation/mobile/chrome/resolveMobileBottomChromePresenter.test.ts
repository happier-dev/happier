import { describe, expect, it } from 'vitest';
import { resolveMobileBottomChromePresenter } from './resolveMobileBottomChromePresenter';

describe('resolveMobileBottomChromePresenter', () => {
    const supported = {
        platform: 'ios', bridgeAvailable: true, verticalBarEdge: 'trailing', enabled: true, deviceType: 'phone',
    } as const;

    it('selects the rail independently of route and keyboard visibility on either directional edge', () => {
        expect(resolveMobileBottomChromePresenter(supported)).toBe('system');
        expect(resolveMobileBottomChromePresenter({ ...supported, verticalBarEdge: 'leading' })).toBe('system');
    });

    it.each([
        { platform: 'android' }, { platform: 'web' }, { platform: 'macos' },
        { bridgeAvailable: false }, { verticalBarEdge: null }, { enabled: false }, { deviceType: 'tablet' },
    ] satisfies Partial<Parameters<typeof resolveMobileBottomChromePresenter>[0]>[])('keeps Happier chrome for %j', override => {
        expect(resolveMobileBottomChromePresenter({ ...supported, ...override })).toBe('happier');
    });
});
