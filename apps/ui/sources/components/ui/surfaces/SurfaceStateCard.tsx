import { HAPPIER_STATE_LINE_METRICS, HAPPIER_STATE_SIZE_METRICS, HappierSurfaceState, HappierSurfaceStateLiveLine, resolveHappierStateFailureGlyph, resolveHappierSurfaceStateQuiet, type HappierSceneInput, type HappierStateSize, type HappierSurfaceStateAction, type HappierSurfaceStateBindings, type HappierSurfaceStateKind, type HappierSurfaceStateLive } from '@happier-dev/plugin-ui/presentation';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { DisclosedCodeText, useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { t } from '@/text';

import { useSurfaceStateCardSize } from './surfaceStateSize';
import { useSurfaceStateElapsedSeconds } from './useSurfaceStateElapsedSeconds';

export type SurfaceStateKind = HappierSurfaceStateKind;
/**
 * The container the state sits in (see `HappierStateSize`), or `line`: the compact in-list variant — one
 * quiet line on the rows' edge (glyph · sentence · inline link) that keeps a section in place when it is
 * loading, empty, failed or denied.
 */
export type SurfaceStateSize = HappierStateSize | 'line';
export type SurfaceStateAccessibilitySemantics = 'status' | 'alert';

/** A state replacing its container's facts, as distinct from a supplemental notice beside them. */
export const SurfaceStateContentContext = React.createContext<((key: symbol, empty: boolean | null) => void) | null>(null);

export type SurfaceStateAction = HappierSurfaceStateAction;

const DEFAULT_ICONS: Partial<Record<SurfaceStateKind, IconName>> = {
    empty: 'tray',
    success: 'check-circle',
    warning: 'warning-circle',
};

/** In a line the glyph is the only tint: a failure shows the warning mark in rose (failed), a warning in amber (needs you). */
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
export type SurfaceStateLive = HappierSurfaceStateLive;

const stylesheet = StyleSheet.create((theme) => ({
    detail: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        textAlign: 'center',
        marginTop: theme.space.s6,
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
    /** The inline recovery of a line (lab `.pj-line a`): ink, semibold, a soft hover; the same as the freshness line's. */
    lineAction: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    /** A state line is prose: proportional figures, so host names and ids keep their natural spacing. */
    lineText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    /** The live progress line's figures change in place, so they stay tabular. */
    liveText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    fullWidth: {
        alignSelf: 'stretch',
        width: '100%',
    },
}));

/**
 * Core's adapter over the ONE shared state composition (`HappierSurfaceState` in plugin-ui, which the
 * public plugin `SurfaceState` renders too; audit XS-3, pane-states lab 0): empty that invites, loading,
 * unavailable/offline, error with cause and recovery, permission denied, and the compact in-list line.
 * This adapter binds core typography, `RoundButton`, glyphs and the canonical {@link EmptyState} tile, and
 * keeps core's lifetimes private: the content-replacement report, the iOS announcer, the "Still waiting"
 * clock and translations. Stale content is not a card but {@link SurfaceFreshnessLine} over the retained
 * content.
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
    /** This state replaces the body; an empty state can use compact room inside a widget group. */
    replacesContent?: boolean;
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
    /** Controls that belong with the action: a choice it affects, or why it cannot proceed. Directly under the actions, before the note. */
    actionFooter?: React.ReactNode;
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
    const reportContent = React.useContext(SurfaceStateContentContext);
    const [contentKey] = React.useState(() => Symbol('surface-state'));
    React.useEffect(() => {
        if (!props.replacesContent || !reportContent) return;
        reportContent(contentKey, props.kind === 'empty' && props.body === undefined);
        return () => reportContent(contentKey, null);
    }, [contentKey, props.replacesContent, props.kind, props.body, reportContent]);
    const containerSize = useSurfaceStateCardSize();
    const size = props.size ?? containerSize;
    const failureGlyph = resolveHappierStateFailureGlyph(props.kind, size === 'line');
    const kindIconName = failureGlyph ? resolvePluginUiIconName(failureGlyph) : undefined;
    const animationEnabled = props.animationEnabled !== false;

    const accessibilityAnnouncement = [props.title, props.reason, props.detail]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
        .join('. ');
    const lastIosAnnouncementRef = React.useRef<string | null>(null);

    // iOS has no live regions, so the card speaks through the canonical announcer on
    // mount and whenever its semantics or text change; web/Android use the live
    // region the shared composition puts on its root (assertive for alerts, polite for status).
    React.useEffect(() => {
        if (Platform.OS !== 'ios' || !props.accessibilitySemantics) return;
        const transitionKey = `${props.accessibilitySemantics}\u0000${accessibilityAnnouncement}`;
        if (lastIosAnnouncementRef.current === transitionKey) return;
        lastIosAnnouncementRef.current = transitionKey;
        announceAccessibilityMessage(accessibilityAnnouncement);
    }, [accessibilityAnnouncement, props.accessibilitySemantics]);

    const bindings = useSurfaceStateBindings(props.testID, animationEnabled);
    const shared = {
        testID: props.testID,
        kind: props.kind,
        action: props.action,
        secondaryAction: props.secondaryAction,
        diagnosticCode: props.diagnosticCode,
        accessibilitySemantics: props.accessibilitySemantics,
        bindings,
    } as const;

    if (size === 'line') {
        const lineIconName = props.iconName ?? kindIconName ?? LINE_ICONS[props.kind];
        const lineTint = props.kind === 'error'
            ? theme.colors.state.danger.foreground
            : props.kind === 'warning'
                ? theme.colors.state.warning.foreground
                : theme.colors.text.tertiary;
        const lineGlyph = props.kind === 'loading' ? (
            <ActivitySpinner
                testID={props.testID ? `${props.testID}-loading-spinner` : undefined}
                size={HAPPIER_STATE_LINE_METRICS.glyphPx - 2}
                color={theme.colors.text.tertiary}
                animationEnabled={animationEnabled}
            />
        ) : props.icon ?? (lineIconName
            ? <Icon name={lineIconName} size={HAPPIER_STATE_LINE_METRICS.glyphPx} color={lineTint} />
            : undefined);
        return (
            <HappierSurfaceState
                {...shared}
                size="line"
                fillsContainer={props.replacesContent}
                glyph={lineGlyph}
                lineText={<>{props.titleContent ?? props.title}{props.reason ? (props.reasonContent != null ? <>{' · '}{props.reasonContent}</> : ` · ${props.reason}`) : null}</>}
            />
        );
    }

    const metrics = size ? HAPPIER_STATE_SIZE_METRICS[size] : null;
    const glyphSize = props.layout === 'inline' ? HAPPIER_STATE_LINE_METRICS.glyphPx : metrics?.glyphPx ?? 32;
    // Every kind shares the empty-state anatomy. The glyph stays calm in the secondary colour; the
    // title carries the trouble, so a failure is never a red "!" on a muted card.
    const glyph = props.kind === 'loading' ? (
        <ActivitySpinner
            testID={props.testID ? `${props.testID}-loading-spinner` : undefined}
            size={metrics ? glyphSize - 4 : 28}
            color={theme.colors.text.secondary}
            animationEnabled={animationEnabled}
        />
    ) : props.icon ?? (
        <Icon
            name={props.iconName ?? kindIconName ?? DEFAULT_ICONS[props.kind]!}
            size={glyphSize}
            color={theme.colors.text.secondary}
        />
    );
    // A sized loading state narrates a long wait on its own unless the caller says the present.
    const live = props.live
        ?? (props.kind === 'loading' && size && animationEnabled
            ? <SurfaceStateStillWaiting testID={props.testID} size={size} bindings={bindings} />
            : undefined);
    const reason = props.detail ? <Text>
        {props.reasonContent ?? (props.reason ? <Text>{props.reason}</Text> : null)}
        {props.reasonContent != null || props.reason ? '\n' : null}
        <Text testID={props.testID ? `${props.testID}-detail` : undefined} style={stylesheet.detail}>{props.detail}</Text>
    </Text> : props.reasonContent ?? props.reason;
    const tileBindings: HappierSurfaceStateBindings = {
        ...bindings,
        // Core's tile: the canonical EmptyState over the shared info tile, in core typography.
        renderTile: (tile) => tile.layout === 'inline' ? (
            <EmptyState
                layout="inline"
                icon={tile.glyph}
                title={props.title}
                titleContent={props.titleContent}
                subtitle={reason}
                titleTestID={tile.titleTestID}
                subtitleTestID={props.reason != null ? tile.reasonTestID : undefined}
                paddingHorizontal={0}
                paddingVertical={0}
            />
        ) : (
            <EmptyState
                size={metrics ? tile.size : undefined}
                icon={tile.glyph}
                scene={props.scene}
                animationEnabled={props.animationEnabled}
                title={props.title}
                titleContent={props.titleContent}
                subtitle={reason}
                titleTestID={tile.titleTestID}
                subtitleTestID={props.reason != null ? tile.reasonTestID : undefined}
                paddingHorizontal={metrics ? 0 : undefined}
                action={tile.action}
            />
        ),
    };
    return (
        <HappierSurfaceState
            {...shared}
            size={size}
            layout={props.layout}
            glyph={glyph}
            live={live}
            body={props.body}
            actionCaption={props.actionCaption}
            note={props.note}
            actionFooter={props.actionFooter}
            learnMore={props.learnMore}
            bindings={tileBindings}
        />
    );
}

/** Core's typography, buttons, spinner and disclosure for the shared state composition. */
function useSurfaceStateBindings(testID: string | undefined, animationEnabled: boolean): HappierSurfaceStateBindings {
    const { theme } = useUnistyles();
    const disclosure = useCoreDisclosureToggleBinding();
    return React.useMemo<HappierSurfaceStateBindings>(() => ({
        renderText: ({ role, metrics, align, testID: textTestID, onPress, children }) => {
            if (role === 'details') return disclosure.renderLabel(children);
            if (role === 'quietLink') {
                return <Text testID={textTestID} accessibilityRole="link" onPress={onPress} style={stylesheet.quietLink}>{children}</Text>;
            }
            const roleStyle = role === 'lineAction' ? stylesheet.lineAction : role === 'quiet' ? stylesheet.quiet
                : role === 'live' ? stylesheet.liveText : stylesheet.lineText;
            return <Text testID={textTestID} style={[roleStyle, metrics, role === 'quiet' && align === 'start' ? { textAlign: 'auto' } : null]}>{children}</Text>;
        },
        renderButton: ({ action, emphasis, tone, compact, fullWidth, testID: buttonTestID }) => (
            <RoundButton
                testID={buttonTestID}
                disabled={action.disabled}
                loading={action.busy}
                // Pointer panes keep a compact action; phone controls keep their touch-sized anatomy,
                // and a column-wide action is a form action, so it takes the form control's height.
                size={compact ? 'mini' : fullWidth ? 'normal' : 'small'}
                display={emphasis === 'secondary' ? 'inverted' : tone === 'filled' ? undefined : 'secondary'}
                textStyle={emphasis === 'secondary' ? Typography.default() : undefined}
                title={action.label}
                accessibilityLabel={action.label}
                style={fullWidth ? stylesheet.fullWidth : undefined}
                action={() => Promise.resolve(action.onPress())}
            />
        ),
        renderSpinner: (sizePx) => (
            <ActivitySpinner size={sizePx} color={theme.colors.text.secondary} animationEnabled={animationEnabled} />
        ),
        renderTile: () => null,
        detailsLabel: t('common.details'),
        // Quiet disclosure for the raw reason code: collapsed by default so the card leads with human
        // copy, one tap away when someone needs to report or debug.
        renderDetailsCaret: disclosure.renderCaret,
        focusRing: disclosure.focusColor,
        renderDetailsCode: (detail) => (
            <DisclosedCodeText testID={testID ? `${testID}-details-code` : undefined} align="center">{detail}</DisclosedCodeText>
        ),
        pressedFill: theme.colors.surface.pressed,
    }), [animationEnabled, disclosure, testID, theme]);
}

/**
 * The live "Still waiting · 12 s" line of a sized loading state. A leaf with its own clock, so the tick
 * re-renders only this line; it mounts only while a sized loading state is visible and animated.
 */
function SurfaceStateStillWaiting(props: Readonly<{
    testID?: string;
    size: HappierStateSize;
    bindings: HappierSurfaceStateBindings;
}>): React.ReactElement | null {
    const elapsedSeconds = useSurfaceStateElapsedSeconds();
    if (elapsedSeconds < STILL_WAITING_AFTER_MS / 1_000) return null;
    return (
        <HappierSurfaceStateLiveLine
            testID={props.testID}
            live={{ text: t('surfaceState.stillWaiting', { seconds: elapsedSeconds }) }}
            metrics={resolveHappierSurfaceStateQuiet(props.size).metrics}
            bindings={props.bindings}
        />
    );
}
