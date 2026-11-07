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

it.each([['plain', 'healthy'], ['e2ee', 'healthy'], ['e2ee', 'lost-ack'], ['plain', 'conflict']] as const)('settles through the captured Account HTTP adapter (%s, %s)', async (mode, outcome) => {
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
    const configurationRevision = outcome === 'lost-ack' ? null : 'configuration-1';
    let saved: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | undefined;
    let healthWrites = 0;
    let credentialWrites = 0;
    let transportRecovered = false;
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        configureSocket: configureConnectedServerSocketBoundary,
        // HTTP and persistence are the boundaries; Account capture, encryption,
        // the physical adapter and shared settlement owner all remain real.
        request: async (input, init) => {
            const incoming = new URL(String(input));
            if (incoming.pathname.startsWith('/v1/machines')) return Response.json([]);
            if (incoming.pathname === '/v4/connect/qualified/credential' && init?.method === 'POST') {
                credentialWrites++;
                if (outcome === 'conflict') return Response.json({ error: 'connect_credential_mutation_superseded',
                    reason: 'credential_revision_mismatch', credentialRevision: nextRevision, configurationRevision }, { status: 409 });
                const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(await new Response(init.body).json());
                saved = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: mutation.ref,
                    authenticationModeId: mutation.authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: nextRevision,
                    configurationRevision, content: mutation.content, metadata: mutation.metadata,
                    health: { v: 1, status: 'needs_reauth', reconnectRequired: true, providerErrorCode: 'login_failed' } });
                if (outcome === 'lost-ack') throw new Error('credential acknowledgement lost');
                return Response.json({ success: true, credentialRevision: nextRevision, configurationRevision });
            }
            if (incoming.pathname === '/v4/connect/qualified/credential' && init?.method === 'GET') {
                if (!transportRecovered) throw new Error('credential read unavailable');
                return Response.json(saved);
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
        const request = { intent: outcome === 'lost-ack' ? 'connect' as const : 'reconnect' as const, service: ref.service, accountId: ref.accountId,
            authenticationModeId: 'api-key', expectedCredentialRevision: outcome === 'lost-ack' ? null : 'csr_0123456789ABCDEFGHJKMNPQRS',
            expectedCredentialConfigurationRevision: configurationRevision, expectedConfigurationRevision: 'unconfigured',
            sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'fixture-1', installSource: 'archive' as const },
            stagedCredentials: { token: 'verified-new' }, displayName: 'Cloud', scopes: [] };
        if (outcome === 'lost-ack') {
            await expect(persistence.settlement.settle(request)).rejects.toThrow('credential acknowledgement lost');
            transportRecovered = true;
            expect(await persistence.settlement.reconcile(request)).toEqual({ status: 'connected', account: ref });
            expect(saved?.content.t).toBe('encrypted');
            expect(credentialWrites).toBe(1);
            return;
        }
        const result = await persistence.settlement.settle(request);
        if (outcome === 'conflict') {
            const { readConnectedServiceSettingsErrorDetailsCode } = await import('@/components/settings/connectedServices/connectedServiceSettingsErrors');
            expect(result.status).toBe('conflict');
            expect(readConnectedServiceSettingsErrorDetailsCode(result)).toBe('connect_credential_mutation_superseded.credential_revision_mismatch');
            expect(healthWrites).toBe(0);
            return;
        }
        expect(result).toEqual({ status: 'connected', account: ref });
        expect(saved?.health).toEqual({ v: 1, status: 'connected', reconnectRequired: false });
        expect(saved?.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
        expect(healthWrites).toBe(1);
    } finally { account.dispose(); }
});
