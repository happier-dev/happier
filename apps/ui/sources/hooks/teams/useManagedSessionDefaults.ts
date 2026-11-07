import * as React from 'react';

import { useTeamBinding } from './useTeamBinding';
import {
    readManagedSessionDefaults,
    type ManagedSessionDefaultsReadInput,
} from '@/sync/ops/teams/managedSessionDefaults';

/** Existing Team demand owns first load, Account qualification and pushed updates. */
export function useManagedSessionDefaults(input: Omit<ManagedSessionDefaultsReadInput, 'memberAccountId'>) {
    const binding = useTeamBinding(input.serverId, input.teamId ?? '');
    const { serverId, teamId, agentTargetKey, explicitChoices } = input;
    const read = React.useMemo(() => readManagedSessionDefaults({
        serverId,
        teamId,
        agentTargetKey,
        explicitChoices,
        memberAccountId: binding.kind === 'bound' ? binding.scope.accountId : null,
    }), [serverId, teamId, agentTargetKey, explicitChoices, binding]);
    return { read, binding };
}
