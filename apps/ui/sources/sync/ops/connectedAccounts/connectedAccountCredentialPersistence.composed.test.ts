import { afterEach, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountCredentialHealthPatchV4Schema, QualifiedConnectedAccountCredentialMutationV4Schema,
    QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { encodeBase64 } from '@/encryption/base64';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => { await connection?.dispose(); connection = undefined; await homes.reset(); vi.restoreAllMocks(); });

it.each(['plain', 'e2ee'] as const)('settles recovered health through the captured Account HTTP adapter (%s)', async mode => {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiConnectedAccountCredentialPersistence } = await import('./connectedAccountCredentialPersistence');
    const accountId = `reconnect-${mode}`;
    const credentials = { token: createAccountTokenForTests(accountId),
        ...(mode === 'e2ee' ? { secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') } : {}) };
    const url = `https://reconnect-${mode}.test`;
    const serverId = await homes.addHome({ name: 'Reconnect', serverUrl: url, accountId, credentials, accountEncryptionMode: mode });
    if (mode === 'e2ee') {
        const { createAccountEncryptionCurrentnessFixtureForCredentials } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    }
    const ref = { service: { pluginId: 'acme.cloud', localId: 'api' }, accountId: 'selected' };
    const nextRevision = 'csr_123456789ABCDEFGHJKMNPQRST';
    const configurationRevision = 'configuration-1';
    let saved: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | undefined;
    let healthWrites = 0;
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        configureSocket: configureConnectedServerSocketBoundary,
        // HTTP and persistence are the boundaries; Account capture, encryption,
        // the physical adapter and shared settlement owner all remain real.
        request: async (input, init) => {
            const incoming = new URL(String(input));
            if (incoming.pathname.startsWith('/v1/machines')) return Response.json([]);
            if (incoming.pathname === '/v4/connect/qualified/credential' && init?.method === 'POST') {
                const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(await new Response(init.body).json());
                saved = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: mutation.ref,
                    authenticationModeId: mutation.authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: nextRevision,
                    configurationRevision, content: mutation.content, metadata: mutation.metadata,
                    health: { v: 1, status: 'needs_reauth', reconnectRequired: true, providerErrorCode: 'login_failed' } });
                return Response.json({ success: true, credentialRevision: nextRevision, configurationRevision });
            }
            if (incoming.pathname === '/v4/connect/qualified/credential/health' && init?.method === 'PATCH') {
                const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(await new Response(init.body).json());
                expect(patch).toEqual({ ref, expectedCredentialRevision: nextRevision, expectedConfigurationRevision: configurationRevision,
                    health: { v: 1, status: 'connected', reconnectRequired: false } });
                if (!saved) throw new Error('Health cannot precede credential settlement');
                saved = { ...saved, health: patch.health };
                healthWrites += 1;
                return Response.json({ success: true, credentialRevision: nextRevision, configurationRevision });
            }
            return homes.request(input, init);
        } });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const persistence = createUiConnectedAccountCredentialPersistence(account);
        await expect(persistence.settlement.settle({ intent: 'reconnect', service: ref.service, accountId: ref.accountId,
            authenticationModeId: 'api-key', expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            expectedCredentialConfigurationRevision: configurationRevision, expectedConfigurationRevision: 'unconfigured',
            sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-1', installSource: 'archive' },
            stagedCredentials: { token: 'verified-new' }, displayName: 'Cloud', scopes: [] })).resolves.toEqual({ status: 'connected', account: ref });
        expect(saved?.health).toEqual({ v: 1, status: 'connected', reconnectRequired: false });
        expect(saved?.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
        expect(healthWrites).toBe(1);
    } finally { account.dispose(); }
});
