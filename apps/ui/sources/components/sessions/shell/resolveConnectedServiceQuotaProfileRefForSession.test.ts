import { describe, expect, it } from 'vitest';

import { resolveSessionUsageAccount } from '@/sync/domains/connectedServices/resolveSessionUsageAccount';

import { resolveConnectedServiceQuotaProfileRefForSession } from './resolveConnectedServiceQuotaProfileRefForSession';

const CODEX = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const CODEX_KEY = 'happier.agent.codex/openai-codex';
const MUSE = { pluginId: 'happier.agent.muse', localId: 'muse-account' } as const;

function resolve(metadata: unknown) {
    const agentId = 'codex';
    return resolveConnectedServiceQuotaProfileRefForSession({
        usageAccount: resolveSessionUsageAccount({ metadata, agentId }),
        agentId,
        connectedAccounts: [{ purpose: 'primary', service: CODEX }],
    });
}

describe('resolveConnectedServiceQuotaProfileRefForSession', () => {
    it('projects the applied account to the released scalar quota transport', () => {
        expect(resolve({
            connectedServices: { v: 2, bindingsByServiceId: {
                [CODEX_KEY]: {
                    source: 'connected', selection: 'group', groupId: 'pool-1',
                    profileId: 'authored', appliedProfileId: 'observed',
                },
            } },
            // The retained launch intent must not replace the running Session binding.
            agentNewSessionOptionStateByAgentId: { codex: {
                connectedServicesBindingsByServiceId: {
                    [CODEX_KEY]: { source: 'connected', selection: 'profile', profileId: 'launch' },
                },
            } },
        })).toEqual({
            serviceKey: CODEX_KEY, legacyServiceId: 'openai-codex', profileId: 'observed', groupId: 'pool-1',
        });
    });

    it('translates a released scalar binding through the Session binding owner', () => {
        expect(resolve({
            connectedServices: { v: 1, bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
            } },
        })).toEqual({ serviceKey: CODEX_KEY, legacyServiceId: 'openai-codex', profileId: 'work' });
    });

    it('does not create a scalar lookup without a known Session account', () => {
        expect(resolve(null)).toBeNull();
        expect(resolve({ connectedServices: { v: 2, bindingsByServiceId: {
            [CODEX_KEY]: { source: 'native' },
        } } })).toBeNull();
        expect(resolve({ connectedServices: { v: 2, bindingsByServiceId: {
            [CODEX_KEY]: { source: 'connected', selection: 'group', groupId: 'pool-1' },
        } } })).toBeNull();
        expect(resolve({ connectedServices: { v: 2, bindingsByServiceId: {
            [CODEX_KEY]: { source: 'team_resource', resourceId: 'team-model', deliveryMode: 'direct',
                disclosedMember: { service: CODEX, accountId: 'work' } },
        } } })).toBeNull();
    });

    it('does not create a scalar lookup for an account outside the Agent catalog declarations', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            agentId: 'codex',
            usageAccount: { status: 'known', source: 'session_binding',
                account: { service: CODEX, accountId: 'work' }, groupId: null },
            connectedAccounts: [{ purpose: 'primary', service: MUSE }],
        })).toBeNull();
    });

    it('leaves a known service without a released scalar alias to the addressed record reader', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            agentId: 'happier.agent.muse/muse',
            usageAccount: { status: 'known', source: 'session_binding',
                account: { service: MUSE, accountId: 'work' }, groupId: null },
            connectedAccounts: [{ purpose: 'primary', service: MUSE }],
        })).toBeNull();
    });
});
