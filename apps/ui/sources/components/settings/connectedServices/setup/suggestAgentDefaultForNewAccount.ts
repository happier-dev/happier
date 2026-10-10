import { resolveAgentConnectedAccountPurposeDefaults, type AgentConnectedAccountPurposeDeclaration } from '@happier-dev/protocol/account/settings/connected-services';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

type AgentDefaultSettings = Parameters<typeof resolveAgentConnectedAccountPurposeDefaults>[0]['settings'];

type AgentUsingServices = Readonly<{
    agentId: string;
    title: string;
    identity: Readonly<{ pluginId: string; localId: string }> | null;
    connectedAccounts: readonly AgentConnectedAccountPurposeDeclaration[];
}>;

function sameService(left: Readonly<{ pluginId: string; localId: string }>, right: Readonly<{ pluginId: string; localId: string }>): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * The next step after an account connects (lab A5 "Use it for Codex?"): the first agent that signs
 * in through this service but still uses its own login for every purpose there. Accepting writes the
 * account as that agent's default through the one purpose-default writer; an agent that already has
 * a default for the service is never offered, so the suggestion never overrides a choice.
 */
export function suggestAgentDefaultForNewAccount(input: Readonly<{
    agents: readonly AgentUsingServices[];
    settings: AgentDefaultSettings;
    purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
    account: QualifiedConnectedAccountRef;
}>): Readonly<{
    agentTitle: string;
    agentId: string;
}> | null {
    for (const agent of input.agents) {
        const identity = agent.identity;
        if (!identity) continue;
        const declarations = agent.connectedAccounts.filter((declaration) => sameService(declaration.service, input.account.service));
        if (declarations.length === 0) continue;
        const defaults = resolveAgentConnectedAccountPurposeDefaults({
            settings: input.settings,
            purposeBindings: input.purposeBindings,
            agentId: agent.agentId,
            consumer: identity,
            declarations: agent.connectedAccounts,
        }).filter((entry) => sameService(entry.service, input.account.service));
        if (defaults.some((entry) => entry.target || entry.teamResource)) continue;
        return {
            agentTitle: agent.title,
            agentId: agent.agentId,
        };
    }
    return null;
}
