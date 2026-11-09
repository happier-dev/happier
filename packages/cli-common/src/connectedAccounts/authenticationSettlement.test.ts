import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createConnectedAccountAuthenticationAttemptOwner } from './authenticationAttemptOwner.js';
import { createConnectedAccountConfigurationOwner } from './configurationOwner.js';
import { createConnectedAccountCredentialSettlement } from './credentialSettlement.js';
import { invokeConnectedAccountAuthenticationRuntime } from './authenticationRuntimeDispatcher.js';
import type { ConnectedAccountCompletionObservation } from './authenticationTypes.js';

// Review probes composed through real attempt/configuration/settlement owners;
// only provider and persistence transports are synthetic boundaries.
describe('admitted authentication settlement', () => {
    it('publishes service-neutral legacy refusals while retaining the private diagnostic', async () => {
        const service = { pluginId: 'acme.review', localId: 'account' };
        const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'manual', kind: 'manual', credentialOrigin: 'authentication', outcomeReconciliation: 'none', fields: [],
        });
        for (const [legacy, current] of [
            ['claude_subscription_oauth_identity_mismatch', 'connected_account_reconnect_provider_identity_mismatch'],
            ['claude_subscription_refresh_token_unavailable', 'connect_reconnect_required'],
            ['current_plugin_diagnostic', 'current_plugin_diagnostic'],
        ] as const) {
            const diagnostic = { code: legacy, severity: 'error' as const };
            const settlement = createConnectedAccountCredentialSettlement({
                now: () => 1000, resolveAccountMode: async () => 'plain',
                seal: (_kind, _mode, payload) => ({ t: 'plain', v: payload }),
                open: (_kind, _mode, envelope) => envelope.t === 'plain' ? envelope.v : null,
                parseConfigurationContent: value => value,
                mutateCredential: async () => { throw new Error('refused authentication must not write'); },
                mutateCredentialHealth: async () => {}, readCredential: async () => null,
                readConfiguration: async () => null, readHttpStatus: () => null, readFailureCode: () => null,
            });
            const configuration = createConnectedAccountConfigurationOwner({
                read: async () => null, replace: async () => { throw new Error('unused'); },
                destroyAttempt: async () => {}, secrets: { admit: async () => {}, has: async () => false, read: async () => null },
                isRuntimeCurrent: () => true,
            });
            const owner = createConnectedAccountAuthenticationAttemptOwner({
                createAttemptId: () => 'attempt-one', createAccountId: () => 'account-one', now: () => 1000,
                attemptAddresses: { acknowledge: async () => ({ expiresAtMs: 60000 }), read: async () => null, clear: async () => {} },
                accounts: { readExact: async () => null }, configuration, settlement,
                runtime: {
                    admit: async () => ({ service, descriptor, occurrenceId: 'one',
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-one', installSource: 'archive' } }),
                    isCurrent: () => true,
                    invoke: async ({ context, operation }) => invokeConnectedAccountAuthenticationRuntime({
                        descriptor, operation, context, registerRawForRedaction: () => {},
                        invokeCallback: async work => await work(),
                        mode: { kind: 'manual', complete: async () => ({ status: 'rejected', diagnostic }) },
                    }),
                },
                oauth: { create: async () => { throw new Error('unused'); } },
            });
            try {
                expect((await owner.beginConnect({ service, modeId: 'manual' })).status).toEqual('awaitingManual');
                const result = await owner.submitManual({ attemptId: 'attempt-one', fields: {} });
                if (result.status !== 'rejected') throw new Error(`Expected rejected, received ${result.status}`);
                expect(result.code).toEqual(current);
                expect(result.diagnostic).toEqual(diagnostic);
            } finally { await owner.dispose(); }
        }
    });
    it.each([
        ['connect', 'none'], ['reconnect', 'none'], ['connect', 'lost-write-ack'],
        ['reconnect', 'lost-write-ack'], ['reconnect', 'lost-health-ack'], ['connect', 'configuration-offline'],
        ['reconnect', 'credential-replaced'], ['connect', 'publication-failed'],
    ] as const)('%s recovers %s without replaying provider work', async (intent, fault) => {
        const service = { pluginId: 'acme.review', localId: 'account' };
        const account = { service, accountId: 'account-one' };
        const before = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const after = 'csr_123456789ABCDEFGHJKMNPQRST';
        const completionObservation: ConnectedAccountCompletionObservation = { v: 1, providerId: 'acme.review/account',
            observedAtMs: 1000, fetchedAtMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] };
        const publications: Parameters<NonNullable<Parameters<typeof createConnectedAccountCredentialSettlement>[0]['onSettled']>>[0][] = [];
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
            onSettled: async input => {
                publications.push(input);
                if (fault === 'publication-failed') throw new Error('publication-failed');
            },
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
                invoke: async ({ context, operation }) => invokeConnectedAccountAuthenticationRuntime({
                    descriptor, operation, context, registerRawForRedaction: () => {}, invokeCallback: async work => await work(),
                    mode: { kind: 'manual', complete: async (_input, callbackContext) => {
                        counts.providerCalls++;
                        await callbackContext.attemptCredentials.set('token', 'verified');
                        return { status: 'connected', credentialKind: 'token', accountId: account.accountId,
                            displayName: 'Review', scopes: [], completionObservation,
                            rawResponse: { access_token: 'private-provider-response' } };
                    } },
                }),
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
                : fault === 'none' || fault === 'configuration-offline' || fault === 'publication-failed' ? 'connected' : 'outcomeUnknown');
            faultActive = false;
            expect(await owner.reconcile({ attemptId: 'attempt-one' })).toMatchObject(fault === 'credential-replaced'
                ? { status: 'conflict', code: 'connect_credential_mutation_superseded' } : { status: 'connected', account });
            if (fault === 'credential-replaced') expect(stored?.content).toEqual({ t: 'plain', v: { v: 1, values: { token: 'old' } } });
            else expect(stored?.metadata).toMatchObject({ kind: 'token' });
            expect(counts.providerCalls).toBe(1);
            expect(counts.writes).toBe(1);
            expect(counts.configurationReads).toBe(admittedReads.configuration);
            expect(counts.credentialReads).toBe(admittedReads.credential);
            expect(publications).toEqual(fault === 'credential-replaced' ? [] : [{ account, accountMode: 'plain',
                credentialRevision: after, configurationRevision: null, completionObservation }]);
            expect(JSON.stringify(stored)).not.toContain('completionObservation');
            expect(JSON.stringify(stored)).not.toContain('private-provider-response');
            expect(JSON.stringify(publications)).not.toContain('private-provider-response');
        } finally { await owner.dispose(); }
    });
});
