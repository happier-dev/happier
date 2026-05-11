import * as React from 'react';
import Constants from 'expo-constants';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commitRemoteManifest, getCurrentReleaseId, resetManifestRuntimeCacheForTests } from '@/changelog/releaseNotes/manifestRuntime';
import { clearCachedManifest, clearLastSeenReleaseId, getLastSeenReleaseId } from '@/changelog/releaseNotes/storage';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { ONBOARDING_SHOWCASE_MANIFEST } from './manifest';
import { clearShowcaseSeenVersion, getShowcaseSeenVersion } from './storage';

type ShowcaseModalProps = Readonly<{
    onComplete?: () => void;
    onDismiss?: () => void;
}>;

type ShowcaseModalConfig = Readonly<{
    onRequestClose?: () => void;
    props?: ShowcaseModalProps;
}>;

const authState = vi.hoisted(() => ({
    isAuthenticated: true,
    credentials: { token: 'token', secret: 'secret' } as unknown,
}));

const setupIntentState = vi.hoisted(() => ({
    pending: null as null | { phase: 'awaiting_auth' | 'post_auth' | 'dismissed' },
}));

const modalState = vi.hoisted(() => ({
    activeCount: 0,
    lastConfig: null as ShowcaseModalConfig | null,
    lastProps: null as ShowcaseModalProps | null,
    show: vi.fn((config: ShowcaseModalConfig) => {
        modalState.lastConfig = config;
        modalState.lastProps = config.props ?? null;
        return 'onboarding-showcase-modal';
    }),
    hide: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => setupIntentState.pending,
}));

vi.mock('@/modal', () => ({
    useModal: () => ({
        state: {
            modals: Array.from({ length: modalState.activeCount }, (_, index) => ({ id: `modal-${index}` })),
        },
    }),
    Modal: {
        show: modalState.show,
        hide: modalState.hide,
    },
}));

vi.mock('@/components/onboarding/showcase', () => ({
    OnboardingShowcaseStorySurface: 'OnboardingShowcaseStorySurface',
}));

describe('OnboardingShowcaseAutoShowMount', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        (Constants as { expoConfig?: { version?: string } }).expoConfig = { version: '0.0.0' };
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'app.ui.onboardingShowcase';
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
        clearShowcaseSeenVersion();
        clearLastSeenReleaseId();
        clearCachedManifest();
        resetManifestRuntimeCacheForTests();
        authState.isAuthenticated = true;
        authState.credentials = { token: 'token', secret: 'secret' };
        setupIntentState.pending = null;
        modalState.activeCount = 0;
        modalState.lastConfig = null;
        modalState.lastProps = null;
        modalState.show.mockClear();
        modalState.hide.mockClear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        clearLastSeenReleaseId();
        clearCachedManifest();
        resetManifestRuntimeCacheForTests();
        process.env = { ...originalEnv };
    });

    async function getMountComponent(): Promise<React.ComponentType> {
        return ((await import('./index')) as unknown as {
            OnboardingShowcaseAutoShowMount?: React.ComponentType;
        }).OnboardingShowcaseAutoShowMount ?? (() => null);
    }

    it('shows the onboarding showcase once on first app open, even before auth resolves', async () => {
        authState.isAuthenticated = false;
        authState.credentials = null;

        const OnboardingShowcaseAutoShowMount = await getMountComponent();
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).toHaveBeenCalledTimes(1);

        await act(async () => {
            modalState.lastProps?.onComplete?.();
        });
        expect(getShowcaseSeenVersion()).toBe(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);

        await screen.update(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).toHaveBeenCalledTimes(1);
    });


    it('marks the showcase seen when dismissed through the modal backdrop', async () => {
        authState.isAuthenticated = false;
        authState.credentials = null;

        const OnboardingShowcaseAutoShowMount = await getMountComponent();
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).toHaveBeenCalledTimes(1);

        await act(async () => {
            modalState.lastConfig?.onRequestClose?.();
        });
        expect(getShowcaseSeenVersion()).toBe(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);

        await screen.update(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).toHaveBeenCalledTimes(1);
    });

    it('does not wait for post-auth setup intent resolution before showing the first-open showcase', async () => {
        authState.isAuthenticated = false;
        authState.credentials = null;
        setupIntentState.pending = { phase: 'post_auth' };

        const OnboardingShowcaseAutoShowMount = await getMountComponent();
        await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).toHaveBeenCalledTimes(1);
    });

    it('marks current release notes seen when the first-open showcase is completed', async () => {
        authState.isAuthenticated = false;
        authState.credentials = null;
        const releaseId = getCurrentReleaseId() ?? 'v0.0.0';
        commitRemoteManifest(JSON.stringify({
            schemaVersion: 'v1',
            latestReleaseId: releaseId,
            generatedAt: '2026-05-10T00:00:00.000Z',
            assetBaseUrl: 'https://cdn.example/release-notes/',
            releases: [{
                releaseId,
                versionLabel: releaseId,
                publishedAt: '2026-05-10T00:00:00.000Z',
                titleKey: 'releaseNotes.test.title',
                cards: [{
                    kind: 'list',
                    titleKey: 'releaseNotes.test.card.title',
                    rows: [{
                        iconId: 'sparkles',
                        titleKey: 'releaseNotes.test.card.rowTitle',
                        bodyKey: 'releaseNotes.test.card.rowBody',
                    }],
                }],
            }],
        }));

        const OnboardingShowcaseAutoShowMount = await getMountComponent();
        await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(getLastSeenReleaseId()).toBeNull();

        await act(async () => {
            modalState.lastProps?.onComplete?.();
        });

        expect(getShowcaseSeenVersion()).toBe(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);
        expect(getLastSeenReleaseId()).toBe(releaseId);
    });

    it('marks the showcase seen without displaying it when the user is already authenticated', async () => {
        authState.isAuthenticated = true;
        authState.credentials = { token: 'token', secret: 'secret' };

        const OnboardingShowcaseAutoShowMount = await getMountComponent();
        await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).not.toHaveBeenCalled();
        expect(getShowcaseSeenVersion()).toBe(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);
    });

    it('does not show when the onboarding showcase feature is denied', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.onboardingShowcase';

        const OnboardingShowcaseAutoShowMount = await getMountComponent();
        await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).not.toHaveBeenCalled();
    });

    it('does not show without an explicit onboarding showcase allow', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = '';
        authState.isAuthenticated = false;
        authState.credentials = null;

        const OnboardingShowcaseAutoShowMount = await getMountComponent();
        await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).not.toHaveBeenCalled();
    });

    it('waits while another app modal owns the top-level flow', async () => {
        authState.isAuthenticated = false;
        authState.credentials = null;
        modalState.activeCount = 1;

        const OnboardingShowcaseAutoShowMount = await getMountComponent();
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).not.toHaveBeenCalled();

        modalState.activeCount = 0;
        await screen.update(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).toHaveBeenCalledTimes(1);
    });
});
