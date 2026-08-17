import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { useBrandPaneTokens } from '../../unauthShell/brandPaneTokens';
import type { JourneyBeat } from '../state/journeyBeats';
import { stageVisualTokens } from '../stage/stageVisualTokens';

const TITLE_WORD_STAGGER_MS = 70;
const TITLE_WORD_REVEAL_OFFSET_Y = 6;

/** How long one word's fade-and-rise takes once its turn in the stagger comes up. */
export const NARRATION_TITLE_WORD_REVEAL_DURATION_MS = 220;

/**
 * How long the word-reveal waits before it starts, measured from the beat
 * mounting. The narration pane glides and blurs in through the shared soft
 * `SlideTransitionSwitch`; holding the words back by that settle window keeps
 * them from animating while the pane itself is still arriving (D18 / spec §2).
 *
 * The hold is expressed as an animation delay rather than as a JS visibility
 * flag on purpose. A flag has a state — "closed" — in which every word sits at
 * opacity 0 with no animation scheduled at all, so a flag that never opened
 * rendered the headline permanently absent (observed live on beat A11). With
 * the hold inside the reveal itself there is no reachable state where a word is
 * hidden and nothing is pending to bring it back.
 */
export const NARRATION_TITLE_REVEAL_DELAY_MS = stageVisualTokens.motion.skipTransitionMs;

/**
 * When a word stops being animated and becomes plain, legible text: the moment
 * its own reveal was due to end.
 *
 * The reveal is an enhancement over the headline, never a precondition for it.
 * Scheduling the fade is not the same as the fade running — the words only
 * reach opacity 1 if the motion runtime actually advances the animation, and a
 * headline whose failure mode is "absent" is not a headline (beat A11 rendered
 * as a body sentence with no subject). So each word also commits its resting
 * style on a plain JS timer, which owes nothing to the animation: if the reveal
 * ran, the word is already there and the commit is invisible; if it never ran,
 * the word arrives at a bounded, known time without the fade.
 */
function narrationTitleWordSettleMs(revealDelayMs: number, wordDelayMs: number): number {
    return revealDelayMs + wordDelayMs + NARRATION_TITLE_WORD_REVEAL_DURATION_MS;
}

const AnimatedText = Animated.createAnimatedComponent(Text);

/**
 * Journey headline copy is written as a lead + closing sentence pair, exactly
 * like the welcome screen's two-line brand tagline: "One key." / "Yours.",
 * "Queue it. Steer it." / "Fork it.", "You love the terminal?" / "We do too.".
 * Splitting on the LAST sentence boundary turns the closing sentence into the
 * muted second tone; copy that is a single sentence stays one tone.
 */
const TITLE_TAIL_PATTERN = /^(.*[.?!])\s+(\S[\s\S]*)$/;

export type NarrationTitleLines = Readonly<{
    lead: string;
    tail: string | null;
}>;

export type RevealTitleWord = Readonly<{
    text: string;
    delayMs: number;
}>;

export type NarrationBeatProps = Readonly<{
    beat: JourneyBeat;
    /** Overrides the user's reduce-motion preference; defaults to it. */
    reducedMotion?: boolean;
    /** Overrides the pane-settle hold before the word reveal starts. */
    revealDelayMs?: number;
    testID?: string;
}>;

const stylesheet = StyleSheet.create(() => ({
    root: {
        width: '100%',
        alignItems: 'flex-start',
        gap: stageVisualTokens.narration.titleBodyGap,
    },
    titleBlock: {
        width: '100%',
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: stageVisualTokens.narration.titleFontSize,
        lineHeight: stageVisualTokens.narration.titleLineHeight,
        letterSpacing: stageVisualTokens.narration.titleLetterSpacing,
    },
    body: {
        fontSize: stageVisualTokens.narration.bodyFontSize,
        lineHeight: stageVisualTokens.narration.bodyLineHeight,
        maxWidth: stageVisualTokens.narration.bodyMaxWidth,
    },
    /** A word at rest is ordinary static text, with no animated style attached. */
    settledWord: {
        opacity: 1,
        transform: [{ translateY: 0 }],
    },
}));

export function splitNarrationTitleLines(title: string): NarrationTitleLines {
    const trimmed = title.trim();
    const match = TITLE_TAIL_PATTERN.exec(trimmed);
    const lead = match?.[1];
    const tail = match?.[2];
    if (!lead || !tail) return { lead: trimmed, tail: null };
    return { lead, tail };
}

/**
 * Splits one headline line into its reveal words. `startIndex` continues the
 * stagger across the second tone so the two lines read as one sentence
 * arriving, not two lists animating in parallel.
 */
export function buildRevealTitleWords(line: string, startIndex = 0): RevealTitleWord[] {
    return line.trim().split(/\s+/).filter((word) => word.length > 0).map((word, index) => ({
        text: word,
        delayMs: (startIndex + index) * TITLE_WORD_STAGGER_MS,
    }));
}

export function RevealTitleWordText(props: Readonly<{
    color: string;
    reducedMotion?: boolean;
    revealDelayMs: number;
    word: RevealTitleWord;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const reducedMotion = props.reducedMotion === true;
    const revealProgress = useSharedValue(reducedMotion ? 1 : 0);
    const { revealDelayMs } = props;
    const wordDelayMs = props.word.delayMs;
    // Reduced motion has no reveal to wait out: the word is born at rest.
    const [settled, setSettled] = React.useState(reducedMotion);

    React.useEffect(() => {
        if (reducedMotion) {
            revealProgress.value = 1;
            return;
        }

        revealProgress.value = withDelay(
            revealDelayMs + wordDelayMs,
            withTiming(1, {
                duration: NARRATION_TITLE_WORD_REVEAL_DURATION_MS,
                easing: Easing.out(Easing.cubic),
            }),
        );
    }, [reducedMotion, revealDelayMs, revealProgress, wordDelayMs]);

    React.useEffect(() => {
        if (reducedMotion) {
            setSettled(true);
            return;
        }

        const settleHandle = setTimeout(
            () => setSettled(true),
            narrationTitleWordSettleMs(revealDelayMs, wordDelayMs),
        );
        return () => clearTimeout(settleHandle);
    }, [reducedMotion, revealDelayMs, wordDelayMs]);

    const animatedStyle = useAnimatedStyle(() => {
        // Reanimated styles win over static styles and retain their last applied
        // values after removal. Explicitly clear the animated fields once the
        // fallback settles so the static resting style owns the visible word.
        if (settled) return { opacity: undefined, transform: undefined };
        return {
            opacity: revealProgress.value,
            transform: [{ translateY: (1 - revealProgress.value) * TITLE_WORD_REVEAL_OFFSET_Y }],
        };
    }, [settled]);

    return (
        <AnimatedText
            testID={props.testID}
            style={[{ color: props.color }, settled ? styles.settledWord : null, animatedStyle]}
        >
            {props.word.text}
        </AnimatedText>
    );
}

function RevealTitleLine(props: Readonly<{
    color: string;
    reducedMotion?: boolean;
    revealDelayMs: number;
    words: readonly RevealTitleWord[];
    testID: string;
    wordTestID: string;
}>): React.ReactElement {
    const styles = stylesheet;

    return (
        <Text testID={props.testID} style={[styles.title, { color: props.color }]}>
            {props.words.map((word, index) => (
                <React.Fragment key={`${word.text}:${index}`}>
                    {index > 0 ? ' ' : null}
                    <RevealTitleWordText
                        color={props.color}
                        reducedMotion={props.reducedMotion}
                        revealDelayMs={props.revealDelayMs}
                        testID={props.wordTestID}
                        word={word}
                    />
                </React.Fragment>
            ))}
        </Text>
    );
}

export function NarrationBeat(props: NarrationBeatProps): React.ReactElement {
    const styles = stylesheet;
    // The narration column sits on the brand-pane canvas, so it takes its
    // display tones from the same owner the welcome screen's BrandTagline /
    // BrandSubTagline use: full foreground lead, muted closing line, soft body.
    const tokens = useBrandPaneTokens();
    const preferredReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? preferredReducedMotion;
    const revealDelayMs = props.revealDelayMs ?? NARRATION_TITLE_REVEAL_DELAY_MS;
    const testID = props.testID ?? 'journey-narration-beat';
    const title = t(props.beat.narrationKeys.title);

    const lines = React.useMemo(() => splitNarrationTitleLines(title), [title]);
    const leadWords = React.useMemo(() => buildRevealTitleWords(lines.lead), [lines.lead]);
    const tailWords = React.useMemo(
        () => (lines.tail === null ? [] : buildRevealTitleWords(lines.tail, leadWords.length)),
        [leadWords.length, lines.tail],
    );

    return (
        <View testID={testID} style={styles.root}>
            <View
                testID={`${testID}-title-block`}
                accessibilityRole="header"
                style={styles.titleBlock}
            >
                <RevealTitleLine
                    color={tokens.foreground}
                    reducedMotion={reducedMotion}
                    revealDelayMs={revealDelayMs}
                    testID={`${testID}-title`}
                    wordTestID={`${testID}-title-word`}
                    words={leadWords}
                />
                {tailWords.length > 0 ? (
                    <RevealTitleLine
                        color={tokens.foregroundMuted}
                        reducedMotion={reducedMotion}
                        revealDelayMs={revealDelayMs}
                        testID={`${testID}-title-tail`}
                        wordTestID={`${testID}-title-word`}
                        words={tailWords}
                    />
                ) : null}
            </View>
            <Text testID={`${testID}-body`} style={[styles.body, { color: tokens.foregroundSoft }]}>
                {t(props.beat.narrationKeys.body)}
            </Text>
        </View>
    );
}
