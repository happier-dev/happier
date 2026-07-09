import { describe, expect, it } from 'vitest';

import {
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
