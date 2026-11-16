import * as React from 'react';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import type { ManagedSessionDefaultsV1 } from '@happier-dev/protocol/teams';

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
}>) {
    const { serverId, agentTargetKey, explicitChoices, memberDefaults } = input;
    // Sharing does not change the Session's primary Team or its creation policy.
    // A sole shared Team nevertheless supplies member defaults. Several shared
    // Teams need an explicit context; their order is not a precedence rule.
    const teamId = React.useMemo(() => {
        if (input.teamId !== null) return input.teamId;
        const sharedTeams = new Set(input.access?.grants.flatMap(({ subject }) =>
            subject.kind === 'account' ? [] : [subject.teamId]));
        return sharedTeams.size === 1 ? sharedTeams.values().next().value ?? null : null;
    }, [input.teamId, input.access]);
    const binding = useTeamBinding(serverId, teamId ?? '');
    const personalResolution = useServerCredentialAccountScopeResolution(teamId === null ? serverId : null);
    const personalScope = personalResolution.kind === 'bound' ? personalResolution.scope : null;
    const homeSnapshot = useHomeSessionDefaultsSnapshot(personalScope);
    const read = React.useMemo(() => readManagedSessionDefaults({
        serverId: personalScope?.serverId ?? serverId,
        teamId,
        agentTargetKey,
        explicitChoices,
        memberDefaults,
        memberAccountId: personalScope?.accountId ?? (binding.kind === 'bound' ? binding.scope.accountId : null),
    }), [serverId, teamId, agentTargetKey, explicitChoices, memberDefaults, binding, personalScope, homeSnapshot]);
    return { read, binding: teamId === null ? personalResolution : binding };
}
