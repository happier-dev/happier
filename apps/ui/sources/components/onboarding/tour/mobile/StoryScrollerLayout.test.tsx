import * as React from 'react';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text/Text';
import {
    collectUnexpectedRawTextNodes,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

import type { JourneyConfigControllerSurface } from '../config/JourneyConfigSlot';
import type { JourneyBeat, JourneyBeatId, JourneySurface } from '../state/journeyBeats';
import { buildJourneyPresentationModel } from '../state/journeyPresentationModel';
import type { JourneyProgressController } from '../state/useJourneyProgress';

import {
    StoryScrollerLayout,
    resolveStoryScrollerStageBandPercent,
} from './StoryScrollerLayout';

afterEach(() => {
    standardCleanup();
});

function createProgress(
    beatId: JourneyBeatId,
    surface: JourneySurface = 'native',
): JourneyProgressController {
    const model = buildJourneyPresentationModel({
        surface,
        currentBeatId: beatId,
    });

    return {
        ...model,
        attentionChoice: 'keep_current',
        setAttentionChoice: vi.fn(),
        advance: vi.fn(),
        back: vi.fn(),
        skipToSetup: vi.fn(),
    } satisfies JourneyProgressController;
}

function createController(overrides: Partial<JourneyConfigControllerSurface> = {}): JourneyConfigControllerSurface {
    return {
        body: <Text>Configuration body</Text>,
        onPrimary: vi.fn(),
        primaryLabel: 'Continue',
        ...overrides,
    };
}

function renderStage(beat: JourneyBeat): React.ReactNode {
    return <Text>{beat.id} stage band</Text>;
}

describe('StoryScrollerLayout', () => {
    it('mounts stage content only for the current beat while retaining every narration page', async () => {
        const progress = createProgress('A2');
        const mountedStageBeatIds: JourneyBeatId[] = [];

        function MountedStageProbe(props: Readonly<{ beatId: JourneyBeatId }>): React.ReactElement {
            React.useEffect(() => {
                mountedStageBeatIds.push(props.beatId);
            }, [props.beatId]);
            return <Text testID={`mounted-stage-${props.beatId}`}>{props.beatId} mounted stage</Text>;
        }

        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={progress}
                controller={createController()}
                renderStage={(beat) => <MountedStageProbe beatId={beat.id} />}
                testID="journey-mobile"
            />,
        );

        expect(screen.findAllByTestId('journey-mobile-page')).toHaveLength(progress.visibleBeats.length);
        expect(mountedStageBeatIds).toEqual(['A2']);
        expect(screen.findByTestId('mounted-stage-A2')).not.toBeNull();
        expect(screen.findByTestId('mounted-stage-A4')).toBeNull();

        const pages = screen.findAllByTestId('journey-mobile-page');
        expect(pages[progress.currentIndex]?.props['aria-hidden']).toBeUndefined();
        const nextPage = pages[progress.currentIndex + 1];
        if (Platform.OS === 'web') {
            expect(nextPage?.props['aria-hidden']).toBe(true);
        } else {
            expect(nextPage?.props.accessibilityElementsHidden).toBe(true);
            expect(nextPage?.props.importantForAccessibility).toBe('no-hide-descendants');
        }
    });

    it('uses a horizontal paged scroller so one page maps to one visible beat', async () => {
        const progress = createProgress('A1');
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={progress}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        const pager = screen.findByTestId('journey-mobile-pager');
        expect(pager).not.toBeNull();
        if (!pager) throw new Error('Expected the story scroller pager to render');

        expect(pager.props).toMatchObject({
            horizontal: true,
            pagingEnabled: true,
            showsHorizontalScrollIndicator: false,
        });
        expect(screen.findAllByTestId('journey-mobile-page')).toHaveLength(progress.visibleBeats.length);
        expect(screen.getTextContent()).toContain('A1 stage band');
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('advances or backs at most one beat from a momentum page change', async () => {
        const forwardProgress = createProgress('A1');
        const forwardScreen = await renderScreen(
            <StoryScrollerLayout
                progress={forwardProgress}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );
        const forwardPager = forwardScreen.findByTestId('journey-mobile-pager');
        expect(forwardPager).not.toBeNull();
        if (!forwardPager) throw new Error('Expected the forward story scroller pager to render');
        forwardPager.props.onMomentumScrollEnd({
            nativeEvent: {
                contentOffset: { x: 900 },
                layoutMeasurement: { width: 300 },
            },
        });

        expect(forwardProgress.advance).toHaveBeenCalledTimes(1);
        expect(forwardProgress.back).not.toHaveBeenCalled();

        const backProgress = createProgress('A4');
        const backScreen = await renderScreen(
            <StoryScrollerLayout
                progress={backProgress}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile-back"
            />,
        );
        const backPager = backScreen.findByTestId('journey-mobile-back-pager');
        expect(backPager).not.toBeNull();
        if (!backPager) throw new Error('Expected the backward story scroller pager to render');
        backPager.props.onMomentumScrollEnd({
            nativeEvent: {
                contentOffset: { x: 0 },
                layoutMeasurement: { width: 300 },
            },
        });

        expect(backProgress.back).toHaveBeenCalledTimes(1);
        expect(backProgress.advance).not.toHaveBeenCalled();
    });

    it('positions the pager at the current visible beat when mounted mid-journey', async () => {
        const progress = createProgress('A4');
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={progress}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        const pager = screen.findByTestId('journey-mobile-pager');
        expect(pager).not.toBeNull();
        if (!pager) throw new Error('Expected the story scroller pager to render');
        expect(pager.props.contentOffset.x).toBeGreaterThan(0);
        expect(pager.props.contentOffset.y).toBe(0);
    });

    it('sizes story and config stage bands by beat type', () => {
        expect(resolveStoryScrollerStageBandPercent(buildJourneyPresentationModel({
            surface: 'native',
            currentBeatId: 'A1',
        }).currentBeat)).toBe(60);
        expect(resolveStoryScrollerStageBandPercent(buildJourneyPresentationModel({
            surface: 'native',
            currentBeatId: 'S1',
        }).currentBeat)).toBe(35);
    });

    it('mounts the canonical mobile planet backdrop behind the story with the R1 bottom fade (F-W13-5)', async () => {
        const progress = createProgress('A1');
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={progress}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        // R1's mobile welcome recipe, reused verbatim: the shared
        // PlanetBackground mobile variant (300% scale / 1.5 aspect / 20%
        // anchor) mounts behind the story content...
        expect(screen.findByTestId('planet-background-mobile-frame')).not.toBeNull();
        // ...with the 60% bottom fade so bottom-anchored text stays readable.
        const fade = screen.findByTestId('journey-mobile-planet-fade');
        expect(fade).not.toBeNull();
        expect(fade?.props.style).toEqual(expect.objectContaining({
            position: 'absolute',
            bottom: 0,
            height: '60%',
        }));
    });

    it('keeps persistent skip controls in the thumb zone on dream beats', async () => {
        const progress = createProgress('A6');
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={progress}
                controller={createController({ onSkip: undefined, showSkip: false })}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        expect(screen.findByTestId('journey-mobile-thumb-zone')).not.toBeNull();
        screen.pressByTestId('journey-mobile-config-skip');

        expect(progress.skipToSetup).toHaveBeenCalledTimes(1);
    });
});
