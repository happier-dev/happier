import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { DiffStat } from '@/components/workspaces/scm/DiffStat';

export type ScmComparisonCoverage = Readonly<{
    fileCount: number;
    added: number;
    removed: number;
    /** False when a file's line counts are unknown: then no line totals are claimed. */
    linesKnown: boolean;
}>;

export type ScmComparisonHeaderProps = Readonly<{
    /** "Files", the view this header heads. */
    viewLabel: string;
    /** The comparison's name ("This session"). */
    scopeLabel: string;
    /** What the scope spans, when known ("since 09:40 · 3 turns with changes"). */
    scopeDetail?: string | null;
    /** The change's own title once a walkthrough has written one; until then the kicker names the scope. */
    title?: string | null;
    coverage: ScmComparisonCoverage;
    /** The comparison's exact change count, once the captured inventory is known ("14 changes"). */
    changeCount?: number | null;
    /** The model's coverage ("Opus 5.5 read all 14") once an analysis exists (U3). */
    analysis?: React.ReactNode;
    /** The person's explicit marks ("You reviewed 2 of 5") once a walkthrough exists (U3). */
    reviewed?: React.ReactNode;
    /** The Explain switch, offered once a walkthrough exists (U3). */
    accessory?: React.ReactNode;
    /** Files whose Viewed mark a newer change cleared ("2 files changed since you viewed them"); 0 or absent says nothing. */
    changedSinceViewedCount?: number;
    /** Narrow widths: one coverage fact per line, the accessory row under them. */
    stacked?: boolean;
    /** Inside a page that already names and counts the comparison (a Review): no eyebrow and no source fact. */
    hosted?: boolean;
    testID?: string;
}>;

/**
 * The compact editorial header of a comparison view (Walkthrough lab WT8): an eyebrow naming the view
 * and scope, the change's title, and one coverage line whose three notions (the source, the model's
 * reading, the person's marks) are never merged into one number.
 */
export const ScmComparisonHeader = React.memo(function ScmComparisonHeader(props: ScmComparisonHeaderProps) {
    const testID = props.testID ?? 'scm-comparison-header';
    const title = typeof props.title === 'string' && props.title.trim().length > 0 ? props.title.trim() : null;
    const coverage = props.coverage;
    const source = props.hosted ? null : <ScmComparisonSourceFact coverage={coverage} changeCount={props.changeCount} testID={`${testID}-source`} />;

    return (
        <View testID={testID} style={[styles.header, props.stacked ? styles.headerStacked : null]}>
            <View style={styles.main}>
                {props.stacked || props.hosted ? null : (
                    <ScmComparisonEyebrow icon="files" viewLabel={props.viewLabel} scope={props.scopeLabel} detail={props.scopeDetail} />
                )}
                {title ? <Text accessibilityRole="header" style={styles.title}>{title}</Text> : null}
                <View style={[styles.coverage, props.stacked ? styles.coverageStacked : null]}>
                    {source}
                    {props.analysis ?? null}
                    {props.reviewed ?? null}
                </View>
                {props.changedSinceViewedCount ? (
                    <View style={[styles.coverage, props.stacked ? styles.coverageStacked : null]}>
                        <ScmComparisonFact testID="scm-comparison-changed-since-viewed" icon="clock-counter-clockwise" tone="warning">
                            <ScmComparisonFactSentence sentence={t('hunkReview.viewedChangedCount', { count: props.changedSinceViewedCount })}
                                counts={[props.changedSinceViewedCount]} />
                        </ScmComparisonFact>
                    </View>
                ) : null}
                {props.stacked && props.accessory ? <View style={styles.accessoryRow}>{props.accessory}</View> : null}
            </View>
            {!props.stacked && props.accessory ? <View style={styles.accessory}>{props.accessory}</View> : null}
        </View>
    );
});

/**
 * The source fact of a comparison ("9 files · 14 changes · +118 −21"): what changes exist, independent
 * of what a model read or what the person marked. Shared by the Files and Walkthrough headers.
 */
export function ScmComparisonSourceFact(props: Readonly<{ coverage: ScmComparisonCoverage; changeCount?: number | null; testID?: string }>) {
    const coverage = props.coverage;
    return (
        <ScmComparisonFact testID={props.testID} icon="file">
            <Text style={styles.factText}>
                <Text style={styles.factStrong}>{t('scmComparison.fileCount', { count: coverage.fileCount })}</Text>
                {typeof props.changeCount === 'number' ? (
                    <>
                        <Text style={styles.factText}>{' · '}</Text>
                        <Text style={styles.factStrong}>{t('scmComparison.changeCount', { count: props.changeCount })}</Text>
                    </>
                ) : null}
                {coverage.linesKnown && (coverage.added > 0 || coverage.removed > 0) ? (
                    <>
                        <Text style={styles.factText}>{' · '}</Text>
                        <DiffStat added={coverage.added} removed={coverage.removed} />
                    </>
                ) : null}
            </Text>
        </ScmComparisonFact>
    );
}

/**
 * The eyebrow over a comparison view's title ("Files · This session · since 09:40"): the view, its
 * scope, and an optional trailing mark (the Walkthrough's Generated mark). Files and Walkthrough draw
 * this one line, so switching views keeps the header's first line identical.
 */
export function ScmComparisonEyebrow(props: Readonly<{
    icon: IconName;
    viewLabel: string;
    scope: string;
    detail?: string | null;
    trailing?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.eyebrow}>
            <Icon name={props.icon} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
            <Text style={styles.eyebrowView}>{props.viewLabel}</Text>
            <Text style={styles.eyebrowScope} numberOfLines={1}>{`· ${props.scope}${props.detail ? ` · ${props.detail}` : ''}`}</Text>
            {props.trailing ? <><View style={styles.grow} />{props.trailing}</> : null}
        </View>
    );
}

/**
 * One coverage fact (the source, the model's reading, the person's marks): a glyph and its sentence.
 * The three notions sit side by side in one line and are never merged into one number. `tone` colours
 * only the glyph; `icon` accepts an identity mark (the writing agent) in place of a glyph name.
 */
export function ScmComparisonFact(props: Readonly<{
    icon: IconName | React.ReactElement;
    tone?: 'neutral' | 'success' | 'warning';
    testID?: string;
    children: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const color = props.tone === 'success' ? theme.colors.state.success.foreground
        : props.tone === 'warning' ? theme.colors.state.warning.foreground : theme.colors.text.tertiary;
    return (
        <View testID={props.testID} style={styles.fact}>
            {typeof props.icon === 'string' ? <Icon name={props.icon} size={ICON_SIZE.xs} color={color} /> : props.icon}
            {props.children}
        </View>
    );
}

/**
 * A translated fact sentence with its counts in primary ink ("Opus 5.5 read all **14**", "You reviewed
 * **2** of **5**"), as the source fact sets "**9 files**". The counts are found as whole numbers after
 * `after` (the model's name, which may itself hold digits), so no locale has to split its sentence.
 */
export function ScmComparisonFactSentence(props: Readonly<{ sentence: string; counts: readonly number[]; after?: string | null }>) {
    const start = props.after ? Math.max(0, props.sentence.indexOf(props.after) + props.after.length) : 0;
    const head = props.sentence.slice(0, start);
    const tail = props.sentence.slice(start);
    // Sentences interpolate either the raw number or its locale form; accept both.
    const wanted = new Set(props.counts.flatMap((count) => [String(count), count.toLocaleString()]));
    const parts = tail.split(/(\d[\d,.\u202f\u00a0]*)/);
    return (
        <Text style={styles.factText}>
            {head}
            {parts.map((part, index) => (index % 2 === 1 && wanted.has(part)
                ? <Text key={index} style={styles.factStrong}>{part}</Text>
                : part))}
        </Text>
    );
}

/** A fact's words: secondary ink; `strong` sets the count that matters in primary ink. Nest for a strong part. */
export function ScmComparisonFactText(props: Readonly<{
    strong?: boolean;
    testID?: string;
    accessibilityLiveRegion?: 'polite';
    children: React.ReactNode;
}>) {
    return (
        <Text testID={props.testID} accessibilityLiveRegion={props.accessibilityLiveRegion} style={props.strong ? styles.factStrong : styles.factText}>
            {props.children}
        </Text>
    );
}

const styles = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s16,
        paddingHorizontal: theme.space.s24,
        paddingTop: 18,
        paddingBottom: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    headerStacked: {
        paddingHorizontal: theme.space.s16,
        paddingTop: 14,
    },
    main: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s6,
    },
    eyebrow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    grow: {
        flex: 1,
    },
    eyebrowView: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    eyebrowScope: {
        flexShrink: 1,
        minWidth: 0,
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
    },
    title: {
        ...Typography.variant('title'),
        color: theme.colors.text.primary,
    },
    coverage: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s16,
        rowGap: theme.space.s6,
        marginTop: theme.space.s2,
    },
    coverageStacked: {
        flexDirection: 'column',
        alignItems: 'flex-start',
    },
    fact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    factText: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    factStrong: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    accessory: {
        flexShrink: 0,
    },
    accessoryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        marginTop: theme.space.s8,
    },
}));
