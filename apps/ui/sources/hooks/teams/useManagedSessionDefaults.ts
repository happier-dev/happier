import * as React from 'react';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';

import { useTeamBinding } from './useTeamBinding';
import {
    readManagedSessionDefaults,
    type ManagedSessionDefaultsReadInput,
} from '@/sync/ops/teams/managedSessionDefaults';

/** Existing Team demand owns first load, Account qualification and pushed updates. */
export function useManagedSessionDefaults(input: Omit<ManagedSessionDefaultsReadInput, 'memberAccountId'> & Readonly<{
    access?: SessionInitialAccessDraftV1 | null;
}>) {
    const { serverId, agentTargetKey, explicitChoices } = input;
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
    const read = React.useMemo(() => readManagedSessionDefaults({
        serverId,
        teamId,
        agentTargetKey,
        explicitChoices,
        memberAccountId: binding.kind === 'bound' ? binding.scope.accountId : null,
    }), [serverId, teamId, agentTargetKey, explicitChoices, binding]);
    return { read, binding };
}
