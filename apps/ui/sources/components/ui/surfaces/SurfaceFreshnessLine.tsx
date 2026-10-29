import { HAPPIER_FRESHNESS_LINE_METRICS, HappierFreshnessClauses, HappierFreshnessLine, HappierPressable, resolveHappierFreshnessText } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';

import type { SurfaceStateAction } from './SurfaceStateCard';

/** A recovery on the line; `primary` marks the one forward step when the line offers more than one. */
export type SurfaceFreshnessAction = SurfaceStateAction & Readonly<{ emphasis?: 'primary' }>;

const SurfaceFreshnessOnSheetContext = React.createContext(false);

/**
 * Hosts whose body already sits on a sheet or card (a widget body, a popover, a dialog) render the line plain
 * on it. `onSheet={false}` keeps the strip (a fullscreen page) without changing the host's tree shape.
 */
export function SurfaceFreshnessOnSheetProvider(props: Readonly<{ onSheet?: boolean; children: React.ReactNode }>): React.ReactElement {
    return <SurfaceFreshnessOnSheetContext.Provider value={props.onSheet ?? true}>{props.children}</SurfaceFreshnessOnSheetContext.Provider>;
}

/**
 * Stale content, told honestly (pane-states lab 0, "Stale"): the last-known content stays at full
 * strength and this one quiet line sits under the surface's header — as of when, why, and one Retry.
 *
 * It never sits over an empty body: a surface that has nothing retained is loading or failed and shows
 * `SurfaceStateCard` instead. Rows never dim. Render it only while the content is stale.
 */
export function SurfaceFreshnessLine(props: Readonly<{
    testID?: string;
    /** When the retained content was last read. Omit when the reason alone says it ("Reconnecting…"). */
    asOf?: number | null;
    /** Already-translated reason: "devbox isn't answering", "reconnecting to MacBook Pro…". */
    reason: string;
    /** A reconnect or refresh is in flight: a small ring replaces the glyph. */
    busy?: boolean;
    /** `warning` tints the strip when retained work needs attention. */
    tone?: 'neutral' | 'warning';
    /** The one recovery (Retry). */
    action?: SurfaceFreshnessAction;
    /**
     * A line that resolves a decision offers its few choices together (Compare · Use mine · Use theirs).
     * Replaces `action`; each choice stays an inline link on the line, never a button row.
     */
    actions?: readonly SurfaceFreshnessAction[];
    /** The part of `reason` that names what happened; drawn in the stronger weight. */
    emphasis?: string;
    /** The line's own mark when the cause has one (offline, back online); defaults to the retained-content glyph. */
    glyph?: IconName;
    animationEnabled?: boolean;
    /**
     * `chip`: the same facts as one inline status at a header's or tab bar's end (resources lab `.rs-live`):
     * "● Live", "Paused", "As of 10:42 · Checking…", "As of 10:42 · Retry". Its glyph is the `signal` dot
     * while nothing is behind, the ring while `busy`, else the clock of held content.
     */
    presentation?: 'line' | 'chip';
    /** Chip only: the steady state's dot, `live` (sampling) or `quiet` (paused, offline). */
    signal?: 'live' | 'quiet';
    /** Chip only: a quiet clause before the glyph ("Sampled only while you're looking"). */
    lead?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const onSheet = React.useContext(SurfaceFreshnessOnSheetContext);
    const chip = props.presentation === 'chip';
    const actions = props.actions ?? (props.action ? [props.action] : []);
    const parts = resolveHappierFreshnessText({
        asOf: props.asOf,
        reason: props.reason,
        formatAsOf: (time) => t('surfaceState.asOf', { time }),
        locale: getPreferredLanguage(),
        parts: true,
    });
    const text = parts.text;
    return (
        <HappierFreshnessLine
            testID={props.testID}
            busy={props.busy}
            onSheet={onSheet}
            // The tint carries the warning; its edges stay ink hairlines (an amber rule read heavier than the words).
            colors={{ background: props.tone === 'warning' ? theme.colors.state.warning.background : theme.colors.surface.inset,
                border: theme.colors.border.default }}
            presentation={chip ? 'chip' : 'line'}
            lead={chip && props.lead ? (
                <Text testID={props.testID ? `${props.testID}-lead` : undefined} style={[stylesheet.text, stylesheet.lead]} numberOfLines={1}>{props.lead}</Text>
            ) : undefined}
            icon={chip && props.signal && !props.busy ? (
                <StatusDot
                    testID={props.testID ? `${props.testID}-signal` : undefined}
                    color={props.signal === 'live' ? theme.colors.state.success.foreground : theme.colors.text.tertiary}
                    size={HAPPIER_FRESHNESS_LINE_METRICS.chip.dotPx}
                />
            ) : props.busy ? (
                <ActivitySpinner
                    testID={props.testID ? `${props.testID}-spinner` : undefined}
                    size={HAPPIER_FRESHNESS_LINE_METRICS.glyphPx - 1}
                    color={theme.colors.text.tertiary}
                    animationEnabled={props.animationEnabled !== false}
                />
            ) : (
                <Icon
                    name={props.glyph ?? (props.tone === 'warning' ? 'warning' : chip ? 'clock' : 'arrow-clockwise')}
                    size={HAPPIER_FRESHNESS_LINE_METRICS.glyphPx}
                    color={props.tone === 'warning' ? theme.colors.state.warning.foreground : theme.colors.text.tertiary}
                />
            )}
            action={actions.length > 0 ? (
                <View style={stylesheet.actions}>
                {/* A chip reads as one phrase, "As of 10:42 · Retry" (lab `.rs-live`); the strip ends with its link instead. */}
                {chip && text ? <Text style={stylesheet.text} aria-hidden accessibilityElementsHidden importantForAccessibility="no">·</Text> : null}
                {actions.map((action, index) => (
                    <HappierPressable
                        key={action.testID ?? action.label}
                        testID={action.testID ?? (props.testID ? `${props.testID}-action${index === 0 ? '' : `-${index}`}` : undefined)}
                        accessibilityRole="button"
                        accessibilityLabel={action.label}
                        // The link's finger reach stays inside the line's own block padding (a chip has none): past
                        // it lies the next row, whose own target it would take taps from.
                        hitReach={{ top: chip ? 0 : HAPPIER_FRESHNESS_LINE_METRICS.paddingVerticalPx, bottom: chip ? 0 : HAPPIER_FRESHNESS_LINE_METRICS.paddingVerticalPx }}
                        disabled={action.disabled}
                        busy={action.busy}
                        onPress={action.onPress}
                        style={({ focused }) => [stylesheet.link, chip ? stylesheet.chipLink : null, focusRingStyle({ focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={[stylesheet.linkLabel, action.emphasis === 'primary' ? stylesheet.primaryLabel : null,
                            action.disabled ? stylesheet.disabledLabel : null]}>{action.label}</Text>
                    </HappierPressable>
                ))}
                </View>
            ) : null}
        >
            {chip || parts.asOf === null ? (
                <Text testID={props.testID ? `${props.testID}-text` : undefined} style={stylesheet.text} numberOfLines={chip ? 1 : 2}>
                    {renderEmphasis(text, props.emphasis)}
                </Text>
            ) : (
                // One block, two clauses: on one line when they fit, the time over the reason when not (L4, FB1o).
                <View testID={props.testID ? `${props.testID}-text` : undefined} accessible accessibilityLabel={text}>
                    <HappierFreshnessClauses
                        asOf={<Text style={stylesheet.text} numberOfLines={1}>{parts.asOf}</Text>}
                        reason={parts.reason ? <Text style={stylesheet.text} numberOfLines={2}>{renderEmphasis(parts.reason, props.emphasis)}</Text> : null}
                        separator={(hidden) => (
                            <Text style={[stylesheet.text, hidden ? stylesheet.hiddenSeparator : null]} aria-hidden
                                accessibilityElementsHidden importantForAccessibility="no">{' · '}</Text>
                        )}
                    />
                </View>
            )}
        </HappierFreshnessLine>
    );
}

function renderEmphasis(text: string, emphasis: string | undefined): React.ReactNode {
    const at = emphasis ? text.indexOf(emphasis) : -1;
    if (!emphasis || at < 0) return text;
    return <>{text.slice(0, at)}<Text style={stylesheet.emphasis}>{emphasis}</Text>{text.slice(at + emphasis.length)}</>;
}

const stylesheet = StyleSheet.create((theme) => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: theme.space.s8,
    },
    emphasis: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    // The forward step among several choices is the link colour; the others stay ink.
    primaryLabel: {
        color: theme.colors.text.link,
    },
    disabledLabel: {
        color: theme.colors.text.tertiary,
    },
    text: {
        ...Typography.default(),
        ...HAPPIER_FRESHNESS_LINE_METRICS.text,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    // Hidden, not removed: the dot keeps its width so the clauses never re-flow when it goes.
    hiddenSeparator: {
        opacity: 0,
    },
    link: {
        // Drawn the same under every pointer; a finger reaches past it through the hit area.
        minHeight: HAPPIER_FRESHNESS_LINE_METRICS.chip.minHeightPx,
        justifyContent: 'center',
        paddingHorizontal: theme.space.s4,
    },
    // The tab's clause stands apart from the status it qualifies (lab `rp` H: clause, then "● Live").
    lead: {
        marginRight: theme.space.s6,
    },
    // In a chip the link keeps the chip's height (its press frame grows through hitSlop), so the chip does not
    // change height between "Live" and "As of 10:42 · Retry".
    chipLink: {
        minHeight: HAPPIER_FRESHNESS_LINE_METRICS.chip.minHeightPx,
        paddingHorizontal: theme.space.s2,
        borderRadius: theme.space.s4,
    },
    // The same inline recovery as a state line's (lab `.l12-fresh a`): ink and semibold.
    linkLabel: {
        ...Typography.default('semiBold'),
        ...HAPPIER_FRESHNESS_LINE_METRICS.text,
        color: theme.colors.text.primary,
    },
}));
