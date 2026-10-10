import { buildQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import { resolveAgentConnectedAccountPurposeDefaults, writeAgentConnectedServiceDefault, type AgentConnectedAccountPurposeDeclaration } from '../account/settings/connectedServicesSettings.js';
import type { QualifiedConnectedAccountPurposeBindingTargetV1, QualifiedConnectedAccountPurposeBindingsV1 } from './connectedAccountPurposeBindings.js';

type DefaultSettings = Parameters<typeof resolveAgentConnectedAccountPurposeDefaults>[0]['settings'];

/** An agent as the agent catalog projects it: what it is called and the services its purposes sign in with. */
export type AgentDefaultChoiceAgent = Readonly<{
    agentId: string;
    title: string;
    identity: Readonly<{ pluginId: string; localId: string }> | null;
    connectedAccounts: readonly AgentConnectedAccountPurposeDeclaration[];
}>;

/** One row of the ★ menu: an agent that signs in through the target's service, and whether the target is its default. */
export type AgentDefaultChoice = Readonly<{ agentId: string; title: string; isDefault: boolean }>;

function serviceOf(target: QualifiedConnectedAccountPurposeBindingTargetV1): Readonly<{ pluginId: string; localId: string }> {
    return target.kind === 'group' ? target.service : target.account.service;
}

function sameService(left: Readonly<{ pluginId: string; localId: string }>, right: Readonly<{ pluginId: string; localId: string }>): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function sameTarget(left: QualifiedConnectedAccountPurposeBindingTargetV1, right: QualifiedConnectedAccountPurposeBindingTargetV1): boolean {
    if (left.kind === 'group' && right.kind === 'group') {
        return sameService(left.service, right.service) && left.groupId === right.groupId;
    }
    if (left.kind === 'account' && right.kind === 'account') {
        return sameService(left.account.service, right.account.service) && left.account.accountId === right.account.accountId;
    }
    return false;
}

/**
 * ★ = "default for an agent" (lab `csvc` open question 2): defaults are per agent, never per service.
 * The menu lists the agents whose purposes sign in through the target's service; an agent is checked
 * when the target is its default there, read through the one purpose-default owner.
 */
export function buildAgentDefaultChoices(input: Readonly<{
    agents: readonly AgentDefaultChoiceAgent[];
    settings: DefaultSettings;
    purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
}>): AgentDefaultChoice[] {
    const service = serviceOf(input.target);
    return input.agents.flatMap((agent) => {
        if (!agent.identity) return [];
        if (!agent.connectedAccounts.some((declaration) => sameService(declaration.service, service))) return [];
        const defaults = resolveAgentConnectedAccountPurposeDefaults({
            settings: input.settings,
            purposeBindings: input.purposeBindings,
            agentId: agent.agentId,
            consumer: agent.identity,
            declarations: agent.connectedAccounts,
        }).filter((entry) => sameService(entry.service, service));
        return [{
            agentId: agent.agentId,
            title: agent.title,
            isDefault: defaults.length > 0 && defaults.every((entry) => entry.target !== null && sameTarget(entry.target, input.target)),
        }];
    });
}

/**
 * Makes the target an agent's default for its service, or returns that agent to its own login there,
 * through the existing per-agent default writer. Returns the purpose value and genuine legacy
 * carrier-retirement delta to commit together, or null when the agent does not use the service.
 */
export function writeAgentDefaultChoice(input: Readonly<{
    agents: readonly AgentDefaultChoiceAgent[];
    settings: DefaultSettings;
    purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    agentId: string;
    makeDefault: boolean;
}>): ReturnType<typeof writeAgentConnectedServiceDefault> {
    const agent = input.agents.find((candidate) => candidate.agentId === input.agentId);
    if (!agent?.identity) return null;
    const target = input.target;
    return writeAgentConnectedServiceDefault({
        settings: input.settings,
        purposeBindings: input.purposeBindings,
        agentId: agent.agentId,
        consumer: agent.identity,
        declarations: agent.connectedAccounts,
        serviceKey: buildQualifiedPluginContributionKey(serviceOf(target)),
        selection: !input.makeDefault
            ? { source: 'native' }
            : target.kind === 'group'
                ? { source: 'connected', selection: 'group', groupId: target.groupId }
                : { source: 'connected', selection: 'profile', profileId: target.account.accountId },
    });
}
