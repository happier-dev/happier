import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

type ShowcaseModalProps = Readonly<{
    onComplete?: () => void;
    onDismiss?: () => void;
}>;

type ShowcaseModalConfig = Readonly<{
    onRequestClose?: () => void;
    props?: ShowcaseModalProps;
}>;

const authState = vi.hoisted(() => ({
    isAuthenticated: false,
    credentials: null as unknown,
}));

const releaseNotesState = vi.hoisted(() => ({
    currentReleaseId: 'v-test',
    lastSeenReleaseId: null as string | null,
}));

const modalState = vi.hoisted(() => ({
    activeCount: 0,
    lastConfig: null as ShowcaseModalConfig | null,
    show: vi.fn((config: ShowcaseModalConfig) => {
        modalState.lastConfig = config;
        return 'onboarding-showcase-modal';
    }),
    hide: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/changelog/releaseNotes/manifestRuntime', () => ({
    getCurrentReleaseId: () => releaseNotesState.currentReleaseId,
}));

vi.mock('@/changelog/releaseNotes/storage', () => ({
    setLastSeenReleaseId: (releaseId: string) => {
        releaseNotesState.lastSeenReleaseId = releaseId;
    },
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
    beforeEach(async () => {
        const { clearShowcaseSeenVersion } = await import('./storage');
        clearShowcaseSeenVersion();
        authState.isAuthenticated = false;
        authState.credentials = null;
        releaseNotesState.lastSeenReleaseId = null;
        modalState.activeCount = 0;
        modalState.lastConfig = null;
        modalState.show.mockClear();
        modalState.hide.mockClear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('shows exactly once before authentication and records completion', async () => {
        const { ONBOARDING_SHOWCASE_MANIFEST } = await import('./manifest');
        const { getShowcaseSeenVersion } = await import('./storage');
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).toHaveBeenCalledTimes(1);

        await act(async () => {
            modalState.lastConfig?.props?.onComplete?.();
        });
        expect(getShowcaseSeenVersion()).toBe(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);
        expect(releaseNotesState.lastSeenReleaseId).toBe(releaseNotesState.currentReleaseId);

        await screen.update(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).toHaveBeenCalledTimes(1);
    });

    it('records a backdrop or skip dismissal as seen', async () => {
        const { ONBOARDING_SHOWCASE_MANIFEST } = await import('./manifest');
        const { getShowcaseSeenVersion } = await import('./storage');
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);
        await act(async () => {
            modalState.lastConfig?.onRequestClose?.();
        });

        expect(getShowcaseSeenVersion()).toBe(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);
        expect(releaseNotesState.lastSeenReleaseId).toBe(releaseNotesState.currentReleaseId);
    });

    it('silently records the tour as seen for an existing authenticated user', async () => {
        authState.isAuthenticated = true;
        authState.credentials = { token: 'token', secret: 'secret' };
        const { ONBOARDING_SHOWCASE_MANIFEST } = await import('./manifest');
        const { getShowcaseSeenVersion } = await import('./storage');
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);

        expect(modalState.show).not.toHaveBeenCalled();
        expect(getShowcaseSeenVersion()).toBe(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);
        expect(releaseNotesState.lastSeenReleaseId).toBeNull();
    });

    it('waits until another top-level modal is gone', async () => {
        modalState.activeCount = 1;
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).not.toHaveBeenCalled();

        modalState.activeCount = 0;
        await screen.update(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).toHaveBeenCalledTimes(1);
    });
});
