import { describe, expect, it, vi } from 'vitest';
import {
    PluginConnectedAccountAuthenticationModeV2Schema,
    QualifiedConnectedAccountCredentialSnapshotV4Schema,
    QualifiedConnectedAccountProfileV4Schema,
} from '@happier-dev/protocol';
import { createConnectedAccountAuthenticationAttemptOwner, createConnectedAccountConfigurationOwner, invokeConnectedAccountAuthenticationRuntime } from '@happier-dev/cli-common/connectedAccounts';
import { resolveGhNativeToken } from '@happier-dev/plugin-sdk/exec';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { githubConnectedAccountRuntime } from '../../../../../packages/plugins/scm-github/src/auth/connectedAccountRuntime';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createQualifiedConnectedAccountDaemonPersistence } from './qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from './qualifiedConnectedAccountAttemptTransactionAdapters';
import { createConnectedAccountAttemptTransactionApiBoundary } from '@/testkit/connectedAccountAttemptTransactionApi';
import { createDeferred } from '@/testkit/async/deferred';

// The native CLI and HTTP/database transports are the external boundaries.
vi.mock('@happier-dev/plugin-sdk/exec', async importOriginal => ({
    ...await importOriginal<typeof import('@happier-dev/plugin-sdk/exec')>(),
    resolveGhNativeToken: vi.fn(),
}));

const service = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
const ref = (accountId: string) => ({ service, accountId });
const revision = 'csr_1234567890123456789012';
type Snapshot = ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse>;

function fixture() {
    const records = new Map<string, Snapshot>();
    const native = vi.mocked(resolveGhNativeToken);
    let attemptNumber = 0;
    let accountNumber = 0;
    let now = Date.now();
    const deviceReady = createDeferred<void>();
    const deviceToken = 'gho_device-b';
    const credentials = { token: 'fixture-home-token', encryption: null };
    const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials, getAccountEncryptionMode: async () => 'plain', getMachineId: () => 'machine-1',
        now: () => now, api: createConnectedAccountAttemptTransactionApiBoundary(),
    });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
        credentials, getAccountEncryptionMode: async () => 'plain', attemptTransactions: transactions,
        listProfiles: async () => ({ service, accounts: [...records.values()].map(record =>
            QualifiedConnectedAccountProfileV4Schema.parse({ ...record.metadata, ref: record.ref,
                authenticationModeId: record.authenticationModeId, status: 'connected', revisionSemantics: 'revisioned',
                credentialRevision: record.credentialRevision, configurationReady: true, configurationRevision: null })) }),
        readCredential: async ({ ref: account }) => records.get(account.accountId) ?? null,
        readConfiguration: async () => null,
        mutateCredential: async ({ mutation }) => {
            const existing = records.get(mutation.ref.accountId);
            if ((existing?.credentialRevision ?? null) !== mutation.expectedCredentialRevision) {
                throw Object.assign(new Error('superseded'), { status: 409, code: 'connect_credential_mutation_superseded' });
            }
            records.set(mutation.ref.accountId, QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
                ref: mutation.ref, authenticationModeId: mutation.authenticationModeId, revisionSemantics: 'revisioned',
                credentialRevision: revision, configurationRevision: null, content: mutation.content, metadata: mutation.metadata,
            }));
            return { success: true, credentialRevision: revision, configurationRevision: null };
        },
        mutateCredentialHealth: async () => ({ success: true, credentialRevision: revision, configurationRevision: null }),
        mutateConfiguration: vi.fn(),
        secrets: { admit: async () => {}, has: async () => true, read: async () => 'github_pat_scm-a' },
    });
    const unavailable = createUnavailablePluginServices();
    const services = { ...unavailable, http: { ...unavailable.http, request: async (request: Parameters<typeof unavailable.http.request>[0]) => {
        const body = request.url.endsWith('/user')
            ? { id: request.headers?.Authorization?.includes('wrong-user') ? 456 : 123, login: 'octocat' }
            : request.url.endsWith('/device/code')
                ? { device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
                : { access_token: deviceToken };
        return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)), finalUrl: request.url };
    } } };
    const configuration = createConnectedAccountConfigurationOwner({ ...persistence.configuration, isRuntimeCurrent: () => true });
    const owner = createConnectedAccountAuthenticationAttemptOwner({
        createAttemptId: () => `attempt-${++attemptNumber}`, createAccountId: () => `grant-${++accountNumber}`, now: () => now,
        onBackgroundTransition: ({ response }) => {
            if (response.status === 'awaitingDeviceAuthorization') deviceReady.resolve();
        },
        accounts: persistence.attempts.accounts, configuration: {
            ...configuration,
            admit: async input => {
                const admitted = await configuration.admit(input);
                return admitted.status === 'ready' ? { ...admitted, snapshot: { ...admitted.snapshot,
                    getPublicOAuthClient: async () => ({ clientId: 'fixture-client', scopes: ['read:user'] }) } } : admitted;
            },
        },
        attemptAddresses: transactions.address, deviceTransactions: transactions.device, oauth: transactions.oauth,
        settlement: persistence.attempts.settlement,
        runtime: {
            admit: async ({ modeId }) => ({ service, occurrenceId: 'generation-1',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture', installSource: 'archive' },
                descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({ id: modeId,
                    kind: modeId === 'copilot-device' ? 'oauthDeviceCode' : 'manual', outcomeReconciliation: 'none',
                    ...(modeId === 'copilot-device' ? {} : { credentialOrigin: modeId === 'native-import' ? 'native_import' : 'authentication',
                        // Store synthetic boundary credentials inline; production's Saved Secret transport is tested separately.
                        fields: [{ id: modeId === 'native-import' ? 'source' : 'token', title: 'Input', schema: { type: 'string' }, secret: false }] }),
                }) }),
            isCurrent: () => true,
            invoke: async ({ admission, context, operation, signal }) => invokeConnectedAccountAuthenticationRuntime({
                descriptor: admission.descriptor, mode: githubConnectedAccountRuntime.authentication.modes[admission.modeId],
                operation, context: { ...context, services, signal: signal ?? new AbortController().signal, invokedAtMs: now,
                    plugin: { id: service.pluginId, version: '1.0.0' }, surface: 'cli',
                    contribution: { id: service.localId, qualifiedId: `${service.pluginId}/connectedAccounts/${service.localId}` } },
                signal, registerRawForRedaction: () => {}, invokeCallback: async work => work(),
            }),
        },
    });
    return { owner, records, native, deviceReady: deviceReady.promise, advance: (ms: number) => { now += ms; } };
}

describe('GitHub saved grant identity', () => {
    it.each(['copilot-token', 'copilot-device', 'native-import'])('preserves SCM grant A and saves same-user %s grant B separately', async modeId => {
        const h = fixture();
        try {
            await h.owner.beginConnect({ service, modeId: 'fine-grained-pat' });
            const first = await h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'github_pat_scm-a' } });
            expect(first).toMatchObject({ status: 'connected', account: ref('grant-1') });
            const savedA = h.records.get('grant-1');
            h.native.mockResolvedValue({ ok: true, token: 'gho_import-b' });
            await h.owner.beginConnect({ service, modeId });
            if (modeId === 'copilot-device') {
                await h.deviceReady;
                h.advance(5000);
            }
            const second = modeId === 'copilot-device'
                ? await h.owner.pollDevice({ attemptId: 'attempt-2' })
                : await h.owner.submitManual({ attemptId: 'attempt-2', fields: modeId === 'native-import' ? { source: 'native' } : { token: 'gho_manual-b' } });
            expect(second, JSON.stringify(second)).toMatchObject({ status: 'connected', account: ref('grant-2') });
            expect(h.records.get('grant-1')).toEqual(savedA);
            expect(h.records.size).toBe(2);
            expect(h.records.get('grant-2')?.metadata.providerIdentity?.accountId).toBe('123');
        } finally { await h.owner.dispose(); }
    });

    it.each(['123', 'opaque-existing'])('keeps saved reference %s on correct-user reconnect and refuses wrong-user reconnect', async accountId => {
        const h = fixture();
        h.records.set(accountId, QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: ref(accountId),
            authenticationModeId: 'copilot-token', revisionSemantics: 'revisioned', credentialRevision: revision,
            configurationRevision: null, content: { t: 'plain', v: { v: 1, values: { token: 'gho_original' } } },
            metadata: { providerIdentity: { accountId: '123' }, scopes: [] } }));
        try {
            await h.owner.beginReconnect({ account: ref(accountId) });
            expect(await h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'gho_same-user' } }))
                .toMatchObject({ status: 'connected', account: ref(accountId) });
            const saved = h.records.get(accountId);
            await h.owner.beginReconnect({ account: ref(accountId) });
            expect(await h.owner.submitManual({ attemptId: 'attempt-2', fields: { token: 'gho_wrong-user' } }))
                .toMatchObject({ status: 'rejected', code: 'connected_account_reconnect_identity_mismatch' });
            expect(h.records.get(accountId)).toEqual(saved);
        } finally { await h.owner.dispose(); }
    });

    it.each(['inline', 'saved-secret'])('reuses the actual imported %s grant even when another same-user grant sorts first', async storage => {
        const h = fixture();
        for (const [accountId, token] of [['a-other', 'gho_other'], ['z-same', 'gho_same']] as const) {
            h.records.set(accountId, QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: ref(accountId),
                authenticationModeId: 'native-import', revisionSemantics: 'revisioned', credentialRevision: revision,
                configurationRevision: null, content: { t: 'plain', v: { v: 1,
                    values: storage === 'saved-secret' && accountId === 'z-same' ? {} : { token },
                    ...(storage === 'saved-secret' && accountId === 'z-same' ? { secretRefs: { token: formatSharedSavedSecretRefV1('secret-scm') } } : {}),
                } },
                metadata: { providerIdentity: { accountId: '123' }, scopes: [] } }));
        }
        try {
            h.native.mockResolvedValue({ ok: true, token: storage === 'saved-secret' ? 'github_pat_scm-a' : 'gho_same' });
            await h.owner.beginConnect({ service, modeId: 'native-import' });
            expect(await h.owner.submitManual({ attemptId: 'attempt-1', fields: { source: 'native' } }))
                .toMatchObject({ status: 'connected', account: ref('z-same') });
            expect(h.records.size).toBe(2);
        } finally { await h.owner.dispose(); }
    });
});
