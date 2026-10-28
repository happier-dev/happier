import { describe, expect, it } from 'vitest';
import { resolveMobileBottomChromePresenter } from './resolveMobileBottomChromePresenter';

describe('resolveMobileBottomChromePresenter', () => {
    const supported = {
        platform: 'ios', bridgeAvailable: true, verticalBarEdge: 'trailing', enabled: true, deviceType: 'phone',
    } as const;

    it('uses the system rail on phones on either directional edge independently of chrome visibility', () => {
        expect(resolveMobileBottomChromePresenter(supported)).toBe('system');
        expect(resolveMobileBottomChromePresenter({
            ...supported, verticalBarEdge: 'leading',
        })).toBe('system');
    });

    it.each([
        { platform: 'android' }, { platform: 'web' }, { platform: 'macos' },
        { bridgeAvailable: false }, { verticalBarEdge: null }, { enabled: false },
        { deviceType: 'tablet' },
    ] satisfies Partial<Parameters<typeof resolveMobileBottomChromePresenter>[0]>[])('retains Happier chrome when disqualified by %j', (override) => {
        expect(resolveMobileBottomChromePresenter({ ...supported, ...override })).toBe('happier');
    });
});
