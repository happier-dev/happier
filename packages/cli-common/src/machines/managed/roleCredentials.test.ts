import { describe, expect, it } from 'vitest';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { captureManagedMachineRoleCredentialConfigurationsV1 } from './roleCredentials.js';

type RetainedCredential = NonNullable<ManagedMachineFullV1['launch']['credentials']>[number];

const provider = { pluginId: 'acme.compute', localId: 'vm' };
const service = { pluginId: 'acme.accounts', localId: 'cloud' };
const selectedAccount = { service, accountId: 'selected-account' };
const otherAccount = { service, accountId: 'other-account' };
const accountCredential = (purpose: string, account = selectedAccount): RetainedCredential => ({
    purpose: { consumer: provider, purpose }, account, configurationRevision: null,
});

describe('managed role credential configuration capture', () => {
    it('reads each selected Account once and excludes Team selections', async () => {
        const reads: typeof selectedAccount[] = [];
        const signal = new AbortController().signal;
        const result = await captureManagedMachineRoleCredentialConfigurationsV1({
            authorizations: [
                { credential: accountCredential('cloud') },
                { credential: accountCredential('registry') },
                { credential: {
                    purpose: { consumer: provider, purpose: 'team-cloud' },
                    teamId: 'team-a',
                    selection: { source: 'team_resource', resourceId: 'shared-cloud', deliveryMode: 'brokered' },
                } satisfies RetainedCredential },
                { credential: accountCredential('other-cloud', otherAccount) },
            ],
            readCredentialConfigurationRevision: async (account, receivedSignal) => {
                expect(receivedSignal).toBe(signal);
                reads.push(account);
                return account.accountId === selectedAccount.accountId ? 'configuration-1' : null;
            },
            signal,
        });

        expect(result).toEqual([
            { account: selectedAccount, revision: 'configuration-1' },
            { account: otherAccount, revision: null },
        ]);
        expect(reads).toEqual([selectedAccount, otherAccount]);
    });
});
