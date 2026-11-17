import {
    resolveManagedSessionDefaults,
    buildManagedSessionDefaultsContext,
    type ManagedSessionDefaultsContext,
    type ManagedSessionDefaultsV1,
    type ManagedSessionExplicitChoicesV1,
} from '@happier-dev/protocol/teams';
import { getOrganizationPolicySessionDefaults } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { readOrganizationPolicy } from '@/sync/domains/organizationPolicy/organizationPolicy';
import { resolveTeamViewState, type TeamViewState } from '@/components/settings/teams/teamViewState';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import { getTeamSnapshot } from '@/sync/store/teams/teamsSnapshots';
import { getHomeSessionDefaultsSnapshot } from '@/sync/store/home/governance/homeSessionDefaultsSnapshots';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { Settings } from '@/sync/domains/settings/settings';

/** Account settings retain provider aliases; the defaults resolver consumes intents. */
export function projectAccountManagedSessionDefaults(settings: Pick<Settings,
    'sessionDefaultPermissionModeByTargetKey' | 'providerDefaultModelSelectionsByAgentTargetKeyV1'>): ManagedSessionDefaultsV1 {
    return {
        permissionModeByAgentTargetKey: Object.fromEntries(Object.entries(settings.sessionDefaultPermissionModeByTargetKey)
            .flatMap(([targetKey, mode]) => {
                const intent = parseAgentPermissionIntentV1Alias(mode);
                return intent ? [[targetKey, intent] as const] : [];
            })),
        modelByAgentTargetKey: settings.providerDefaultModelSelectionsByAgentTargetKeyV1,
    };
}

export type ManagedSessionDefaultsReadInput = Readonly<{
    serverId: string;
    teamId: string | null;
    memberAccountId: string | null;
    agentTargetKey: string;
    explicitChoices?: ManagedSessionExplicitChoicesV1;
    memberDefaults?: ManagedSessionDefaultsV1 | null;
    /** Already admitted selected Project context; no second governance read. */
    context?: ManagedSessionDefaultsContext;
    repairRequired?: boolean;
    creationMachineApprovalProfileId?: string | null;
}>;
export type ManagedSessionDefaultsRead = Readonly<{ context: ManagedSessionDefaultsContext }> & (
    | Readonly<{
        status: 'ready';
        defaults: ReturnType<typeof resolveManagedSessionDefaults>;
        repairRequired: boolean;
    }>
    | Readonly<{ status: 'unavailable'; reason: 'invalid_scope' }>
    | Readonly<{ status: 'unavailable'; reason: 'unobserved' }>
    | Readonly<{ status: 'unavailable'; reason: Exclude<TeamViewState, { kind: 'ready' }>['kind']; teamState: Exclude<TeamViewState, { kind: 'ready' }> }>
);

/** Synchronous, Home/Account-qualified read. The hook declares the matching projection demand. */
export function readManagedSessionDefaults(input: ManagedSessionDefaultsReadInput): ManagedSessionDefaultsRead {
    const policyDefaults = getOrganizationPolicySessionDefaults(readOrganizationPolicy());
    let context: ManagedSessionDefaultsContext = buildManagedSessionDefaultsContext({
        ...(input.context ? { context: input.context } : {}), memberDefaults: input.memberDefaults,
        creationMachineApprovalProfileId: input.creationMachineApprovalProfileId, policy: policyDefaults });
    let repairRequired = input.repairRequired ?? false;
    if (!input.context && input.teamId === null) {
        const scope = createServerAccountScope(input.serverId, input.memberAccountId);
        if (!scope) return { status: 'unavailable', reason: 'invalid_scope', context };
        const snapshot = getHomeSessionDefaultsSnapshot(scope);
        // New Session already waits on this owner's readiness. A first read
        // must settle before its unresolved fallback is serialized as explicit.
        if (!snapshot) return { status: 'unavailable', reason: 'unobserved', context };
        context = buildManagedSessionDefaultsContext({ home: snapshot.data?.homeDefaults,
            memberDefaults: input.memberDefaults, creationMachineApprovalProfileId: input.creationMachineApprovalProfileId,
            policy: policyDefaults });
    }
    if (!input.context && input.teamId !== null) {
        const scope = createServerAccountScope(input.serverId, input.memberAccountId);
        const address = createTeamAddress(input.serverId, input.teamId);
        if (!scope || !address) return { status: 'unavailable', reason: 'invalid_scope', context };
        const state = resolveTeamViewState(getTeamSnapshot(scope, address));
        if (state.kind !== 'ready') return { status: 'unavailable', reason: state.kind, teamState: state, context };
        repairRequired = state.team.policy.managedDefaultsStatus === 'repair_required';
        context = buildManagedSessionDefaultsContext({ team: state.team, primaryTeamId: input.teamId,
            memberDefaults: input.memberDefaults, creationMachineApprovalProfileId: input.creationMachineApprovalProfileId,
            policy: policyDefaults });
    }
    const defaults = resolveManagedSessionDefaults({ ...context, agentTargetKey: input.agentTargetKey,
        explicitChoices: input.explicitChoices });
    return { status: 'ready', context, defaults, repairRequired };
}
