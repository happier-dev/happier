/**
 * The one JS-side view of what the lateral gesture's second axis has selected.
 *
 * The gesture publishes its selection as shared values, which is what keeps the scrub
 * itself off the JS thread entirely. But two surfaces need the selected session as
 * DATA — the picker's rows and the capsule readout they descend into — and a session
 * title cannot be read from a worklet. This hook is that boundary, and it is deliberately
 * the only one: a second bridge would let the column and the capsule disagree about which
 * session the release is about to commit.
 *
 * Two things keep it cheap enough to sit under a finger:
 *
 * - The reaction reads ONLY the direction and the index, so it wakes on the handful of
 *   frames where the selection actually changes rather than on every frame of the drag.
 * - Session metadata is resolved ONCE per direction lock and held in a ref. It is read
 *   imperatively through `useSessionCockpitLateralNavigation`, never through
 *   `useSessionMetadata`, because this runs inside chrome mounted on every route — see
 *   that hook for the full reasoning.
 *
 * The JS-side guard is not optional. `useAnimatedReaction` fires per render in the test
 * environment and per change in production; without an identity check ahead of `setState`
 * the readout re-renders itself in a loop, which is exactly how the shipped readout's
 * direction bridge was first written and had to be fixed.
 */

import * as React from 'react';
import { useAnimatedReaction } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useSessionLateralSwipe } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import type { SessionNavigationDirection } from '@/sync/domains/session/navigation/sessionNavigationOrder';

import {
    useSessionCockpitLateralNavigation,
    type SessionLateralNavigationTarget,
} from './useSessionCockpitLateralNavigation';

export type SessionLateralPickerSelection = Readonly<{
    /** Locked at horizontal activation; null while the gesture is at rest. */
    direction: SessionNavigationDirection | null;
    /** 1-based into the locked direction; 0 while nothing is selectable. */
    index: number;
    /** The reachable sessions that way, nearest first. */
    targets: readonly SessionLateralNavigationTarget[];
    /** What the capsule is showing, i.e. exactly what a release would commit. */
    selected: SessionLateralNavigationTarget | null;
}>;

const NO_TARGETS: readonly SessionLateralNavigationTarget[] = [];

export function useSessionLateralPickerSelection(params: Readonly<{
    sessionId: string | null;
    serverId?: string | null;
}>): SessionLateralPickerSelection {
    const { picker } = useSessionLateralSwipe();
    const navigation = useSessionCockpitLateralNavigation(params);
    const resolveTargets = navigation.resolveTargets;
    // The neighbours are measured from the anchor, and the anchor moves on every commit.
    // A cache keyed on direction alone therefore keeps describing the session you just
    // LEFT for as long as you keep swiping the same way — the second right-to-left swipe
    // would list the first one's neighbours. Keyed on both, it cannot.
    const anchorSessionKey = navigation.anchorSessionKey;

    const [selection, setSelection] = React.useState<Readonly<{
        direction: SessionNavigationDirection | null;
        index: number;
    }>>({ direction: null, index: 0 });
    const selectionRef = React.useRef(selection);
    const targetsRef = React.useRef<readonly SessionLateralNavigationTarget[]>(NO_TARGETS);
    const targetsKeyRef = React.useRef<string | null>(null);

    const applySelection = React.useCallback((
        direction: SessionNavigationDirection | null,
        index: number,
    ) => {
        const current = selectionRef.current;
        const targetsKey = direction ? `${direction}\u0000${anchorSessionKey ?? ''}` : null;
        if (targetsKey !== targetsKeyRef.current) {
            // One metadata read per (direction, anchor) pair, at the moment the picker can
            // first be opened — never per scrubbed row and never per frame.
            targetsRef.current = direction ? resolveTargets(direction) : NO_TARGETS;
            targetsKeyRef.current = targetsKey;
        }
        if (current.direction === direction && current.index === index) return;
        const next = { direction, index };
        selectionRef.current = next;
        setSelection(next);
    }, [anchorSessionKey, resolveTargets]);

    useAnimatedReaction(
        () => ({ direction: picker.direction.value, index: picker.index.value }),
        (current) => {
            scheduleOnRN(applySelection, current.direction, current.index);
        },
        [applySelection, picker],
    );

    const targets = selection.direction ? targetsRef.current : NO_TARGETS;
    return React.useMemo(() => ({
        direction: selection.direction,
        index: selection.index,
        targets,
        selected: selection.index >= 1 ? targets[selection.index - 1] ?? null : null,
    }), [selection.direction, selection.index, targets]);
}
