import * as React from 'react';
import type { FeatureDecision } from '@happier-dev/protocol';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

/**
 * What the one Workflows destination may show (FIN 04 §3.1), derived once from the two canonical
 * decisions. `workflows` declares `automations` as its catalog dependency, so the shared dependency
 * resolver already decided what an Automations bit implies; this only names the arms a surface
 * presents.
 *
 * - `workflows`: the whole destination.
 * - `triggersOnly`: Automations enabled with Workflows unavailable, a supported configuration in
 *   which the released one-shot recipe stays authorable; the column shows its Triggers only.
 * - `locallyDisabled`: turned off only by this device's policy. The destination stays listed and
 *   pressable so its **Open Settings** repair is reachable, and mounts no content.
 * - `unavailable`: hard server or build denial, or a bit that is missing, unknown or malformed.
 *   Discovery never enables from those (fail closed).
 * - `resolving`: a decision has not arrived yet; nothing is listed.
 */
export type WorkflowsDestinationAccessKind = 'resolving' | 'workflows' | 'triggersOnly' | 'locallyDisabled' | 'unavailable';

export type WorkflowsDestinationAccess = Readonly<{
    kind: WorkflowsDestinationAccessKind;
    /** Listed on the rail, in the phone launcher and in the command palette. */
    discoverable: boolean;
}>;

const ACCESS: Readonly<Record<WorkflowsDestinationAccessKind, WorkflowsDestinationAccess>> = {
    resolving: Object.freeze({ kind: 'resolving', discoverable: false }),
    workflows: Object.freeze({ kind: 'workflows', discoverable: true }),
    triggersOnly: Object.freeze({ kind: 'triggersOnly', discoverable: true }),
    locallyDisabled: Object.freeze({ kind: 'locallyDisabled', discoverable: true }),
    unavailable: Object.freeze({ kind: 'unavailable', discoverable: false }),
};

function isLocalPolicyBlock(decision: FeatureDecision): boolean {
    return decision.state === 'disabled' && decision.blockedBy === 'local_policy';
}

export function resolveWorkflowsDestinationAccess(input: Readonly<{
    workflows: FeatureDecision | null;
    automations: FeatureDecision | null;
}>): WorkflowsDestinationAccess {
    const { workflows, automations } = input;
    if (workflows?.state === 'enabled') return ACCESS.workflows;
    if (workflows === null || automations === null) return ACCESS.resolving;
    if (automations.state === 'enabled') return ACCESS.triggersOnly;
    // Provenance comes from the dependency resolver's own facts: Workflows blocked only because
    // Automations is off on this device is still a local, repairable state.
    if (isLocalPolicyBlock(automations) || isLocalPolicyBlock(workflows)) return ACCESS.locallyDisabled;
    return ACCESS.unavailable;
}

/**
 * The destination's access, each decision at the scope its own owner reads it: Workflows at the
 * runtime scope `WorkflowsGate` uses, Automations at the scope `useAutomationsSupport` uses.
 */
export function useWorkflowsDestinationAccess(): WorkflowsDestinationAccess {
    const workflows = useFeatureDecision('workflows', { scopeKind: 'runtime' });
    const automations = useFeatureDecision('automations');
    const serverId = useActiveServerSnapshot().serverId;
    // Each arm is a frozen constant, so the result keeps its identity while the arm holds.
    const access = resolveWorkflowsDestinationAccess({ workflows, automations });
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
