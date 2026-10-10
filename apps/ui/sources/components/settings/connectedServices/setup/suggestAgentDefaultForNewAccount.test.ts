import { describe, expect, it } from 'vitest';

import { writeAgentDefaultChoice } from '../defaults/agentDefaultChoices';

import { suggestAgentDefaultForNewAccount } from './suggestAgentDefaultForNewAccount';

const CODEX_SERVICE = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const CODEX = { agentId: 'codex', title: 'Codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, connectedAccounts: [{ purpose: 'model', service: CODEX_SERVICE }] };
const OPENCODE = { agentId: 'opencode', title: 'OpenCode', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' }, connectedAccounts: [{ purpose: 'openai', service: CODEX_SERVICE }] };
const EMPTY = { connectedServicesDefaultAuthByAgentIdV1: undefined };

describe('suggestAgentDefaultForNewAccount', () => {
    it('offers the first agent that uses the service with its own login', () => {
        const account = { service: CODEX_SERVICE, accountId: 'acct-1' };
        const suggestion = suggestAgentDefaultForNewAccount({ agents: [CODEX, OPENCODE], settings: EMPTY, account })!;

        expect(suggestion).toEqual({ agentTitle: 'Codex', agentId: 'codex' });
    });

    it('offers nothing when every agent that uses the service already has a default for it', () => {
        const first = writeAgentDefaultChoice({ agents: [CODEX], settings: EMPTY,
            target: { kind: 'account', account: { service: CODEX_SERVICE, accountId: 'acct-1' } }, agentId: 'codex', makeDefault: true })!;

        expect(suggestAgentDefaultForNewAccount({
            agents: [CODEX],
            settings: first,
            purposeBindings: first.connectedAccountPurposeBindingsV1,
            account: { service: CODEX_SERVICE, accountId: 'acct-2' },
        })).toBeNull();
    });
});
