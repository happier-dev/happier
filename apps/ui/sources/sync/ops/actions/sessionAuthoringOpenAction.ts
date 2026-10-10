import type { SessionAuthoringOpenResultV1 } from '@happier-dev/protocol/plugins/ui';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { openOrdinaryNewSessionSeed } from '@/components/sessions/new/newSessionSeedNavigation';

/** Presentation only: the ordinary composer retains sole ownership of edits and explicit Send. */
export const openSessionAuthoringDraft: NonNullable<ActionExecutorDeps['sessionAuthoringOpen']> = async ({ input, context }): Promise<SessionAuthoringOpenResultV1> => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime
        || (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, lifetime.scope.serverId))
        || (context.runtimeAccountId && context.runtimeAccountId !== lifetime.scope.accountId)) {
        return { kind: 'stale', reason: 'host_retired' };
    }
    const pluginId = context.actionCaller?.kind === 'plugin' ? context.actionCaller.pluginId : undefined;
    const outcome = await openOrdinaryNewSessionSeed({
        seed: input.seed,
        ...(pluginId ? { pluginId } : {}),
        scope: lifetime.scope,
        ...(context.signal ? { signal: context.signal } : {}),
        isCurrent: lifetime.isCurrent,
    });
    return outcome.kind === 'opened'
        ? { kind: 'opened', draftId: outcome.draftId, destination: 'newSession' }
        : outcome;
};
