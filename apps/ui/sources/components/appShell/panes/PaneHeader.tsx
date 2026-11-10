import { PaneMainRestoreChip, usePaneMainRestoreChipVisible } from './mainColumn/PaneMainColumnControls';
import { useContainingGlassSurfaceGroup } from '@/components/ui/glass/GlassSurface';
import * as React from 'react';
import { Platform, View, type LayoutChangeEvent, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PAGE_METRICS, HAPPIER_PRESS_FEEDBACK_V1, happierPageTextMetrics, useHappierMaterialColorResolver, useHappierTextPresentation } from '@happier-dev/plugin-ui/presentation';
import type { PluginUiDetailsPanePresentation } from '@happier-dev/plugin-ui/advanced';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { BACK_GLYPH_INK_INSET_PX, DefaultBackButton } from '@/components/navigation/Header';
import { useHeaderControlMetrics, type HeaderControlMetrics } from '@/components/ui/icons/iconButtonGlyphSize';
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
import { PANE_HEADER_BAND_TRAILING_PADDING_PX, resolvePaneHeaderColumnMaxWidthPx } from './paneHeaderColumn';
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

/** A fact that has not arrived: it holds its room on the line and is neither seen nor spoken. */
function isPendingSegment(segment: PaneHeaderLineSegment): boolean {
    return typeof segment !== 'string' && 'pending' in segment;
}

function readSpokenLine(segments: readonly PaneHeaderLineSegment[]): string {
    return segments.filter(segment => !isPendingSegment(segment)).map(readSegmentText).join(', ');
}

const PENDING_FACT_STYLE = { opacity: 0 } as const;
/** The pending fact's box, separator included, is out of the accessibility tree (native reads each text node). */
const PENDING_FACT_HIDDEN = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** A phone's large header gives its facts up to two lines; the band keeps one. */
const LARGE_FACTS_LINES = 2;

/**
 * The height of one line of facts as the facts' own text lays out. The row clips to whole lines of
 * this height, so it must follow everything that enlarges that text: the in-app text size, the OS
 * font scale and a browser's minimum font size, which no style value sees. A hidden one-line probe
 * in the facts' style reports the laid-out line; until its first layout the row uses the
 * type-scale line at the known scales, which is the same height at the default text size.
 */
function useFactsLine(large: boolean, probeStyle: StyleProp<TextStyle>): Readonly<{ lineHeight: number; probe: React.ReactNode }> {
    const uiFontScale = useLocalSetting('uiFontScale');
    const { metricScale } = useHappierTextPresentation({ textScale: uiFontScale });
    const { fontScale } = usePresentationWindowDimensions();
    const hostScale = Platform.OS === 'web' ? 1 : fontScale;
    const estimate = (large ? happierPageTextMetrics('pageDescription').lineHeight : HEADER_BAND_SUBTITLE_TEXT.lineHeight) * metricScale * hostScale;
    const [measured, setMeasured] = React.useState<number | null>(null);
    // A hidden pane reads 0; keep the last laid-out line.
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { height } = event.nativeEvent.layout;
        if (height > 0) setMeasured(height);
    }, []);
    const probe = (
        <Text aria-hidden accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden
            numberOfLines={1} onLayout={onLayout} style={[probeStyle, stylesheet.factsProbe]}>{NO_BREAK_SPACE}</Text>
    );
    return { lineHeight: measured ?? estimate, probe };
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
    const leadingSeparated = line?.leadingSeparated === true && line.segments.length > 0;
    const hasLink = line?.segments.some(isLinkSegment) === true;
    const subtitleStyle = [styles.subtitle, large ? styles.largeSubtitle : null];
    const factsLine = useFactsLine(large === true, subtitleStyle);
    // One fact, after the `separator` that joins it to the one before (the band's " · ", or none).
    const renderFact = (segment: PaneHeaderLineSegment, index: number, separator: string): React.ReactNode => {
        if (isPendingSegment(segment)) {
            return (
                <Text key={index} numberOfLines={large ? LARGE_FACTS_LINES : 1} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                    style={[styles.subtitle, large ? styles.largeSubtitle : null, index === 0 ? null : styles.followingFact, PENDING_FACT_STYLE]}>
                    {separator}{readSegmentText(segment)}
                </Text>
            );
        }
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
        // Items that hold a pending fact's room: their separator stays unseen with them.
        const pendingItems = new Set<number>();
        if (line.leading) items.push([<View key="leading" style={[styles.lineLeading, leadingSeparated ? null : styles.largeLeading]}>{line.leading}</View>]);
        line.segments.forEach((segment, index) => {
            const previous = index === 0 ? null : line.segments[index - 1]!;
            // `+4 −2` stays together; a mark's first fact follows it directly.
            const joined = previous ? isToneSegment(segment) && isToneSegment(previous) : line.leading !== undefined && line.leading !== null && !leadingSeparated;
            const fact = renderFact(segment, index, joined && previous ? NO_BREAK_SPACE : '');
            if (joined && items.length > 0) items[items.length - 1]!.push(fact);
            else {
                items.push([fact]);
                if (isPendingSegment(segment)) pendingItems.add(items.length - 1);
            }
        });
        // The final fact's own trailing words (who wrote it, a copy control) wrap with that fact, inside the row.
        if (props.lineEnd) items[items.length - 1]!.push(<React.Fragment key="lineEnd">{props.lineEnd}</React.Fragment>);
        return (
            <View style={[styles.line, styles.largeLine]}>
                <View
                    testID={`${testID}.subtitle`}
                    accessible={!hasLink && !line.leading}
                    accessibilityLabel={hasLink || line.leading ? undefined : readSpokenLine(line.segments)}
                    style={[styles.facts, styles.largeFacts, { maxHeight: factsLine.lineHeight * LARGE_FACTS_LINES }]}
                >
                    <View style={styles.largeFlow}>
                        {items.map((nodes, index) => (
                            <View key={index} style={[styles.largeItem, pendingItems.has(index) ? PENDING_FACT_STYLE : null]} {...(pendingItems.has(index) ? PENDING_FACT_HIDDEN : {})}>
                                <View style={styles.largeSeparator}>{index === 0 ? null : <Text style={subtitleStyle}>·</Text>}</View>
                                {nodes}
                            </View>
                        ))}
                    </View>
                    {factsLine.probe}
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
                    accessibilityLabel={hasLink ? undefined : readSpokenLine(line.segments)}
                    style={[styles.facts, { height: factsLine.lineHeight }]}
                >
                    {line.segments.map((segment, index) => renderFact(segment, index, bandSeparator(index)))}
                    {factsLine.probe}
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
    /** View controls aligned with the facts rather than with the title actions. */
    lineTrailing?: React.ReactNode;
}>;

export type PaneHeaderProps = PaneHeaderContent & Readonly<{
    /** Semantic focus binding supplied by the pane content owner. */
    headingRef?: PluginUiDetailsPanePresentation['headingRef'];
    /** Identity mark beside the title; it has no backing tile. */
    leading?: React.ReactNode;
    /**
     * A title that is itself a control, such as a named-object switcher. As a function it wraps the band's
     * own title text, so the switcher keeps the one title size this header owns.
     */
    titleControl?: React.ReactNode | ((title: React.ReactElement) => React.ReactNode);
    /** null allows a long title to wrap; the default pane band stays on one line. */
    titleNumberOfLines?: number | null;
    titleTextStyle?: StyleProp<TextStyle>;
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
    /**
     * The width of the content column under the band (a Session's conversation column). The band still spans the
     * pane; its title and controls stand on that column's edges (`resolvePaneHeaderColumnMaxWidthPx`).
     */
    columnMaxWidthPx?: number;
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
    const navigationBandEdges = useNavigationBandEdges();
    const hasTitle = props.title.trim().length > 0 || Boolean(props.leading) || Boolean(props.titleControl) || chipVisible;
    const titleText = (
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
    );
    // A band over a centred content column keeps the pane-wide paint and shade; its contents stand on the column's edges.
    const columnMaxWidthPx = !large && props.columnMaxWidthPx !== undefined && Number.isFinite(props.columnMaxWidthPx)
        ? resolvePaneHeaderColumnMaxWidthPx(props.columnMaxWidthPx) : null;
    const lineView = (line && (line.segments.length > 0 || line.leading)) || props.lineTrailing ? (
        <PaneHeaderLineView
            line={line}
            large={large}
            testID={testID}
            lineEnd={props.lineEnd}
            lineTrailing={props.lineTrailing}
        />
    ) : null;
    const identity = (
        <View style={large ? styles.largeIdentityRow : styles.identity}>
        {chipVisible ? <PaneMainRestoreChip /> : null}
        {props.leading ? <View style={large ? styles.identityMark : styles.identityMarkCentered}>{props.leading}</View> : null}
        <View style={styles.titleBlock}>
            {props.overline ?? null}
            {/* A host that already names the thing (a breadcrumb ending on it) passes no title: the live line stands alone. */}
            {hasTitle ? <View style={styles.titleRow}>
            {typeof props.titleControl === 'function' ? props.titleControl(titleText) : props.titleControl ?? titleText}
            {props.onTitleNaturalWidth && !props.titleControl ? (
                <View testID={`${testID}.titleMeasure`} aria-hidden pointerEvents="none" style={[styles.titleRow, styles.titleMeasure]}
                    onLayout={(event) => props.onTitleNaturalWidth?.(Math.ceil(event.nativeEvent.layout.width))}>
                    {props.leading ? <View style={styles.identityMark}>{props.leading}</View> : null}
                    <Text numberOfLines={1} style={[large ? styles.largeTitle : styles.title, props.titleTextStyle]}>{props.title}</Text>
                </View>
            ) : null}
            </View> : null}
            {large ? null : lineView}
        </View>
        </View>
    );
    const contents = (
        <>
            {props.navigation ? (
                // The phone's one Back (`DefaultBackButton`): its ink on the page's text edge, as on every bar.
                <DefaultBackButton
                    testID={props.navigation.backTestID ?? `${testID}.back`}
                    tintColor={theme.colors.chrome.header.foreground}
                    // The identity mark sits one band gap to its right: Back's hit area takes half of it.
                    trailingReachPx={theme.space.s2 / 2}
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
                    interactiveTargetEdgesPx={{ trailing: theme.space.s2 / 2 }}
                    onPress={props.onBack}
                />
            ) : null}
            {/* One identity block. In the band the mark stands beside the text and the overline, title and live
                line all start on the title's own text edge (lab cshead H1). A large header hangs the mark from the
                title's line and runs the facts beneath at the identity's full width, from the mark's edge, as
                `PageHeader`'s `hang` does: a long facts line never leaves an empty gutter under the mark. */}
            {large ? <View style={styles.largeIdentity}>{identity}{lineView}</View> : identity}
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
        </>
    );
    return (
        <View testID={testID} style={[large ? styles.large : [styles.band, { height: height + topInset, paddingTop: topInset }],
            props.navigation ? navigationBandEdges : props.onBack ? styles.bandWithBack : null,
            columnMaxWidthPx === null ? null : styles.bandOverColumn,
            // On the navigation plane (a side panel standing on the canvas) the band takes the plane's paint.
            { backgroundColor: onNavigationPlane ? 'transparent' : materialColor(theme.colors.surface.base, 'transparent') }]}>
            {columnMaxWidthPx === null ? contents : (
                <View testID={`${testID}.column`} style={[styles.column, { maxWidth: columnMaxWidthPx }]}>{contents}</View>
            )}
            {props.shade === false ? null : <PaneHeaderShade />}
        </View>
    );
});

const NAVIGATION_BAND_POINTER_CONTROL: HeaderControlMetrics = Object.freeze({ sizePx: HAPPIER_PAGE_METRICS.controlHeightPx, glyphPx: ICON_SIZE.md });

/**
 * A phone screen's navigation band stands on the page's edges (phone-system lab D1): Back's chevron ink starts on
 * the page text line, and the trailing action's glyph box ends on the same line from the other side, so its 44 pt
 * hit area stops 8 pt short of the screen edge.
 */
function useNavigationBandEdges(): Readonly<{ paddingLeft: number; paddingRight: number }> {
    const control = useHeaderControlMetrics(NAVIGATION_BAND_POINTER_CONTROL);
    return React.useMemo(() => ({
        paddingLeft: HAPPIER_PAGE_METRICS.pageTextInsetPx - BACK_GLYPH_INK_INSET_PX,
        paddingRight: HAPPIER_PAGE_METRICS.pageTextInsetPx - (control.sizePx - control.glyphPx) / 2,
    }), [control.glyphPx, control.sizePx]);
}

const stylesheet = StyleSheet.create((theme) => ({
    // The band stands above its body, so the shade beneath it overlays the content scrolling under it.
    band: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        position: 'relative',
        zIndex: 1,
        paddingLeft: HEADER_BAND_HORIZONTAL_PADDING_PX,
        paddingRight: PANE_HEADER_BAND_TRAILING_PADDING_PX,
        gap: theme.space.s2,
        backgroundColor: theme.colors.surface.base,
    },
    // The contents' column is centred in the band (`columnMaxWidthPx`).
    bandOverColumn: {
        justifyContent: 'center',
    },
    column: {
        flex: 1,
        minWidth: 0,
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
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
        // A phone's large title is page text, not the band's chrome: it stands on the page text line (18), with
        // the page's title, purpose and section labels (phone lab: bare text on 18).
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s12,
        gap: theme.space.s8,
        backgroundColor: theme.colors.surface.base,
    },
    identity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    // A large header's identity: the mark and title on one row, the facts beneath at its full width.
    largeIdentity: { flex: 1, minWidth: 0 },
    largeIdentityRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
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
    // Controls aligned with the facts keep to the column: at a large text size they wrap within it rather than run past its edge.
    lineTrailing: { flexShrink: 1, minWidth: 0, marginLeft: 'auto' },
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
    // The facts' row is exactly one line tall (height set from useFactsLine), two at most on a phone's
    // large header: what wraps beneath that is clipped.
    facts: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        overflow: 'hidden',
        marginTop: HEADER_BAND_SUBTITLE_TEXT.marginTop,
    },
    // Out of the flow and unseen: it only reports the facts' laid-out line height.
    factsProbe: {
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: 0,
        pointerEvents: 'none',
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
        // The attention text role: the readable amber words, while the dot keeps the attention amber.
        color: theme.colors.state.attention.textForeground,
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
        // The band leaves 2 px between the identity block and the actions; with this, 6: the leading action's
        // hit area reaches half of the 6 px actions keep from each other, and a flush control of the identity
        // block (a lineage link) keeps the other half, so the two never overlap.
        marginLeft: theme.space.s4,
    },
}));
