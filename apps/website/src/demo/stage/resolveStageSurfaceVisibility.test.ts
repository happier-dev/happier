import { describe, expect, it } from 'vitest';
import { resolveStageSurfaceVisibility } from './resolveStageSurfaceVisibility';

describe('website demo stage surface visibility', () => {
    it('keeps the remote-launch terminal hidden until the attach beat', () => {
        expect(
            resolveStageSurfaceVisibility({
                layout: 'terminal-phone-desktop',
                visibleSurfaces: ['phone-new-session', 'desktop-new-session'],
                phoneView: 'phone-new-session',
                desktopView: 'desktop-session',
            }),
        ).toMatchObject({
            showTerminal: false,
            showPhone: true,
            showDesktop: true,
            resolvedDesktopView: 'desktop-new-session',
        });

        expect(
            resolveStageSurfaceVisibility({
                layout: 'terminal-phone-desktop',
                visibleSurfaces: ['terminal', 'phone-session', 'desktop-session'],
                phoneView: 'phone-new-session',
                desktopView: 'desktop-session',
            }),
        ).toMatchObject({
            showTerminal: true,
            showPhone: true,
            showDesktop: true,
            resolvedPhoneView: 'phone-session',
        });
    });

    it('allows direct sessions to render outside-Happier terminal proof beside browse UI', () => {
        expect(
            resolveStageSurfaceVisibility({
                layout: 'terminal-phone-desktop',
                visibleSurfaces: ['terminal', 'direct-browse', 'phone-session'],
                phoneView: 'phone-session',
                desktopView: 'direct-browse',
            }),
        ).toMatchObject({
            showTerminal: true,
            showPhone: true,
            showDesktop: true,
            resolvedDesktopView: 'direct-browse',
        });
    });
});
