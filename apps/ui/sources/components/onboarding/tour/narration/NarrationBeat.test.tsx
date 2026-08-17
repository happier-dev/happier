import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    collectUnexpectedRawTextNodes,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

import { journeyBeatById } from '../state/journeyBeats';
import { stageVisualTokens } from '../stage/stageVisualTokens';
import {
    buildRevealTitleWords,
    NARRATION_TITLE_REVEAL_DELAY_MS,
    NARRATION_TITLE_WORD_REVEAL_DURATION_MS,
    NarrationBeat,
    RevealTitleWordText,
    splitNarrationTitleLines,
} from './NarrationBeat';

const reanimatedCalls = vi.hoisted(() => ({
    withDelay: [] as Array<{ delayMs: number; animation: unknown }>,
    withTiming: [] as Array<{ value: number; config: unknown }>,
    useFreshSharedValueReference: false,
}));

vi.mock('react-native-reanimated', () => {
    const ReactModule = require('react') as typeof import('react');
    const ANIMATED_STYLE_MARKER = '__narrationTestAnimatedStyle';
    const AnimatedComponent = (component: unknown) => {
        const RetainedAnimatedComponent = (props: Readonly<Record<string, unknown>>) => {
            // Reanimated's documented style contract retains values it has
            // applied until the animated style explicitly supplies `undefined`.
            // Model that external boundary for every test: forwarding the raw
            // `undefined` into React Native's StyleSheet is not how an Animated
            // component releases an applied value on web or native.
            const retainedAnimatedStyleRef = ReactModule.useRef<Record<string, unknown>>({});
            const staticStyle: Record<string, unknown> = {};
            const collectStyle = (candidate: unknown): void => {
                if (Array.isArray(candidate)) {
                    for (const nested of candidate) collectStyle(nested);
                    return;
                }
                if (typeof candidate !== 'object' || candidate === null) return;
                const style = candidate as Record<string, unknown>;
                if (style[ANIMATED_STYLE_MARKER] === true) {
                    for (const [property, value] of Object.entries(style)) {
                        if (property === ANIMATED_STYLE_MARKER) continue;
                        if (value === undefined) {
                            delete retainedAnimatedStyleRef.current[property];
                        } else {
                            retainedAnimatedStyleRef.current[property] = value;
                        }
                    }
                    return;
                }
                Object.assign(staticStyle, style);
            };
            collectStyle(props.style);

            return ReactModule.createElement(
                component as React.ComponentType<Record<string, unknown>>,
                { ...props, style: { ...staticStyle, ...retainedAnimatedStyleRef.current } },
            );
        };
        return RetainedAnimatedComponent;
    };
    const Animated = {
        createAnimatedComponent: AnimatedComponent,
    };
    // Real reanimated hands `sharedValue.value = withTiming(...)` an animation
    // descriptor and advances it on the UI thread; nothing ticks that thread
    // here, so an assigned animation is recorded and the value stays put. That
    // is exactly the state the headline is in while its reveal has been
    // scheduled but has not advanced — the case the legibility contract owns.
    type PendingAnimation = Readonly<{ pendingReanimatedAnimation: true; toValue: number }>;
    const isPendingAnimation = (candidate: unknown): candidate is PendingAnimation => (
        typeof candidate === 'object'
        && candidate !== null
        && 'pendingReanimatedAnimation' in candidate
    );
    return {
        __esModule: true,
        default: Animated,
        Easing: {
            out: (easing: unknown) => easing,
            cubic: 'cubic',
        },
        useAnimatedStyle: <T,>(factory: () => T): T => {
            const style = factory();
            if (typeof style !== 'object' || style === null) return style;
            return {
                ...(style as Record<string, unknown>),
                [ANIMATED_STYLE_MARKER]: true,
            } as T;
        },
        useSharedValue: <T,>(initial: T): { value: T } => {
            const ref = ReactModule.useRef<{ value: T } | null>(null);
            if (!ref.current) {
                let current = initial;
                ref.current = {
                    get value(): T {
                        return current;
                    },
                    set value(next: T) {
                        if (isPendingAnimation(next)) return;
                        current = next;
                    },
                };
            }
            if (reanimatedCalls.useFreshSharedValueReference) {
                // React Native Web can rebind animation handles while its
                // surrounding layout commits. The owner must not let that
                // incidental identity churn postpone the headline's bounded
                // legibility fallback.
                return {
                    get value(): T {
                        return ref.current!.value;
                    },
                    set value(next: T) {
                        ref.current!.value = next;
                    },
                };
            }
            return ref.current;
        },
        withDelay: (delayMs: number, animation: unknown) => {
            reanimatedCalls.withDelay.push({ delayMs, animation });
            return animation;
        },
        withTiming: (value: number, config: unknown) => {
            reanimatedCalls.withTiming.push({ value, config });
            return { pendingReanimatedAnimation: true, toValue: value } satisfies PendingAnimation;
        },
    };
});

afterEach(() => {
    standardCleanup();
    reanimatedCalls.withDelay = [];
    reanimatedCalls.withTiming = [];
    reanimatedCalls.useFreshSharedValueReference = false;
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
        expect(screen.getTextContent()).toContain('Start anywhere.');
        expect(screen.getTextContent()).toContain('Continue everywhere.');
        expect(screen.getTextContent()).toContain('Begin with one session that follows you across terminal, desktop, web, and phone.');
    });

    it('renders the headline two-tone like the welcome brand tagline', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);

        const lead = screen.findByTestId('narration-beat-title');
        const tail = screen.findByTestId('narration-beat-title-tail');
        expect(lead).toBeTruthy();
        expect(tail).toBeTruthy();

        const leadStyle = flattenStyle(lead?.props.style);
        const tailStyle = flattenStyle(tail?.props.style);
        // Same display metrics on both lines, two different tones — exactly the
        // BrandTagline relationship (full foreground lead, muted closing line).
        expect(tailStyle.fontSize).toBe(leadStyle.fontSize);
        expect(tailStyle.lineHeight).toBe(leadStyle.lineHeight);
        expect(tailStyle.letterSpacing).toBe(leadStyle.letterSpacing);
        expect(typeof leadStyle.color).toBe('string');
        expect(tailStyle.color).not.toBe(leadStyle.color);

        // The title block is one heading, not two loose paragraphs.
        expect(screen.findByTestId('narration-beat-title-block')?.props.accessibilityRole).toBe('header');
    });

    it('splits every headline at its closing sentence and leaves single-sentence copy one tone', async () => {
        expect(splitNarrationTitleLines('Start anywhere. Continue everywhere.')).toEqual({
            lead: 'Start anywhere.',
            tail: 'Continue everywhere.',
        });
        expect(splitNarrationTitleLines('Queue it. Steer it. Fork it.')).toEqual({
            lead: 'Queue it. Steer it.',
            tail: 'Fork it.',
        });
        expect(splitNarrationTitleLines('You love the terminal? We do too.')).toEqual({
            lead: 'You love the terminal?',
            tail: 'We do too.',
        });
        expect(splitNarrationTitleLines('Configure (almost) everything.')).toEqual({
            lead: 'Configure (almost) everything.',
            tail: null,
        });

        const beat = journeyBeatById.get('A7');
        expect(beat).toBeDefined();
        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);
        expect(screen.getTextContent()).toContain('Always know what needs you.');
        expect(screen.findByTestId('narration-beat-title-tail')).toBeNull();
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

    it('splits the title into stable reveal words with stagger delays that continue across both tones', async () => {
        expect(buildRevealTitleWords('Start anywhere.')).toEqual([
            { text: 'Start', delayMs: 0 },
            { text: 'anywhere.', delayMs: 70 },
        ]);
        expect(buildRevealTitleWords('Continue everywhere.', 2)).toEqual([
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

    it('holds the staggered reveal back by the pane settle window but always schedules it at mount', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);

        expect(screen.findAllByType(RevealTitleWordText).map((node) => node.props.reducedMotion)).toEqual([
            false,
            false,
            false,
            false,
        ]);
        // D18/§2 still holds: the words wait out the incoming pane transition.
        // The wait lives INSIDE the reveal animation, so there is no state in
        // which a word is hidden with nothing scheduled to bring it back — a
        // headline whose failure mode is "absent" is not a headline.
        const settle = NARRATION_TITLE_REVEAL_DELAY_MS;
        expect(reanimatedCalls.withDelay.map((call) => call.delayMs)).toEqual([
            settle,
            settle + 70,
            settle + 140,
            settle + 210,
        ]);
        expect(reanimatedCalls.withTiming.map((call) => call.value)).toEqual([1, 1, 1, 1]);
        const firstWordHost = screen.findAllByTestId('narration-beat-title-word')
            .find((node) => typeof node.type === 'string');
        expect(flattenStyle(firstWordHost?.props.style)).toMatchObject({
            color: expect.any(String),
            opacity: 0,
            transform: [{ translateY: 6 }],
        });
    });

    it('lands the headline legible even when the reveal animation never advances', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        vi.useFakeTimers();
        try {
            const screen = await renderScreen(
                <NarrationBeat beat={beat!} revealDelayMs={0} testID="narration-beat" />,
            );
            const readWordStyles = () => screen.findAllByTestId('narration-beat-title-word')
                .filter((node) => typeof node.type === 'string')
                .map((node) => flattenStyle(node.props.style));

            // The reveal is scheduled, and the motion runtime never advances it.
            expect(readWordStyles().map((style) => style.opacity)).toEqual([0, 0, 0, 0]);

            // Past its own reveal window every word is at its resting, legible
            // style with no animation having run. The headline is a title, not a
            // reward for a completed animation: on beat A11 the words stayed at
            // opacity 0 and the beat rendered as a body sentence with no subject.
            await flushHookEffects({
                advanceTimersMs: buildRevealTitleWords('Start anywhere. Continue everywhere.')
                    .reduce((max, word) => Math.max(max, word.delayMs), 0)
                    + NARRATION_TITLE_WORD_REVEAL_DURATION_MS,
            });

            expect(readWordStyles().map((style) => style.opacity)).toEqual([1, 1, 1, 1]);
            expect(readWordStyles().map((style) => style.transform)).toEqual([
                [{ translateY: 0 }],
                [{ translateY: 0 }],
                [{ translateY: 0 }],
                [{ translateY: 0 }],
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles the default-delay headline despite repeated animation-handle lifecycle churn', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        vi.useFakeTimers();
        reanimatedCalls.useFreshSharedValueReference = true;
        try {
            const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);
            const readWordStyles = () => screen.findAllByTestId('narration-beat-title-word')
                .filter((node) => typeof node.type === 'string')
                .map((node) => flattenStyle(node.props.style));
            const latestWordSettleMs = NARRATION_TITLE_REVEAL_DELAY_MS
                + buildRevealTitleWords('Start anywhere. Continue everywhere.')
                    .reduce((max, word) => Math.max(max, word.delayMs), 0)
                + NARRATION_TITLE_WORD_REVEAL_DURATION_MS;

            // Re-render more often than any word's settle deadline. This is the
            // live RNW failure mode: a motion-handle identity can churn while the
            // pane measures/resizes, but the semantic H1 must still become plain
            // legible text within its original bounded fallback window.
            for (let elapsedMs = 0; elapsedMs < latestWordSettleMs + 300; elapsedMs += 50) {
                await flushHookEffects({ cycles: 1, advanceTimersMs: 50 });
                await screen.update(<NarrationBeat beat={beat!} testID="narration-beat" />);
            }

            expect(readWordStyles().map((style) => style.opacity)).toEqual([1, 1, 1, 1]);
            expect(readWordStyles().map((style) => style.transform)).toEqual([
                [{ translateY: 0 }],
                [{ translateY: 0 }],
                [{ translateY: 0 }],
                [{ translateY: 0 }],
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps every word visible when Reanimated retains prior animated styles after the fallback settles', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();

        vi.useFakeTimers();
        try {
            const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);
            const readWordStyles = () => screen.findAllByTestId('narration-beat-title-word')
                .filter((node) => typeof node.type === 'string')
                .map((node) => flattenStyle(node.props.style));
            const latestWordSettleMs = NARRATION_TITLE_REVEAL_DELAY_MS
                + buildRevealTitleWords('Start anywhere. Continue everywhere.')
                    .reduce((max, word) => Math.max(max, word.delayMs), 0)
                + NARRATION_TITLE_WORD_REVEAL_DURATION_MS;

            expect(readWordStyles().map((style) => style.opacity)).toEqual([0, 0, 0, 0]);
            await flushHookEffects({ cycles: 1, advanceTimersMs: latestWordSettleMs });

            expect(readWordStyles().map((style) => style.opacity)).toEqual([1, 1, 1, 1]);
            expect(readWordStyles().map((style) => style.transform)).toEqual([
                [{ translateY: 0 }],
                [{ translateY: 0 }],
                [{ translateY: 0 }],
                [{ translateY: 0 }],
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('renders title words at their resting legible style without motion when reduced motion is enabled', async () => {
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
        const wordStyles = screen.findAllByTestId('narration-beat-title-word')
            .filter((node) => typeof node.type === 'string')
            .map((node) => flattenStyle(node.props.style));
        expect(wordStyles.map((style) => style.opacity)).toEqual([1, 1, 1, 1]);
        expect(wordStyles.map((style) => style.transform)).toEqual([
            [{ translateY: 0 }],
            [{ translateY: 0 }],
            [{ translateY: 0 }],
            [{ translateY: 0 }],
        ]);
    });

    it('does not leak raw strings outside Text hosts', async () => {
        const beat = journeyBeatById.get('A1');
        expect(beat).toBeDefined();
        const screen = await renderScreen(<NarrationBeat beat={beat!} testID="narration-beat" />);

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });
});
