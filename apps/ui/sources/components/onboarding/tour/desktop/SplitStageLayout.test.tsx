import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
import { Text } from '@/components/ui/text/Text';
import {
    collectUnexpectedRawTextNodes,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

import type { JourneyConfigControllerSurface } from '../config/JourneyConfigSlot';
import { journeyBeatById, type JourneyBeatId } from '../state/journeyBeats';
import { buildJourneyPresentationModel } from '../state/journeyPresentationModel';
import type { JourneyProgressController } from '../state/useJourneyProgress';
import { stageVisualTokens } from '../stage/stageVisualTokens';

import { SplitStageLayout, resolveJourneyStagePaneState } from './SplitStageLayout';

function collectDirectChildTestIds(node: ReturnType<typeof renderScreen> extends Promise<infer Screen>
    ? Screen extends { findByTestId: (testID: string) => infer Match }
        ? NonNullable<Match>
        : never
    : never): string[] {
    return node.children
        .filter((child) => typeof child === 'object' && child !== null)
        .map((child) => (child as { props?: { testID?: string } }).props?.testID)
        .filter((testID): testID is string => typeof testID === 'string');
}

function flattenStyle(style: unknown): Record<string, unknown> {
    return StyleSheet.flatten(style) as Record<string, unknown>;
}

vi.mock('react-native-svg', () => ({
    __esModule: true,
    default: 'Svg',
    Circle: 'Circle',
    G: 'G',
    Line: 'Line',
    Path: 'Path',
    Rect: 'Rect',
    Svg: 'Svg',
    SvgXml: 'SvgXml',
}));

afterEach(() => {
    standardCleanup();
});

function requireBeat(beatId: JourneyBeatId) {
    const beat = journeyBeatById.get(beatId);
    if (!beat) {
        throw new Error(`Missing test beat ${beatId}`);
    }
    return beat;
}

function createProgress(beatId: JourneyBeatId): JourneyProgressController {
    const model = buildJourneyPresentationModel({
        surface: 'desktop',
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

describe('SplitStageLayout', () => {
    it('drives full-planet stage moments from beat data', () => {
        expect(resolveJourneyStagePaneState(requireBeat('A1'))).toMatchObject({
            mode: 'stage',
            planetOpacity: 1,
            planetScale: 1,
            stageContentVisible: false,
        });
        expect(resolveJourneyStagePaneState(requireBeat('S5'))).toMatchObject({
            mode: 'stage',
            planetOpacity: 1,
            planetScale: 1,
            stageContentVisible: false,
        });
        expect(resolveJourneyStagePaneState(requireBeat('A2'))).toMatchObject({
            mode: 'stage',
            planetOpacity: 0.74,
            stageContentVisible: true,
        });
    });

    it('renders narration and config on the right by default, with the full-planet hero beat', async () => {
        const screen = await renderScreen(
            <SplitStageLayout
                progress={createProgress('A1')}
                controller={createController()}
                stage={<Text>Hero demo stage</Text>}
                testID="journey-desktop"
            />,
        );

        expect(screen.findByTestId('journey-desktop-narration-pane')).not.toBeNull();
        expect(screen.findByTestId('journey-desktop-stage-pane')).not.toBeNull();
        expect(collectDirectChildTestIds(screen.findByTestId('journey-desktop')!)).toEqual([
            'journey-desktop-current-beat:A1',
            'journey-desktop-stage-host',
            'journey-desktop-narration-pane',
            'journey-desktop-brand-logo',
            'journey-desktop-skip-pill',
        ]);
        expect(flattenStyle(screen.findByTestId('journey-desktop-narration-pane')?.props.style)).toMatchObject({
            width: stageVisualTokens.narration.width,
            minWidth: stageVisualTokens.narration.minWidth,
            maxWidth: stageVisualTokens.narration.maxWidth,
        });
        expect(screen.findByTestId('unauth-shell-stage-brand-host')).toBeNull();
        expect(screen.findByTestId('unauth-shell-stage-wallpaper-host')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Start anywhere. Continue everywhere.');
        expect(screen.getTextContent()).toContain('Configuration body');
        expect(screen.getTextContent()).not.toContain('Hero demo stage');
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('renders the supplied stage on the right and keeps narration controls on the left when orientation flips', async () => {
        const progress = createProgress('A2');
        const screen = await renderScreen(
            <SplitStageLayout
                progress={progress}
                controller={createController()}
                orientation="narration-left"
                stage={<Text>Session list stage</Text>}
                testID="journey-desktop"
            />,
        );

        expect(collectDirectChildTestIds(screen.findByTestId('journey-desktop')!)).toEqual([
            'journey-desktop-current-beat:A2',
            'journey-desktop-narration-pane',
            'journey-desktop-stage-host',
            'journey-desktop-brand-logo',
            'journey-desktop-skip-pill',
        ]);
        expect(screen.findByTestId('journey-desktop-stage-host')?.props.children.props.testID).toBe('journey-desktop-stage-pane');
        expect(screen.getTextContent()).toContain('Session list stage');
        expect(screen.getTextContent()).toContain('Configuration body');

        screen.pressByTestId('journey-desktop-skip-pill');

        expect(progress.skipToSetup).toHaveBeenCalledTimes(1);
    });

    it('kills ACT/dot chrome and renders a single hairline progress + single-scroll flow column', async () => {
        const progress = createProgress('A2');
        const screen = await renderScreen(
            <SplitStageLayout
                progress={progress}
                controller={createController()}
                stage={<Text>Session list stage</Text>}
                testID="journey-desktop"
            />,
        );

        // No ACT eyebrow rows, no beat number, no dot rail (D17).
        expect(screen.findByTestId('journey-desktop-narration-locator')).toBeNull();
        expect(screen.findByTestId('journey-desktop-progress-rail')).toBeNull();
        expect(screen.findByTestId('journey-desktop-progress-dot-A2')).toBeNull();
        expect(screen.getTextContent()).not.toContain('ACT I');
        expect(screen.getTextContent()).not.toContain('ACT II');

        // A single 2px accent-hue hairline whose fill tracks beat progress.
        const hairline = screen.findByTestId('journey-desktop-progress-hairline');
        expect(hairline).not.toBeNull();
        expect(flattenStyle(hairline?.props.style).height).toBe(2);
        const fillStyle = flattenStyle(screen.findByTestId('journey-desktop-progress-hairline-fill')?.props.style);
        const expectedFraction = progress.currentNumber / progress.visibleBeats.length;
        expect(fillStyle.width).toBe(`${expectedFraction * 100}%`);
        expect(fillStyle.backgroundColor).toBe(requireBeat('A2').accentHue);

        // Single-ScrollView column (R1 WorkflowPanel architecture, D18): the
        // narration + config flow together inside one scroll; the config body is
        // a plain in-flow View, never a competing inner scroller.
        const scroll = screen.findByTestId('journey-desktop-narration-scroll');
        expect(scroll).not.toBeNull();
        expect(flattenStyle(scroll?.props.contentContainerStyle)).toMatchObject({ flexGrow: 1 });
        const configBody = screen.findByTestId('journey-desktop-config-body');
        expect(configBody?.type).toBe('View');
        expect(flattenStyle(configBody?.props.style).flex).toBeUndefined();
    });

    it('keeps the setup column top rhythm within the 900px primary-action budget', async () => {
        const screen = await renderScreen(
            <SplitStageLayout
                progress={createProgress('S3')}
                controller={createController({
                    onBack: vi.fn(),
                    onSkip: vi.fn(),
                    skipLabel: "I'll do this later",
                    footerHint: 'Active Relay: http://127.0.0.1:4099',
                })}
                stage={<Text>Machine setup stage</Text>}
                testID="journey-desktop"
            />,
        );

        const scroll = screen.findByTestId('journey-desktop-narration-scroll');
        const contentStyle = flattenStyle(scroll?.props.contentContainerStyle);

        // The post-wrap S3 card adds five command lines. At the reference 900px
        // viewport, 52px is the largest observed top inset that keeps the full
        // primary action in-frame; reserve a little tolerance for font metrics.
        expect(contentStyle.paddingTop).toBeLessThanOrEqual(52);
    });

    it('renders the supplied demo stage in the right pane after the hero', async () => {
        const screen = await renderScreen(
            <SplitStageLayout
                progress={createProgress('A2')}
                controller={createController()}
                stage={<Text>Session list stage</Text>}
                direction="forward"
                reducedMotion
                testID="journey-desktop"
            />,
        );

        expect(screen.findByTestId('unauth-shell-stage-brand-host')).toBeNull();
        expect(screen.getTextContent()).toContain('Session list stage');
        expect(screen.findByType(SlideTransitionSwitch).props).toMatchObject({
            contentKey: 'A2',
            direction: 'forward',
            reducedMotion: true,
        });
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('keeps skip-to-setup available on dream beats without requiring controller-specific wiring', async () => {
        const progress = createProgress('A3');
        const screen = await renderScreen(
            <SplitStageLayout
                progress={progress}
                controller={createController({ onSkip: undefined, showSkip: false })}
                stage={<Text>Terminal TUI stage</Text>}
                testID="journey-desktop"
            />,
        );

        screen.pressByTestId('journey-desktop-skip-pill');

        expect(progress.skipToSetup).toHaveBeenCalledTimes(1);
    });
});
