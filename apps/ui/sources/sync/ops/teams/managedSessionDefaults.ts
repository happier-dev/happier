import {
    resolveManagedSessionDefaults,
    type ManagedSessionDefaultsContext,
    type ManagedSessionDefaultsV1,
} from '@happier-dev/protocol/teams';
import { projectSessionModelSelectionV2ToV1 } from '@happier-dev/protocol/providers/selection/v2';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import { getOrganizationPolicySessionDefaults } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { readOrganizationPolicy } from '@/sync/domains/organizationPolicy/organizationPolicy';
import { resolveTeamViewState, type TeamViewState } from '@/components/settings/teams/teamViewState';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import { getTeamSnapshot } from '@/sync/store/teams/teamsSnapshots';

export type ManagedSessionDefaultsReadInput = Readonly<{
    serverId: string;
    teamId: string | null;
    memberAccountId: string | null;
    agentTargetKey: string;
    explicitChoices?: ManagedSessionDefaultsV1;
}>;
export type ManagedSessionDefaultsRead = Readonly<{ context: ManagedSessionDefaultsContext }> & (
    | Readonly<{
        status: 'ready';
        defaults: ReturnType<typeof resolveManagedSessionDefaults>;
        /** Team-source V2 remains in defaults.model; older carriers cannot represent it. */
        sessionModelSelectionV1: SessionModelSelectionV1 | null;
        providerBoundModelRef: SessionModelSelectionV1['ref'] | null;
        repairRequired: boolean;
    }>
    | Readonly<{ status: 'unavailable'; reason: 'invalid_scope' }>
    | Readonly<{ status: 'unavailable'; reason: Exclude<TeamViewState, { kind: 'ready' }>['kind']; teamState: Exclude<TeamViewState, { kind: 'ready' }> }>
);

/** Synchronous, Home/Account-qualified read. useManagedSessionDefaults declares live Team demand. */
export function readManagedSessionDefaults(input: ManagedSessionDefaultsReadInput): ManagedSessionDefaultsRead {
    const policyDefaults = getOrganizationPolicySessionDefaults(readOrganizationPolicy());
    let context: ManagedSessionDefaultsContext = { policyDefaults };
    let repairRequired = false;
    if (input.teamId !== null) {
        const scope = createServerAccountScope(input.serverId, input.memberAccountId);
        const address = createTeamAddress(input.serverId, input.teamId);
        if (!scope || !address) return { status: 'unavailable', reason: 'invalid_scope', context };
        const state = resolveTeamViewState(getTeamSnapshot(scope, address));
        if (state.kind !== 'ready') return { status: 'unavailable', reason: state.kind, teamState: state, context };
        repairRequired = state.team.policy.managedDefaultsStatus === 'repair_required';
        context = { policyDefaults, teamDefaults: state.team.policy.managedDefaults ?? null,
            groupIds: state.team.managedDefaultsGroupIds ?? [] };
    }
    const defaults = resolveManagedSessionDefaults({ ...context, agentTargetKey: input.agentTargetKey,
        explicitChoices: input.explicitChoices });
    const model = defaults.model.value;
    const sessionModelSelectionV1 = model ? model.v === 1 ? model : projectSessionModelSelectionV2ToV1(model) : null;
    return { status: 'ready', context, defaults, sessionModelSelectionV1,
        providerBoundModelRef: sessionModelSelectionV1?.ref ?? null, repairRequired };
}
