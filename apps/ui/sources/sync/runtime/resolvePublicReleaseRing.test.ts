import { describe, expect, it } from 'vitest';

import { resolvePreferredPublicReleaseRingIdForApp, resolvePreferredPublicReleaseRingLabelForApp } from './resolvePublicReleaseRing';

describe('resolvePreferredPublicReleaseRingIdForApp', () => {
    it('maps the publicdev variant to the publicdev ring', () => {
        expect(resolvePreferredPublicReleaseRingIdForApp({
            variant: 'publicdev',
            envAppEnv: 'development',
            envExpoPublicAppEnv: 'development',
        })).toBe('publicdev');
    });

    it('maps the preview variant to the preview ring', () => {
        expect(resolvePreferredPublicReleaseRingIdForApp({
            variant: 'preview',
            envAppEnv: 'development',
            envExpoPublicAppEnv: 'development',
        })).toBe('preview');
    });

    it('falls back to stable in production-like app variants', () => {
        expect(resolvePreferredPublicReleaseRingIdForApp({
            variant: null,
            envAppEnv: 'production',
            envExpoPublicAppEnv: 'production',
        })).toBe('stable');
    });

    it('prefers env APP_ENV release ring ids when variant is missing', () => {
        expect(resolvePreferredPublicReleaseRingIdForApp({
            variant: null,
            envAppEnv: 'publicdev',
            envExpoPublicAppEnv: 'publicdev',
        })).toBe('publicdev');
    });

    it('falls back to preview in non-production app variants', () => {
        expect(resolvePreferredPublicReleaseRingIdForApp({
            variant: null,
            envAppEnv: 'development',
            envExpoPublicAppEnv: 'development',
        })).toBe('preview');
    });
});

describe('resolvePreferredPublicReleaseRingLabelForApp', () => {
    it('maps the publicdev variant to the dev label', () => {
        expect(resolvePreferredPublicReleaseRingLabelForApp({
            variant: 'publicdev',
            envAppEnv: 'development',
            envExpoPublicAppEnv: 'development',
        })).toBe('dev');
    });

    it('maps the preview variant to the preview label', () => {
        expect(resolvePreferredPublicReleaseRingLabelForApp({
            variant: 'preview',
            envAppEnv: 'development',
            envExpoPublicAppEnv: 'development',
        })).toBe('preview');
    });

    it('falls back to stable label in production-like app variants', () => {
        expect(resolvePreferredPublicReleaseRingLabelForApp({
            variant: null,
            envAppEnv: 'production',
            envExpoPublicAppEnv: 'production',
        })).toBe('stable');
    });
});
