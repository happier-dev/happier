import * as React from 'react';

import { retainDeep } from '@/sync/domains/state/structuralSharing';
import type { PermissionToolCallMessageLocation } from './permissionToolCallLocationTypes';

type ToolCallLocations = ReadonlyMap<string, PermissionToolCallMessageLocation | null>;

/** `previous` when every request keeps the same place, otherwise `next` with each unchanged place reused. */
export function retainToolCallLocations(previous: ToolCallLocations | undefined, next: ToolCallLocations): ToolCallLocations {
    if (previous === undefined || previous === next) return next;
    let same = previous.size === next.size;
    const retained = new Map<string, PermissionToolCallMessageLocation | null>();
    for (const [id, location] of next) {
        const kept = previous.has(id) ? retainDeep(previous.get(id), location) : location;
        if (!previous.has(id) || kept !== previous.get(id)) same = false;
        retained.set(id, kept);
    }
    return same ? previous : retained;
}

/**
 * Waiting prompt cards locate their tool call by scanning the transcript, which every transcript write
 * re-runs. The places rarely move, so a memoized card keeps its `location` and redraws only when its own
 * request moves.
 */
export function useRetainedToolCallLocations(next: ToolCallLocations): ToolCallLocations {
    const publishedRef = React.useRef<ToolCallLocations | undefined>(undefined);
    const retained = retainToolCallLocations(publishedRef.current, next);
    publishedRef.current = retained;
    return retained;
}
