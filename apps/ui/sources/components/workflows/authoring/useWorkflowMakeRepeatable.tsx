import * as React from 'react';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { appendMountedComposerDraft } from '@/sync/ops/actions/appendMountedComposerDraft';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { useWorkflowsAvailability } from '../gating/workflowsAvailability';

type RepeatableSource = Readonly<{
    sessionId: string;
    serverId: string | null | undefined;
    message?: Readonly<{ id: string; text: string }>;
}>;

/** Both entry points append to this Session's mounted editable composer; pressing never sends. */
export function useWorkflowMakeRepeatable(source: RepeatableSource) {
    const workflows = useWorkflowsAvailability({ scopeKind: 'spawn', serverId: source.serverId ?? undefined });
    const profileScope = storage((state) => state.profileScope);
    const available = workflows.available && areServerProfileIdentifiersEquivalent(profileScope?.serverId, source.serverId);
    const openRepeatable = React.useCallback(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        // A Session from another Home must not disclose its context into this draft.
        if (!available || !source.serverId || !lifetime || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, source.serverId)) return;
        const seed = buildWorkflowAgentAuthoringSeed({ kind: 'repeatable', sessionId: source.sessionId,
            serverId: source.serverId, ...(source.message ? { message: source.message } : {}),
        });
        return appendMountedComposerDraft({ scope: lifetime.scope, ref: { kind: 'session', sessionId: source.sessionId }, text: seed.prompt });
    }, [available, source.sessionId, source.serverId, source.message]);
    return { available, openRepeatable };
}
