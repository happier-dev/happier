import * as React from 'react';
import { useProjectSources } from '@/components/projects/sources/useProjectSources';
import { useMachinePreset } from '@/components/settings/machines/managed/useMachinePresets';
import type { TeamSectionContext } from '@/components/settings/teams/teamSectionContext';
import { useOpenedTeamCredentialDisplayNames } from '@/components/settings/teams/credentials/teamCredentialPrivateLabels';
import { useTeamCredentialResourceCatalog } from '@/hooks/teams/useTeamCredentialResources';
import { useTeamSharedResourcesSummary } from '@/hooks/teams/useTeamSharedResourcesSummary';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildManagedSessionDefaultsContext } from '@happier-dev/protocol/teams';
import { readManagedSessionDefaults } from '@/sync/ops/teams/managedSessionDefaults';

export type TeamSetupResourceContext = Readonly<Pick<TeamSectionContext, 'scope' | 'address' | 'team'> & {
    lifetime: ServerAccountScopeLifetime;
}>;

/** Mount after invitation admission; each resource retains its owner's projection and refusal. */
export function useTeamSetupResources(context: TeamSetupResourceContext) {
    const sharedResources = useTeamSharedResourcesSummary({
        scope: context.scope, address: context.address, enabled: true,
    });
    const defaults = context.team.policy.managedDefaults;
    const managedDefaults = readManagedSessionDefaults({
        serverId: context.scope.serverId, teamId: context.address.teamId,
        memberAccountId: context.scope.accountId, agentTargetKey: '',
        context: buildManagedSessionDefaultsContext({ team: context.team, primaryTeamId: context.address.teamId }),
    });
    const placement = managedDefaults.status === 'ready' ? managedDefaults.defaults.placement.value : undefined;
    const preset = useMachinePreset(context.scope.serverId, placement?.kind === 'preset' ? placement.presetId : '');
    const sources = useProjectSources(context.scope, {
        lifetime: context.lifetime,
        sharedWithTeamId: context.address.teamId,
        repositoryFacts: false,
    });
    // Repository-free Sources still carry shared setup/defaults. Keep them visible;
    // only repository selectors can enter the native clone plan.
    const sourceKinds = React.useMemo(() => ({
        repositorySources: sources.state.rows.filter(source => source.repository !== undefined),
        repositoryFreeSources: sources.state.rows.filter(source => source.repository === undefined),
    }), [sources.state.rows]);
    const credentialsEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn', serverId: context.scope.serverId,
    });
    const credentials = useTeamCredentialResourceCatalog({
        scope: context.scope, address: context.address, enabled: credentialsEnabled,
    });
    const credentialDisplayNames = useOpenedTeamCredentialDisplayNames({
        scope: context.scope, resources: credentials.resources, enabled: credentialsEnabled,
    });
    return {
        sharedResources,
        defaults,
        managedDefaultsStatus: context.team.policy.managedDefaultsStatus,
        preset: placement?.kind === 'preset' ? preset : null,
        sources,
        ...sourceKinds,
        credentials,
        credentialsEnabled,
        credentialDisplayNames,
    };
}

/** Owner statuses stay intact for Joined summaries and the demanded setup page. */
export type TeamSetupResources = ReturnType<typeof useTeamSetupResources>;
