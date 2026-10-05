import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import type { ScmDiffSummaryAnalysisCoverage } from '@happier-dev/protocol/scm';

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
            <Text style={styles.generatedText}>
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
    const { theme } = useUnistyles();
    const who = props.model ?? t('walkthrough.modelFallback');
    const amber = (props.unavailableCount ?? 0) > 0 || props.stopped === true;
    const sentence = props.analysed >= props.total && props.total > 0 && !props.stopped
        ? t('walkthrough.analysisAll', { who, count: props.total })
        : props.stopped
            ? t('walkthrough.analysisStopped', { who, analysed: props.analysed, total: props.total })
            : t('walkthrough.analysisSome', { who, analysed: props.analysed, total: props.total });
    return (
        <View testID="walkthrough-analysis-fact" style={styles.fact}>
            {amber
                ? <Icon name="warning" size={ICON_SIZE.xs} color={theme.colors.state.warning.foreground} />
                : props.mark ?? <Icon name="sparkle" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />}
            <Text style={styles.factText}>{sentence}</Text>
            {props.parts ? <Text testID="walkthrough-parts-progress" accessibilityLiveRegion="polite" style={styles.factText}>
                {` · ${t('walkthrough.progress.parts', props.parts)}${props.parts.phase === 'merge' ? ` · ${t('walkthrough.progress.merge')}` : ''}`}
            </Text> : null}
            {(props.unavailableCount ?? 0) > 0 ? (
                <Text style={styles.factText}>{` · ${t('walkthrough.unavailableCount', { count: props.unavailableCount ?? 0 })}`}</Text>
            ) : null}
        </View>
    );
}

/** The person's explicit marks, the third notion ("You reviewed 2 of 5"). */
export function WalkthroughReviewedFact(props: Readonly<{ count: number; total: number }>) {
    const { theme } = useUnistyles();
    return (
        <View testID="walkthrough-reviewed-fact" style={styles.fact}>
            <Icon name="check-circle" size={ICON_SIZE.xs} color={theme.colors.state.success.foreground} />
            <Text style={styles.factText}>{t('walkthrough.youReviewed', { count: props.count, total: props.total })}</Text>
        </View>
    );
}

/** A file path as the lab draws it: dim folder, strong name. */
/** A long folder keeps its first two and last segments ("apps/ui/…/settings/"), so the file name always shows. */
export function shortenWalkthroughFolder(folder: string): string {
    const segments = folder.split('/').filter((segment) => segment.length > 0);
    if (segments.length <= 3) return folder;
    return `${segments.slice(0, 2).join('/')}/…/${segments[segments.length - 1]}/`;
}

export function WalkthroughPath(props: Readonly<{ path: string }>) {
    const slash = props.path.lastIndexOf('/');
    const folder = slash >= 0 ? shortenWalkthroughFolder(props.path.slice(0, slash + 1)) : '';
    const name = slash >= 0 ? props.path.slice(slash + 1) : props.path;
    return (
        <Text style={styles.path} numberOfLines={1} accessibilityLabel={props.path}>
            {folder ? <Text style={styles.pathFolder}>{folder}</Text> : null}
            <Text style={styles.pathName}>{name}</Text>
        </Text>
    );
}

export function WalkthroughLineCounts(props: Readonly<{ added: number; removed: number }>) {
    return (
        <Text style={styles.counts}>
            {props.added > 0 ? <Text style={styles.added}>{`+${props.added}`}</Text> : null}
            {props.added > 0 && props.removed > 0 ? ' ' : null}
            {props.removed > 0 ? <Text style={styles.removed}>{`−${props.removed}`}</Text> : null}
        </Text>
    );
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
        fontSize: 11.5,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
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
    generated: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0, maxWidth: '100%' },
    generatedText: { fontSize: 12.5, color: theme.colors.text.tertiary, flexShrink: 1, minWidth: 0, ...Typography.default('medium') },
    fact: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    factText: { fontSize: 13, color: theme.colors.text.secondary, fontVariant: ['tabular-nums'], ...Typography.default() },
    path: { flexShrink: 1, minWidth: 0, fontSize: 13, ...Typography.default() },
    pathFolder: { color: theme.colors.text.tertiary },
    pathName: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
    counts: { fontSize: 12, fontVariant: ['tabular-nums'], ...Typography.default() },
    added: { color: theme.colors.state.success.foreground },
    removed: { color: theme.colors.state.danger.foreground },
}));
