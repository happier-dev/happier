import { HAPPIER_STATE_LINE_METRICS, HAPPIER_STATE_SIZE_METRICS, HappierSurfaceStateFrame, HappierStateLine, HappierStateDetails, resolveHappierStateAnnouncement, resolveHappierStateFailureGlyph, type HappierSceneInput, type HappierStateSize, type HappierSurfaceStateKind } from '@happier-dev/plugin-ui/presentation';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { useSurfaceStateCardSize } from './surfaceStateSize';

export type SurfaceStateKind = HappierSurfaceStateKind;
/**
 * The container the state sits in (see `HappierStateSize`), or `line`: the compact in-list variant — one
 * quiet line on the rows' edge (glyph · sentence · inline link) that keeps a section in place when it is
 * loading, empty, failed or denied.
 */
export type SurfaceStateSize = HappierStateSize | 'line';
export type SurfaceStateAccessibilitySemantics = 'status' | 'alert';

export type SurfaceStateAction = Readonly<{
    /** Already-translated action label. */
    label: string;
    onPress: () => void | Promise<unknown>;
    testID?: string;
    disabled?: boolean;
    /** Pending work owned by the caller; returned promises also retain shared pending behavior. */
    busy?: boolean;
}>;

const DEFAULT_ICONS: Partial<Record<SurfaceStateKind, IconName>> = {
    empty: 'tray',
    success: 'check-circle',
    warning: 'warning-circle',
};

/** In a line the glyph is the only tint: a failure shows the warning mark, nothing else changes. */
const LINE_ICONS: Partial<Record<SurfaceStateKind, IconName | null>> = {
    empty: null,
    success: 'check-circle',
    warning: 'warning',
};

/**
 * A wait becomes worth narrating after this long: a first read that answers quickly never shows the
 * line, one that doesn't says so instead of spinning silently (pane-states lab 0, "L").
 */
const STILL_WAITING_AFTER_MS = 5_000;

/** A present-tense line under the state: "Reconnecting · next try in 8 s", "Still waiting · 12 s". */
export type SurfaceStateLive = Readonly<{
    /** Already-translated. */
    text: string;
    /** Draws a small working ring before the text. */
    busy?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    actions: {
        flexDirection: 'row',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        justifyContent: 'center',
    },
    detail: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        opacity: 0.9,
        marginTop: -10,
    },
    hiddenDiagnostic: {
        width: 0,
        height: 0,
    },
    detailsToggleLabel: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        // Quiet by size and placement, not by contrast: small text keeps the
        // secondary role so it stays legible.
        color: theme.colors.text.secondary,
    },
    detailsCode: {
        ...Typography.mono(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    iconWrap: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    quiet: {
        ...Typography.default(),
        color: theme.colors.text.tertiary,
        textAlign: 'center',
    },
    quietLink: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        textDecorationLine: 'underline',
    },
    live: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    liveText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    fullWidth: {
        alignSelf: 'stretch',
        width: '100%',
    },
    liveAndActions: {
        alignItems: 'center',
        gap: 16,
    },
    inline: {
        alignSelf: 'stretch',
        gap: 4,
    },
    inlineFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
}));

/**
 * The ONE shared state composition for panes, details and app surfaces (audit XS-3; pane-states lab 0):
 * empty that invites, loading, unavailable/offline, error with cause and recovery, permission denied,
 * and the compact in-list line. Composes the canonical {@link EmptyState} (icon + title + copy + action
 * slot); stale content is not a card but {@link SurfaceFreshnessLine} over the retained content.
 *
 * Size comes from the container: the right sidebar, details drawer and phone panes set it once through
 * `SurfaceStateSizeProvider`, an explicit `size` wins, and outside both the card keeps its unsized
 * centred column. One message per state; the container never resizes around it.
 *
 * i18n is the caller's responsibility: `title` and `reason` are already-translated HUMAN copy (route
 * reason codes through `resolveReasonCopy` first). The raw machine code goes on `diagnosticCode`: it is
 * never the headline, reason or an accessibility label. On a failure card (error, unavailable, warning)
 * it stays behind a quiet, collapsed "Details" disclosure for support and expert users (DESIGN.md "Error
 * and recovery copy"); every card keeps it on a testID marker for QA.
 */
export function SurfaceStateCard(props: Readonly<{
    testID?: string;
    kind: SurfaceStateKind;
    /** The container step; defaults to the enclosing `SurfaceStateSizeProvider`. */
    size?: SurfaceStateSize;
    /** Existing inline anatomy for a state inside a sheet; whole-pane states stay centered. */
    layout?: 'centered' | 'inline';
    /** Already-translated title: what is here, or what failed, in the person's words. */
    title: string;
    /** Optional glyph decoration inside the existing title Text; semantic copy stays in `title`. */
    titleContent?: React.ReactNode;
    /** Already-translated human explanation — the promise, or the cause (never a raw reason code). */
    reason?: string;
    /** Optional glyph decoration inside the existing reason Text; semantic copy stays in `reason`. */
    reasonContent?: React.ReactNode;
    /** Raw machine reason code — collapsed Details disclosure and testID marker only. */
    diagnosticCode?: string | null;
    /** Optional sanitized supplemental detail. Never pass a raw machine code. */
    detail?: string;
    /** The one next step (create the first item, retry, check again…). */
    action?: SurfaceStateAction;
    /** A quiet second way forward beside it. */
    secondaryAction?: SurfaceStateAction;
    /** "How it works": a quiet link under the actions, after the {@link note} when there is one. */
    learnMore?: SurfaceStateAction;
    /** A quiet line under the actions: a prerequisite ("Runs on a machine in Personal Home.") or a reassurance ("Nothing is lost."). */
    note?: string;
    /**
     * The present, under the copy ("Reconnecting · next try in 8 s"). A sized loading state narrates a
     * long wait on its own ("Still waiting · 12 s") unless this is given.
     */
    live?: SurfaceStateLive;
    /** Caller-owned domain summary, after copy/live and before actions. Compact line states omit it. */
    body?: React.ReactNode;
    /** Quiet context for the next action, after the domain summary. */
    actionCaption?: string;
    /** Caller-owned glyph when a surface has a domain-specific icon. */
    icon?: React.ReactNode;
    /** Override the per-kind default glyph. */
    iconName?: IconName;
    /**
     * The Daybreak scene drawn in the glyph's place (plugin-ui scene registry) when the card is centred
     * with room for it; a line or inline card keeps its glyph. Pass a built-in scene id or a scene
     * defined once.
     */
    scene?: HappierSceneInput;
    animationEnabled?: boolean;
    /** Opts this dynamic state into one live-region owner; static cards stay silent by default. */
    accessibilitySemantics?: SurfaceStateAccessibilitySemantics;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const containerSize = useSurfaceStateCardSize();
    const size = props.size ?? containerSize;
    const failureGlyph = resolveHappierStateFailureGlyph(props.kind, size === 'line');
    const kindIconName = failureGlyph ? resolvePluginUiIconName(failureGlyph) : undefined;

    // U8.5 craft S4: every kind shares the empty-state anatomy. The glyph stays calm in the secondary
    // colour; the title carries the trouble, so a failure is never a red "!" on a muted card.
    const glyphColor = theme.colors.text.secondary;
    const accessibilityAnnouncement = [props.title, props.reason, props.detail]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
        .join('. ');
    const lastIosAnnouncementRef = React.useRef<string | null>(null);

    // iOS has no live regions, so the card speaks through the canonical announcer on
    // mount and whenever its semantics or text change; web/Android use the live
    // region on the root below (assertive for alerts, polite for status).
    React.useEffect(() => {
        if (Platform.OS !== 'ios' || !props.accessibilitySemantics) return;
        const transitionKey = `${props.accessibilitySemantics}\u0000${accessibilityAnnouncement}`;
        if (lastIosAnnouncementRef.current === transitionKey) return;
        lastIosAnnouncementRef.current = transitionKey;
        announceAccessibilityMessage(accessibilityAnnouncement);
    }, [accessibilityAnnouncement, props.accessibilitySemantics]);

    const liveRegionProps = resolveHappierStateAnnouncement(props.accessibilitySemantics);

    const diagnosticMarker = props.diagnosticCode ? (
        // Nothing failed (or nothing to disclose in a line), so the code stays on the QA testID channel only.
        <View
            testID={props.testID ? `${props.testID}-diagnostic-${props.diagnosticCode}` : undefined}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.hiddenDiagnostic}
        />
    ) : null;

    if (size === 'line') {
        const lineIconName = props.iconName ?? kindIconName ?? LINE_ICONS[props.kind];
        const lineTint = props.kind === 'error' || props.kind === 'warning'
            ? theme.colors.state.warning.foreground
            : theme.colors.text.tertiary;
        const lineGlyph = props.kind === 'loading' ? (
            <ActivitySpinner
                testID={props.testID ? `${props.testID}-loading-spinner` : undefined}
                size={HAPPIER_STATE_LINE_METRICS.glyphPx - 2}
                color={theme.colors.text.tertiary}
                animationEnabled={props.animationEnabled !== false}
            />
        ) : props.icon ?? (lineIconName
            ? <Icon name={lineIconName} size={HAPPIER_STATE_LINE_METRICS.glyphPx} color={lineTint} />
            : undefined);
        return (
            <View {...liveRegionProps}>
                <HappierStateLine
                    testID={props.testID}
                    icon={lineGlyph}
                    action={(
                        <View style={{ flexDirection: 'row', gap: HAPPIER_STATE_LINE_METRICS.gapPx }}>
                            {[props.action, props.secondaryAction].map((action, index) => action ? (
                                <HappierPressable
                                    key={index}
                                    testID={action.testID ?? (props.testID ? `${props.testID}-${index === 0 ? 'action' : 'secondary-action'}` : undefined)}
                                    accessibilityRole="button"
                                    accessibilityLabel={action.label}
                                    disabled={action.disabled}
                                    busy={action.busy}
                                    onPress={action.onPress}
                                    style={{ minHeight: HAPPIER_STATE_LINE_METRICS.minHeightPx, justifyContent: 'center' }}
                                >
                                    <Text style={[styles.quietLink, HAPPIER_STATE_LINE_METRICS.text]}>{action.label}</Text>
                                </HappierPressable>
                            ) : null)}
                        </View>
                    )}
                ><Text style={[styles.liveText, HAPPIER_STATE_LINE_METRICS.text]}>{props.titleContent ?? props.title}{props.reason ? (props.reasonContent != null ? <>{' · '}{props.reasonContent}</> : ` · ${props.reason}`) : null}</Text></HappierStateLine>
                {diagnosticMarker}
            </View>
        );
    }

    const metrics = size ? HAPPIER_STATE_SIZE_METRICS[size] : null;
    const glyphSize = props.layout === 'inline' ? HAPPIER_STATE_LINE_METRICS.glyphPx : metrics?.glyphPx ?? 32;
    const icon = props.kind === 'loading' ? (
        <ActivitySpinner
            testID={props.testID ? `${props.testID}-loading-spinner` : undefined}
            size={metrics ? glyphSize - 4 : 28}
            color={theme.colors.text.secondary}
            animationEnabled={props.animationEnabled !== false}
        />
    ) : props.icon ?? (
        <Icon
            name={props.iconName ?? kindIconName ?? DEFAULT_ICONS[props.kind]!}
            size={glyphSize}
            color={glyphColor}
        />
    );
    const buttonStyle = metrics?.fullWidthActions ? styles.fullWidth : undefined;
    const quietTextStyle = metrics
        ? { fontSize: metrics.quiet.fontSize, lineHeight: metrics.quiet.lineHeight }
        : { fontSize: 12, lineHeight: 17 };
    const quietGap = metrics?.quietGapPx ?? 12;

    const live = props.live
        ? <SurfaceStateLiveLine testID={props.testID} live={props.live} textStyle={quietTextStyle} animationEnabled={props.animationEnabled !== false} />
        : props.kind === 'loading' && size && props.animationEnabled !== false
            ? <SurfaceStateStillWaiting testID={props.testID} textStyle={quietTextStyle} />
            : null;

    const quietLine = props.note || props.learnMore ? (
        <Text
            testID={props.testID ? `${props.testID}-note` : undefined}
            style={[styles.quiet, quietTextStyle, { marginTop: quietGap }]}
        >
            {props.note ?? null}
            {props.note && props.learnMore ? ' ' : null}
            {props.learnMore ? (
                <Text
                    testID={props.testID ? `${props.testID}-learn-more` : undefined}
                    accessibilityRole="link"
                    onPress={() => { void props.learnMore!.onPress(); }}
                    style={styles.quietLink}
                >
                    {props.learnMore.label}
                </Text>
            ) : null}
        </Text>
    ) : null;

    const actions = props.action || props.secondaryAction ? (
        <View style={[styles.actions, metrics?.fullWidthActions ? { flexDirection: 'column', alignItems: 'stretch', alignSelf: 'stretch' } : null]}>
            {props.action ? (
                <RoundButton
                    testID={props.action.testID ?? (props.testID ? `${props.testID}-action` : undefined)}
                    disabled={props.action.disabled}
                    loading={props.action.busy}
                    // Pointer panes keep a compact action; phone controls keep their touch-sized anatomy.
                    size={size === 'phone' || size === undefined ? 'small' : 'mini'}
                    display={props.kind === 'empty' || props.kind === 'success' ? undefined : 'secondary'}
                    title={props.action.label}
                    accessibilityLabel={props.action.label}
                    style={buttonStyle}
                    action={() => Promise.resolve(props.action!.onPress())}
                />
            ) : null}
            {props.secondaryAction ? (
                <RoundButton
                    testID={props.secondaryAction.testID ?? (props.testID ? `${props.testID}-secondary-action` : undefined)}
                    disabled={props.secondaryAction.disabled}
                    loading={props.secondaryAction.busy}
                    size={size === 'phone' || size === undefined ? 'small' : 'mini'}
                    display="inverted"
                    title={props.secondaryAction.label}
                    textStyle={Typography.default()}
                    accessibilityLabel={props.secondaryAction.label}
                    style={buttonStyle}
                    action={() => Promise.resolve(props.secondaryAction!.onPress())}
                />
            ) : null}
        </View>
    ) : undefined;

    const iconSlot = (
        <View
            testID={props.testID ? `${props.testID}-icon` : undefined}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.iconWrap}
        >
            {icon}
        </View>
    );
    const actionCaption = props.actionCaption && actions ? <Text style={[styles.liveText, quietTextStyle]}>{props.actionCaption}</Text> : null;
    const supplemental = <>
        {props.detail ? <Text testID={props.testID ? `${props.testID}-detail` : undefined} style={styles.detail}>{props.detail}</Text> : null}
        {quietLine}
        {props.diagnosticCode ? (
            props.kind === 'loading' || props.kind === 'empty' || props.kind === 'success' || props.kind === 'denied'
                ? diagnosticMarker
                : <SurfaceStateDiagnosticDetails testID={props.testID} diagnosticCode={props.diagnosticCode} />
        ) : null}
    </>;
    if (props.layout === 'inline') {
        return <View testID={props.testID} {...liveRegionProps} style={styles.inline}>
            <EmptyState
                layout="inline"
                icon={iconSlot}
                title={props.title}
                titleContent={props.titleContent}
                subtitle={props.reasonContent ?? props.reason}
                titleTestID={props.testID ? `${props.testID}-title` : undefined}
                subtitleTestID={props.testID && props.reason != null ? `${props.testID}-reason` : undefined}
                paddingHorizontal={0}
                paddingVertical={0}
            />
            {live ? <View style={{ alignItems: 'flex-start' }}>{live}</View> : null}
            {props.body}
            {actions ? <View style={[styles.inlineFooter, metrics?.fullWidthActions ? { flexDirection: 'column', alignItems: 'stretch' } : null]}>{actionCaption}{actions}</View> : null}
            {supplemental}
        </View>;
    }

    return (
        <HappierSurfaceStateFrame
            testID={props.testID}
            size={size}
            accessibilitySemantics={props.accessibilitySemantics}
        >
                <EmptyState
                    size={metrics ? size : undefined}
                    icon={iconSlot}
                    scene={props.scene}
                    animationEnabled={props.animationEnabled}
                    title={props.title}
                    titleContent={props.titleContent}
                    subtitle={props.reasonContent ?? props.reason}
                    titleTestID={props.testID ? `${props.testID}-title` : undefined}
                    subtitleTestID={props.testID && props.reason != null ? `${props.testID}-reason` : undefined}
                    paddingHorizontal={metrics ? 0 : undefined}
                    // The present reads with the copy, before the way forward (lab 0: title · copy · live · action).
                    action={props.body ? (
                        <View style={[styles.liveAndActions, styles.fullWidth]}>
                            {live}
                            <View style={styles.fullWidth}>{props.body}</View>
                            {actionCaption}
                            {actions}
                        </View>
                    ) : live && actions ? (
                        <View style={[styles.liveAndActions, metrics?.fullWidthActions ? styles.fullWidth : null]}>
                            {live}
                            {actions}
                        </View>
                    ) : live ?? actions}
                />
                {supplemental}
        </HappierSurfaceStateFrame>
    );
}

function SurfaceStateLiveLine(props: Readonly<{
    testID?: string;
    live: SurfaceStateLive;
    textStyle: Readonly<{ fontSize: number; lineHeight: number }>;
    animationEnabled: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID ? `${props.testID}-live` : undefined} style={stylesheet.live}>
            {props.live.busy ? (
                <ActivitySpinner
                    size={props.textStyle.fontSize}
                    color={theme.colors.text.secondary}
                    animationEnabled={props.animationEnabled}
                />
            ) : null}
            <Text style={[stylesheet.liveText, props.textStyle]}>{props.live.text}</Text>
        </View>
    );
}

/**
 * The live "Still waiting · 12 s" line of a sized loading state. A leaf with its own clock, so the tick
 * re-renders only this line; it mounts only while a sized loading state is visible and animated.
 */
function SurfaceStateStillWaiting(props: Readonly<{
    testID?: string;
    textStyle: Readonly<{ fontSize: number; lineHeight: number }>;
}>): React.ReactElement | null {
    const [elapsedMs, setElapsedMs] = React.useState(0);
    React.useEffect(() => {
        const startedAt = Date.now();
        const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
        return () => clearInterval(interval);
    }, []);
    if (elapsedMs < STILL_WAITING_AFTER_MS) return null;
    return (
        <SurfaceStateLiveLine
            testID={props.testID}
            live={{ text: t('surfaceState.stillWaiting', { seconds: Math.floor(elapsedMs / 1_000) }) }}
            textStyle={props.textStyle}
            animationEnabled
        />
    );
}

/**
 * Quiet disclosure for the raw reason code: collapsed by default so the card
 * leads with human copy, one tap away when someone needs to report or debug.
 */
function SurfaceStateDiagnosticDetails(props: Readonly<{
    testID?: string;
    diagnosticCode: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const label = t('common.details');
    return (
        <HappierStateDetails
            testID={props.testID}
            markerTestID={props.testID ? `${props.testID}-diagnostic-${props.diagnosticCode}` : undefined}
            label={label}
            details={props.diagnosticCode}
            renderToggle={(open) => <>
                <Icon
                    name={open ? 'caret-down' : 'caret-right'}
                    size={12}
                    color={theme.colors.text.secondary}
                />
                <Text accessible={false} style={styles.detailsToggleLabel}>{label}</Text>
            </>}
            renderDetails={(detail) => (
                <Text
                    testID={props.testID ? `${props.testID}-details-code` : undefined}
                    selectable
                    style={styles.detailsCode}
                >
                    {detail}
                </Text>
            )}
        />
    );
}
