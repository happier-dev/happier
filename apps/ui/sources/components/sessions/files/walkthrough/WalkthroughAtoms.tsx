import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ScmComparisonFact, ScmComparisonFactSentence, ScmComparisonFactText } from '@/components/sessions/files/comparison/ScmComparisonHeader';
import { t } from '@/text';
import type { ScmDiffSummaryAnalysisCoverage } from '@happier-dev/protocol/scm';
import type { WalkthroughReviewedSource } from './walkthroughReviewedProjection';
import { useWalkthroughReviewedCount } from './useWalkthroughReviewed';

/**
 * A stop's number, and its reviewed state. The signature moment of the Walkthrough (lab WT1 Motion): when
 * the person marks a stop, the ring fills and the check arrives in one base-duration settle on the
 * standard curve; reduced motion swaps at once. Nothing else animates on a mark.
 */
export const WalkthroughStopNumber = React.memo(function WalkthroughStopNumber(props: Readonly<{
    number: number;
    reviewed: boolean;
    current?: boolean;
    size?: 'stream' | 'rail';
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const progress = useSharedValue(props.reviewed ? 1 : 0);
    React.useEffect(() => {
        const target = props.reviewed ? 1 : 0;
        progress.value = reducedMotion
            ? target
            : withTiming(target, { duration: motionTokens.durationMs.base, easing: Easing.bezier(0.2, 0, 0, 1) });
    }, [progress, props.reviewed, reducedMotion]);
    const fillStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ scale: 0.6 + 0.4 * progress.value }],
    }));
    const numberStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
    const rail = props.size === 'rail';
    const box = rail ? styles.boxRail : styles.boxStream;
    return (
        <View
            accessibilityLabel={props.reviewed ? t('walkthrough.stopReviewedA11y', { number: props.number }) : undefined}
            style={[styles.box, box, props.current && !props.reviewed ? styles.ringCurrent : styles.ring]}
        >
            <Animated.Text style={[styles.number, rail ? styles.numberRail : null, props.current ? styles.numberCurrent : null, numberStyle]}>
                {String(props.number)}
            </Animated.Text>
            <Animated.View style={[styles.fill, fillStyle]} pointerEvents="none">
                <Icon name="check" size={rail ? 10 : 12} weight="bold" color={theme.colors.surface.base} />
            </Animated.View>
        </View>
    );
});

/** The neutral authorship mark of model-written content (no colour): sparkle + "Generated · model". */
export function WalkthroughGeneratedMark(props: Readonly<{ model?: string | null; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} accessibilityLabel={t('walkthrough.generatedA11y')} style={styles.generated}>
            <Icon name="sparkle" size={12} color={theme.colors.text.tertiary} />
            <Text style={styles.generatedText} numberOfLines={1}>
                {props.model ? t('walkthrough.generatedBy', { model: props.model }) : t('walkthrough.generated')}
            </Text>
        </View>
    );
}

/** The model's reading, one of the three coverage notions ("Opus 5.5 read all 14"). */
export function WalkthroughAnalysisFact(props: Readonly<{
    analysed: number;
    total: number;
    model?: string | null;
    stopped?: boolean;
    unavailableCount?: number;
    mark?: React.ReactNode;
    parts?: ScmDiffSummaryAnalysisCoverage['parts'];
}>) {
    const who = props.model ?? t('walkthrough.modelFallback');
    const amber = (props.unavailableCount ?? 0) > 0 || props.stopped === true;
    const sentence = props.analysed >= props.total && props.total > 0 && !props.stopped
        ? t('walkthrough.analysisAll', { who, count: props.total })
        : props.stopped
            ? t('walkthrough.analysisStopped', { who, analysed: props.analysed, total: props.total })
            : t('walkthrough.analysisSome', { who, analysed: props.analysed, total: props.total });
    const icon = amber ? 'warning' : React.isValidElement(props.mark) ? props.mark : 'sparkle';
    return (
        <ScmComparisonFact testID="walkthrough-analysis-fact" icon={icon} tone={amber ? 'warning' : 'neutral'}>
            <ScmComparisonFactSentence sentence={sentence} counts={[props.analysed, props.total]} after={who} />
            {/* Parts are progress: once reading has stopped, "read x of y" is the whole coverage. The row's gap spaces each fact. */}
            {props.parts && !props.stopped ? <ScmComparisonFactText testID="walkthrough-parts-progress" accessibilityLiveRegion="polite">
                {`· ${t('walkthrough.progress.parts', props.parts)}${props.parts.phase === 'merge' ? ` · ${t('walkthrough.progress.merge')}` : ''}`}
            </ScmComparisonFactText> : null}
            {(props.unavailableCount ?? 0) > 0 ? (
                <ScmComparisonFactText>{`· ${t('walkthrough.unavailableCount', { count: props.unavailableCount ?? 0 })}`}</ScmComparisonFactText>
            ) : null}
        </ScmComparisonFact>
    );
}

/**
 * The person's explicit marks, the third notion ("You reviewed 2 of 5"). While the marks are still being read it holds its
 * room, unseen, so the content below does not move when they arrive.
 */
export function WalkthroughReviewedFact(props: Readonly<{ count: number; total: number; pending?: boolean; source?: WalkthroughReviewedSource }>) {
    const count = useWalkthroughReviewedCount(props.source, props.count);
    const fact = (
        <ScmComparisonFact testID="walkthrough-reviewed-fact" icon="check-circle" tone="success">
            <ScmComparisonFactSentence sentence={t('walkthrough.youReviewed', { count, total: props.total })} counts={[count, props.total]} />
        </ScmComparisonFact>
    );
    return props.pending
        ? <View style={styles.reserved} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{fact}</View>
        : fact;
}

const styles = StyleSheet.create((theme) => ({
    box: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    boxStream: { width: 22, height: 22, borderRadius: 11 },
    boxRail: { width: 18, height: 18, borderRadius: 9 },
    ring: { borderWidth: 1.25, borderColor: theme.colors.border.strong },
    ringCurrent: { borderWidth: 1.5, borderColor: theme.colors.text.primary },
    number: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    numberRail: { fontSize: 10 },
    numberCurrent: { color: theme.colors.text.primary },
    fill: {
        position: 'absolute',
        top: -1.5,
        left: -1.5,
        right: -1.5,
        bottom: -1.5,
        borderRadius: 999,
        backgroundColor: theme.colors.state.success.foreground,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // On a narrow eyebrow the model label yields first: what is compared (the scope) outranks who wrote it. The mark
    // claims only the room left after the scope (no basis of its own, right-aligned), so even a hair of shortfall
    // ellipsizes the model, never the scope.
    reserved: { opacity: 0 },
    generated: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.s4, flexGrow: 1000, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    generatedText: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.tertiary, flexShrink: 1, minWidth: 0,  },
}));
