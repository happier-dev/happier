/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JourneyConfigControllerSurface } from '../config/JourneyConfigSlot';
import type { JourneyBeat, JourneyBeatId } from '../state/journeyBeats';
import { buildJourneyPresentationModel } from '../state/journeyPresentationModel';
import type { JourneyProgressController } from '../state/useJourneyProgress';

import { StoryScrollerLayout } from './StoryScrollerLayout';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This must use react-native-web's real host mapping: the regression is about
// the browser's page boundary, not a test renderer's prop bag.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock() as Record<string, unknown>;
    const { Text, View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        ...mock,
        default: { ...(mock.default as object), Text, View },
        Text,
        View,
    };
});

function createProgress(beatId: JourneyBeatId): JourneyProgressController {
    const model = buildJourneyPresentationModel({ surface: 'native', currentBeatId: beatId });
    return {
        ...model,
        attentionChoice: 'keep_current',
        setAttentionChoice: vi.fn(),
        advance: vi.fn(),
        back: vi.fn(),
        skipToSetup: vi.fn(),
    } satisfies JourneyProgressController;
}

function createController(): JourneyConfigControllerSurface {
    return {
        body: <button data-testid="active-relay-radio">Saved relay</button>,
        onPrimary: vi.fn(),
        primaryLabel: 'Continue',
    };
}

function renderStage(_beat: JourneyBeat): React.ReactNode {
    return null;
}

describe('StoryScrollerLayout web page isolation', () => {
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root?.unmount();
            });
        }
        container?.remove();
        container = null;
        root = null;
    });

    it('keeps prior story pages mounted but removes them and their descendants from browser navigation at setup', async () => {
        const initialProgress = createProgress('A1');
        const setupProgress = createProgress('S1');
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root?.render(
                <StoryScrollerLayout
                    progress={initialProgress}
                    controller={createController()}
                    renderStage={renderStage}
                    reducedMotion
                    testID="journey-mobile"
                />,
            );
        });

        const firstStoryPage = container.querySelector<HTMLElement>('[data-testid="journey-mobile-page"]');
        expect(firstStoryPage).not.toBeNull();

        await act(async () => {
            root?.render(
                <StoryScrollerLayout
                    progress={setupProgress}
                    controller={createController()}
                    renderStage={renderStage}
                    reducedMotion
                    testID="journey-mobile"
                />,
            );
        });

        const pages = [...container.querySelectorAll<HTMLElement>('[data-testid="journey-mobile-page"]')];
        expect(pages).toHaveLength(setupProgress.visibleBeats.length);
        expect(pages[0]).toBe(firstStoryPage);

        const currentPage = pages[setupProgress.currentIndex];
        const priorStoryPages = pages.slice(0, setupProgress.currentIndex);
        expect(priorStoryPages.length).toBeGreaterThan(0);
        expect(currentPage?.hasAttribute('inert')).toBe(false);
        expect(currentPage?.getAttribute('aria-hidden')).toBeNull();
        expect(container.querySelector('[data-testid="active-relay-radio"]')?.closest('[inert]')).toBeNull();

        for (const page of priorStoryPages) {
            // `inert` is the browser primitive that removes a mounted subtree —
            // including its ScrollView descendants — from sequential focus and
            // accessibility navigation. `aria-hidden` alone cannot do that.
            expect(page.hasAttribute('inert')).toBe(true);
            expect(page.getAttribute('aria-hidden')).toBe('true');
            const storyScroller = page.querySelector<HTMLElement>(
                '[data-testid^="journey-mobile-story-scroll-"]',
            );
            expect(storyScroller).not.toBeNull();
            // Chromium promotes overflowing containers to sequential Tab stops.
            // `inert` remains the page-level owner for descendants, while this
            // explicit negative index keeps each retained, offscreen ScrollView
            // out of the actual web focus order until that browser behavior is
            // consistently enforced through ancestor inertness.
            expect(storyScroller?.getAttribute('tabindex')).toBe('-1');
        }

        // The active setup control stays in the reachable order; page isolation
        // must not hide the live relay choice together with the retained story.
        expect(container.querySelector('[data-testid="active-relay-radio"]')?.getAttribute('tabindex'))
            .not.toBe('-1');
    });
});
