import * as React from 'react';

import type { SessionModelBrowseScope } from './SessionModelSourceScope';

/**
 * How "Runs through" reaches the engine pane's browse scope. The composer owns which picker is open,
 * so it carries the one pending request and opens the engine pane; the pane's model picker takes the
 * scope from here. Nothing is committed by a request, and it is dropped when the pane closes.
 */
export type SessionModelSourceBrowseHandoff = Readonly<{
    request: Readonly<{ agentTargetKey: string; scope: SessionModelBrowseScope; key: number }> | null;
    browse: (agentTargetKey: string, scope: SessionModelBrowseScope) => void;
}>;

export const SessionModelSourceBrowseHandoffContext = React.createContext<SessionModelSourceBrowseHandoff | null>(null);

/**
 * The account or pool the Agent's own models run through, for a host that builds its picker before
 * it resolves that label (the running session). Hosts that know it earlier pass `nativeSourceLabel`.
 */
export const SessionModelNativeSourceLabelContext = React.createContext<string | null>(null);
