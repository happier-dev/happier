import * as React from 'react';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import type { ManagedSessionDefaultsV1 } from '@happier-dev/protocol/teams';
import type { ProjectSessionDefaultsContextSelectionV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { buildManagedSessionDefaultsContext, resolveManagedSessionDefaultsTeamId } from '@happier-dev/protocol/teams/managedDefaults';
import { useProjectSessionDefaults } from '@/hooks/projects/useProjectSessionDefaults';

import { useTeamBinding } from './useTeamBinding';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useHomeSessionDefaultsSnapshot } from '@/hooks/home/useHomeSessionDefaultsSnapshot';
import {
    readManagedSessionDefaults,
    type ManagedSessionDefaultsReadInput,
} from '@/sync/ops/teams/managedSessionDefaults';

/** Existing scoped projection demand owns first load, Account qualification and pushed updates. */
export function useManagedSessionDefaults(input: Omit<ManagedSessionDefaultsReadInput, 'memberAccountId'> & Readonly<{
    access?: SessionInitialAccessDraftV1 | null;
    memberDefaults?: ManagedSessionDefaultsV1 | null;
    projectContext?: ProjectSessionDefaultsContextSelectionV1 | null;
}>) {
    const { serverId, agentTargetKey, explicitChoices, memberDefaults } = input;
    const hasProject = Boolean(input.projectContext?.projectRef || input.projectContext?.sourceRef);
    const sharedTeamIds = React.useMemo(() => [...new Set(input.access?.grants.flatMap(({ subject }) =>
        subject.kind === 'account' ? [] : [subject.teamId]))], [input.access]);
    const projectRead = useProjectSessionDefaults({ ...input.projectContext,
        primaryTeamId: input.teamId, sharedTeamIds, demanded: hasProject });
    // Sharing does not change the Session's primary Team or its creation policy.
    // A sole shared Team nevertheless supplies member defaults. Several shared
    // Teams need an explicit context; their order is not a precedence rule.
    const teamId = React.useMemo(() => resolveManagedSessionDefaultsTeamId({
        primaryTeamId: input.teamId, sharedTeamIds,
    }), [input.teamId, sharedTeamIds]);
    const binding = useTeamBinding(serverId, hasProject ? '' : teamId ?? '');
    const personalResolution = useServerCredentialAccountScopeResolution(!hasProject && teamId === null ? serverId : null);
    const personalScope = personalResolution.kind === 'bound' ? personalResolution.scope : null;
    const homeSnapshot = useHomeSessionDefaultsSnapshot(personalScope);
    const read = React.useMemo(() => hasProject && !projectRead.data
        ? { status: 'unavailable' as const, reason: 'unobserved' as const,
            context: buildManagedSessionDefaultsContext({ memberDefaults }) }
        : readManagedSessionDefaults({
        serverId: personalScope?.serverId ?? serverId,
        teamId,
        agentTargetKey,
        explicitChoices,
        memberDefaults,
        creationMachineApprovalProfileId: input.creationMachineApprovalProfileId,
        ...(hasProject && projectRead.data ? { context: projectRead.data.context,
            repairRequired: projectRead.data.repairRequired } : {}),
        memberAccountId: personalScope?.accountId ?? (binding.kind === 'bound' ? binding.scope.accountId : null),
    }), [serverId, teamId, agentTargetKey, explicitChoices, memberDefaults, binding, personalScope, homeSnapshot,
        hasProject, projectRead.data, input.creationMachineApprovalProfileId]);
    return { read, binding: teamId === null ? personalResolution : binding, projectRead };
}
