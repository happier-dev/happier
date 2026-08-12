import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';

import type { AgentActivityRowActionId, AgentActivityRowEntry } from '../agentActivityRowEntry';
import type { AgentActivityStaleness } from '../presentation/agentActivityStaleness';
import { AgentActivityRow } from './AgentActivityRow';

/**
 * The row owns anatomy; this owns disclosure.
 *
 * `Item` exposes no children slot and a workflow agent has no route to open, so a host that needs an
 * expandable body cannot get one from the row and must not grow one inside it. This wrapper is the
 * whole of that seam: it holds `expanded`, turns the row's press into a toggle, and renders the
 * host's body as a **sibling** below. It adds no anatomy — no glyph, no title, no meta line, no
 * duration — so every host still shows one row, drawn once, in one place.
 *
 * It also reports the height change to the transcript's measurement owner. Expanding an agent inside
 * a transcript card changes the row's height, and a cached height that outlives the change is how a
 * list ends up scrolled to the wrong place. `useTranscriptRowLayoutMutation` is a no-op outside a
 * transcript, so the popover host pays nothing for it and neither host has to know which it is.
 *
 * Deliberately unanimated. §4.8 authorises four animations and an expanding body is not one of
 * them; adding a spring to content that mounts inside a virtualized, height-cached transcript row
 * without a device capture is exactly the "declared motion done from source" failure.
 */

export type AgentActivityDisclosureProps = Readonly<{
    entry: AgentActivityRowEntry;
    /**
     * The expandable body, or absent. Absent is what makes this a plain read-only row — there is no
     * `expandable` flag, so a host cannot offer a caret with nothing behind it.
     */
    body?: React.ReactNode;
    /**
     * Opens this unit of work, when it has somewhere to go.
     *
     * Present splits the two gestures: the ROW opens and the CARET discloses, so an agent with a
     * transcript keeps the one-press destination it has always had and gains a glance beside it.
     * Absent keeps the whole row as the toggle, which is the only honest press for a unit of work
     * with no destination — a background command, or a workflow agent whose sidechain no tool
     * message owns.
     */
    onPress?: (entryId: string) => void;
    /**
     * Row overflow actions, forwarded verbatim.
     *
     * Not optional decoration: without it a disclosed row silently loses `stop`, `send` and the
     * destructive actions the same row shows when it has no body — an affordance disappearing
     * because a preview appeared is exactly the kind of coupling this wrapper must not introduce.
     */
    onAction?: (entryId: string, actionId: AgentActivityRowActionId) => void;
    density?: ResolvedItemDensity;
    metaPlacement?: 'below' | 'inline';
    /**
     * Forwarded verbatim to the row, which owns what silence looks like (4.10).
     *
     * Present so a disclosed row is not quietly exempt from the quiet/stale notes every other row
     * carries: a host that resolves staleness for its list must be able to hand it to both shapes.
     */
    staleness?: AgentActivityStaleness;
    /** Suppressed automatically while expanded, so the row and its body read as one block. */
    showDivider?: boolean;
    testID?: string;
}>;

export const AgentActivityDisclosure = React.memo((props: AgentActivityDisclosureProps) => {
    const [expanded, setExpanded] = React.useState(false);
    const notifyRowLayoutMutation = useTranscriptRowLayoutMutation();
    const { body, entry, onAction, onPress } = props;
    const canDisclose = body != null;

    const handleToggle = React.useCallback(() => {
        setExpanded((current) => {
            const next = !current;
            notifyRowLayoutMutation({ reason: next ? 'expand' : 'collapse', sourceId: entry.id });
            return next;
        });
    }, [entry.id, notifyRowLayoutMutation]);

    const handleOpen = React.useCallback(() => onPress?.(entry.id), [entry.id, onPress]);

    // A body that disappears under an expanded row (a result the provider retracted) must not leave
    // the wrapper claiming an expansion it can no longer show.
    const isExpanded = canDisclose && expanded;

    const row = (
        <AgentActivityRow
            entry={entry}
            testID={props.testID}
            density={props.density}
            metaPlacement={props.metaPlacement}
            staleness={props.staleness}
            showDivider={isExpanded ? false : props.showDivider}
            {...(onAction ? { onAction } : null)}
            {...(canDisclose
                ? {
                    // The row opens when it can, and discloses when opening is not a thing it does.
                    // One press, one meaning, decided by what this unit of work actually has.
                    onPress: onPress ? handleOpen : handleToggle,
                    // The caret becomes its own target only when the row press means something
                    // else; otherwise the whole row is the toggle and a second one inside it would
                    // be two controls for one action.
                    ...(onPress ? { onToggleDisclosure: handleToggle } : null),
                    disclosure: isExpanded ? 'expanded' as const : 'collapsed' as const,
                }
                : (onPress ? { onPress: handleOpen } : null))}
        />
    );

    if (!canDisclose) return row;

    return (
        <View style={isExpanded ? styles.expanded : undefined}>
            {row}
            {isExpanded ? body : null}
        </View>
    );
});

AgentActivityDisclosure.displayName = 'AgentActivityDisclosure';

const styles = StyleSheet.create((theme) => ({
    expanded: {
        // The row and the body it opened are one object while open; without a shared ground the
        // body reads as an unrelated block that happened to appear underneath.
        backgroundColor: theme.colors.surface.base,
        borderRadius: 8,
    },
}));
