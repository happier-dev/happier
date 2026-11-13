import { expect, it } from 'vitest';
import { createConnectedAccountAuthenticationAttemptOwner, createConnectedAccountConfigurationOwner,
    executeConnectedAccountAuthenticationCommand } from '@happier-dev/cli-common/connectedAccounts';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from '@/daemon/connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import { createConnectedAccountAttemptTransactionApiBoundary } from '@/testkit/connectedAccountAttemptTransactionApi';

// Use the admitted catalog, rather than a copied list that misses a new provider.
const modes = loadCurrentBundledPluginLocatorResult().loadedPlugins.flatMap(plugin =>
    plugin.manifest.contributes.connectedAccountDescriptors.flatMap(descriptor =>
        descriptor.authentication.modes.filter(mode => mode.kind === 'manual').map(mode => ({
            service: { pluginId: plugin.pluginId, localId: descriptor.id }, mode,
        }))));

it.each(modes)('restores the unsubmitted manual mode $service.pluginId/$service.localId/$mode.id through the shared owner', async ({ service, mode }) => {
    const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: { token: 'synthetic-account-token', encryption: null },
        getAccountEncryptionMode: async () => 'plain', api: createConnectedAccountAttemptTransactionApiBoundary(),
    });
    const createOwner = () => {
        const configuration = createConnectedAccountConfigurationOwner({
            // Only persistence is substituted. Configuration selection, validation,
            // admission and attempt restoration are the production owners.
            read: async () => null, replace: async () => { throw new Error('No configuration writes expected'); },
            destroyAttempt: async () => {}, secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => true,
        });
        return createConnectedAccountAuthenticationAttemptOwner({
            createAttemptId: () => 'manual-handoff', createAccountId: () => 'manual-handoff-account', now: Date.now,
            accounts: { readExact: async () => null }, configuration,
            runtime: {
                // This is the external plugin registration boundary. No callback
                // or vendor work is entered while moving an unsubmitted draft.
                admit: async () => ({ service, descriptor: mode, occurrenceId: 'fixture',
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-artifact', installSource: 'archive' } }),
                isCurrent: () => true, invoke: async () => { throw new Error('No provider call expected'); },
            },
            oauth: transactions.oauth, deviceTransactions: transactions.device, attemptAddresses: transactions.address,
            settlement: { settle: async () => { throw new Error('No settlement expected'); } },
        });
    };
    const first = createOwner();
    const next = createOwner();
    try {
        const begun = await executeConnectedAccountAuthenticationCommand({ attempts: first,
            command: { operation: 'beginConnect', service, modeId: mode.id } });
        expect(['awaitingManual', 'configurationRequired']).toContain(begun.status);
        if (begun.status === 'configurationRequired' && !begun.attemptId) {
            // Service configuration precedes attempt admission; there is no
            // pending attempt to hand off until that prerequisite is supplied.
            expect(begun.target.kind).toBe('service');
            return;
        }
        expect(begun).toHaveProperty('attemptId', 'manual-handoff');
        first.dispose();
        expect(await executeConnectedAccountAuthenticationCommand({ attempts: next,
            command: { operation: 'read', attemptId: 'manual-handoff' } })).toEqual(begun);
        expect(await executeConnectedAccountAuthenticationCommand({ attempts: next,
            command: { operation: 'cancel', attemptId: 'manual-handoff' } })).toMatchObject({ status: 'cancelled' });
    } finally { first.dispose(); next.dispose(); }
});
