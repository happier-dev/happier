import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import type { ConnectedServicesIndexPool } from '../model/buildConnectedServicesIndexModel';
import type { suggestAgentDefaultForNewAccount } from './suggestAgentDefaultForNewAccount';

type AgentDefaultSuggestion = NonNullable<ReturnType<typeof suggestAgentDefaultForNewAccount>>;

export type ConnectedAccountSettleOffer =
    /** "Add it to Codex pool, so Codex moves to it when Personal runs out?" */
    | Readonly<{ kind: 'pool'; groupId: string; poolName: string; agentTitle: string | null; activeLabel: string | null }>
    /** "Use it for Codex?" (the service has no pool). */
    | Readonly<{ kind: 'agentDefault' } & AgentDefaultSuggestion>;

/**
 * The next step once an account connects (lab `csvc` A5): join the service's pool an agent signs in
 * through (so that agent moves to it when the account in use runs out), else any pool of the service
 * it is not in yet; only where the service has no such pool, become an agent's default (the existing
 * per-agent suggestion, which never overrides a choice). Null: nothing to anticipate.
 */
export function selectConnectedAccountSettleOffer(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    /** The service's pools on the index (with the agents that default to each). */
    pools: readonly ConnectedServicesIndexPool[];
    agentDefault: AgentDefaultSuggestion | null;
    /** The name an account goes by (its label, else its identity). */
    labelFor: (accountId: string) => string | null;
}>): ConnectedAccountSettleOffer | null {
    const joinable = input.pools.filter((pool) => (
        !pool.members.some((member) => member.connectedAccountId === input.account.accountId)
    ));
    const pool = joinable.find((candidate) => candidate.defaultFor.length > 0) ?? joinable[0] ?? null;
    if (pool) {
        const active = pool.activeConnectedAccountId ?? null;
        return {
            kind: 'pool',
            groupId: pool.ref.groupId,
            poolName: pool.displayName ?? pool.ref.groupId,
            agentTitle: pool.defaultFor[0] ?? null,
            activeLabel: active ? input.labelFor(active) : null,
        };
    }
    return input.agentDefault ? { kind: 'agentDefault', ...input.agentDefault } : null;
}
