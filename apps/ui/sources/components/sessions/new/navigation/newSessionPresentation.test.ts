import { describe, expect, it } from 'vitest';

import {
    isNewSessionFloatingComposerPresentation,
    resolveNewSessionRoutePresentation,
} from './newSessionPresentation';

describe('resolveNewSessionRoutePresentation', () => {
    it('presents the simple composer as a transparent modal on native so the app can paint its own backdrop', () => {
        // `transparentModal` (UIModalPresentationOverFullScreen) and `containedTransparentModal`
        // (OverCurrentContext) are the only presentations for which @react-navigation/native-stack
        // omits the opaque `contentStyle` background. The non-contained one is chosen deliberately:
        // see `isNewSessionFloatingComposerPresentation` below.
        expect(resolveNewSessionRoutePresentation({ variant: 'simple', platformOs: 'ios' }))
            .toBe('transparentModal');
        expect(resolveNewSessionRoutePresentation({ variant: 'simple', platformOs: 'android' }))
            .toBe('transparentModal');
    });

    it('never uses a CONTAINED transparent presentation, which would move the screen onto the popover anchor arbiter branch', () => {
        // `resolvePortalRelativeAnchorRect` exists because CONTAINED react-native-screens
        // presentations report `measureInWindow` coordinates that are already portal-relative.
        // `pageSheet` (today) and `transparentModal` are both top-level presentations, so the
        // composer's popovers keep taking the branch they take today. Regressing this to
        // `containedTransparentModal` would buy nothing visually and change that branch.
        for (const variant of ['simple', 'wizard'] as const) {
            for (const platformOs of ['ios', 'android', 'web'] as const) {
                expect(resolveNewSessionRoutePresentation({ variant, platformOs }))
                    .not.toBe('containedTransparentModal');
                expect(resolveNewSessionRoutePresentation({ variant, platformOs }))
                    .not.toBe('containedModal');
            }
        }
    });

    it('leaves the wizard variant on the native sheet it uses today', () => {
        expect(resolveNewSessionRoutePresentation({ variant: 'wizard', platformOs: 'ios' }))
            .toBe('pageSheet');
        expect(resolveNewSessionRoutePresentation({ variant: 'wizard', platformOs: 'android' }))
            .toBe('modal');
    });

    it('leaves web on the modal presentation that Expo Router renders as its Vaul drawer', () => {
        expect(resolveNewSessionRoutePresentation({ variant: 'simple', platformOs: 'web' }))
            .toBe('modal');
        expect(resolveNewSessionRoutePresentation({ variant: 'wizard', platformOs: 'web' }))
            .toBe('modal');
    });
});

describe('isNewSessionFloatingComposerPresentation', () => {
    it('is true only for the simple variant on native', () => {
        expect(isNewSessionFloatingComposerPresentation({ variant: 'simple', platformOs: 'ios' })).toBe(true);
        expect(isNewSessionFloatingComposerPresentation({ variant: 'simple', platformOs: 'android' })).toBe(true);
    });

    it('is false for the wizard, which keeps its sheet chrome and header', () => {
        expect(isNewSessionFloatingComposerPresentation({ variant: 'wizard', platformOs: 'ios' })).toBe(false);
        expect(isNewSessionFloatingComposerPresentation({ variant: 'wizard', platformOs: 'android' })).toBe(false);
    });

    it('is false on web, where the route stays inside Expo Router’s drawer', () => {
        expect(isNewSessionFloatingComposerPresentation({ variant: 'simple', platformOs: 'web' })).toBe(false);
        expect(isNewSessionFloatingComposerPresentation({ variant: 'wizard', platformOs: 'web' })).toBe(false);
    });

    it('agrees with the presentation resolver: the floating composer is exactly the transparent-modal case', () => {
        for (const variant of ['simple', 'wizard'] as const) {
            for (const platformOs of ['ios', 'android', 'web'] as const) {
                const isFloating = isNewSessionFloatingComposerPresentation({ variant, platformOs });
                const presentation = resolveNewSessionRoutePresentation({ variant, platformOs });
                expect(isFloating).toBe(presentation === 'transparentModal');
            }
        }
    });
});
