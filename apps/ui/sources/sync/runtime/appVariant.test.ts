import { describe, expect, it } from 'vitest';

import {
    resolveAppEnvironmentBadge,
    resolveAppVariant,
    resolveExpoReleaseChannel,
    resolveVisibleAppEnvironmentBadge,
} from './appVariant';

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

describe('resolveAppVariant', () => {
    it('prefers app variant over release channel and env fallbacks', () => {
        expect(
            resolveAppVariant({
                appVariant: 'preview',
                updatesChannel: 'production',
                envAppEnv: 'production',
            }),
        ).toBe('preview');
    });

    it('uses release channel when app variant is unavailable', () => {
        expect(
            resolveAppVariant({
                appVariant: null,
                updatesChannel: 'preview',
                envAppEnv: 'production',
            }),
        ).toBe('preview');
    });

    it('falls back to APP_ENV when app variant and release channel are unavailable', () => {
        expect(
            resolveAppVariant({
                appVariant: null,
                updatesChannel: null,
                envAppEnv: 'preview',
                envExpoPublicAppEnv: 'production',
            }),
        ).toBe('preview');
    });

    it('falls back to EXPO_PUBLIC_APP_ENV when APP_ENV is unavailable', () => {
        expect(
            resolveAppVariant({
                appVariant: null,
                updatesChannel: null,
                envAppEnv: null,
                envExpoPublicAppEnv: 'development',
            }),
        ).toBe('development');
    });

    it('returns null when no variant can be resolved', () => {
        expect(
            resolveAppVariant({
                appVariant: null,
                updatesChannel: null,
                envAppEnv: null,
                envExpoPublicAppEnv: null,
            }),
        ).toBeNull();
    });
});

describe('resolveAppEnvironmentBadge', () => {
    it('prefers stack context over all other signals', () => {
        expect(
            resolveAppEnvironmentBadge({
                appVariant: 'development',
                isStackContext: true,
                isUsingCustomServer: true,
            }),
        ).toBe('STACK');
    });

    it('uses self-host badge when running against a custom server', () => {
        expect(
            resolveAppEnvironmentBadge({
                appVariant: 'preview',
                isStackContext: false,
                isUsingCustomServer: true,
            }),
        ).toBe('SELF');
    });

    it('uses dev badge when variant resolves to development', () => {
        expect(
            resolveAppEnvironmentBadge({
                appVariant: 'development',
                isStackContext: false,
                isUsingCustomServer: false,
            }),
        ).toBe('DEV');
    });

    it('uses prev badge when variant resolves to preview', () => {
        expect(
            resolveAppEnvironmentBadge({
                appVariant: 'preview',
                isStackContext: false,
                isUsingCustomServer: false,
            }),
        ).toBe('PREV');
    });

    it('returns null for default production cloud environment', () => {
        expect(
            resolveAppEnvironmentBadge({
                appVariant: 'production',
                isStackContext: false,
                isUsingCustomServer: false,
            }),
        ).toBeNull();
    });
});

describe('resolveVisibleAppEnvironmentBadge', () => {
    it('returns null when user setting disables environment badges', () => {
        expect(
            resolveVisibleAppEnvironmentBadge({
                showEnvironmentBadge: false,
                appVariant: 'preview',
                isStackContext: false,
                isUsingCustomServer: false,
            }),
        ).toBeNull();
    });

    it('returns resolved badge when setting allows environment badges', () => {
        expect(
            resolveVisibleAppEnvironmentBadge({
                showEnvironmentBadge: true,
                appVariant: 'preview',
                isStackContext: false,
                isUsingCustomServer: false,
            }),
        ).toBe('PREV');
    });
});
