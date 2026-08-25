import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const authState = vi.hoisted(() => ({
    credentials: { token: 'token', secret: 'secret' } as unknown,
}));

const releaseNotesLauncherState = vi.hoisted(() => ({
    open: vi.fn(() => true),
}));

const setupIntentState = vi.hoisted(() => ({
    pending: null as null | { phase: 'awaiting_auth' | 'post_auth' | 'dismissed' },
}));

const modalState = vi.hoisted(() => ({
    activeCount: 0,
}));

const onboardingState = vi.hoisted(() => ({
    hasUnread: false,
}));

vi.mock('expo-router', () => createExpoRouterMock().module);

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        credentials: authState.credentials,
        isAuthenticated: Boolean(authState.credentials),
    }),
}));

vi.mock('@/onboarding/showcase', () => ({
    useOnboardingShowcaseState: () => onboardingState,
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => setupIntentState.pending,
}));

vi.mock('@/modal', () => ({
    useOptionalModal: () => ({
        state: {
            modals: Array.from({ length: modalState.activeCount }, (_, index) => ({ id: `modal-${index}` })),
        },
    }),
}));

vi.mock('./migration', () => ({
    runReleaseNotesMigrationSeeding: vi.fn(),
}));

vi.mock('./remoteManifest', () => ({
    revalidateRemoteManifest: vi.fn(async () => null),
}));

vi.mock('./useReleaseNotesLauncher', () => ({
    useReleaseNotesLauncher: () => ({
        open: releaseNotesLauncherState.open,
    }),
}));

describe('ReleaseNotesAutoShowMount', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'app.ui.releaseNotes';
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
        authState.credentials = { token: 'token', secret: 'secret' };
        setupIntentState.pending = null;
        modalState.activeCount = 0;
        onboardingState.hasUnread = false;
        releaseNotesLauncherState.open.mockClear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        process.env = { ...originalEnv };
    });

    it('opens release notes after auth/setup/onboarding gates are resolved', async () => {
        const { ReleaseNotesAutoShowMount } = await import('./ReleaseNotesAutoShowMount');
        await renderScreen(<ReleaseNotesAutoShowMount />);

        await vi.advanceTimersByTimeAsync(800);

        expect(releaseNotesLauncherState.open).toHaveBeenCalledTimes(1);
    });

    it('waits until the first-open onboarding showcase has been resolved', async () => {
        onboardingState.hasUnread = true;
        const { ReleaseNotesAutoShowMount } = await import('./ReleaseNotesAutoShowMount');
        const screen = await renderScreen(<ReleaseNotesAutoShowMount />);
        await vi.advanceTimersByTimeAsync(800);

        expect(releaseNotesLauncherState.open).not.toHaveBeenCalled();

        onboardingState.hasUnread = false;
        await screen.update(<ReleaseNotesAutoShowMount />);
        await vi.advanceTimersByTimeAsync(800);

        expect(releaseNotesLauncherState.open).toHaveBeenCalledTimes(1);
    });

    it('does not open while a setup intent still needs to resolve', async () => {
        setupIntentState.pending = { phase: 'post_auth' };

        const { ReleaseNotesAutoShowMount } = await import('./ReleaseNotesAutoShowMount');
        await renderScreen(<ReleaseNotesAutoShowMount />);

        await vi.advanceTimersByTimeAsync(1000);

        expect(releaseNotesLauncherState.open).not.toHaveBeenCalled();
    });

    it('does not auto-open when the release-notes feature is denied', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.releaseNotes';

        const { ReleaseNotesAutoShowMount } = await import('./ReleaseNotesAutoShowMount');
        await renderScreen(<ReleaseNotesAutoShowMount />);

        await vi.advanceTimersByTimeAsync(1000);

        expect(releaseNotesLauncherState.open).not.toHaveBeenCalled();
    });

    it('does not auto-open without an explicit release-notes story allow', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = '';

        const { ReleaseNotesAutoShowMount } = await import('./ReleaseNotesAutoShowMount');
        await renderScreen(<ReleaseNotesAutoShowMount />);

        await vi.advanceTimersByTimeAsync(1000);

        expect(releaseNotesLauncherState.open).not.toHaveBeenCalled();
    });

    it('waits while another app modal owns the top-level flow', async () => {
        modalState.activeCount = 1;

        const { ReleaseNotesAutoShowMount } = await import('./ReleaseNotesAutoShowMount');
        const screen = await renderScreen(<ReleaseNotesAutoShowMount />);

        await vi.advanceTimersByTimeAsync(1000);

        expect(releaseNotesLauncherState.open).not.toHaveBeenCalled();

        modalState.activeCount = 0;
        await screen.update(<ReleaseNotesAutoShowMount />);
        await vi.advanceTimersByTimeAsync(800);

        expect(releaseNotesLauncherState.open).toHaveBeenCalledTimes(1);
    });
});
