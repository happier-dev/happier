import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    collectUnexpectedRawTextNodes,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

import { journeyBeatById } from '../state/journeyBeats';
import { stageVisualTokens } from '../stage/stageVisualTokens';
import { buildRevealTitleWords, NarrationBeat, RevealTitleWordText } from './NarrationBeat';

const reanimatedCalls = vi.hoisted(() => ({
    withDelay: [] as Array<{ delayMs: number; animation: unknown }>,
    withTiming: [] as Array<{ value: number; config: unknown }>,
}));

vi.mock('react-native-reanimated', () => {
    const ReactModule = require('react') as typeof import('react');
    const Animated = {
        createAnimatedComponent: (component: unknown) => component,
    };
    return {
        __esModule: true,
        default: Animated,
        Easing: {
            out: (easing: unknown) => easing,
            cubic: 'cubic',
        },
        useAnimatedStyle: <T,>(factory: () => T): T => factory(),
        useSharedValue: <T,>(initial: T): { value: T } => {
            const ref = ReactModule.useRef<{ value: T } | null>(null);
            if (!ref.current) ref.current = { value: initial };
            return ref.current;
        },
        withDelay: (delayMs: number, animation: unknown) => {
            reanimatedCalls.withDelay.push({ delayMs, animation });
            return animation;
        },
        withTiming: (value: number, config: unknown) => {
            reanimatedCalls.withTiming.push({ value, config });
            return value;
        },
    };
});

afterEach(() => {
    standardCleanup();
    reanimatedCalls.withDelay = [];
    reanimatedCalls.withTiming = [];
});

function flattenStyle(style: unknown): Record<string, unknown> {
    return StyleSheet.flatten(style) as Record<string, unknown>;
}

describe('NarrationBeat', () => {
    it('renders translated title and body copy for a beat without an ACT eyebrow', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);

        expect(screen.findByTestId('narration-beat')).toBeTruthy();
        // D17: the ACT eyebrow row is killed — no "Act N" label above the title.
        expect(screen.findByTestId('narration-beat-eyebrow')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Act 1');
        expect(screen.getTextContent()).toContain('Start anywhere. Continue everywhere.');
        expect(screen.getTextContent()).toContain('Begin with one session that follows you across terminal, desktop, web, and phone.');
    });

    it('uses the binding desktop narration typography scale', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);

        expect(flattenStyle(screen.findByTestId('narration-beat-title')?.props.style)).toMatchObject({
            fontSize: stageVisualTokens.narration.titleFontSize,
            lineHeight: stageVisualTokens.narration.titleLineHeight,
            letterSpacing: stageVisualTokens.narration.titleLetterSpacing,
        });
        expect(flattenStyle(screen.findByTestId('narration-beat-body')?.props.style)).toMatchObject({
            fontSize: stageVisualTokens.narration.bodyFontSize,
            lineHeight: stageVisualTokens.narration.bodyLineHeight,
            maxWidth: stageVisualTokens.narration.bodyMaxWidth,
        });
    });

    it('splits the title into stable reveal words with stagger delays', async () => {
        expect(buildRevealTitleWords('Start anywhere. Continue everywhere.')).toEqual([
            { text: 'Start', delayMs: 0 },
            { text: 'anywhere.', delayMs: 70 },
            { text: 'Continue', delayMs: 140 },
            { text: 'everywhere.', delayMs: 210 },
        ]);

        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();
        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);
        const wordHosts = screen.findAllByTestId('narration-beat-title-word')
            .filter((node) => typeof node.type === 'string');
        expect(wordHosts).toHaveLength(4);
        expect(screen.findAllByType(RevealTitleWordText).map((node) => node.props.word.delayMs)).toEqual([0, 70, 140, 210]);
    });

    it('animates every title word with staggered opacity and translate reveal', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);

        expect(screen.findAllByType(RevealTitleWordText).map((node) => node.props.reducedMotion)).toEqual([
            false,
            false,
            false,
            false,
        ]);
        expect(reanimatedCalls.withDelay.map((call) => call.delayMs)).toEqual([0, 70, 140, 210]);
        expect(reanimatedCalls.withTiming.map((call) => call.value)).toEqual([1, 1, 1, 1]);
        const firstWordHost = screen.findAllByTestId('narration-beat-title-word')
            .find((node) => typeof node.type === 'string');
        expect(firstWordHost?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ color: expect.any(String) }),
            expect.objectContaining({
                opacity: 0,
                transform: [{ translateY: 6 }],
            }),
        ]));
    });

    it('renders title words without delayed motion when reduced motion is enabled', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        const screen = await renderScreen(
            <NarrationBeat beat={beat!} reducedMotion testID="narration-beat" />,
        );

        expect(screen.findAllByType(RevealTitleWordText).map((node) => node.props.reducedMotion)).toEqual([
            true,
            true,
            true,
            true,
        ]);
        expect(reanimatedCalls.withDelay).toEqual([]);
        expect(reanimatedCalls.withTiming).toEqual([]);
    });

    it('does not start the word reveal until the beat transition has settled', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        const screen = await renderScreen(
            <NarrationBeat beat={beat!} revealGate={false} testID="narration-beat" />,
        );

        // D18/§2: word reveal is visibility-gated — while the pane is still
        // transitioning in (revealGate=false) no reveal animation is scheduled
        // and every word stays hidden at opacity 0.
        expect(reanimatedCalls.withDelay).toEqual([]);
        expect(reanimatedCalls.withTiming).toEqual([]);
        const firstWordHost = screen.findAllByTestId('narration-beat-title-word')
            .find((node) => typeof node.type === 'string');
        expect(firstWordHost?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ opacity: 0, transform: [{ translateY: 6 }] }),
        ]));
    });

    it('starts the staggered word reveal once the gate opens', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        await renderScreen(
            <NarrationBeat beat={beat!} revealGate testID="narration-beat" />,
        );

        expect(reanimatedCalls.withDelay.map((call) => call.delayMs)).toEqual([0, 70, 140, 210]);
        expect(reanimatedCalls.withTiming.map((call) => call.value)).toEqual([1, 1, 1, 1]);
    });

    it('does not leak raw strings outside Text hosts', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();
        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });
});
