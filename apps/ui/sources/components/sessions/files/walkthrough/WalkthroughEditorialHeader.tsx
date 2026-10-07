import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ScmComparisonSourceFact } from '@/components/sessions/files/comparison/ScmComparisonHeader';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WalkthroughAnalysisFact, WalkthroughGeneratedMark, WalkthroughReviewedFact, WalkthroughStopNumber } from './WalkthroughAtoms';
import type { WalkthroughCodeMapFile, WalkthroughReading } from './walkthroughReading';

export type WalkthroughEditorialHeaderProps = Readonly<{
    reading: WalkthroughReading;
    scopeLabel: string;
    scopeDetail?: string | null;
    /** The model that wrote it, as a person reads it ("Opus 5.5"); null keeps "Generated" alone. */
    modelLabel?: string | null;
    /** What the Generated mark says when it is more than the model ("Opus 5.5 · continues the review"). */
    generatedLabel?: string | null;
    /** The analysis fact's mark (the writing agent's identity mark), when the caller has it. */
    analysisMark?: React.ReactNode;
    reviewedProgressAvailable?: boolean;
    phone?: boolean;
    narrow?: boolean;
    overviewOpen: boolean;
    onToggleOverview: () => void;
    /** The stop whose files the overview outlines: the one being read. */
    highlightedStopId: string | null;
    onSelectStop: (stopId: string) => void;
    /** What the eyebrow says while nothing is written yet; "Reading the changes…" by default. */
    writingLabel?: string;
    /** A second coverage line from another owner (a review's findings, lab WT5-R1). */
    extraFact?: React.ReactNode;
    /** A note under the coverage (a narrator saying it read the diffs but did not review them, lab WT5-R9). */
    note?: React.ReactNode;
}>;

/**
 * The Walkthrough's one hero (lab WT1-A, B's editorial header): eyebrow with the scope and authorship,
 * the change's own title, a short intro, the three coverage notions side by side, and the optional
 * overview strip. While nothing is written yet, the title and intro reserve their space.
 */
export const WalkthroughEditorialHeader = React.memo(function WalkthroughEditorialHeader(props: WalkthroughEditorialHeaderProps) {
    const { theme } = useUnistyles();
    const reading = props.reading;
    const phone = props.phone === true;
    const writing = reading.phase === 'inventory' || (Boolean(props.writingLabel) && reading.phase === 'arriving');
    const hasStops = reading.stops.length > 0;
    const coverage = {
        fileCount: reading.source.fileCount,
        added: reading.source.added,
        removed: reading.source.removed,
        linesKnown: reading.source.linesKnown,
    };
    const stopped = reading.phase === 'failed' || reading.phase === 'cancelled' || reading.phase === 'partial';
    const facts = (
        <>
            <ScmComparisonSourceFact coverage={coverage} changeCount={reading.source.changeCount} testID="walkthrough-source-fact" />
            {reading.analysis ? (
                <WalkthroughAnalysisFact
                    analysed={reading.analysis.analysed}
                    parts={reading.analysis.parts}
                    total={reading.analysis.total}
                    model={props.modelLabel}
                    stopped={stopped && reading.analysis.analysed < reading.analysis.total}
                    unavailableCount={reading.source.unavailableCount}
                    mark={props.analysisMark}
                />
            ) : null}
            {props.reviewedProgressAvailable !== false && hasStops && !writing && reading.phase !== 'arriving' ? (
                <WalkthroughReviewedFact count={reading.reviewedCount} total={reading.stops.length} />
            ) : null}
        </>
    );
    return (
        <View testID="walkthrough-editorial-header" style={[styles.header, phone ? styles.headerPhone : null]}>
            <View style={styles.eyebrow}>
                <Icon name="path" size={13} color={theme.colors.text.tertiary} />
                <Text style={styles.eyebrowView}>{t('walkthrough.eyebrow')}</Text>
                <Text style={styles.eyebrowScope} numberOfLines={1}>
                    {`· ${props.scopeLabel}${props.scopeDetail && !phone && !props.narrow ? ` · ${props.scopeDetail}` : ''}`}
                </Text>
                <View style={styles.grow} />
                {writing ? (
                    <View style={styles.writing}>
                        <View style={styles.writingDot} />
                        <Text style={styles.writingText}>{props.writingLabel ?? t('walkthrough.readingChanges')}</Text>
                    </View>
                ) : hasStops || reading.title ? <WalkthroughGeneratedMark model={props.generatedLabel ?? props.modelLabel} /> : null}
            </View>
            {reading.title ? (
                <Text accessibilityRole="header" style={[styles.title, phone ? styles.titlePhone : null]}>{reading.title}</Text>
            ) : writing ? (
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.skeleton}>
                    <View style={[styles.skeletonBar, styles.skeletonTitle]} />
                    <View style={[styles.skeletonBar, styles.skeletonLine]} />
                    <View style={[styles.skeletonBar, styles.skeletonLineShort]} />
                </View>
            ) : null}
            {reading.titleEdited ? <Text testID="walkthrough-title-edited" style={styles.eyebrowScope}>{t('walkthrough.progress.titleEdited')}</Text> : null}
            {reading.intro && reading.phase !== 'arriving' ? (
                <View style={styles.introFrame}>
                    <MarkdownView
                        markdown={reading.intro}
                        textStyle={phone ? { fontSize: 16, lineHeight: 24, color: theme.colors.text.secondary } : { fontSize: 15, lineHeight: 23, color: theme.colors.text.secondary }}
                        renderCacheKey={`walkthrough-intro:${reading.title ?? ''}`}
                    />
                </View>
            ) : null}
            <View style={[styles.coverage, phone ? styles.coveragePhone : null]}>{facts}</View>
            {props.extraFact ? <View style={styles.extraFact}>{props.extraFact}</View> : null}
            {props.note}
            {hasStops && reading.phase !== 'arriving' && reading.codeMap.length > 1 ? (
                <WalkthroughOverviewStrip
                    files={reading.codeMap}
                    stops={reading.stops}
                    open={props.overviewOpen}
                    phone={phone}
                    onToggle={props.onToggleOverview}
                    highlightedStopId={props.highlightedStopId}
                    onSelectStop={props.onSelectStop}
                />
            ) : null}
        </View>
    );
});

function Miniature(props: Readonly<{ file: WalkthroughCodeMapFile; size: 'mini' | 'tile'; outlined?: boolean }>) {
    const tile = props.size === 'tile';
    return (
        <View style={[tile ? styles.tile : styles.mini, props.outlined ? styles.tileOutlined : null, props.file.generated ? styles.tileGenerated : null]}>
            {props.file.lines.slice(0, tile ? 11 : 5).map((line, index) => (
                <View
                    key={index}
                    style={[
                        tile ? styles.tileLine : styles.miniLine,
                        { width: `${tile ? line.widthPct : 100}%` },
                        line.kind === 'added' ? styles.lineAdded : line.kind === 'removed' ? styles.lineRemoved : styles.lineContext,
                    ]}
                />
            ))}
        </View>
    );
}

/** B's code map, kept as an optional strip: collapsed to one line, open to a miniature per file (lab WT1-A3). */
function WalkthroughOverviewStrip(props: Readonly<{
    files: readonly WalkthroughCodeMapFile[];
    stops: WalkthroughReading['stops'];
    open: boolean;
    phone: boolean;
    onToggle: () => void;
    highlightedStopId: string | null;
    onSelectStop: (stopId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const highlighted = props.stops.find((stop) => stop.id === props.highlightedStopId) ?? props.stops[0] ?? null;
    const toggle = (
        <HappierPressable
            testID="walkthrough-overview-toggle"
            accessibilityRole="button"
            expanded={props.open}
            accessibilityLabel={t('walkthrough.showOverviewA11y', { count: props.files.length })}
            onPress={props.onToggle}
            style={(state) => [styles.overviewHead, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <Icon name={props.open ? 'caret-down' : 'caret-right'} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
            <Text style={styles.overviewTitle}>{t('walkthrough.overview')}</Text>
            {props.phone && !props.open ? null : (
                <Text style={styles.overviewMeta} numberOfLines={1}>
                    {props.open && !props.phone
                        ? `${t('walkthrough.codeMapOf', { count: props.files.length })} · ${t('walkthrough.codeMapHint')}`
                        : t('walkthrough.codeMapOf', { count: props.files.length })}
                </Text>
            )}
            <View style={styles.grow} />
            {props.open ? null : (
                <View style={styles.minis} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    {props.files.slice(0, 12).map((file) => <Miniature key={file.path} file={file} size="mini" />)}
                </View>
            )}
        </HappierPressable>
    );
    if (!props.open) return <View testID="walkthrough-overview" style={styles.overview}>{toggle}</View>;
    const tiles = props.files.map((file) => {
        const outlined = highlighted ? file.stopIds.includes(highlighted.id) : false;
        return (
            <HappierPressable
                key={file.path}
                testID={`walkthrough-overview-file-${file.path}`}
                accessibilityRole="button"
                accessibilityLabel={file.label}
                onPress={() => { if (file.stopIds[0]) props.onSelectStop(file.stopIds[0]); }}
                style={styles.tileFrame}
            >
                <Miniature file={file} size="tile" outlined={outlined} />
                <Text style={styles.tileLabel} numberOfLines={1}>{file.label}</Text>
            </HappierPressable>
        );
    });
    return (
        <View testID="walkthrough-overview" style={[styles.overview, styles.overviewOpen]}>
            {toggle}
            {props.phone
                ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tiles}>{tiles}</ScrollView>
                : <View style={[styles.tiles, styles.tilesWrap]}>{tiles}</View>}
            {highlighted ? (
                <View style={styles.overviewCaption}>
                    <WalkthroughStopNumber number={highlighted.number} reviewed={false} size="rail" />
                    <Text style={styles.overviewCaptionText}>
                        <Text style={styles.overviewCaptionStrong}>{highlighted.title}</Text>
                        {` ${t('walkthrough.touchesOutlined')}`}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    header: {
        paddingTop: 34,
        paddingBottom: 22,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
        marginBottom: 8,
    },
    headerPhone: { paddingTop: 18, paddingHorizontal: 16, paddingBottom: 18, marginBottom: 0 },
    eyebrow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 10 },
    eyebrowView: { fontSize: 13, color: theme.colors.text.secondary, ...Typography.default('semiBold') },
    eyebrowScope: { fontSize: 13, color: theme.colors.text.tertiary, flexShrink: 1, ...Typography.default() },
    grow: { flex: 1 },
    writing: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    extraFact: { marginTop: 8 },
    writingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.text.tertiary },
    writingText: { fontSize: 12.5, color: theme.colors.text.tertiary, ...Typography.default('medium') },
    title: {
        fontSize: 27,
        lineHeight: 33,
        letterSpacing: -0.6,
        maxWidth: 660,
        color: theme.colors.text.primary,
        ...Typography.default('bold'),
    },
    titlePhone: { fontSize: 25, lineHeight: 31 },
    skeleton: { gap: 10, paddingTop: 4 },
    skeletonBar: { height: 12, borderRadius: 6, backgroundColor: theme.colors.surface.inset },
    skeletonTitle: { height: 20, width: '72%' },
    skeletonLine: { width: '92%' },
    skeletonLineShort: { width: '84%' },
    // The intro's type goes to the markdown owner as a plain style: it reads colour from the value it is given.
    introFrame: { marginTop: 10, maxWidth: 640 },
    coverage: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 6, marginTop: 16 },
    coveragePhone: { flexDirection: 'column', alignItems: 'flex-start', rowGap: 8 },
    overview: {
        marginTop: 18,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        maxWidth: 916,
    },
    overviewOpen: { paddingBottom: 12 },
    overviewHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 14 },
    overviewTitle: { fontSize: 13.5, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    overviewMeta: { fontSize: 13, color: theme.colors.text.tertiary, flexShrink: 1, ...Typography.default() },
    minis: { flexDirection: 'row', gap: 4 },
    mini: {
        width: 16,
        height: 22,
        borderRadius: 3,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        paddingHorizontal: 3,
        paddingVertical: 4,
        gap: 2,
        justifyContent: 'center',
    },
    miniLine: { height: 2, borderRadius: 1 },
    tiles: { flexDirection: 'row', gap: 8, paddingHorizontal: 14 },
    tilesWrap: { flexWrap: 'wrap' },
    tileFrame: { width: 66, alignItems: 'center', gap: 6 },
    tile: {
        width: 66,
        height: 78,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        padding: 7,
        gap: 3,
        overflow: 'hidden',
    },
    tileOutlined: { borderWidth: 2, borderColor: theme.colors.text.primary, padding: 6 },
    tileGenerated: { opacity: 0.55 },
    tileLine: { height: 3, borderRadius: 1.5 },
    lineAdded: { backgroundColor: theme.colors.state.success.foreground },
    lineRemoved: { backgroundColor: theme.colors.state.danger.foreground },
    lineContext: { backgroundColor: theme.colors.border.default },
    tileLabel: { fontSize: 11.5, color: theme.colors.text.secondary, maxWidth: 66, ...Typography.default() },
    overviewCaption: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 12 },
    overviewCaptionText: { fontSize: 13, color: theme.colors.text.secondary, ...Typography.default() },
    overviewCaptionStrong: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
}));
