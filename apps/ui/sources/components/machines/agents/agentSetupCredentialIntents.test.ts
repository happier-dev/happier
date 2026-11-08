import { describe, expect, it } from 'vitest';
import { executeConnectedServiceConfigurationActionV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { QualifiedConnectedAccountPurposeBindingsV1RecordSchema } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { buildAgentSetupCredentialIntents } from './agentSetupCredentialIntents';

const service = { pluginId: 'acme.agent', localId: 'account' };
const otherService = { pluginId: 'acme.agent', localId: 'other' };
const consumer = { pluginId: 'acme.agent', localId: 'review' };
const agent = {
    agentId: 'review',
    signIn: {
        status: 'signedOut', via: null, nativeLogin: 'terminal',
        connectedServices: [{ serviceId: 'acme.agent/account', title: 'Work account', connected: true, healthy: true,
            profileLabel: 'Work', profiles: [{ profileId: 'expired', healthy: false, profileLabel: 'Expired' },
                { profileId: 'work', healthy: true, profileLabel: 'Work' }] },
            { serviceId: 'acme.agent/other', title: 'Other', connected: false, healthy: false, profileLabel: null }],
    },
} satisfies Pick<MachineAgent, 'agentId' | 'signIn'>;

describe('setup credential selection through the canonical purpose Action', () => {
    it('persists the exact account or pool chosen instead of the first healthy account', () => {
        for (const selection of [{ selection: 'profile' as const, profileId: 'backup' },
            { selection: 'group' as const, groupId: 'pool' }]) {
            const input = { agent, machineId: 'machine-a', serviceId: 'acme.agent/account', selection };
            expect(buildAgentSetupCredentialIntents(input)).toEqual([{ kind: 'service', input: {
                agentId: 'review', machineId: 'machine-a', service,
                selection: { source: 'connected', ...selection },
            } }]);
        }
    });

    it('persists the displayed healthy account, clears all Agent service defaults for native, and restores without touching another Agent', async () => {
        const unrelated = { purpose: { consumer: { pluginId: 'another.agent', localId: 'review' }, purpose: 'model' },
            target: { kind: 'account', account: { service, accountId: 'another' } } };
        const otherDefault = { purpose: { consumer, purpose: 'tools' },
            target: { kind: 'account', account: { service: otherService, accountId: 'other-work' } } };
        let stored = QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse({ v: 1, bindings: [unrelated, otherDefault] });
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {}, async request() { throw new Error('unexpected_network_request'); }, async resetQuota() {},
            // Installed declaration and acknowledged persistence are the host boundaries; the Action and writer remain real.
            async resolveAgent(id, machineId) {
                expect(machineId).toBe('machine-a');
                return id === 'review' ? { agentId: id, title: 'Review', identity: consumer,
                    connectedAccounts: [{ purpose: 'model', service }, { purpose: 'tools', service: otherService }] } : null;
            },
            async mutatePurposeBindings(mutate) {
                const next = mutate(stored, {});
                if (next) stored = QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse(next.purposeBindings);
            },
        };
        const choose = async (serviceId: string | null) => {
            for (const intent of buildAgentSetupCredentialIntents({ agent, machineId: 'machine-a', serviceId,
                ...(serviceId ? { selection: { selection: 'profile' as const, profileId: 'work' } } : {}) })) {
                if (intent.kind !== 'service') throw new Error('unexpected_intent');
                expect(await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.accounts.purposeDefault.set', intent.input)).toEqual({ applied: true });
            }
        };
        await choose('acme.agent/account');
        const selectedDefault = { purpose: { consumer, purpose: 'model' },
            target: { kind: 'account', account: { service, accountId: 'work' } } };
        expect(stored.bindings).toHaveLength(3);
        expect(stored.bindings).toEqual(expect.arrayContaining([unrelated, otherDefault, selectedDefault]));
        await choose(null);
        expect(stored.bindings).toEqual([unrelated]);
        await choose('acme.agent/account');
        expect(stored.bindings).toHaveLength(2);
        expect(stored.bindings).toEqual(expect.arrayContaining([unrelated, selectedDefault]));
    });

    it('refuses an unavailable account instead of silently choosing native or another service', () => {
        expect(() => buildAgentSetupCredentialIntents({ agent, machineId: 'machine-a', serviceId: 'acme.agent/other' }))
            .toThrow('connected_account_unavailable');
        expect(() => buildAgentSetupCredentialIntents({ agent, machineId: 'machine-a', serviceId: 'unknown/account' }))
            .toThrow('agent_connected_service_unavailable');
    });
});
