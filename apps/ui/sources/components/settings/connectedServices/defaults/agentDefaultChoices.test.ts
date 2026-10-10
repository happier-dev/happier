import { describe, expect, it } from 'vitest';

import { buildAgentDefaultChoices, writeAgentDefaultChoice } from './agentDefaultChoices';

const CLAUDE = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } as const;
const CHATGPT = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;

const AGENTS = [
    { agentId: 'claude', title: 'Claude Code', identity: { pluginId: 'happier.agent.claude', localId: 'claude' }, connectedAccounts: [{ purpose: 'model', service: CLAUDE }] },
    { agentId: 'opencode', title: 'OpenCode', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' }, connectedAccounts: [{ purpose: 'anthropic', service: CLAUDE }, { purpose: 'openai', service: CHATGPT }] },
    { agentId: 'codex', title: 'Codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, connectedAccounts: [{ purpose: 'model', service: CHATGPT }] },
];

const POOL = { kind: 'group' as const, service: CLAUDE, groupId: 'work-pool' };
const EMPTY_SETTINGS = { connectedServicesDefaultAuthByAgentIdV1: undefined };

describe('agent default choices (★ = default for an agent)', () => {
    it('uses the explicit catalog value instead of a retired settings root', () => {
        const purposeBindings = { v: 1 as const, bindings: [{
            purpose: { consumer: AGENTS[0]!.identity, purpose: 'model' }, target: POOL,
        }] };
        expect(buildAgentDefaultChoices({ agents: AGENTS, settings: EMPTY_SETTINGS, purposeBindings, target: POOL })[0]?.isDefault).toBe(true);
        const written = writeAgentDefaultChoice({ agents: AGENTS, settings: EMPTY_SETTINGS, purposeBindings,
            target: POOL, agentId: 'claude', makeDefault: false });
        expect(written?.connectedAccountPurposeBindingsV1.bindings).toEqual([]);
    });
    it('lists only the agents that sign in through the service, none default yet', () => {
        expect(buildAgentDefaultChoices({ agents: AGENTS, settings: EMPTY_SETTINGS, target: POOL })).toEqual([
            { agentId: 'claude', title: 'Claude Code', isDefault: false },
            { agentId: 'opencode', title: 'OpenCode', isDefault: false },
        ]);
    });

    it('choosing an agent writes the pool as its default for this service only; choosing again returns it to its own login', () => {
        const on = writeAgentDefaultChoice({ agents: AGENTS, settings: EMPTY_SETTINGS, target: POOL, agentId: 'opencode', makeDefault: true });
        expect(on).not.toBeNull();
        const afterOn = { ...EMPTY_SETTINGS, ...on! };
        expect(buildAgentDefaultChoices({ agents: AGENTS, settings: afterOn, purposeBindings: on!.connectedAccountPurposeBindingsV1, target: POOL })).toEqual([
            { agentId: 'claude', title: 'Claude Code', isDefault: false },
            { agentId: 'opencode', title: 'OpenCode', isDefault: true },
        ]);
        // Its other service keeps its own login.
        expect(buildAgentDefaultChoices({ agents: AGENTS, settings: afterOn, purposeBindings: on!.connectedAccountPurposeBindingsV1, target: { kind: 'account', account: { service: CHATGPT, accountId: 'personal' } } }))
            .toEqual([
                { agentId: 'opencode', title: 'OpenCode', isDefault: false },
                { agentId: 'codex', title: 'Codex', isDefault: false },
            ]);
        const off = writeAgentDefaultChoice({ agents: AGENTS, settings: afterOn, purposeBindings: on!.connectedAccountPurposeBindingsV1, target: POOL, agentId: 'opencode', makeDefault: false });
        expect(buildAgentDefaultChoices({ agents: AGENTS, settings: { ...afterOn, ...off! }, purposeBindings: off!.connectedAccountPurposeBindingsV1, target: POOL })
            .find((choice) => choice.agentId === 'opencode')?.isDefault).toBe(false);
    });
});
