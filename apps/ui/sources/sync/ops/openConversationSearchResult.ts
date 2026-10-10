import type { UniversalSearchTarget } from '@/components/appShell/search/universalSearchResult';
import { openExternalSessionCandidate, type ExternalSessionCandidateOpenState,
    type ExternalSessionCandidateFindSeed } from '@/components/sessions/external/browse/openExternalSessionCandidate';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { readConversationSearchSources } from './searchConversations';

/** Native item identity remains native until the historical-import/Find owner resolves it. */
export async function openConversationSearchResult(input: Readonly<{
    target: Extract<UniversalSearchTarget, { kind: 'externalConversation' }>;
    accountLifetime: ServerAccountScopeLifetime;
    state: ExternalSessionCandidateOpenState;
    onLinkingChange?(key: string | null): void;
    openSession(sessionId: string, target: Readonly<{ machineId: string; serverId: string | null }>, find?: ExternalSessionCandidateFindSeed): void | Promise<void>;
}>): Promise<boolean> {
    const { target, accountLifetime } = input;
    if (!accountLifetime.isCurrent() || accountLifetime.scope.accountId !== target.accountId
        || accountLifetime.scope.serverId !== target.serverId) return false;
    const controller = new AbortController();
    const retirement = accountLifetime.onRetire(() => controller.abort());
    try {
        const source = target.source ?? (await readConversationSearchSources({ machineId: target.machineId,
            accountLifetime, signal: controller.signal })).find(value => value.agentId === target.agentId && value.sourceKey === target.sourceKey)?.source;
        controller.signal.throwIfAborted();
        if (!source || !accountLifetime.isCurrent()) return false;
        const machine = resolveVisibleMachinesForActiveServerFromState(storage.getState(), { serverId: target.serverId })
            .find(value => value.id === target.machineId);
        return await openExternalSessionCandidate({ candidate: target.candidate, agentId: target.agentId, source,
            actionsAllowed: true, offline: !machine || !isMachineOnline(machine), isSelectionCurrent: () => accountLifetime.isCurrent(),
            accountCurrentness: accountLifetime, state: input.state, onLinkingChange: input.onLinkingChange ?? (() => {}),
            resolveCurrentTarget: () => accountLifetime.isCurrent() ? target : null,
            find: { query: target.query, sourceItemId: target.sourceItemId }, openSession: input.openSession,
        }) === 'opened';
    } finally { retirement.dispose(); }
}
