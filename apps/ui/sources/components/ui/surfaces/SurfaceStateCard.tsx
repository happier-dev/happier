import { defineHappierScene, HAPPIER_STATE_LINE_METRICS, HAPPIER_STATE_SIZE_METRICS, HappierDisclosureToggle, HappierSurfaceState, HappierSurfaceStateLiveLine, resolveHappierStateFailureGlyph, resolveHappierSurfaceStateQuiet, type HappierSceneInput, type HappierStateSize, type HappierSurfaceStateAction, type HappierSurfaceStateBindings, type HappierSurfaceStateKind, type HappierSurfaceStateLive } from '@happier-dev/plugin-ui/presentation';
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

import { useSurfaceStateCardSize, useSurfaceStateQuietActions } from './surfaceStateSize';
import { useSurfaceStateElapsedSeconds } from './useSurfaceStateElapsedSeconds';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useModalContentId } from '@/modal/ModalProvider';

export type SurfaceStateKind = HappierSurfaceStateKind;
/**
 * The container the state sits in (see `HappierStateSize`), or `line`: the compact in-list variant — one
 * quiet line on the rows' edge (glyph · sentence · inline link) that keeps a section in place when it is
 * loading, empty, failed or denied.
 */
export type SurfaceStateSize = HappierStateSize | 'line';
export type SurfaceStateAccessibilitySemantics = 'status' | 'alert';

/** A state replacing its container's facts, as distinct from a supplemental notice beside them. */
/**
 * What a state that replaces its body tells the frame around it: whether it is an empty state, whether it is one line
 * (the whole body is that line, so the frame sizes to it), and whether it is still loading (the room stays held).
 */
export type SurfaceStateContentReport = Readonly<{ empty: boolean; line: boolean; loading: boolean }>;
export const SurfaceStateContentContext = React.createContext<((key: symbol, report: SurfaceStateContentReport | null) => void) | null>(null);

export type SurfaceStateAction = HappierSurfaceStateAction;

const DEFAULT_ICONS: Partial<Record<SurfaceStateKind, IconName>> = {
    empty: 'tray',
    success: 'check-circle',
    warning: 'warning-circle',
};

/**
 * In a line only a warning tints its glyph (amber: needs you). A failure keeps its mark in the line's ink, as a
 * card keeps its glyph calm: the words carry the trouble, so a list of folders never reads as a row of alarms.
 */
const LINE_ICONS: Partial<Record<SurfaceStateKind, IconName | null>> = {
    empty: null,
    success: 'check-circle',
    warning: 'warning',
};

/**
 * The one scene a failure draws when it fills a sized surface (a page, a pane, a details area, a widget) and
 * its caller names none: the Daybreak ridge at dusk with the planet in its failed state, so a surface that
 * failed reads like its empty state. A local failure (a line among rows, an inline note, an unsized card)
 * keeps its glyph.
 */
const SURFACE_FAILURE_SCENE = defineHappierScene({ name: 'happier.surfaceFailed', horizon: 'ridge', moment: 'dusk', planet: 'failed' });

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
    /** `menu`: a line state among a transient menu's rows (a picker's empty or failed list) sits on their label edge. */
    lineDensity?: 'menu';
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
    /** Sanitized diagnostics or correlation shown with the code inside Details; never spoken. */
    diagnosticDetail?: string | null;
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
    const containerSize = useSurfaceStateCardSize();
    const size = props.size ?? containerSize;
    const reportedEmpty = props.kind === 'empty' && props.body === undefined;
    React.useEffect(() => {
        if (!props.replacesContent || !reportContent) return;
        reportContent(contentKey, { empty: reportedEmpty, line: size === 'line', loading: props.kind === 'loading' });
        return () => reportContent(contentKey, null);
    }, [contentKey, props.replacesContent, props.kind, reportedEmpty, size, reportContent]);
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

    const bindings = useSurfaceStateBindings(props.testID, animationEnabled, props.title);
    // A container that never owns its page's primary (a widget card) offers every state's way forward quiet:
    // the shared composition draws a step that is not an invitation in the secondary tone.
    const quietActions = useSurfaceStateQuietActions();
    const action = quietActions && props.action ? { ...props.action, invitation: false } : props.action;
    const shared = {
        testID: props.testID,
        kind: props.kind,
        action,
        secondaryAction: props.secondaryAction,
        diagnosticCode: props.diagnosticCode,
        diagnosticDetail: props.diagnosticDetail,
        accessibilitySemantics: props.accessibilitySemantics,
        bindings,
    } as const;

    if (size === 'line') {
        const lineIconName = props.iconName ?? kindIconName ?? LINE_ICONS[props.kind];
        const lineTint = props.kind === 'error'
            ? theme.colors.text.secondary
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
                lineDensity={props.lineDensity}
                glyph={lineGlyph}
                lineText={<>{props.titleContent ?? props.title}{props.reason ? (props.reasonContent != null ? <>{' · '}{props.reasonContent}</> : ` · ${props.reason}`) : null}</>}
            />
        );
    }

    const metrics = size ? HAPPIER_STATE_SIZE_METRICS[size] : null;
    const scene = props.scene ?? (metrics && props.layout !== 'inline' && (props.kind === 'error' || props.kind === 'unavailable')
        ? SURFACE_FAILURE_SCENE : undefined);
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
                quietTitle={tile.quietTitle}
                icon={tile.glyph}
                scene={scene}
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
function useSurfaceStateBindings(testID: string | undefined, animationEnabled: boolean, title: string): HappierSurfaceStateBindings {
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
                action={(event) => Promise.resolve(action.onPress(event))}
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
        renderDetailsToggle: props => <SurfaceStateDetailsToggle {...props} title={title} />,
        focusRing: disclosure.focusColor,
        renderDetailsCode: (detail, align = 'center') => (
            <DisclosedCodeText testID={testID ? `${testID}-details-code` : undefined} align={align === 'center' ? 'center' : undefined}>{detail}</DisclosedCodeText>
        ),
        pressedFill: theme.colors.surface.pressed,
    }), [animationEnabled, disclosure, testID, theme, title]);
}

/** The shared disclosure owns its state; core exposes that same intent through the mounted command. */
function SurfaceStateDetailsToggle(props: React.ComponentProps<typeof HappierDisclosureToggle> & Readonly<{ title: string }>) {
    const { title, ...toggleProps } = props;
    const modalId = useModalContentId();
    const commands = useCurrentUiContextLocalCommands([{ key: 'toggle', title: `${title}: ${props.label}`, invoke: props.onPress }],
        { foregroundOverlay: modalId !== null, unbound: 'local' });
    return <HappierDisclosureToggle {...toggleProps} onPress={() => { void commands.invoke('toggle'); }} />;
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
