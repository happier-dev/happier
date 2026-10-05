import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

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
    /** Narrow widths: one coverage fact per line, the accessory row under them. */
    stacked?: boolean;
    testID?: string;
}>;

/**
 * The compact editorial header of a comparison view (Walkthrough lab WT8): an eyebrow naming the view
 * and scope, the change's title, and one coverage line whose three notions (the source, the model's
 * reading, the person's marks) are never merged into one number.
 */
export const ScmComparisonHeader = React.memo(function ScmComparisonHeader(props: ScmComparisonHeaderProps) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'scm-comparison-header';
    const title = typeof props.title === 'string' && props.title.trim().length > 0 ? props.title.trim() : null;
    const coverage = props.coverage;
    const source = <ScmComparisonSourceFact coverage={coverage} changeCount={props.changeCount} testID={`${testID}-source`} />;

    return (
        <View testID={testID} style={[styles.header, props.stacked ? styles.headerStacked : null]}>
            <View style={styles.main}>
                {props.stacked ? null : (
                    <View style={styles.eyebrow}>
                        <Icon name="files" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                        <Text style={styles.eyebrowView}>{props.viewLabel}</Text>
                        <Text style={styles.eyebrowScope} numberOfLines={1}>
                            {`· ${props.scopeLabel}${props.scopeDetail ? ` · ${props.scopeDetail}` : ''}`}
                        </Text>
                    </View>
                )}
                {title ? <Text accessibilityRole="header" style={[styles.title, props.stacked ? styles.titleStacked : null]}>{title}</Text> : null}
                <View style={[styles.coverage, props.stacked ? styles.coverageStacked : null]}>
                    {source}
                    {props.analysis ?? null}
                    {props.reviewed ?? null}
                </View>
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
    const { theme } = useUnistyles();
    const coverage = props.coverage;
    return (
        <View testID={props.testID} style={styles.fact}>
            <Icon name="file" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
            <Text style={styles.factText}>
                <Text style={styles.factStrong}>{t('scmComparison.fileCount', { count: coverage.fileCount })}</Text>
                {typeof props.changeCount === 'number' ? (
                    <>
                        <Text style={styles.factText}>{' · '}</Text>
                        <Text style={styles.factStrong}>{t('scmComparison.changeCount', { count: props.changeCount })}</Text>
                    </>
                ) : null}
                {coverage.linesKnown ? (
                    <>
                        <Text style={styles.factText}>{' · '}</Text>
                        <Text style={styles.added}>{`+${coverage.added.toLocaleString()}`}</Text>
                        <Text style={styles.factText}>{' '}</Text>
                        <Text style={styles.removed}>{`−${coverage.removed.toLocaleString()}`}</Text>
                    </>
                ) : null}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 16,
        paddingHorizontal: 24,
        paddingTop: 18,
        paddingBottom: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    headerStacked: {
        paddingHorizontal: 16,
        paddingTop: 14,
    },
    main: {
        flex: 1,
        minWidth: 0,
        gap: 6,
    },
    eyebrow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    eyebrowView: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    eyebrowScope: {
        fontSize: 13,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
    },
    title: {
        fontSize: 22,
        lineHeight: 28,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    titleStacked: {
        fontSize: 24,
        lineHeight: 30,
    },
    coverage: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 16,
        rowGap: 6,
        marginTop: 2,
    },
    coverageStacked: {
        flexDirection: 'column',
        alignItems: 'flex-start',
    },
    fact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    factText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
        ...Typography.default(),
    },
    factStrong: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    added: {
        fontSize: 13,
        fontVariant: ['tabular-nums'],
        color: theme.colors.state.success.foreground,
        ...Typography.default(),
    },
    removed: {
        fontSize: 13,
        fontVariant: ['tabular-nums'],
        color: theme.colors.state.danger.foreground,
        ...Typography.default(),
    },
    accessory: {
        flexShrink: 0,
    },
    accessoryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 8,
    },
}));
