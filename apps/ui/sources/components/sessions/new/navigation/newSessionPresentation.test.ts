import { describe, expect, it } from 'vitest';

import {
    isNewSessionFloatingComposerPresentation,
    resolveNewSessionPickerRoutePresentation,
    resolveNewSessionSecretRequirementRoutePresentation,
    resolveNewSessionRoutePresentation,
    resolveNewSessionShouldBottomAnchor,
} from './newSessionPresentation';

describe('new session route presentation', () => {
    it('preserves the deployed automatic modal presentation by platform', () => {
        expect(resolveNewSessionRoutePresentation({ mode: 'auto', platformOs: 'ios' })).toBe('containedModal');
        expect(resolveNewSessionRoutePresentation({ mode: 'auto', platformOs: 'web' })).toBe('modal');
    });

    it('allows users to force screen or modal route presentation', () => {
        expect(resolveNewSessionRoutePresentation({ mode: 'screen', platformOs: 'ios' })).toBeUndefined();
        expect(resolveNewSessionRoutePresentation({ mode: 'modal', platformOs: 'web' })).toBe('modal');
        expect(resolveNewSessionRoutePresentation({ mode: 'modal', platformOs: 'ios' })).toBe('containedModal');
    });

    it('keeps the secret requirement route aligned with the selected presentation mode', () => {
        expect(resolveNewSessionSecretRequirementRoutePresentation({ mode: 'screen', platformOs: 'ios' })).toBeUndefined();
        expect(resolveNewSessionSecretRequirementRoutePresentation({ mode: 'screen', platformOs: 'web' })).toBeUndefined();
        expect(resolveNewSessionSecretRequirementRoutePresentation({ mode: 'modal', platformOs: 'ios' })).toBe('containedTransparentModal');
        expect(resolveNewSessionSecretRequirementRoutePresentation({ mode: 'modal', platformOs: 'web' })).toBe('modal');
        expect(resolveNewSessionSecretRequirementRoutePresentation({ mode: 'auto', platformOs: 'ios' })).toBe('containedTransparentModal');
        expect(resolveNewSessionSecretRequirementRoutePresentation({ mode: 'auto', platformOs: 'web' })).toBe('modal');
    });

    it('bottom-anchors wide layouts only when the route is rendered as a screen', () => {
        expect(resolveNewSessionShouldBottomAnchor({
            mode: 'screen',
            platformOs: 'web',
            isMobileLayoutWidth: false,
        })).toBe(true);
        expect(resolveNewSessionShouldBottomAnchor({
            mode: 'auto',
            platformOs: 'web',
            isMobileLayoutWidth: false,
        })).toBe(false);
        expect(resolveNewSessionShouldBottomAnchor({
            mode: 'modal',
            platformOs: 'web',
            isMobileLayoutWidth: false,
        })).toBe(false);
        expect(resolveNewSessionShouldBottomAnchor({
            mode: 'modal',
            platformOs: 'web',
            isMobileLayoutWidth: true,
        })).toBe(true);
    });

    it('presents the simple composer transparently on native so the screen can paint its own backdrop', () => {
        // `transparentModal` (UIModalPresentationOverFullScreen) is one of only two presentations
        // for which @react-navigation/native-stack omits the opaque `contentStyle` background —
        // the precondition for an app-painted backdrop.
        expect(resolveNewSessionRoutePresentation({ mode: 'auto', variant: 'simple', platformOs: 'ios' }))
            .toBe('transparentModal');
        expect(resolveNewSessionRoutePresentation({ mode: 'modal', variant: 'simple', platformOs: 'android' }))
            .toBe('transparentModal');
    });

    it('never picks a CONTAINED transparent presentation, which reports portal-relative anchors', () => {
        // `resolvePortalRelativeAnchorRect` exists because CONTAINED react-native-screens
        // presentations report `measureInWindow` coordinates that are already portal-relative.
        // `transparentModal` is top-level, so `/new` moves OFF that quirk rather than onto it.
        for (const variant of ['simple', 'wizard'] as const) {
            for (const platformOs of ['ios', 'android', 'web'] as const) {
                for (const mode of ['auto', 'modal', 'screen'] as const) {
                    expect(resolveNewSessionRoutePresentation({ mode, variant, platformOs }))
                        .not.toBe('containedTransparentModal');
                }
            }
        }
    });

    it('keeps the wizard variant on the sheet presentation it uses today', () => {
        expect(resolveNewSessionRoutePresentation({ mode: 'auto', variant: 'wizard', platformOs: 'ios' }))
            .toBe('containedModal');
        expect(resolveNewSessionRoutePresentation({ mode: 'auto', variant: 'wizard', platformOs: 'android' }))
            .toBe('modal');
    });

    it('keeps web on the modal presentation Expo Router renders as its own drawer', () => {
        expect(resolveNewSessionRoutePresentation({ mode: 'auto', variant: 'simple', platformOs: 'web' }))
            .toBe('modal');
    });

    it('honours a forced screen presentation over the floating composer', () => {
        // `screen` means "no modal at all"; there is nothing for a transparent modal to float over.
        expect(resolveNewSessionRoutePresentation({ mode: 'screen', variant: 'simple', platformOs: 'ios' }))
            .toBeUndefined();
        expect(isNewSessionFloatingComposerPresentation({ mode: 'screen', variant: 'simple', platformOs: 'ios' }))
            .toBe(false);
    });

    it('leaves the picker sub-routes on the sheet presentation regardless of the composer variant', () => {
        // The pickers push ON TOP of `/new`; a transparent picker would show the composer through it.
        expect(resolveNewSessionPickerRoutePresentation({ mode: 'auto', platformOs: 'ios' })).toBe('containedModal');
        expect(resolveNewSessionPickerRoutePresentation({ mode: 'auto', platformOs: 'android' })).toBe('modal');
    });

    it('agrees with the presentation resolver: floating is exactly the transparent-modal case', () => {
        for (const variant of ['simple', 'wizard'] as const) {
            for (const platformOs of ['ios', 'android', 'web'] as const) {
                for (const mode of ['auto', 'modal', 'screen'] as const) {
                    expect(isNewSessionFloatingComposerPresentation({ mode, variant, platformOs }))
                        .toBe(resolveNewSessionRoutePresentation({ mode, variant, platformOs }) === 'transparentModal');
                }
            }
        }
    });

    it('bottom-anchors forced screen presentation independent of platform name', () => {
        expect(resolveNewSessionShouldBottomAnchor({
            mode: 'screen',
            platformOs: 'ios',
            isMobileLayoutWidth: false,
        })).toBe(true);
        expect(resolveNewSessionShouldBottomAnchor({
            mode: 'screen',
            platformOs: 'desktop',
            isMobileLayoutWidth: false,
        })).toBe(true);
    });
});
