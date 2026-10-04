import * as React from 'react';
import { Platform, StyleSheet as RNStyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierPressable,
    HappierWidgetFrame,
    HAPPIER_WIDGET_FRAME_METRICS,
    happierPageTextMetrics,
    resolveHappierWidgetFrameInsetPx,
    type HappierWidgetFramePlacement,
    type HappierWidgetFrameStyle,
    type HappierWidgetFrameTextRender,
} from '@happier-dev/plugin-ui/presentation';

import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

export type WidgetFrameStyle = HappierWidgetFrameStyle;
export type WidgetFramePlacement = HappierWidgetFramePlacement;

/** How many rows a Home widget's body keeps room for, whatever state it is in. */
export const HOME_WIDGET_BODY_ROWS = 4;

/**
 * What the body shows. `content` is the widget's own rows (a built-in's, a Board item's renderer, or
 * a plugin surface that draws its own states); the other three are the host's W1 states for a widget
 * whose data the host reads.
 */
export type WidgetFrameBody =
    | Readonly<{ kind: 'content'; children: React.ReactNode }>
    /** First load only: a widget with last-known rows shows them while it refreshes. */
    | Readonly<{ kind: 'loading'; accessibilityLabel: string }>
    | Readonly<{ kind: 'empty'; title: string; reason: string; iconName?: IconName; action?: SurfaceStateAction }>
    | Readonly<{
        kind: 'error';
        title: string;
        reason: string;
        action?: SurfaceStateAction;
        /** Machine code, behind the state's quiet Details disclosure; never the headline. */
        diagnosticCode?: string | null;
        iconName?: IconName;
    }>;

/**
 * The one footer row: where the widget leads, or — while last-known rows are shown after a failed
 * refresh — why they are not current, with Retry.
 */
export type WidgetFrameFooter =
    | Readonly<{ kind: 'open'; label: string; onPress: () => void;
        secondary?: Readonly<{ label: string; onPress: () => void }> }>
    | Readonly<{ kind: 'refreshFailed'; reason: string; onRetry?: () => void | Promise<unknown> }>;

export type WidgetFrameProps = Readonly<{
    testID: string;
    /** Card (its own surface) or plain (on the page, a hairline above). See `useWidgetFrameStyle`. */
    frameStyle: WidgetFrameStyle;
    placement: WidgetFramePlacement;
    /** The source's mark: its glyph, or a brand mark element. */
    mark?: IconName | React.ReactElement;
    /** A string, or an element the placement owns (the Board's rename field). */
    title: string | React.ReactElement;
    /** The source's name, quiet beside the title ("Note", a plugin's name), or the placement's own source text. */
    source?: string | React.ReactElement;
    /** Freshness ("As of 10:42") or a count, only when the source actually knows it. */
    meta?: React.ReactNode;
    /** The widget's controls at the end of the header: its ⋯ menu, a move handle. */
    menu?: React.ReactNode;
    body: WidgetFrameBody;
    footer?: WidgetFrameFooter | null;
    /** Reserved body rows. Home keeps {@link HOME_WIDGET_BODY_ROWS}; other placements reserve none. */
    rows?: number;
    /** Body box (a measured height, full-bleed insets) for a placement that sizes its body. */
    bodyStyle?: React.ComponentProps<typeof HappierWidgetFrame>['bodyStyle'];
    /** It just arrived while you were looking (the agent added it): a one-shot ring that fades. */
    fresh?: boolean;
    /** Fill the grid cell, so cards in one row share a height. */
    fill?: boolean;
    accessibilityLabel?: string;
}>;

const FOOTER_MIN_TARGET_PX = resolveMinimumInteractiveTargetSize(Platform.OS);
/** How long the arrival ring stays before it fades: long enough to find it, short enough to never read as a badge. */
const FRESH_RING_HOLD_MS = 2000;
const FRESH_RING_FADE_MS = 600;

/**
 * The one widget frame (lab `cwidgets` F1, round 2 Card | Plain): mark · title · source · meta · ⋯,
 * a body that keeps its room through loading, empty and error, and one footer — on Home, the Board
 * and the Companion. The structure is `HappierWidgetFrame` (plugin-ui); this adapter supplies
 * Happier's theme, text owner, glyphs, the W1 state bodies and the arrival ring.
 */
export const WidgetFrame = React.memo(function WidgetFrame(props: WidgetFrameProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const phone = useDeviceType() === 'phone';
    const rows = props.rows ?? (props.placement === 'home' ? HOME_WIDGET_BODY_ROWS : 0);
    const inset = resolveHappierWidgetFrameInsetPx(props.frameStyle, props.placement);
    const footer = props.footer ?? null;

    const renderText = React.useCallback<HappierWidgetFrameTextRender>((input) => (
        <Text
            testID={input.role === 'title' ? `${props.testID}.title` : `${props.testID}.source`}
            style={input.role === 'title' ? styles.title : styles.source}
            numberOfLines={1}
            accessibilityRole={input.role === 'title' ? 'header' : undefined}
        >
            {input.text}
        </Text>
    ), [props.testID, styles.source, styles.title]);

    const mark = props.mark === undefined
        ? null
        : typeof props.mark === 'string'
            ? <Icon name={props.mark} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
            : props.mark;

    const footerNode = footer?.kind === 'open' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
        <HappierPressable
            testID={`${props.testID}.open`}
            accessibilityRole="link"
            accessibilityLabel={footer.label}
            onPress={footer.onPress}
            style={(state) => [
                styles.footer, { flexGrow: 1 },
                { paddingHorizontal: inset, minHeight: props.frameStyle === 'plain' ? undefined : FOOTER_MIN_TARGET_PX },
                state.pressed ? styles.footerPressed : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            <Text style={styles.footerLabel} numberOfLines={1}>{footer.label}</Text>
            <Icon name="caret-right" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
        </HappierPressable>
        {footer.secondary ? (
            <HappierPressable
                testID={`${props.testID}.secondary-open`}
                accessibilityRole="link"
                accessibilityLabel={footer.secondary.label}
                onPress={footer.secondary.onPress}
                style={(state) => [styles.footer,
                    { paddingHorizontal: inset, minHeight: FOOTER_MIN_TARGET_PX },
                    state.pressed ? styles.footerPressed : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
            >
                <Text style={styles.footerLabel}>{footer.secondary.label}</Text>
            </HappierPressable>
        ) : null}
        </View>
    ) : footer?.kind === 'refreshFailed' ? (
        <View style={styles.footerFill}>
            <SurfaceFreshnessLine
                testID={`${props.testID}.stale`}
                reason={footer.reason}
                tone="warning"
                {...(footer.onRetry ? { action: { label: t('common.retry'), onPress: footer.onRetry } } : {})}
            />
        </View>
    ) : null;

    return (
        <HappierWidgetFrame
            testID={props.testID}
            frameStyle={props.frameStyle}
            placement={props.placement}
            cardStyle={styles.card}
            dividerColor={theme.colors.border.default}
            mark={mark}
            title={props.title}
            {...(props.source ? { source: props.source } : {})}
            sourcePlacement={phone ? 'below' : 'inline'}
            meta={props.meta}
            accessory={props.menu}
            renderText={renderText}
            footer={footerNode}
            fill={props.fill}
            bodyStyle={props.bodyStyle}
            accessibilityLabel={props.accessibilityLabel
                ?? (typeof props.source === 'string' && typeof props.title === 'string' ? `${props.title}, ${props.source}` : undefined)}
            overlay={props.fresh ? <WidgetFrameArrivalRing frameStyle={props.frameStyle} /> : null}
        >
            {rows > 0 ? (
                <WidgetFrameReservedRows rows={rows}>
                    <WidgetFrameBodyView testID={props.testID} body={props.body} rows={rows} />
                </WidgetFrameReservedRows>
            ) : (
                <WidgetFrameBodyView testID={props.testID} body={props.body} rows={rows} />
            )}
        </HappierWidgetFrame>
    );
});

/**
 * Keeps the room of `rows` list rows whatever state the body is in (Home's W1 rule), so nothing
 * below moves when data arrives. Rows are two-line rows of a compact list at the reader's density
 * (widget rows are list rows), so the reserve matches the real rows' box.
 */
function WidgetFrameReservedRows(props: Readonly<{ rows: number; children: React.ReactNode }>) {
    const rowMetrics = usePageRowMetrics('list');
    const rowHeight = Math.max(
        rowMetrics.minHeightPx,
        2 * rowMetrics.paddingVerticalPx
            + rowMetrics.title.lineHeight
            + rowMetrics.subtitle.marginTop
            + rowMetrics.subtitle.lineHeight,
    );
    return <View style={{ flexGrow: 1, minHeight: props.rows * rowHeight, justifyContent: 'center' }}>{props.children}</View>;
}

/**
 * The one-shot "just arrived" ring (lab WA): drawn while the frame is fresh, held long enough to be
 * found, then faded. It never persists as a badge. Reduced motion: it simply disappears.
 */
function WidgetFrameArrivalRing(props: Readonly<{ frameStyle: WidgetFrameStyle }>) {
    const styles = stylesheet;
    const reduceMotion = useReducedMotionPreference();
    const opacity = useSharedValue(1);
    React.useEffect(() => {
        opacity.value = withDelay(
            FRESH_RING_HOLD_MS,
            withTiming(0, { duration: reduceMotion ? motionTokens.durationMs.instant : FRESH_RING_FADE_MS }),
        );
    }, [opacity, reduceMotion]);
    const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return (
        <Animated.View
            pointerEvents="none"
            testID="widget-frame.arrival-ring"
            style={[styles.ring, props.frameStyle === 'plain' ? styles.ringPlain : null, animated]}
        />
    );
}

function WidgetFrameBodyView(props: Readonly<{ testID: string; body: WidgetFrameBody; rows: number }>) {
    const body = props.body;
    switch (body.kind) {
        case 'content':
            return <>{body.children}</>;
        case 'loading':
            return (
                <ItemLoadStateRows
                    testID={`${props.testID}.loading`}
                    state={{ kind: 'loading' }}
                    rows={Math.max(1, props.rows)}
                    lines={2}
                    shape="list"
                    accessibilityLabel={body.accessibilityLabel}
                />
            );
        case 'empty':
            return (
                <SurfaceStateCard
                    testID={`${props.testID}.empty`}
                    kind="empty"
                    size="pane"
                    title={body.title}
                    reason={body.reason}
                    {...(body.action ? { action: body.action } : {})}
                    {...(body.iconName ? { iconName: body.iconName } : {})}
                />
            );
        case 'error':
            return (
                <SurfaceStateCard
                    testID={`${props.testID}.error`}
                    kind="error"
                    size="pane"
                    title={body.title}
                    reason={body.reason}
                    accessibilitySemantics="status"
                    {...(body.action ? { action: body.action } : {})}
                    {...(body.diagnosticCode ? { diagnosticCode: body.diagnosticCode } : {})}
                    {...(body.iconName ? { iconName: body.iconName } : {})}
                />
            );
    }
}

const stylesheet = StyleSheet.create((theme) => {
    const surfaceBorderStyle = resolveThemeSurfaceBorderStyle({
        borderColor: theme.colors.border.surface,
        highlightColor: theme.colors.effect.surfaceHighlight,
    });
    const hasVisibleSurfaceChrome = surfaceBorderStyle.borderWidth > 0 || surfaceBorderStyle.borderTopWidth > 0;
    return {
        // The card is the app's surface card: base surface, hairline edge and the first elevation step.
        card: {
            backgroundColor: theme.colors.surface.base,
            ...surfaceBorderStyle,
            ...(hasVisibleSurfaceChrome ? shadowLevelStyle(theme.colors.shadowLevels[1]) : {}),
        },
        title: {
            ...Typography.default('semiBold'),
            ...happierPageTextMetrics('sectionTitle'),
            color: theme.colors.text.primary,
        },
        source: {
            ...Typography.default('regular'),
            ...happierPageTextMetrics('meta'),
            color: theme.colors.text.tertiary,
        },
        footer: {
            flex: 1,
            alignSelf: 'stretch',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
        },
        footerFill: {
            flex: 1,
        },
        footerPressed: {
            opacity: motionTokens.press.opacity,
        },
        footerLabel: {
            ...Typography.default('medium'),
            ...happierPageTextMetrics('meta'),
            color: theme.colors.text.primary,
        },
        ring: {
            ...RNStyleSheet.absoluteFillObject,
            borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx,
            borderWidth: 2,
            borderColor: theme.colors.state.info.border,
        },
        ringPlain: {
            // A plain widget has no corner of its own; the ring still marks its rows.
            borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx / 2,
        },
    };
});
