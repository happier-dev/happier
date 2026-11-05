import { PaneMainRestoreChip, usePaneMainRestoreChipVisible } from './mainColumn/PaneMainColumnControls';
import { useContainingGlassSurfaceGroup } from '@/components/ui/glass/GlassSurface';
import * as React from 'react';
import { Platform, View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1, happierPageTextMetrics, useHappierMaterialColorResolver, useHappierTextPresentation } from '@happier-dev/plugin-ui/presentation';
import type { PluginUiDetailsPanePresentation } from '@happier-dev/plugin-ui/advanced';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import {
    HEADER_BAND_HORIZONTAL_PADDING_PX,
    HEADER_BAND_SUBTITLE_TEXT,
    HEADER_BAND_TITLE_TEXT,
} from '@/components/ui/layout/headerBand';
import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/store/hooks';
import { t } from '@/text';
import { useHeaderHeight, usePresentationWindowDimensions } from '@/utils/platform/responsive';

import type { PaneHeaderLine, PaneHeaderLineSegment } from './paneHeaderSlot';
import { PaneHeaderShade } from './paneHeaderScroll';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';

export type { PaneHeaderLine, PaneHeaderLineSegment } from './paneHeaderSlot';

const NO_BREAK_SPACE = '\u00A0';

/** `+4 −2` reads as one fact: two change counts in a row are spaced, not dotted. */
function isToneSegment(segment: PaneHeaderLineSegment): boolean {
    return typeof segment !== 'string' && 'tone' in segment;
}

function isLinkSegment(segment: PaneHeaderLineSegment): boolean {
    return typeof segment !== 'string' && ('icon' in segment || 'failure' in segment) && segment.onPress !== undefined;
}

function readSegmentText(segment: PaneHeaderLineSegment): string {
    return typeof segment === 'string' ? segment : segment.text;
}

/** A phone's large header gives its facts up to two lines; the band keeps one. */
const LARGE_FACTS_LINES = 2;

/**
 * The height of one line of facts as the facts' own text renders it. The row clips to this height,
 * so it follows the same effective line height as the child `Text`: the in-app text size
 * (web scales Text through a CSS variable the View's height never sees, native pre-scales the
 * style) and, on native, the OS font scale the host applies on top.
 */
function useFactsLineHeight(large: boolean): number {
    const uiFontScale = useLocalSetting('uiFontScale');
    const { metricScale } = useHappierTextPresentation({ textScale: uiFontScale });
    const { fontScale } = usePresentationWindowDimensions();
    const hostScale = Platform.OS === 'web' ? 1 : fontScale;
    const lineHeight = large ? happierPageTextMetrics('pageDescription').lineHeight : HEADER_BAND_SUBTITLE_TEXT.lineHeight;
    return lineHeight * metricScale * hostScale;
}

/**
 * The pane header's live line (a leading mark, then real nouns joined by " · "). One owner for the
 * band's line and for any host that states the same facts inline, such as the Session Board tab.
 */
export const PaneHeaderLineView = React.memo(function PaneHeaderLineView(props: Readonly<{
    line: PaneHeaderLine | null;
    large?: boolean;
    testID?: string;
    /** An inline affordance belonging to the final fact (copying its identifier). */
    lineEnd?: React.ReactNode;
    /** View controls aligned with the facts. */
    lineTrailing?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { line, large } = props;
    const testID = props.testID ?? 'pane-header';
    const factsLineHeight = useFactsLineHeight(large === true);
    const leadingSeparated = line?.leadingSeparated === true && line.segments.length > 0;
    const hasLink = line?.segments.some(isLinkSegment) === true;
    const subtitleStyle = [styles.subtitle, large ? styles.largeSubtitle : null];
    // One fact, after the `separator` that joins it to the one before (the band's " · ", or none).
    const renderFact = (segment: PaneHeaderLineSegment, index: number, separator: string): React.ReactNode => {
        if (typeof segment !== 'string' && 'icon' in segment) {
            // A glyph-led fact stays one item: the separator, its glyph, then its words.
            const onPress = segment.onPress;
            const fact = (hovered: boolean) => <>
                <Icon name={segment.icon} size={ICON_SIZE.xs} color={hovered ? theme.colors.text.primary : theme.colors.text.secondary} />
                <Text numberOfLines={1} style={[styles.subtitle, large ? styles.largeSubtitle : null, styles.iconFactText, hovered ? styles.linkHovered : null]}>{segment.text}</Text>
            </>;
            return (
                <View key={index} style={[styles.iconFact, index === 0 ? null : styles.followingFact]}>
                    {separator ? <Text style={[styles.subtitle, large ? styles.largeSubtitle : null]}>{separator}</Text> : null}
                    {onPress ? (
                        <HappierPressable testID={segment.testID} accessibilityRole="link" accessibilityLabel={segment.accessibilityLabel ?? segment.text}
                            onPress={onPress} style={(state) => [styles.iconFact, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                            {(state) => fact(state.hovered || state.focused)}
                        </HappierPressable>
                    ) : fact(false)}
                </View>
            );
        }
        if (typeof segment !== 'string' && 'failure' in segment && segment.onPress) {
            // A failure count that leads to its list ("3 problems" opens Problems).
            const onPress = segment.onPress;
            return (
                <View key={index} style={[styles.iconFact, index === 0 ? null : styles.followingFact]}>
                    {separator ? <Text style={[styles.subtitle, large ? styles.largeSubtitle : null]}>{separator}</Text> : null}
                    <HappierPressable testID={segment.testID} accessibilityRole="link" accessibilityLabel={segment.accessibilityLabel ?? segment.text}
                        onPress={onPress} style={(state) => [state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                        {(state) => (
                            <Text numberOfLines={1} style={[styles.subtitle, large ? styles.largeSubtitle : null, styles.failure,
                                state.hovered || state.focused ? styles.failureHovered : null]}>{segment.text}</Text>
                        )}
                    </HappierPressable>
                </View>
            );
        }
        return (
            <Text
                key={index}
                // A large header's fact wraps inside its two lines; the band's stays on its one.
                numberOfLines={large ? LARGE_FACTS_LINES : 1}
                style={[styles.subtitle, large ? styles.largeSubtitle : null, index === 0 ? null : styles.followingFact]}
            >
                {separator}
                {typeof segment === 'string'
                    ? segment
                    : 'tone' in segment
                        ? <Text style={segment.tone === 'added' ? styles.added : styles.removed}>{segment.text}</Text>
                        : 'attention' in segment
                            ? <Text style={styles.attention}>{segment.text}</Text>
                            : 'failure' in segment
                                ? <Text style={styles.failure}>{segment.text}</Text>
                            : <Text style={styles.emphasis}>{segment.text}</Text>}
            </Text>
        );
    };
    // The band's facts: each fact is its own flex item, where web collapses a leading space; a no-break space keeps the gap.
    const bandSeparator = (index: number): string => index === 0 || !line ? ''
        : isToneSegment(line.segments[index]!) && isToneSegment(line.segments[index - 1]!) ? NO_BREAK_SPACE : `${NO_BREAK_SPACE}·${NO_BREAK_SPACE}`;
    if (large && line && (line.segments.length > 0 || line.leading)) {
        // A phone's large header: the leading words and the facts are one quiet row that wraps from the
        // title's edge (files lab FV1p/FV6p). Every item carries its separator in a fixed-width box before it,
        // and the row starts one box to the left under the clip, so a separator that would open a line never shows.
        const items: React.ReactNode[][] = [];
        if (line.leading) items.push([<View key="leading" style={[styles.lineLeading, leadingSeparated ? null : styles.largeLeading]}>{line.leading}</View>]);
        line.segments.forEach((segment, index) => {
            const previous = index === 0 ? null : line.segments[index - 1]!;
            // `+4 −2` stays together; a mark's first fact follows it directly.
            const joined = previous ? isToneSegment(segment) && isToneSegment(previous) : line.leading !== undefined && line.leading !== null && !leadingSeparated;
            const fact = renderFact(segment, index, joined && previous ? NO_BREAK_SPACE : '');
            if (joined && items.length > 0) items[items.length - 1]!.push(fact);
            else items.push([fact]);
        });
        // The final fact's own trailing words (who wrote it, a copy control) wrap with that fact, inside the row.
        if (props.lineEnd) items[items.length - 1]!.push(<React.Fragment key="lineEnd">{props.lineEnd}</React.Fragment>);
        return (
            <View style={[styles.line, styles.largeLine]}>
                <View
                    testID={`${testID}.subtitle`}
                    accessible={!hasLink && !line.leading}
                    accessibilityLabel={hasLink || line.leading ? undefined : line.segments.map(readSegmentText).join(', ')}
                    style={[styles.facts, styles.largeFacts, { maxHeight: factsLineHeight * LARGE_FACTS_LINES }]}
                >
                    <View style={styles.largeFlow}>
                        {items.map((nodes, index) => (
                            <View key={index} style={styles.largeItem}>
                                <View style={styles.largeSeparator}>{index === 0 ? null : <Text style={subtitleStyle}>·</Text>}</View>
                                {nodes}
                            </View>
                        ))}
                    </View>
                </View>
            </View>
        );
    }
    return (
        <View style={styles.line}>
            {line?.leading ? (
                <View style={[styles.lineLeading, line.segments.length === 0 ? styles.leadingOnly : null, leadingSeparated ? styles.leadingSeparated : null]}>
                    {line.leading}
                    {leadingSeparated ? <Text style={subtitleStyle}>·</Text> : null}
                </View>
            ) : null}
            {line && line.segments.length > 0 ? (
                // One line of facts. A fact that does not fit wraps below the clip and drops whole, so
                // the band never ends on half a word ("6 wo…"); a lone long fact still ellipsizes.
                <View
                    testID={`${testID}.subtitle`}
                    // One spoken line, unless a fact on it is a link of its own to reach.
                    accessible={!hasLink}
                    accessibilityLabel={hasLink ? undefined : line.segments.map(readSegmentText).join(', ')}
                    style={[styles.facts, { height: factsLineHeight }]}
                >
                    {line.segments.map((segment, index) => renderFact(segment, index, bandSeparator(index)))}
                </View>
            ) : null}
            {props.lineEnd}
            {props.lineTrailing ? <View style={styles.lineTrailing}>{props.lineTrailing}</View> : null}
        </View>
    );
});

/** What a pane says about itself at the top: a title, an optional subtitle, optional actions. */
export type PaneHeaderContent = Readonly<{
    title: string;
    subtitle?: string | null;
    /**
     * The live line under the title (a branch, a count, what is waiting): real nouns joined by " · ".
     * Takes the subtitle's place when both are given.
     */
    line?: PaneHeaderLine | null;
    /** Trailing actions (icon buttons), before the close button. */
    actions?: React.ReactNode;
}>;

export type PaneHeaderProps = PaneHeaderContent & Readonly<{
    /** Semantic focus binding supplied by the pane content owner. */
    headingRef?: PluginUiDetailsPanePresentation['headingRef'];
    /** Identity mark beside the title; it has no backing tile. */
    leading?: React.ReactNode;
    /** A title that is itself a control, such as a named-object switcher. */
    titleControl?: React.ReactNode;
    /** null allows a long title to wrap; the default pane band stays on one line. */
    titleNumberOfLines?: number | null;
    titleTextStyle?: StyleProp<TextStyle>;
    /** View controls aligned with the facts rather than with the title actions. */
    lineTrailing?: React.ReactNode;
    /** An inline affordance belonging to the final fact (copying its identifier). */
    lineEnd?: React.ReactNode;
    /** Shows the close button. */
    onClose?: () => void;
    /** Leads the band with Back: the pane is a sub-page of the column it sits in (lab AR1 EFv). */
    onBack?: () => void;
    /**
     * A phone screen's navigation band (calm-shell `cshead.H1p`): Back to the previous screen leads it,
     * and with `includeTopInset` the band also clears the status bar.
     */
    navigation?: Readonly<{ onBack: () => void; includeTopInset?: boolean; backTestID?: string }>;
    /** A real fact above the title (a reporting Session's leads). */
    overline?: React.ReactNode;
    /**
     * Whether this band draws the scroll-linked shade beneath itself (default). A host that stacks rows
     * under the band (Details controls, a notice) draws the one shade under its whole stack instead.
     */
    shade?: boolean;
    /**
     * This pane is the hidden main column's neighbour: while main is hidden its restore chip leads
     * the band (lab ade-shell H1–H3).
     */
    mainRestoreChip?: boolean;
    /**
     * `band` (default): the side pane's header, in the session header's band. `large`: a phone
     * screen's large title over the same live line, below the navigation bar.
     */
    size?: 'band' | 'large';
    /** Reports the title row's own width (mark and name, unshrunk), so a host can leave the name its room. */
    onTitleNaturalWidth?: (width: number) => void;
    testID?: string;
}>;

/**
 * The header of a side pane (the right sidebar and the details pane). It sits in the same band as
 * the session header beside it — same height, inset and text — so the two read as one line.
 */
export const PaneHeader = React.memo(function PaneHeader(props: PaneHeaderProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const height = useHeaderHeight();
    const testID = props.testID ?? 'pane-header';
    const large = props.size === 'large';
    const line = props.line ?? (props.subtitle ? { segments: [props.subtitle] } : null);
    const chipVisible = usePaneMainRestoreChipVisible() && props.mainRestoreChip === true;
    const insets = useChromeSafeAreaInsets();
    const onNavigationPlane = useContainingGlassSurfaceGroup() === 'sidebar';
    const topInset = props.navigation?.includeTopInset ? insets.top : 0;
    const hasTitle = props.title.trim().length > 0 || Boolean(props.leading) || Boolean(props.titleControl) || chipVisible;
    return (
        <View testID={testID} style={[large ? styles.large : [styles.band, { height: height + topInset, paddingTop: topInset }],
            props.onBack || props.navigation ? styles.bandWithBack : null,
            // On the navigation plane (a side panel standing on the canvas) the band takes the plane's paint.
            { backgroundColor: onNavigationPlane ? 'transparent' : materialColor(theme.colors.surface.base, 'transparent') }]}>
            {props.navigation ? (
                <IconButton
                    testID={props.navigation.backTestID ?? `${testID}.back`}
                    iconName={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                    accessibilityLabel={t('common.back')}
                    variant="plain"
                    onPress={props.navigation.onBack}
                />
            ) : null}
            {props.onBack ? (
                <IconButton
                    testID={`${testID}.back`}
                    iconName="caret-left"
                    accessibilityLabel={t('panes.mainColumn.backToTranscript')}
                    tooltip={t('panes.mainColumn.backToTranscript')}
                    variant="plain"
                    onPress={props.onBack}
                />
            ) : null}
            {/* One identity block: the mark stands beside the text, and the overline, title and live line
                all start on the title's own text edge (lab cshead H1). */}
            <View style={styles.identity}>
            {chipVisible ? <PaneMainRestoreChip /> : null}
            {props.leading ? <View style={large ? styles.identityMark : styles.identityMarkCentered}>{props.leading}</View> : null}
            <View style={styles.titleBlock}>
                {props.overline ?? null}
                {/* A host that already names the thing (a breadcrumb ending on it) passes no title: the live line stands alone. */}
                {hasTitle ? <View style={styles.titleRow}>
                {props.titleControl ?? (
                <Text
                    ref={props.headingRef}
                    tabIndex={props.headingRef ? -1 : undefined}
                    testID={`${testID}.title`}
                    numberOfLines={props.titleNumberOfLines === null ? undefined : props.titleNumberOfLines ?? 1}
                    accessibilityRole="header"
                    style={[large ? styles.largeTitle : styles.title, styles.titleText, props.titleTextStyle]}
                >
                    {props.title}
                </Text>
                )}
                {props.onTitleNaturalWidth && !props.titleControl ? (
                    <View testID={`${testID}.titleMeasure`} aria-hidden pointerEvents="none" style={[styles.titleRow, styles.titleMeasure]}
                        onLayout={(event) => props.onTitleNaturalWidth?.(Math.ceil(event.nativeEvent.layout.width))}>
                        {props.leading ? <View style={styles.identityMark}>{props.leading}</View> : null}
                        <Text numberOfLines={1} style={[large ? styles.largeTitle : styles.title, props.titleTextStyle]}>{props.title}</Text>
                    </View>
                ) : null}
                </View> : null}
                {(line && (line.segments.length > 0 || line.leading)) || props.lineTrailing ? (
                    <PaneHeaderLineView
                        line={line}
                        large={large}
                        testID={testID}
                        lineEnd={props.lineEnd}
                        lineTrailing={props.lineTrailing}
                    />
                ) : null}
            </View>
            </View>
            {props.actions ? <View style={styles.actions}>{props.actions}</View> : null}
            {props.onClose ? (
                <IconButton
                    testID={`${testID}.close`}
                    iconName="x"
                    accessibilityLabel={t('common.close')}
                    tooltip={props.size === 'large' ? undefined : t('common.close')}
                    variant="plain"
                    onPress={props.onClose}
                />
            ) : null}
            {props.shade === false ? null : <PaneHeaderShade />}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    // The band stands above its body, so the shade beneath it overlays the content scrolling under it.
    band: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        position: 'relative',
        zIndex: 1,
        paddingLeft: HEADER_BAND_HORIZONTAL_PADDING_PX,
        paddingRight: HEADER_BAND_HORIZONTAL_PADDING_PX / 2,
        gap: theme.space.s2,
        backgroundColor: theme.colors.surface.base,
    },
    // Back takes the band's leading inset: its glyph sits where the title would start.
    bandWithBack: {
        paddingLeft: HEADER_BAND_HORIZONTAL_PADDING_PX / 2,
    },
    large: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        flexShrink: 0,
        position: 'relative',
        zIndex: 1,
        paddingHorizontal: HEADER_BAND_HORIZONTAL_PADDING_PX,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s12,
        gap: theme.space.s8,
        backgroundColor: theme.colors.surface.base,
    },
    identity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    titleBlock: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minWidth: 0 },
    titleText: { flexShrink: 1, minWidth: 0 },
    // The title row at its natural width, out of flow and unseen (`onTitleNaturalWidth`).
    titleMeasure: { position: 'absolute', left: 0, top: 0, opacity: 0 },
    identityMark: { flexShrink: 0, alignSelf: 'flex-start', marginTop: theme.space.s2 },
    // In the band the mark centres on the whole identity text (title over its live line).
    identityMarkCentered: { flexShrink: 0 },
    lineTrailing: { flexShrink: 0, marginLeft: 'auto' },
    largeTitle: {
        ...pageTitleTypography(),
        color: theme.colors.text.primary,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        gap: theme.space.s4,
    },
    largeLine: {
        marginTop: theme.space.s4,
    },
    lineLeading: {
        flexShrink: 0,
        marginTop: HEADER_BAND_SUBTITLE_TEXT.marginTop,
    },
    // On a phone's large header a glyph and its first fact share one wrapping item, so the band's row gap
    // never reaches between them: the glyph keeps the same step from its words here.
    largeLeading: {
        marginRight: theme.space.s4,
    },
    leadingOnly: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...HEADER_BAND_TITLE_TEXT,
        ...Typography.default('semiBold'),
        color: theme.colors.chrome.header.foreground,
    },
    // The facts' row is exactly one line tall (height set from useFactsLineHeight), two at most on a phone's
    // large header: what wraps beneath that is clipped.
    facts: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        overflow: 'hidden',
        marginTop: HEADER_BAND_SUBTITLE_TEXT.marginTop,
    },
    largeFacts: {
        marginTop: 0,
        flexGrow: 1,
    },
    // The phone's one row of leading words and facts: it starts one separator box to the left of the clip.
    largeFlow: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        marginLeft: -theme.space.s16,
    },
    largeItem: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    // Every item's separator box is the same width, so the clip hides exactly the one that opens a line.
    largeSeparator: {
        width: theme.space.s16,
        alignItems: 'center',
        flexShrink: 0,
    },
    leadingSeparated: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    subtitle: {
        ...HEADER_BAND_SUBTITLE_TEXT,
        ...Typography.default(),
        marginTop: 0,
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
    },
    // A fact after the first keeps its own width: it either fits whole or wraps away.
    followingFact: {
        flexShrink: 0,
    },
    iconFact: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    iconFactText: {
        marginLeft: theme.space.s4,
    },
    linkHovered: {
        color: theme.colors.text.primary,
    },
    largeSubtitle: {
        ...happierPageTextMetrics('pageDescription'),
        marginTop: 0,
    },
    emphasis: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    attention: {
        ...Typography.default('semiBold'),
        color: theme.colors.state.warning.foreground,
    },
    failure: {
        color: theme.colors.state.danger.foreground,
        fontVariant: ['tabular-nums'],
    },
    failureHovered: {
        textDecorationLine: 'underline',
    },
    added: {
        color: theme.colors.diff.success,
        fontVariant: ['tabular-nums'],
    },
    removed: {
        color: theme.colors.diff.error,
        fontVariant: ['tabular-nums'],
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
    },
}));
