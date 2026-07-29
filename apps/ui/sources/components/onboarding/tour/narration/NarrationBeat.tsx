import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { JourneyBeat } from '../state/journeyBeats';
import { stageVisualTokens } from '../stage/stageVisualTokens';

const TITLE_WORD_STAGGER_MS = 70;
const TITLE_WORD_REVEAL_DURATION_MS = 220;
const TITLE_WORD_REVEAL_OFFSET_Y = 6;

const AnimatedText = Animated.createAnimatedComponent(Text);

export type RevealTitleWord = Readonly<{
    text: string;
    delayMs: number;
}>;

export type NarrationBeatProps = Readonly<{
    beat: JourneyBeat;
    reducedMotion?: boolean;
    /**
     * Visibility gate for the staggered title word-reveal. Defaults to `true`
     * (open) so a standalone beat still animates; the journey column passes the
     * beat-transition settled signal so the reveal only starts once the pane has
     * fully transitioned in (D18 / spec §2). While `false` every word stays
     * hidden and no animation is scheduled.
     */
    revealGate?: boolean;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        alignItems: 'flex-start',
        gap: 14,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: stageVisualTokens.narration.titleFontSize,
        lineHeight: stageVisualTokens.narration.titleLineHeight,
        letterSpacing: stageVisualTokens.narration.titleLetterSpacing,
    },
    titleWord: {
        color: theme.colors.text.primary,
    },
    body: {
        color: theme.colors.text.secondary,
        fontSize: stageVisualTokens.narration.bodyFontSize,
        lineHeight: stageVisualTokens.narration.bodyLineHeight,
        maxWidth: stageVisualTokens.narration.bodyMaxWidth,
    },
}));

export function buildRevealTitleWords(title: string): RevealTitleWord[] {
    return title.trim().split(/\s+/).filter((word) => word.length > 0).map((word, index) => ({
        text: word,
        delayMs: index * TITLE_WORD_STAGGER_MS,
    }));
}

export function RevealTitleWordText(props: Readonly<{
    reducedMotion?: boolean;
    revealGate?: boolean;
    word: RevealTitleWord;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const reducedMotion = props.reducedMotion === true;
    const revealGate = props.revealGate !== false;
    const revealProgress = useSharedValue(reducedMotion ? 1 : 0);

    React.useEffect(() => {
        if (reducedMotion) {
            revealProgress.value = 1;
            return;
        }

        if (!revealGate) {
            revealProgress.value = 0;
            return;
        }

        revealProgress.value = withDelay(
            props.word.delayMs,
            withTiming(1, {
                duration: TITLE_WORD_REVEAL_DURATION_MS,
                easing: Easing.out(Easing.cubic),
            }),
        );
    }, [props.word.delayMs, reducedMotion, revealGate, revealProgress]);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: revealProgress.value,
        transform: [{ translateY: (1 - revealProgress.value) * TITLE_WORD_REVEAL_OFFSET_Y }],
    }));

    return (
        <AnimatedText testID={props.testID} style={[styles.titleWord, animatedStyle]}>
            {props.word.text}
        </AnimatedText>
    );
}

function RevealTitle(props: Readonly<{
    reducedMotion?: boolean;
    revealGate?: boolean;
    title: string;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const words = React.useMemo(() => buildRevealTitleWords(props.title), [props.title]);

    return (
        <Text testID={props.testID} style={styles.title}>
            {words.map((word, index) => (
                <React.Fragment key={`${word.text}:${index}`}>
                    {index > 0 ? ' ' : null}
                    <RevealTitleWordText
                        reducedMotion={props.reducedMotion}
                        revealGate={props.revealGate}
                        testID={`${props.testID}-word`}
                        word={word}
                    />
                </React.Fragment>
            ))}
        </Text>
    );
}

export function NarrationBeat(props: NarrationBeatProps): React.ReactElement {
    const styles = stylesheet;
    useUnistyles();
    const testID = props.testID ?? 'journey-narration-beat';
    const reducedMotion = props.reducedMotion === true;
    const title = t(props.beat.narrationKeys.title);

    return (
        <View testID={testID} style={styles.root}>
            <RevealTitle
                reducedMotion={reducedMotion}
                revealGate={props.revealGate}
                title={title}
                testID={`${testID}-title`}
            />
            <Text testID={`${testID}-body`} style={styles.body}>
                {t(props.beat.narrationKeys.body)}
            </Text>
        </View>
    );
}
