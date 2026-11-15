import * as React from 'react';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { useDestinationParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';

import { parseSessionPaneUrlState, serializeSessionPaneUrlState, type SessionPaneUrlState } from './sessionPaneUrlState';

type DestinationParams = Readonly<Record<string, string | string[] | undefined>>;

export function sameSessionPaneUrlState(left: SessionPaneUrlState | null, right: SessionPaneUrlState | null): boolean {
    if (left === right) return true;
    if (left === null || right === null) return false;
    return sameStrictJsonValue(serializeSessionPaneUrlState(left), serializeSessionPaneUrlState(right));
}

/**
 * The pane facts a Session destination's URL carries, read by the component that consumes them. A
 * query write that leaves these facts unchanged keeps the same value, so it renders no reader.
 */
export function useSessionPaneUrlState(): SessionPaneUrlState | null {
    return useSessionPaneUrlFact(parseSessionPaneUrlState, sameSessionPaneUrlState);
}

/** One selected pane-URL fact (`select` must keep its identity: a module-level function). */
export function useSessionPaneUrlFact<T>(select: (params: DestinationParams) => T,
    equal: (left: T | null, right: T | null) => boolean = Object.is): T {
    const selected = useDestinationParamsSelector(select, equal);
    // The Expo-route fallback selects on every render; keep the held value while it is equal.
    const held = React.useRef(selected);
    if (!equal(held.current, selected)) held.current = selected;
    return held.current;
}
