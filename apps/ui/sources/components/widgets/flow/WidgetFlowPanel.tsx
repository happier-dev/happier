import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_WIDGET_FRAME_METRICS, HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useRetainedPlacement } from '@/modal/components/RetainedModalFrame';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { HAPPIER_RADIUS_V1 } from '@happier-dev/plugin-ui/environment';

/**
 * The height a floating flow surface allows its flow (the anchored shell's room). Inside it a flow
 * keeps its header and footer in place and scrolls only its body, so Save never scrolls away.
 */
export const WidgetFlowHeightBoundContext = React.createContext<number | null>(null);

export type WidgetFlowPrimary = Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
    /** What is happening while it is busy, said in the footer line beside the spinner ("Adding…"). */
    busyNote?: string;
    /** Why the primary is off, said beside it and read with it. */
    blockedReason?: string | null;
    /** A glyph before the words (Add's "+"). */
    icon?: IconName;
    testID?: string;
}>;

/**
 * The one anatomy of every widget flow (lab `dashboards` dadd A/Ap, dbind E/Ep, dagent G2/G3, dscope
 * VS): a header with the way back where there is one, the widget's mark where the flow is about one
 * widget, its title and one line under it; the body; and one footer — a quiet line at the start
 * (what is still needed, a consequence, or what failed), Cancel, and exactly one primary.
 *
 * On a phone the flow is a sheet: the header keeps its caret (Back, or close when there is nowhere
 * to go back to — lab Ep), Cancel goes (the caret and the sheet dismiss it), and the primary takes
 * the full width under its line. The line keeps its room, so nothing moves when it speaks.
 */
export function WidgetFlowPanel(props: Readonly<{
    title: string;
    hint?: string | null;
    /** Who made it and where it comes from, a quiet third line (the Add pane). */
    provenance?: string | null;
    /** The widget's own mark, for a flow about one widget (About, the Add pane). */
    mark?: IconName | React.ReactElement;
    onBack?: () => void;
    /** Names where Back goes ("Widgets"), beside its caret, on a phone's pushed step. */
    backLabel?: string;
    /**
     * Phones: the caret closes the sheet when there is no step to go back to. On desktop a flow
     * without Cancel (the Add pane) closes from an × at the header's end.
     */
    onClose?: () => void;
    /** Quiet words in the footer ("Saved to your account · only you"). */
    note?: string | null;
    error?: string | null;
    noteTestID?: string;
    onCancel?: () => void;
    primary?: WidgetFlowPrimary;
    /** Secondary actions that sit in the footer start instead of a note (About's Change and Duplicate). */
    footerStart?: React.ReactNode;
    /** Quiet help just before the primary (the Add pane's ⌘↵). */
    footerAccessory?: React.ReactNode;
    /** The flow fills its surface: the body takes the room between header and footer (the Add pane). */
    fill?: boolean;
    /** The host already knows it is a phone sheet (Set up); otherwise the device decides. */
    phone?: boolean;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const devicePhone = useDeviceType() === 'phone';
    const phone = props.phone ?? devicePhone;
    const busyNote = props.primary?.busy === true ? props.primary.busyNote : undefined;
    const message = props.error ?? busyNote ?? props.primary?.blockedReason ?? props.note ?? null;
    // The busy word ("Saving…") is short and the spinner already speaks: it stays beside the buttons, so pressing
    // the primary never moves it. Any other message in a narrow surface takes its own line.
    const messageOwnsLine = message !== null && (props.error != null || busyNote === undefined);
    const caret = props.onBack ?? (phone ? props.onClose ?? props.onCancel : undefined);
    const closeInHeader = !phone && !props.onBack && !props.onCancel ? props.onClose : undefined;
    const mark = props.mark === undefined ? null
        : typeof props.mark === 'string' ? <Icon name={props.mark} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
        : props.mark;
    const note = props.footerStart ?? (
        <Text
            style={[styles.note, phone ? null : messageOwnsLine ? styles.noteWrap : null, props.error ? styles.noteError : null]}
            numberOfLines={3}
            testID={props.noteTestID ?? `${props.testID}.note`}
            accessibilityLiveRegion="polite"
        >
            {message ?? ''}
        </Text>
    );
    const primary = props.primary ? (
        <View style={phone ? styles.primaryPhone : null}>
            <RoundButton
                testID={props.primary.testID ?? `${props.testID}.primary`}
                size={phone ? 'normal' : 'small'}
                title={props.primary.label}
                {...(props.primary.icon ? { leading: <Icon name={props.primary.icon} size={ICON_SIZE.xs}
                    color={props.primary.disabled === true ? theme.colors.text.tertiary : theme.colors.button.primary.tint} /> } : {})}
                disabled={props.primary.disabled === true || props.primary.busy === true}
                loading={props.primary.busy === true}
                {...(props.primary.blockedReason ? { accessibilityHint: props.primary.blockedReason } : {})}
                onPress={props.primary.onPress}
            />
        </View>
    ) : null;
    const hasFooter = props.primary || props.onCancel || props.footerStart || message;
    const heightBound = React.useContext(WidgetFlowHeightBoundContext);
    const bounded = heightBound !== null && !props.fill;
    const retainedBody = useRetainedPlacement<null>(() => props.children);
    return (
        <View testID={props.testID} accessibilityLabel={props.title}
            style={[styles.root, phone ? styles.rootPhone : null, props.fill ? styles.rootFill : null, bounded ? { maxHeight: heightBound } : null]}>
            {retainedBody.body}
            {phone && props.onBack && props.backLabel ? (
                <HappierPressable
                    testID={`${props.testID}.back`}
                    accessibilityRole="button"
                    accessibilityLabel={props.backLabel}
                    onPress={props.onBack}
                    style={(state) => [styles.backRow, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Icon name="caret-left" size={ICON_SIZE.sm} color={theme.colors.text.link} />
                    <Text style={styles.backLabel}>{props.backLabel}</Text>
                </HappierPressable>
            ) : null}
            <View style={styles.header}>
                {caret && !(phone && props.onBack && props.backLabel) ? (
                    <HappierPressable
                        testID={`${props.testID}.${props.onBack ? 'back' : 'close'}`}
                        accessibilityRole="button"
                        accessibilityLabel={props.onBack ? t('common.back') : t('common.close')}
                        onPress={caret}
                        style={(state) => [styles.caret, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Icon name="caret-left" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                    </HappierPressable>
                ) : null}
                {mark ? <View style={styles.mark}>{mark}</View> : null}
                <View style={styles.titleBlock}>
                    <Text style={styles.title} accessibilityRole="header" numberOfLines={2}>{props.title}</Text>
                    {props.hint ? <Text style={styles.hint} numberOfLines={3}>{props.hint}</Text> : null}
                    {props.provenance ? <Text testID={`${props.testID}.provenance`} style={styles.provenance} numberOfLines={1}>{props.provenance}</Text> : null}
                </View>
                {closeInHeader ? (
                    <IconButton testID={`${props.testID}.close`} iconName="x" variant="plain" accessibilityLabel={t('common.close')} onPress={closeInHeader} />
                ) : null}
            </View>
            {bounded ? (
                <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="always"
                    testID={`${props.testID}.body`}>
                    {retainedBody.mount(null)}
                </ScrollView>
            ) : (
                <View style={[styles.body, props.fill ? styles.bodyFill : null]}>{retainedBody.mount(null)}</View>
            )}
            {hasFooter ? (
                phone ? (
                    <View style={[styles.footer, styles.footerPhone]}>
                        {note}
                        {primary}
                    </View>
                ) : (
                    <View style={[styles.footer, styles.footerWrap]}>
                        {note}
                        {props.footerAccessory ?? null}
                        {props.onCancel || primary ? (
                            <View style={styles.footerActions}>
                                {props.onCancel ? (
                                    // Closing a submitted flow does not promise withdrawal of its Action.
                                    <RoundButton testID={`${props.testID}.cancel`} size="small" display="secondary"
                                        title={t(props.primary?.busy ? 'common.close' : 'common.cancel')} onPress={props.onCancel} />
                                ) : null}
                                {primary}
                            </View>
                        ) : null}
                    </View>
                )
            ) : null}
        </View>
    );
}

/** One fact row of About (lab G2): a quiet label column, the fact, and its consequence beneath. */
export function WidgetFactRow(props: Readonly<{
    label: string;
    children: React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const phone = useDeviceType() === 'phone';
    const styles = stylesheet;
    return (
        <View testID={props.testID} style={[styles.fact, phone ? styles.factPhone : null]} accessible={false}>
            <Text style={[styles.factLabel, phone ? styles.factLabelPhone : null]}>{props.label}</Text>
            <View style={styles.factBody}>{props.children}</View>
        </View>
    );
}

/**
 * A quiet text action inside a flow ("Edit", "Refresh now", "Duplicate"): the words in the link
 * weight, an optional glyph before them, the shared focus ring, and no box of its own.
 */
export function WidgetFlowTextAction(props: Readonly<{
    label: string;
    onPress: () => void;
    icon?: IconName;
    disabled?: boolean;
    busy?: boolean;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            disabled={props.disabled}
            busy={props.busy}
            onPress={props.onPress}
            style={(state) => [styles.textAction, state.pressed ? styles.textActionPressed : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            {props.icon ? <Icon name={props.icon} size={ICON_SIZE.xs} color={theme.colors.text.secondary} /> : null}
            <Text style={widgetFlowText.link}>{props.label}</Text>
        </HappierPressable>
    );
}

/** The room a preview well keeps around the real card it holds. */
const PREVIEW_WELL_PADDING_PX = 8;

/**
 * The plate a flow shows a preview on (Set up's live preview, Post a snapshot's frozen card, Save as
 * your widget): an inset surface whose corner is concentric with the card's, so the inner corner is
 * never rounder than the outer one. `height` fixes the room on a phone, where the card shows its
 * first rows and the rest is clipped; the card itself is drawn at its own size.
 *
 * A `framed` preview is a real card with its own edge, so it needs no plate: the caption sits on the
 * flow's own edge above it and the card is the only surface between the flow and its content.
 */
export function WidgetPreviewWell(props: Readonly<{
    caption?: string;
    minHeight?: number;
    height?: number;
    framed?: boolean;
    testID?: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const styles = stylesheet;
    const framed = props.framed === true && props.height === undefined;
    return (
        <View
            testID={props.testID}
            style={[
                framed ? styles.wellFramed : styles.well,
                props.minHeight !== undefined ? { minHeight: props.minHeight } : null,
                props.height !== undefined ? { height: props.height, overflow: 'hidden' } : null,
            ]}
        >
            {props.caption ? <Text style={framed ? styles.wellCaptionFramed : styles.wellCaption}>{props.caption}</Text> : null}
            <View pointerEvents="none">{props.children}</View>
        </View>
    );
}

/** The flows' text steps, from the page anatomy's scale. */
export const widgetFlowText = StyleSheet.create((theme) => ({
    primary: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary },
    strong: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    secondary: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary },
    link: { ...Typography.default('semiBold'), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary },
}));

const stylesheet = StyleSheet.create((theme) => ({
    root: { paddingHorizontal: theme.space.s6, paddingTop: theme.space.s6, paddingBottom: theme.space.s8 },
    // A phone's sheet keeps the page metrics' sheet inset on every edge (header, body, footer add their own s4).
    rootPhone: { paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx - theme.space.s4 },
    // A phone's pushed step: "‹ Widgets" on its own line, as the navigation bar would draw it.
    backRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: theme.space.s2, paddingVertical: theme.space.s6, paddingRight: theme.space.s8, marginLeft: -2, marginBottom: theme.space.s4, borderRadius: HAPPIER_RADIUS_V1.sm },
    backLabel: { ...Typography.default(), ...happierPageTextMetrics('rowTitle'), color: theme.colors.text.link },
    rootFill: { flex: 1, minHeight: 0 },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s6, paddingHorizontal: theme.space.s4, paddingTop: theme.space.s2, paddingBottom: theme.space.s10 },
    caret: {
        width: 28,
        height: 28,
        borderRadius: HAPPIER_RADIUS_V1.sm,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: -4,
        marginLeft: -4,
    },
    // The mark sits on the title's first line.
    mark: { height: happierPageTextMetrics('sectionTitle').lineHeight, justifyContent: 'center' },
    titleBlock: { flex: 1, minWidth: 0, gap: theme.space.s2 },
    title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary },
    hint: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary },
    provenance: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary, marginTop: theme.space.s2 },
    body: { paddingHorizontal: theme.space.s4 },
    bodyFill: { flex: 1, minHeight: 0 },
    // Bounded by its floating surface: the body gives way and scrolls; header and footer stay.
    bodyScroll: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        marginTop: theme.space.s8,
        paddingTop: theme.space.s10,
        paddingHorizontal: theme.space.s4,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    // In a narrow surface (a rail, a card's popover) a note with something to say takes its own line above the buttons
    // instead of being crushed beside them; a silent note sits beside them, so it never leaves a blank line above the
    // buttons. Cancel and the primary action wrap together, never apart.
    footerWrap: { flexWrap: 'wrap', justifyContent: 'flex-end' },
    noteWrap: { flexGrow: 1, flexShrink: 1, flexBasis: 180 },
    footerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    footerPhone: { flexDirection: 'column', alignItems: 'stretch', paddingTop: theme.space.s8 },
    primaryPhone: { alignSelf: 'stretch' },
    note: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        flex: 1,
        // One line of room even while it says nothing, so a message never moves the buttons.
        minHeight: happierPageTextMetrics('meta').lineHeight,
        color: theme.colors.text.tertiary,
    },
    noteError: { color: theme.colors.state.danger.foreground },
    fact: {
        flexDirection: 'row',
        gap: theme.space.s12,
        paddingVertical: theme.space.s10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    factPhone: { flexDirection: 'column', gap: theme.space.s2 },
    // A flow panel is panel glass: its quiet labels are the secondary role, which takes the stronger backed step
    // over a picture and keeps its place over a chart; tertiary sank into both.
    factLabel: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), width: 88, color: theme.colors.text.secondary },
    factLabelPhone: { width: undefined },
    factBody: { flex: 1, minWidth: 0, gap: theme.space.s2 },
    textAction: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, borderRadius: HAPPIER_RADIUS_V1.sm },
    textActionPressed: { opacity: motionTokens.press.opacity },
    well: {
        borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx + PREVIEW_WELL_PADDING_PX,
        backgroundColor: theme.colors.surface.inset,
        padding: PREVIEW_WELL_PADDING_PX,
        gap: theme.space.s6,
    },
    wellFramed: { gap: theme.space.s6 },
    wellCaptionFramed: { ...Typography.default('semiBold'), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
    wellCaption: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        paddingHorizontal: theme.space.s4,
    },
}));
