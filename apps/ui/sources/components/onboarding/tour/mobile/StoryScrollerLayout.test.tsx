import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text/Text';
import {
    collectUnexpectedRawTextNodes,
    flattenTestStyle,
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
    resolveStoryScrollerThumbZonePercent,
} from './StoryScrollerLayout';

const deviceState = vi.hoisted(() => ({
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => deviceState.safeAreaInsets,
}));

afterEach(() => {
    deviceState.safeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    standardCleanup();
});

/** Captures the pager's imperative handle so tests can assert real scroll commands. */
function createPagerNodeMock(pagerTestID: string, scrollTo: () => void) {
    return (element: React.ReactElement): Record<string, unknown> => {
        const testID = (element.props as { testID?: string }).testID;
        return testID === pagerTestID ? { scrollTo } : {};
    };
}

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

/** The width the pager gives each page, read back from the rendered page itself. */
function readPageWidth(screen: RenderedScreen): number {
    const width = flattenTestStyle(screen.findAllByTestId('journey-mobile-page')[0]?.props.style).width;
    if (typeof width !== 'number') throw new Error('Expected the story page to carry a numeric width');
    return width;
}

/** Reports the natural height the config body laid out at, as the runtime would. */
async function layOutConfigBody(screen: RenderedScreen, height: number): Promise<void> {
    const measured = screen.findByTestId('journey-mobile-config-body-measure');
    if (!measured) throw new Error('Expected the config body to be measured for the thumb-zone share');
    await act(async () => {
        measured.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } });
    });
}

function readThumbZoneBasis(screen: RenderedScreen): unknown {
    return flattenTestStyle(screen.findByTestId('journey-mobile-thumb-zone')?.props.style).flexBasis;
}

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
        const scrollTo = vi.fn();
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={progress}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
            { createNodeMock: createPagerNodeMock('journey-mobile-pager', scrollTo) },
        );

        const pager = screen.findByTestId('journey-mobile-pager');
        expect(pager).not.toBeNull();
        if (!pager) throw new Error('Expected the story scroller pager to render');
        expect(pager.props.contentOffset.x).toBeGreaterThan(0);
        expect(pager.props.contentOffset.y).toBe(0);
        // `contentOffset` is dropped by react-native-web, so the declarative
        // prop can never be the only owner of the pager position.
        expect(scrollTo).toHaveBeenCalledWith({
            x: pager.props.contentOffset.x,
            y: 0,
            animated: false,
        });
    });

    it('moves the pager to a new beat by scrolling, leaving contentOffset as a mount-only seed', async () => {
        const scrollTo = vi.fn();
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={createProgress('A1')}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
            { createNodeMock: createPagerNodeMock('journey-mobile-pager', scrollTo) },
        );
        const seededOffset = screen.findByTestId('journey-mobile-pager')?.props.contentOffset;
        expect(seededOffset).toEqual({ x: 0, y: 0 });
        scrollTo.mockClear();

        const nextProgress = createProgress('A4');
        await screen.update(
            <StoryScrollerLayout
                progress={nextProgress}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        // Both native scrollers re-apply `contentOffset` on every commit whose
        // value changed — iOS Fabric assigns `_scrollView.contentOffset` in
        // RCTScrollViewComponentView, and Android's `contentOffset` @ReactProp
        // calls `scrollTo` — so a value that tracks the beat would cut the pager
        // to the destination and leave the animated scroll below a no-op.
        expect(screen.findByTestId('journey-mobile-pager')?.props.contentOffset).toEqual({ x: 0, y: 0 });
        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(scrollTo).toHaveBeenCalledWith({
            x: nextProgress.currentIndex * readPageWidth(screen),
            y: 0,
            animated: true,
        });
    });

    it('syncs the pager without animation when reduced motion is requested', async () => {
        const scrollTo = vi.fn();
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={createProgress('A1')}
                controller={createController()}
                renderStage={renderStage}
                reducedMotion
                testID="journey-mobile"
            />,
            { createNodeMock: createPagerNodeMock('journey-mobile-pager', scrollTo) },
        );
        scrollTo.mockClear();

        await screen.update(
            <StoryScrollerLayout
                progress={createProgress('A4')}
                controller={createController()}
                renderStage={renderStage}
                reducedMotion
                testID="journey-mobile"
            />,
        );

        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ animated: false }));
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

    it('hands narration a scroll-measured child so the story band cannot collapse to zero height', async () => {
        const progress = createProgress('A1');
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={progress}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        const band = screen.findByTestId('journey-mobile-story-band-A1');
        // The band owns the vertical placement, so short narration stays
        // optically centered the way it is on the desktop split and the way
        // mobile web rendered it before the band gained a scroller.
        expect(flattenTestStyle(band?.props.style)).toMatchObject({
            flex: 1,
            minHeight: 0,
            justifyContent: 'center',
        });

        // The band resolves to a definite height. NarrationColumn's own root is
        // auto-height around a `flex: 1` transition frame, and Yoga zeroes that
        // frame's free space whenever its container is measured against a
        // definite height — the narration then paints nothing. The band
        // therefore hands narration to a vertical scroller whose content view is
        // measured with an unbounded main axis.
        const narrationScroll = screen.findByTestId('journey-mobile-story-scroll-A1');
        expect(narrationScroll).not.toBeNull();
        // The scroller hugs its narration instead of filling the band (Yoga
        // clamps a content-sized scroll container to the room the band offers,
        // so long copy still scrolls). Filling the band would leave narration
        // top-aligned with no way to center it.
        expect(flattenTestStyle(narrationScroll?.props.style)).toMatchObject({
            flexGrow: 0,
            flexShrink: 1,
            minHeight: 0,
        });
        // A `flexGrow` on the content view would stretch it back to a definite
        // height and re-collapse the narration frame.
        expect(flattenTestStyle(narrationScroll?.props.contentContainerStyle).flexGrow).toBeUndefined();
        expect(narrationScroll?.findAllByProps({ testID: 'journey-mobile-narration-A1' }).length)
            .toBeGreaterThan(0);
    });

    it('reserves a definite thumb-zone height so the config body and its actions resolve', async () => {
        // `JourneyConfigSlot`'s scroll layout is a height-bounded region: its
        // body is a `flex: 1` ScrollView, so an auto-height thumb zone leaves
        // the body — and the Back/Next/Skip row under it — at zero height.
        expect(resolveStoryScrollerThumbZonePercent(0)).toBe(22);
        expect(resolveStoryScrollerThumbZonePercent(380)).toBe(44);

        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={createProgress('S1')}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        await layOutConfigBody(screen, 260);
        expect(readThumbZoneBasis(screen)).toBe('44%');
        expect(flattenTestStyle(screen.findByTestId('journey-mobile-thumb-zone')?.props.style))
            .toMatchObject({ flexGrow: 0 });
        expect(flattenTestStyle(screen.findByTestId('journey-mobile-pager')?.props.style))
            .toMatchObject({ flex: 1, minHeight: 0 });
    });

    it('sizes the thumb zone from the body the controller actually renders, not from configStepId', async () => {
        // The finale beat carries no `configStepId`, yet its controller body is
        // the whole ShowcaseReel: keying the share off the beat handed A14 the
        // narration-sized zone and crushed the reel. Narration beats hand the
        // slot a placeholder body and keep the small zone.
        const finaleProgress = createProgress('A14');
        expect(finaleProgress.currentBeat.configStepId).toBeUndefined();

        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={finaleProgress}
                controller={createController({ body: <Text>Showcase reel</Text> })}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        await layOutConfigBody(screen, 380);
        expect(readThumbZoneBasis(screen)).toBe('44%');

        // The measurement belongs to the beat that produced it: stepping to a
        // narration beat must not inherit the finale's share.
        await screen.update(
            <StoryScrollerLayout
                progress={createProgress('A1')}
                controller={createController({ body: <Text>{null}</Text> })}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );
        expect(readThumbZoneBasis(screen)).toBe('22%');

        await layOutConfigBody(screen, 0);
        expect(readThumbZoneBasis(screen)).toBe('22%');
    });

    it('insets the story page and thumb zone with the device safe area', async () => {
        deviceState.safeAreaInsets = { top: 44, right: 8, bottom: 34, left: 8 };
        const screen = await renderScreen(
            <StoryScrollerLayout
                progress={createProgress('A1')}
                controller={createController()}
                renderStage={renderStage}
                testID="journey-mobile"
            />,
        );

        expect(flattenTestStyle(screen.findAllByTestId('journey-mobile-page')[0]?.props.style))
            .toMatchObject({ paddingTop: 60, paddingLeft: 26, paddingRight: 26 });
        expect(flattenTestStyle(screen.findByTestId('journey-mobile-thumb-zone')?.props.style))
            .toMatchObject({ paddingBottom: 52, paddingLeft: 26, paddingRight: 26 });
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
