import { describe, expect, it } from 'vitest';

import { resolveExpoReleaseChannel } from './expoConstantsReleaseChannel';

describe('resolveExpoReleaseChannel', () => {
    it('prefers explicit updates releaseChannel when present', () => {
        expect(
            resolveExpoReleaseChannel({
                updatesReleaseChannel: 'preview',
                updatesChannel: 'preview-channel',
            }),
        ).toBe('preview');
    });

    it('falls back to updates channel when releaseChannel is missing', () => {
        expect(
            resolveExpoReleaseChannel({
                updatesReleaseChannel: null,
                updatesChannel: 'stable',
            }),
        ).toBe('stable');
    });

    it('falls back to manifest and expoConfig release channels', () => {
        expect(
            resolveExpoReleaseChannel({
                updatesReleaseChannel: null,
                updatesChannel: null,
                manifestReleaseChannel: 'manifest-preview',
                expoConfigReleaseChannel: 'expo-preview',
            }),
        ).toBe('manifest-preview');

        expect(
            resolveExpoReleaseChannel({
                updatesReleaseChannel: null,
                updatesChannel: null,
                manifestReleaseChannel: null,
                expoConfigReleaseChannel: 'expo-preview',
            }),
        ).toBe('expo-preview');
    });

    it('returns null when no channel can be resolved', () => {
        expect(
            resolveExpoReleaseChannel({
                updatesReleaseChannel: null,
                updatesChannel: null,
                manifestReleaseChannel: null,
                expoConfigReleaseChannel: null,
            }),
        ).toBeNull();
    });
});
