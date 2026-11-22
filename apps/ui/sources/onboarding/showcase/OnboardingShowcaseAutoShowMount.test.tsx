import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { presentReadyHome, setHomeArrivalMotionPending } from '@/components/hub/homeArrival';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

type ShowcaseModalProps = Readonly<{
    onComplete?: () => void;
    onDismiss?: () => void;
    onAskHappier?: () => void;
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

const routeState = vi.hoisted(() => ({ segments: [] as string[] }));

vi.mock('expo-router', () => createExpoRouterMock({
    segments: () => routeState.segments,
    pathname: () => '/' + routeState.segments.filter(segment => !segment.startsWith('(') && segment !== 'index').join('/'),
}).module);

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
    let withdrawHome: (() => void) | undefined;
    beforeEach(async () => {
        withdrawHome = presentReadyHome();
        const { clearShowcaseSeenVersion } = await import('./storage');
        clearShowcaseSeenVersion();
        authState.isAuthenticated = false;
        authState.credentials = null;
        routeState.segments = [];
        releaseNotesState.lastSeenReleaseId = null;
        modalState.activeCount = 0;
        modalState.lastConfig = null;
        modalState.show.mockClear();
        modalState.hide.mockClear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        withdrawHome?.();
        withdrawHome = undefined;
        setHomeArrivalMotionPending(false);
        vi.useRealTimers();
    });

    async function signIn(screen: Awaited<ReturnType<typeof renderScreen>>, element: React.ReactElement): Promise<void> {
        authState.isAuthenticated = true;
        authState.credentials = { token: 'token', secret: 'secret' };
        await screen.update(element);
    }

    it('keeps the signed-out doorway clear, even for a returning signed-out visitor', async () => {
        // LABPARITY-ACCEPT-D-1118 (UI refinements 14:58Z): welcome-1115 shows the doorway first, with no sheet.
        routeState.segments = ['(app)', 'index'];
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);
        await screen.update(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).not.toHaveBeenCalled();
    });

    it('shows exactly once after the first sign-in on this device and records completion', async () => {
        const { ONBOARDING_SHOWCASE_MANIFEST } = await import('./manifest');
        const { getShowcaseSeenVersion } = await import('./storage');
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).not.toHaveBeenCalled();

        await signIn(screen, <OnboardingShowcaseAutoShowMount />);
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

    it('still shows after the first sign-in when the page reloads in between (an OAuth return, a refresh)', async () => {
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const signedOut = await renderScreen(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);
        await signedOut.unmount();

        authState.isAuthenticated = true;
        authState.credentials = { token: 'token', secret: 'secret' };
        await renderScreen(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).toHaveBeenCalledTimes(1);
    });

    it('waits for a Home landing admitted in the same commit as authentication', async () => {
        withdrawHome?.();
        withdrawHome = undefined;
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        function Landing() {
            React.useLayoutEffect(() => {
                if (authState.isAuthenticated) setHomeArrivalMotionPending(true);
            }, [authState.isAuthenticated]);
            return <OnboardingShowcaseAutoShowMount />;
        }
        const screen = await renderScreen(<Landing />);
        await signIn(screen, <Landing />);
        expect(modalState.show).not.toHaveBeenCalled();
        await act(async () => setHomeArrivalMotionPending(false));
        expect(modalState.show).not.toHaveBeenCalled();
        await act(async () => { withdrawHome = presentReadyHome(); });
        expect(modalState.show).toHaveBeenCalledTimes(1);
    });

    it('offers Ask Happier on the last card as an explicit choice that closes the tour as seen', async () => {
        const { ONBOARDING_SHOWCASE_MANIFEST } = await import('./manifest');
        const { getShowcaseSeenVersion } = await import('./storage');
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);
        await signIn(screen, <OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.lastConfig?.props?.onAskHappier).toBeTypeOf('function');
        await act(async () => {
            modalState.lastConfig?.props?.onAskHappier?.();
        });
        expect(modalState.hide).toHaveBeenCalledWith('onboarding-showcase-modal');
        expect(getShowcaseSeenVersion()).toBe(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);
    });

    it('records a backdrop or skip dismissal as seen', async () => {
        const { ONBOARDING_SHOWCASE_MANIFEST } = await import('./manifest');
        const { getShowcaseSeenVersion } = await import('./storage');
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);
        await signIn(screen, <OnboardingShowcaseAutoShowMount />);

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

    it.each([
        ['an invitation', ['(app)', 'join', '[token]']],
        ['a Team sign-in', ['(app)', 'teams', '[teamId]', 'sign-in']],
        ['sign-in with a key', ['(app)', 'restore', 'manual']],
        ['the sign-in choice', ['(app)', 'restore']],
        ['a terminal connect link', ['(app)', 'terminal', 'connect']],
    ])('after sign-in, waits while %s is open, then shows once the person reaches Home', async (_name, segments) => {
        routeState.segments = segments;
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);
        await signIn(screen, <OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).not.toHaveBeenCalled();

        routeState.segments = ['(app)', 'index'];
        await screen.update(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).toHaveBeenCalledTimes(1);
    });

    it('waits until another top-level modal is gone', async () => {
        modalState.activeCount = 1;
        const { OnboardingShowcaseAutoShowMount } = await import('./OnboardingShowcaseAutoShowMount');
        const screen = await renderScreen(<OnboardingShowcaseAutoShowMount />);
        await signIn(screen, <OnboardingShowcaseAutoShowMount />);

        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).not.toHaveBeenCalled();

        modalState.activeCount = 0;
        await screen.update(<OnboardingShowcaseAutoShowMount />);
        await vi.advanceTimersByTimeAsync(300);
        expect(modalState.show).toHaveBeenCalledTimes(1);
    });
});
