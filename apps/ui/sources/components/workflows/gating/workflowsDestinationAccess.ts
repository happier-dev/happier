import * as React from 'react';
import type { FeatureDecision } from '@happier-dev/protocol/features/decision';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

/**
 * What the one Workflows destination may show, derived from the canonical Workflows decision.
 *
 * - `workflows`: the whole destination.
 * - `locallyDisabled`: turned off only by this device's policy. The destination stays listed and
 *   pressable so its **Open Settings** repair is reachable, and mounts no content.
 * - `unavailable`: hard server or build denial, or a bit that is missing, unknown or malformed.
 *   Discovery never enables from those (fail closed).
 * - `resolving`: a decision has not arrived yet; nothing is listed.
 */
export type WorkflowsDestinationAccessKind = 'resolving' | 'workflows' | 'locallyDisabled' | 'unavailable';

export type WorkflowsDestinationAccess = Readonly<{
    kind: WorkflowsDestinationAccessKind;
    /** Listed on the rail, in the phone launcher and in the command palette. */
    discoverable: boolean;
}>;

const ACCESS: Readonly<Record<WorkflowsDestinationAccessKind, WorkflowsDestinationAccess>> = {
    resolving: Object.freeze({ kind: 'resolving', discoverable: false }),
    workflows: Object.freeze({ kind: 'workflows', discoverable: true }),
    locallyDisabled: Object.freeze({ kind: 'locallyDisabled', discoverable: true }),
    unavailable: Object.freeze({ kind: 'unavailable', discoverable: false }),
};

function isLocalPolicyBlock(decision: FeatureDecision): boolean {
    return decision.state === 'disabled' && decision.blockedBy === 'local_policy';
}

export function resolveWorkflowsDestinationAccess(input: Readonly<{
    workflows: FeatureDecision | null;
}>): WorkflowsDestinationAccess {
    const { workflows } = input;
    if (workflows?.state === 'enabled') return ACCESS.workflows;
    if (workflows === null) return ACCESS.resolving;
    if (isLocalPolicyBlock(workflows)) return ACCESS.locallyDisabled;
    return ACCESS.unavailable;
}

/** The destination reads Workflows at the same runtime or addressed-Home scope as its gate. */
export function useWorkflowsDestinationAccess(exactServerId?: string | null): WorkflowsDestinationAccess {
    const activeServerId = useActiveServerSnapshot().serverId;
    const serverId = exactServerId ?? activeServerId;
    const scope = exactServerId ? { scopeKind: 'spawn' as const, serverId } : undefined;
    const workflows = useFeatureDecision('workflows', scope ?? { scopeKind: 'runtime' });
    // Each arm is a frozen constant, so the result keeps its identity while the arm holds.
    const access = resolveWorkflowsDestinationAccess({ workflows });
    // A decision that re-resolves for the same server (its snapshot reloading under a slow or
    // briefly offline server) keeps its last settled arm: refreshing never unmounts an open editor
    // or Run for a full-page loading state. A different server, or a first resolution, still
    // resolves from nothing, so nothing is admitted before its own decision arrives.
    const settledRef = React.useRef<Readonly<{ serverId: string; access: WorkflowsDestinationAccess }> | null>(null);
    if (access.kind !== 'resolving') {
        if (settledRef.current?.serverId !== serverId || settledRef.current.access !== access) {
            settledRef.current = { serverId, access };
        }
        return access;
    }
    return settledRef.current?.serverId === serverId ? settledRef.current.access : access;
}
