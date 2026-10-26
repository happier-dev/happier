import { describe, expect, it } from 'vitest';
import { resolveMobileBottomChromePresenter } from './resolveMobileBottomChromePresenter';

describe('resolveMobileBottomChromePresenter', () => {
    const supported = {
        platform: 'ios', bridgeAvailable: true, verticalBarEdge: 'trailing', enabled: true,
        model: { kind: 'mainAppTabs', activeTab: 'sessions' },
    } as const;

    it('uses the system rail for main and cockpit tabs on either directional edge', () => {
        expect(resolveMobileBottomChromePresenter(supported)).toBe('system');
        expect(resolveMobileBottomChromePresenter({
            ...supported, verticalBarEdge: 'leading',
            model: { kind: 'sessionCockpit', sessionId: 'session', surface: 'chat', terminalTabAvailable: false },
        })).toBe('system');
    });

    it.each([
        { platform: 'android' }, { platform: 'web' }, { platform: 'macos' },
        { bridgeAvailable: false }, { verticalBarEdge: null }, { enabled: false },
        { model: { kind: 'hidden' } as const },
    ])('retains Happier chrome when disqualified by %j', (override) => {
        expect(resolveMobileBottomChromePresenter({ ...supported, ...override })).toBe('happier');
    });
});
