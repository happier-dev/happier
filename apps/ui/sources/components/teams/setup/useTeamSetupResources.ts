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
    preview?: boolean;
}>;

/** Counts and names shared by Joined and the full setup page. */
export function useTeamSetupResourceSummary(context: TeamSetupResourceContext) {
    const sharedResources = useTeamSharedResourcesSummary({
        scope: context.scope, address: context.address, enabled: !context.preview,
    });
    const defaults = context.team.policy.managedDefaults;
    const managedDefaults = readManagedSessionDefaults({
        serverId: context.scope.serverId, teamId: context.address.teamId,
        memberAccountId: context.scope.accountId, agentTargetKey: '',
        context: buildManagedSessionDefaultsContext({ team: context.team, primaryTeamId: context.address.teamId }),
    });
    const placement = managedDefaults.status === 'ready' ? managedDefaults.defaults.placement.value : undefined;
    const preset = useMachinePreset(context.scope.serverId, !context.preview && placement?.kind === 'preset' ? placement.presetId : '');
    const sources = useProjectSources(context.scope, {
        lifetime: context.lifetime,
        sharedWithTeamId: context.address.teamId,
        repositoryFacts: false,
    });
    return {
        sharedResources,
        defaults,
        managedDefaultsStatus: context.team.policy.managedDefaultsStatus,
        preset: !context.preview && placement?.kind === 'preset' ? preset : null,
        sources,
    };
}

/** Setup also needs the credential choices for binding keys. */
export function useTeamSetupResources(context: TeamSetupResourceContext) {
    const summary = useTeamSetupResourceSummary(context);
    const rows = summary.sources.state.rows;
    // Repository-free Sources still carry shared setup/defaults. Keep them visible;
    // only repository selectors can enter the native clone plan.
    const sourceKinds = React.useMemo(() => {
        // The scoped Source catalog distinguishes whole-Team access from the viewer's Group grants.
        const visible = context.preview ? rows.filter(source =>
            source.sharedWithTeamScope === 'team' || source.sharedWithTeamScope === 'team_and_group') : rows;
        return {
            repositorySources: visible.filter(source => source.repository !== undefined),
            repositoryFreeSources: visible.filter(source => source.repository === undefined),
        };
    }, [context.preview, rows]);
    const credentialFeatureEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn', serverId: context.scope.serverId,
    });
    const credentialsEnabled = !context.preview && credentialFeatureEnabled;
    const credentials = useTeamCredentialResourceCatalog({
        scope: context.scope, address: context.address, enabled: credentialsEnabled,
    });
    const credentialDisplayNames = useOpenedTeamCredentialDisplayNames({
        scope: context.scope, resources: credentials.resources, enabled: credentialsEnabled,
    });
    return {
        ...summary,
        ...sourceKinds,
        credentials,
        credentialsEnabled,
        credentialDisplayNames,
    };
}

export type TeamSetupResources = ReturnType<typeof useTeamSetupResources>;
