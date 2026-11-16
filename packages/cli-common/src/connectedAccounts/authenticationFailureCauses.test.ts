import { expect, it } from 'vitest';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { createConnectedAccountAuthenticationAttemptOwner } from './authenticationAttemptOwner.js';
import { createConnectedAccountConfigurationOwner } from './configurationOwner.js';
import { createConnectedAccountCredentialSettlement } from './credentialSettlement.js';
import { invokeConnectedAccountAuthenticationRuntime } from './authenticationRuntimeDispatcher.js';
import { createConnectedAccountAttemptTransactionAdapters } from './attemptTransactionAdapters.js';
import type { ConnectedAccountAttemptTransactionRecord, ConnectedAccountAttemptTransactionStoreApi } from './attemptTransactionApi.js';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountAuthenticationModeRuntime, ConnectedAccountOAuthBeginRequest } from './authenticationTypes.js';

const cases = (['oauthAuthorizationCode', 'oauthDeviceCode'] as const).flatMap(kind =>
    (['create', 'restore-read', 'restore-configuration', 'settlement-ack'] as const).map(stage => [kind, stage] as const));

it.each(cases)(
    'retains %s persistence causes during %s', async (kind, stage) => {
        const service = { pluginId: 'acme.failure', localId: 'account' };
        const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'login', kind, outcomeReconciliation: 'none', configuration: { scope: 'service', changeBehavior: 'reconnect', fields: [
                { id: 'tenant', title: 'Tenant', schema: { type: 'string' }, required: false, secret: false },
            ] },
            ...(kind === 'oauthAuthorizationCode' ? { pkce: 'required', callbackUrl: 'https://home.example/callback' } : {}),
        });
        let fail: 'create' | 'read' | 'configuration' | 'ack' | null = stage === 'create' ? 'create' : null;
        let now = 1000;
        const unavailable = (): never => { throw Object.assign(new Error('private persistence response'), {
            response: { status: 503, data: { error: 'database_transaction_timeout', private: 'private persistence response' } },
        }); };
        let record: ConnectedAccountAttemptTransactionRecord | null = null;
        const api: ConnectedAccountAttemptTransactionStoreApi = {
            async read() { if (fail === 'read') unavailable(); return record; },
            async create(input) {
                if (fail === 'create') unavailable();
                return record = { ...input, expiresAtMs: input.expiresAtMs ?? 60_000, revision: 1 };
            },
            async replace(input) {
                if (fail === 'ack') unavailable();
                return record = { ...input, revision: input.expectedRevision + 1 };
            },
            async delete() { record = null; }, async listPending() { return []; },
        };
        const transactions = createConnectedAccountAttemptTransactionAdapters({ api, now: () => now,
            randomBytes: size => new Uint8Array(size),
            generatePkceCodes: async () => ({ challenge: 'c'.repeat(43), verifier: 'v'.repeat(43) }),
            seal: async payload => ({ t: 'plain', v: payload }),
            open: async entry => entry.content.t === 'plain' ? entry.content.v : null,
        });
        const configuration = createConnectedAccountConfigurationOwner({
            read: async () => { if (fail === 'configuration') unavailable();
                return { revision: 'configuration-one', values: { tenant: 'fixture' }, secretRefs: {} }; },
            replace: async () => { throw new Error('No configuration edits'); }, destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null }, isRuntimeCurrent: () => true,
        });
        const settlement = createConnectedAccountCredentialSettlement({ now: () => now, resolveAccountMode: async () => 'plain',
            seal: (_kind, _mode, payload) => ({ t: 'plain', v: payload }),
            open: (_kind, _mode, envelope) => envelope.t === 'plain' ? envelope.v : null,
            parseConfigurationContent: value => value,
            mutateCredential: async () => { throw new Error('Unacknowledged attempt must not settle credentials'); },
            mutateCredentialHealth: async () => {}, readCredential: async () => null, readConfiguration: async () => null,
            readHttpStatus: () => null, readFailureCode: () => null,
        });
        let callback: ConnectedAccountOAuthBeginRequest | undefined;
        const complete = async (context: ConnectedAccountAuthenticationContext) => {
            await context.attemptCredentials.set('token', 'synthetic-grant');
            if (stage === 'settlement-ack') fail = 'ack';
            return { status: 'connected' as const, credentialKind: 'oauth' as const, displayName: 'Failure fixture', scopes: [] };
        };
        // A fixture plugin supplies callbacks; the dispatcher, attempt,
        // configuration, transaction and settlement owners remain real.
        const mode: ConnectedAccountAuthenticationModeRuntime<ConnectedAccountAuthenticationContext> = kind === 'oauthAuthorizationCode'
            ? { kind, begin: async request => { callback = request; return { status: 'awaitingOAuthRedirect',
                authorizationUrl: 'https://vendor.example/authorize' }; },
                complete: async (_input, context) => complete(context), cancel: async () => {} }
            : { kind, begin: async () => ({ status: 'awaitingDeviceAuthorization', verificationUri: 'https://vendor.example/device',
                expiresAtMs: 60_000, pollIntervalMs: 1 }), poll: async context => complete(context), cancel: async () => {} };
        const createOwner = () => createConnectedAccountAuthenticationAttemptOwner({
            createAttemptId: () => 'failure-attempt', createAccountId: () => 'failure-account', now: () => now,
            attemptAddresses: transactions.address, oauth: transactions.oauth, deviceTransactions: transactions.device,
            configuration, accounts: { readExact: async () => null }, settlement,
            runtime: {
                admit: async () => ({ service, descriptor, occurrenceId: 'one', sourceCustody: {
                    kind: 'managed', immutableGenerationId: 'artifact-one', installSource: 'archive' } }),
                isCurrent: () => true,
                invoke: async ({ context, operation }) => invokeConnectedAccountAuthenticationRuntime({
                    mode, descriptor, context, operation, registerRawForRedaction: () => {}, invokeCallback: async work => work(),
                }),
            },
        });
        const owner = createOwner();
        let restored: ReturnType<typeof createOwner> | undefined;
        try {
            let response = await owner.beginConnect({ service, modeId: 'login' });
            if (response.status === 'starting') {
                response = await owner.read({ attemptId: 'failure-attempt', waitForProviderStart: true });
            }
            if (stage !== 'create') {
                expect(response.status).toBe(kind === 'oauthAuthorizationCode' ? 'awaitingOAuth' : 'awaitingDeviceAuthorization');
                if (stage === 'restore-read' || stage === 'restore-configuration') {
                    fail = stage === 'restore-read' ? 'read' : 'configuration';
                    restored = createOwner();
                    response = kind === 'oauthAuthorizationCode'
                        ? await restored.completeOAuth({ attemptId: 'failure-attempt', completion: {
                            code: 'synthetic-code', callbackUrl: callback!.callbackUrl, state: callback!.state,
                        } })
                        : await restored.resumeDevice({ attemptId: 'failure-attempt', restoreOnly: true });
                } else {
                    now += 2;
                    response = kind === 'oauthAuthorizationCode'
                        ? await owner.completeOAuth({ attemptId: 'failure-attempt', completion: {
                            code: 'synthetic-code', callbackUrl: callback!.callbackUrl, state: callback!.state,
                        } })
                        : await owner.pollDevice({ attemptId: 'failure-attempt' });
                }
            }
            const family = kind === 'oauthAuthorizationCode' ? 'oauth' : 'device';
            expect(response, `${kind} ${stage}`).toMatchObject(stage === 'settlement-ack'
                ? { status: 'outcomeUnknown', diagnostic: { code: `connected_account_${family}_settlement_persistence_unavailable` } }
                : { status: 'unavailable', code: stage === 'restore-configuration'
                    ? 'connected_account_configuration_unavailable' : `connected_account_${family}_transaction_unavailable` });
            expect(response, `${kind} ${stage}`).toMatchObject({ diagnostic: { details: {
                failureCause: { httpStatus: 503, errorCode: 'database_transaction_timeout' },
            } } });
            expect(JSON.stringify(response)).not.toContain('private persistence response');
        } finally { fail = null; await restored?.dispose(); await owner.dispose(); }
    },
);
