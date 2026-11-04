import type { WorkflowDefinitionSavedByV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { useDiscussionParticipantProfiles } from '@/components/discussions/useDiscussionParticipantProfiles';

import { useWorkflowAccountLifetime } from './workflowAccountScope';

const EMPTY_SCOPE = Object.freeze({ serverId: '', accountId: '' });

/** One demanded page, through the existing captured-Home People projection (also used before a roster exists). */
export function useWorkflowSourcePeople(
    sources: readonly (WorkflowDefinitionSavedByV1 | null | undefined)[],
    explicitLifetime?: ServerAccountScopeLifetime | null,
) {
    const active = useActiveServerAccountScopeLifetime();
    const addressed = useWorkflowAccountLifetime(explicitLifetime);
    const lifetime = addressed === undefined ? active : addressed;
    const scope = lifetime?.scope ?? EMPTY_SCOPE;
    const people = useDiscussionParticipantProfiles({ scope, roster: null,
        accountIds: sources.flatMap(source => source?.kind === 'person' && source.accountId !== scope.accountId
            ? [source.accountId] : []),
        accountLifetime: lifetime, enabled: lifetime?.isCurrent() === true,
    });
    return { viewerAccountId: lifetime?.scope.accountId ?? null, profiles: people.accounts, status: people.status };
}
