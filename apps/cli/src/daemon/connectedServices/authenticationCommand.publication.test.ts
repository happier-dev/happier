import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol';
import { createConnectedAccountAuthenticationAttemptOwner, createConnectedAccountConfigurationOwner,
  executeConnectedAccountAuthenticationCommand, invokeConnectedAccountAuthenticationRuntime } from '@happier-dev/cli-common/connectedAccounts';
import { createConnectedAccountAttemptTransactionApiBoundary } from '@/testkit/connectedAccountAttemptTransactionApi';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from './qualifiedConnectedAccountAttemptTransactionAdapters';

describe('authentication command publication', () => {
  it.each(['beginConnect', 'beginReconnect', 'continueConnect'] as const)(
    '%s returns a routable device challenge before the next Account-addressed read', async operation => {
      const service = { pluginId: 'acme.accounts', localId: 'work' };
      const account = { service, accountId: 'saved-account' };
      const api = createConnectedAccountAttemptTransactionApiBoundary();
      const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: { token: 'fixture', encryption: null }, getAccountEncryptionMode: async () => 'plain',
        getMachineId: () => 'machine-one', api, now: () => 1000,
      });
      let configured = operation !== 'continueConnect';
      const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
        id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none',
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
          { id: 'tenant', title: 'Tenant', schema: { type: 'string' }, required: true },
        ] },
      });
      const configuration = createConnectedAccountConfigurationOwner({
        read: async () => configured ? { revision: 'config-one', values: { tenant: 'work' }, secretRefs: {} } : null,
        replace: async () => ({ status: 'conflict' }), destroyAttempt: async () => {},
        secrets: { admit: async () => {}, has: async () => false, read: async () => null }, isRuntimeCurrent: () => true,
      });
      const attempts = createConnectedAccountAuthenticationAttemptOwner({
        createAttemptId: () => 'attempt-one', createAccountId: () => 'new-account', now: () => 1000,
        attemptAddresses: transactions.address, deviceTransactions: transactions.device, oauth: transactions.oauth,
        accounts: { readExact: async () => ({ account, authenticationModeId: 'device',
          credentialRevision: 'credential-one', configurationRevision: null }) }, configuration,
        settlement: { settle: async () => ({ status: 'connected', account }) },
        runtime: {
          admit: async () => ({ service, descriptor, occurrenceId: 'occurrence-one',
            sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-one', installSource: 'archive' } }),
          isCurrent: () => true,
          invoke: async ({ context, operation }) => invokeConnectedAccountAuthenticationRuntime({
            descriptor, context, operation, registerRawForRedaction: () => {}, invokeCallback: async work => await work(),
            mode: { kind: 'oauthDeviceCode', begin: async () => ({ status: 'awaitingDeviceAuthorization',
              verificationUri: 'https://provider.example/device', verificationUriComplete: 'https://provider.example/device?code=ABCD',
              userCode: 'ABCD', pollIntervalMs: 5000, expiresAtMs: 61000 }),
              poll: async () => ({ status: 'pending', retryAfterMs: 5000 }), cancel: async () => {} },
          }),
        },
      });
      try {
        if (operation === 'continueConnect') {
          expect(await executeConnectedAccountAuthenticationCommand({ attempts,
            command: { operation: 'beginConnect', service, modeId: 'device' } })).toMatchObject({ status: 'configurationRequired' });
          configured = true;
        }
        const command = operation === 'beginConnect' ? { operation, service, modeId: 'device' }
          : operation === 'beginReconnect' ? { operation, account } : { operation, attemptId: 'attempt-one' };
        const response = await executeConnectedAccountAuthenticationCommand({ attempts, command });
        expect(response).toMatchObject({ status: 'awaitingDeviceAuthorization', attemptId: 'attempt-one', userCode: 'ABCD' });
        const address = await transactions.address.read('attempt-one');
        expect(address).toMatchObject({ kind: 'device', scope: { machineId: 'machine-one', service, phase: 'awaitingDeviceAuthorization' } });
        expect(await executeConnectedAccountAuthenticationCommand({ attempts, command: { operation: 'read', attemptId: 'attempt-one' },
          ...(address ? { addressedRecord: address } : {}) })).toEqual(response);
      } finally { attempts.dispose(); }
    },
  );
});
