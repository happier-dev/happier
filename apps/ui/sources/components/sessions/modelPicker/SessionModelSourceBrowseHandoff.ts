import * as React from 'react';

import type { SessionModelBrowseScope } from './SessionModelSourceScope';

/**
 * How "Runs through" reaches the engine pane's browse scope. The composer owns which picker is open,
 * so it carries the one pending request and opens the engine pane; the pane's model picker takes the
 * scope from here. Nothing is committed by a request, and it is dropped when the pane closes.
 */
export type SessionModelSourceBrowseHandoff = Readonly<{
    request: Readonly<{ agentTargetKey: string; scope: SessionModelBrowseScope; key: number; onSelect?: () => void }> | null;
    /** Commit the requested auth choice only when a model in this source is picked. */
    browse: (agentTargetKey: string, scope: SessionModelBrowseScope, onSelect?: () => void) => void;
}>;

export const SessionModelSourceBrowseHandoffContext = React.createContext<SessionModelSourceBrowseHandoff | null>(null);

/**
 * The account or pool the Agent's own models run through, for a host that builds its picker before
 * it resolves that label (the running session). Hosts that know it earlier pass `nativeSourceLabel`.
 */
export const SessionModelNativeSourceLabelContext = React.createContext<string | null>(null);

/**
 * When a model change takes effect and any note about it, as the composer's own engine pane says
 * them (`useSessionAuthoringControls`). The composer hands them to a model surface that replaces
 * its default one, so the running line reads the same in both.
 */
export const SessionModelApplyTimingContext = React.createContext<Readonly<{
    timing: string;
    notes: readonly string[];
}> | null>(null);
