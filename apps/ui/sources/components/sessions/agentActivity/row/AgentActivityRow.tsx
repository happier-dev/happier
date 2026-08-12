import type { AgentActivityStatusV1 } from '@happier-dev/protocol';
import { resolveAgentActivityTone } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconAction } from '@/components/ui/buttons/IconAction';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ITEM_CHEVRON_SIZE } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { AgentActivityRowActionId, AgentActivityRowEntry } from '../agentActivityRowEntry';
import {
    resolveAgentActivityElapsedFreezeAtMs,
    type AgentActivityStaleness,
} from '../presentation/agentActivityStaleness';
import {
    resolveAgentActivityStatusWord,
    resolveAgentActivityToneStyle,
} from '../presentation/agentActivityToneStyle';
import { resolveAgentActivityElapsedStartMs } from '../presentation/resolveAgentActivityElapsedStartMs';
import { resolveAgentActivityMetaLine } from '../presentation/resolveAgentActivityMetaLine';
import { resolveAgentActivityTitle } from '../presentation/resolveAgentActivityTitle';
import { AgentActivityRowOverflow } from './AgentActivityRowOverflow';
import { AgentActivityStatusSlot } from './AgentActivityStatusSlot';
import { AgentActivityTimeSlot } from './AgentActivityTimeSlot';
import {
    AGENT_ROW_ACTION_GAP_PX,
    AGENT_ROW_ACTION_HIT_SLOP,
    AGENT_ROW_MIN_HEIGHT_PX,
    AGENT_ROW_SEPARATOR_HEIGHT_PX,
    AGENT_ROW_SEPARATOR_INSET_PX,
    AGENT_STATUS_COLUMN_PX,
    AGENT_STATUS_GLYPH_PX,
} from './agentRowMetrics';

/**
 * The one row that renders a unit of agent work, in every host (R-5).
 *
 * **A composition over `Item`, never a re-implementation.** That single decision is what removes
 * ~80 lines of JSX duplicated across a web/native fork, the web branch's missing pressed state, and
 * two divergent accessible names — because `Item` already owns the iOS pressed overlay, the
 * Android/web ripple, hover, the divider and the group corner radii. Nothing here restates any of
 * them; where this file sets a value it is because the value is different, not to have a copy.
 *
 * The anatomy is five fixed moves: a fixed-width status column, a title, at most one meta line, a
 * right-aligned tabular elapsed value, and one press plus one 44pt overflow. No fact pills, no card
 * per row, no status pill drifting with the title length.
 *
 * The row owns anatomy; the host owns disclosure. A host that needs an expandable body wraps this
 * and renders a sibling; this component never grows a children slot.
 */

/**
 * Statuses whose meta line takes the tone ink rather than ordinary secondary text.
 *
 * Only the abnormal ones. Colouring every meta line by tone would turn the densest text in the list
 * into a colour chart and leave nothing for the abnormal states to stand out against. This is
 * VISIBILITY, not attention: the ink makes a failed or blocked row scannable, and nothing anywhere
 * escalates because of it.
 */
const TONE_INKED_META: ReadonlySet<AgentActivityStatusV1> = new Set([
    'waiting',
    'failed',
    'timedOut',
    'cancelled',
]);

export type AgentActivityRowProps = Readonly<{
    entry: AgentActivityRowEntry;
    /** Absent makes the row read-only. Takes the entry id so a list needs one callback, not N. */
    onPress?: (entryId: string) => void;
    /** Absent, or an empty `entry.actions`, means no overflow menu at all. */
    onAction?: (entryId: string, actionId: AgentActivityRowActionId) => void;
    /**
     * Present only on a host that owns an expandable body. Drives the caret and
     * `accessibilityState.expanded`; it replaces an `expandable` + `expanded` pair whose fourth
     * combination was invalid.
     */
    disclosure?: 'collapsed' | 'expanded';
    /**
     * Toggles the disclosed body from the CARET, leaving the row press to mean "open".
     *
     * Absent means the whole row is the toggle, which is right for a unit of work that has nowhere
     * else to go (a background command, an orphan workflow sidechain). Present is what lets a row
     * that *does* have a destination offer both without the two fighting for one gesture: press to
     * open, caret to glance. The caret is a real target rather than an icon inside a larger press —
     * the same shape as the overflow button already beside it.
     */
    onToggleDisclosure?: () => void;
    /**
     * `'below'` puts the meta line under the title. `'inline'` puts it in the right slot, keeping
     * dense transcript and popover rows to one line.
     *
     * Never derived from density: density is a user setting about how much fits on screen, and it
     * must not silently change what information a row shows.
     */
    metaPlacement?: 'below' | 'inline';
    density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
    /**
     * How long this entry has been silent (4.10), resolved by the host from the shared clock.
     *
     * A prop rather than a subscription: the row is memoized so a ticking roster costs one text
     * node per second, and a clock in here would re-render every row instead. It is presentation
     * only — it adds a word, tints that word, and stops the elapsed value. It never changes the
     * status, and a silent entry never becomes a finished one (4.9.3).
     */
    staleness?: AgentActivityStaleness;
    /** Set by `ItemGroup` when this row is inside one. */
    showDivider?: boolean;
    testID?: string;
}>;

export const AgentActivityRow = React.memo((props: AgentActivityRowProps) => {
    const { theme } = useUnistyles();
    const density = useResolvedItemDensity(props.density);
    const { entry, onAction, onPress, testID } = props;
    const { status } = entry;

    const staleness = props.staleness ?? 'fresh';
    const toneStyle = resolveAgentActivityToneStyle(resolveAgentActivityTone(status), theme);
    const title = resolveAgentActivityTitle(entry);
    const metaLine = resolveAgentActivityMetaLine(entry, staleness);
    // Stale takes the attention ink — through the same tone binding as every other status, never a
    // direct `theme.colors.state.*` read — because the line now leads with a caveat a person may
    // need to act on. Quiet deliberately does not: it keeps the ordinary secondary ink, which IS
    // the neutral tone 4.10 asks for, and reaching for `state.neutral.foreground` instead would put
    // a 2.98:1 grey on a line that carries meaning.
    const metaInk = staleness === 'stale'
        ? resolveAgentActivityToneStyle('attention', theme).ink
        : (TONE_INKED_META.has(status) ? toneStyle.ink : undefined);
    const metaPlacement = props.metaPlacement ?? 'below';

    const isInteractive = onPress != null;
    const hasOverflow = onAction != null && entry.actions.length > 0;
    // `Item`'s default, preserved: a host that says nothing gets a rule, and the list withholds it
    // at a section edge so a heading reads as a break rather than as another row.
    const showSeparator = props.showDivider !== false;

    const handlePress = React.useCallback(
        () => onPress?.(entry.id),
        [entry.id, onPress],
    );

    const accessibilityState = React.useMemo(() => ({
        busy: status === 'running',
        ...(props.disclosure != null ? { expanded: props.disclosure === 'expanded' } : null),
    }), [props.disclosure, status]);

    const leftElement = (
        <AgentActivityStatusSlot
            status={status}
            size={AGENT_STATUS_GLYPH_PX[density]}
            // A stale row stops claiming liveness with everything it has, not just its clock: a
            // spinner turning next to a frozen number reads as a broken clock rather than as an
            // agent that has gone quiet. Silence is the ONLY thing that freezes a row's spinner —
            // there is no host switch above this one (W30).
            animationEnabled={staleness !== 'stale'}
            testID={testID ? `${testID}:status` : undefined}
        />
    );

    const rightElement = (
        <View style={styles.rightCluster}>
            <AgentActivityTimeSlot
                // Not `entry.startedAtMs`: a start alone is only a clock while the work is still
                // going. Once it is over without a recorded finish, no elapsed value is true and
                // the column renders nothing rather than a number (D-8).
                startedAtMs={resolveAgentActivityElapsedStartMs(entry)}
                endedAtMs={entry.endedAtMs}
                // Derived here, from the same silence rule the note uses, so the clock stops on the
                // threshold instead of waiting for the host's slower recomputation.
                freezeAtMs={resolveAgentActivityElapsedFreezeAtMs(entry)}
                testID={testID ? `${testID}:elapsed` : undefined}
            />
            {hasOverflow ? (
                <AgentActivityRowOverflow
                    entryId={entry.id}
                    title={title}
                    actions={entry.actions}
                    onAction={onAction}
                    testID={testID ? `${testID}:overflow` : undefined}
                />
            ) : null}
            {props.disclosure != null ? (
                props.onToggleDisclosure ? (
                    // The canonical icon-only action, exactly as the overflow beside it uses —
                    // including `stopPropagation`, without which pressing the caret would ALSO fire
                    // the row press it sits inside and open the agent while expanding it.
                    <IconAction
                        size="sm"
                        hitSlop={AGENT_ROW_ACTION_HIT_SLOP}
                        accessibilityLabel={props.disclosure === 'expanded'
                            ? t('session.agentActivity.row.collapse', { title })
                            : t('session.agentActivity.row.expand', { title })}
                        active={props.disclosure === 'expanded'}
                        onPress={(event) => {
                            event?.stopPropagation?.();
                            props.onToggleDisclosure?.();
                        }}
                        testID={testID ? `${testID}:disclosure` : undefined}
                    >
                        <Icon
                            name={props.disclosure === 'expanded' ? 'caret-up' : 'caret-down'}
                            size={ITEM_CHEVRON_SIZE[density]}
                            color={theme.colors.text.secondary}
                        />
                    </IconAction>
                ) : (
                    <Icon
                        name={props.disclosure === 'expanded' ? 'caret-up' : 'caret-down'}
                        size={ITEM_CHEVRON_SIZE[density]}
                        color={theme.colors.text.secondary}
                    />
                )
            ) : null}
        </View>
    );

    return (
        <View style={styles.container}>
            <Item
                testID={testID}
                leftElement={leftElement}
                iconBoxSize={AGENT_STATUS_COLUMN_PX[density]}
                title={title}
                subtitle={metaPlacement === 'below' ? metaLine : null}
                subtitleLines={1}
                subtitleStyle={metaInk ? { color: metaInk } : undefined}
                detail={metaPlacement === 'inline' ? metaLine ?? undefined : undefined}
                detailStyle={[styles.inlineMeta, metaInk ? { color: metaInk } : null]}
                rightElement={rightElement}
                // A chevron beside an overflow is two affordances for one row, and the whole row is
                // already the press target.
                showChevron={false}
                onPress={isInteractive ? handlePress : undefined}
                mode={isInteractive ? undefined : 'info'}
                accessibilityRole={isInteractive ? 'button' : undefined}
                // Title and the translated status word — deliberately NOT the elapsed value. A
                // 1s-ticking label makes VoiceOver re-announce the focused row every second; the
                // clock carries its own name in the time slot instead.
                accessibilityLabel={t('session.agentActivity.row.a11yLabel', {
                    title,
                    status: resolveAgentActivityStatusWord(status),
                })}
                accessibilityState={accessibilityState}
                density={props.density}
                // The rule below is this row's, on every platform. `Item`'s own is iOS-only, so
                // leaving it on would mean two hairlines there and none on web or Android.
                showDivider={false}
                style={{
                    // Derived from whether an overflow actually rendered. A flat 44 everywhere would
                    // grow the transcript card and the work-state popover by half again.
                    minHeight: hasOverflow
                        ? AGENT_ROW_MIN_HEIGHT_PX.withActions
                        : AGENT_ROW_MIN_HEIGHT_PX.readOnly,
                }}
            />
            {showSeparator ? (
                <View
                    testID={testID ? `${testID}:separator` : undefined}
                    style={[styles.separator, { marginLeft: AGENT_ROW_SEPARATOR_INSET_PX[density] }]}
                />
            ) : null}
        </View>
    );
});

AgentActivityRow.displayName = 'AgentActivityRow';

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    separator: {
        height: AGENT_ROW_SEPARATOR_HEIGHT_PX,
        // The same ink every list rule in this app uses. A separator invented for this corridor
        // would be a second weight for one concept, visible the moment a roster sits beside a
        // settings list.
        backgroundColor: theme.colors.border.default,
    },
    rightCluster: {
        flexDirection: 'row',
        alignItems: 'center',
        // The gap is touch geometry, not decoration: it is what the two controls' hit slops are
        // derived from, so the seam between them belongs to one of them and not to both.
        gap: AGENT_ROW_ACTION_GAP_PX,
    },
    inlineMeta: {
        ...Typography.timestamp(),
    },
}));
