import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createConnectedAccountAuthenticationAttemptOwner } from './authenticationAttemptOwner.js';
import { createConnectedAccountConfigurationOwner } from './configurationOwner.js';
import { createConnectedAccountCredentialSettlement } from './credentialSettlement.js';

// Review probes composed through real attempt/configuration/settlement owners;
// only provider and persistence transports are synthetic boundaries.
describe('admitted authentication settlement', () => {
    it.each([
        ['connect', 'none'], ['reconnect', 'none'], ['connect', 'lost-write-ack'],
        ['reconnect', 'lost-write-ack'], ['reconnect', 'lost-health-ack'], ['connect', 'configuration-offline'],
        ['reconnect', 'credential-replaced'],
    ] as const)('%s recovers %s without replaying provider work', async (intent, fault) => {
        const service = { pluginId: 'acme.review', localId: 'account' };
        const account = { service, accountId: 'account-one' };
        const before = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const after = 'csr_123456789ABCDEFGHJKMNPQRST';
        const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'manual', kind: 'manual', credentialOrigin: 'authentication', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: false }],
            configuration: { scope: 'service', changeBehavior: 'reconnect', fields: [
                { id: 'tenant', title: 'Tenant', schema: { type: 'string' }, required: true, secret: false },
            ] },
        });
        let stored: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | null = intent === 'reconnect'
            ? QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'manual',
                revisionSemantics: 'revisioned', credentialRevision: before, configurationRevision: null,
                content: { t: 'plain', v: { v: 1, values: { token: 'old' } } }, metadata: { displayName: 'Review', scopes: [] } }) : null;
        let faultActive = false;
        const counts = { configurationReads: 0, credentialReads: 0, providerCalls: 0, writes: 0 };
        const settlement = createConnectedAccountCredentialSettlement({
            now: () => 1000, resolveAccountMode: async () => 'plain',
            seal: (_kind, _mode, payload) => ({ t: 'plain', v: payload }),
            open: (_kind, _mode, envelope) => {
                if (envelope.t !== 'plain') throw new Error('wrong envelope mode');
                return envelope.v;
            },
            parseConfigurationContent: value => value,
            mutateCredential: async mutation => {
                counts.writes++;
                if (stored && mutation.expectedCredentialRevision !== stored.credentialRevision) {
                    throw Object.assign(new Error('superseded'), { status: 409, code: 'connect_credential_mutation_superseded' });
                }
                stored = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'manual',
                    revisionSemantics: 'revisioned', credentialRevision: after, configurationRevision: null,
                    content: mutation.content, metadata: mutation.metadata });
                if (fault === 'lost-write-ack' && faultActive) throw new Error('lost-write-ack');
                return { success: true, credentialRevision: after, configurationRevision: null };
            },
            mutateCredentialHealth: async () => {
                if (fault === 'lost-health-ack' && faultActive) throw new Error('lost-health-ack');
            },
            readCredential: async () => {
                if (faultActive) throw new Error('read-offline');
                return stored;
            },
            readConfiguration: async () => null,
            readHttpStatus: error => error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null,
            readFailureCode: error => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null,
        });
        const configuration = createConnectedAccountConfigurationOwner({
            read: async () => {
                counts.configurationReads++;
                if (fault === 'configuration-offline' && faultActive) throw new Error('read-offline');
                return { revision: 'configuration-one', values: { tenant: 'review' }, secretRefs: {} };
            },
            replace: async () => { throw new Error('unused'); }, destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null }, isRuntimeCurrent: () => true,
        });
        const owner = createConnectedAccountAuthenticationAttemptOwner({
            createAttemptId: () => 'attempt-one', createAccountId: () => account.accountId, now: () => 1000,
            attemptAddresses: { acknowledge: async () => ({ expiresAtMs: 60000 }), read: async () => null, clear: async () => {} },
            accounts: { readExact: async () => {
                counts.credentialReads++;
                return stored?.revisionSemantics === 'revisioned' ? { account, authenticationModeId: 'manual', credentialRevision: stored.credentialRevision,
                    configurationRevision: null } : null;
            } }, configuration,
            runtime: {
                admit: async () => ({ service, descriptor, occurrenceId: 'one', sourceCustody: {
                    kind: 'managed', immutableGenerationId: 'artifact-one', installSource: 'archive' } }),
                isCurrent: () => true,
                invoke: async ({ context }) => {
                    counts.providerCalls++;
                    await context.attemptCredentials.set('token', 'verified');
                    return { status: 'connected', credentialKind: 'token', accountId: account.accountId, displayName: 'Review', scopes: [] };
                },
            },
            oauth: { create: async () => { throw new Error('unused'); } }, settlement,
        });
        try {
            expect((intent === 'connect' ? await owner.beginConnect({ service, modeId: 'manual' })
                : await owner.beginReconnect({ account })).status).toBe('awaitingManual');
            const admittedReads = { configuration: counts.configurationReads, credential: counts.credentialReads };
            if (fault === 'credential-replaced' && stored?.revisionSemantics === 'revisioned') stored = { ...stored, credentialRevision: after };
            faultActive = fault !== 'none';
            const first = await owner.submitManual({ attemptId: 'attempt-one', fields: { token: 'verified' } });
            expect(first.status).toBe(fault === 'credential-replaced' ? 'conflict'
                : fault === 'none' || fault === 'configuration-offline' ? 'connected' : 'outcomeUnknown');
            faultActive = false;
            expect(await owner.reconcile({ attemptId: 'attempt-one' })).toMatchObject(fault === 'credential-replaced'
                ? { status: 'conflict', code: 'connect_credential_mutation_superseded' } : { status: 'connected', account });
            if (fault === 'credential-replaced') expect(stored?.content).toEqual({ t: 'plain', v: { v: 1, values: { token: 'old' } } });
            else expect(stored?.metadata).toMatchObject({ kind: 'token' });
            expect(counts.providerCalls).toBe(1);
            expect(counts.writes).toBe(1);
            expect(counts.configurationReads).toBe(admittedReads.configuration);
            expect(counts.credentialReads).toBe(admittedReads.credential);
        } finally { await owner.dispose(); }
    });
});
