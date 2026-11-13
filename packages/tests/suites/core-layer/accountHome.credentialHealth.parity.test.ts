import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
    encodeQualifiedConnectedAccountV4StructuredQueryValue,
    QualifiedConnectedAccountCredentialHealthPatchV4Schema,
    QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
    QualifiedConnectedAccountCredentialSnapshotV4Schema,
    QualifiedConnectedAccountRefSchema,
} from '@happier-dev/protocol';
import { registerAccountHomeHttp } from '../../../../apps/cli/src/session/actions/widgetApproval.testkit';

// Server modules keep their importer-relative @/* alias in the cross-package harness.
// The HTTP, authentication, mutation repository and SQLite storage below are real.
let harness: Awaited<ReturnType<typeof import('../../../../apps/server/sources/testkit/lightSqliteHarness')['createLightSqliteHarness']>>;
let home: FastifyInstance;
let origin: string;
let token: string;
const ref = { service: { pluginId: 'example.account', localId: 'service' }, accountId: 'selected-provider-account' };
const readPath = '/v4/connect/qualified/credential?ref=' + encodeURIComponent(
    encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, ref));
const healthPath = '/v4/connect/qualified/credential/health';

beforeAll(async () => {
    const server = await import('../../../../apps/server/sources/testkit/lightSqliteHarness');
    const { createAuthenticatedTestApp } = await import('../../../../apps/server/sources/app/api/testkit/sqliteFastify');
    const { registerQualifiedConnectedAccountCredentialRoutesV4 } = await import(
        '../../../../apps/server/sources/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4');
    const { db } = await import('../../../../apps/server/sources/storage/db');
    harness = await server.createLightSqliteHarness({ tempDirPrefix: 'account-home-health-parity-', initAuth: true,
        initEncrypt: true, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none' } });
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    token = await server.createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    registerQualifiedConnectedAccountCredentialRoutesV4(app);
    home = app;
    origin = await home.listen({ host: '127.0.0.1', port: 0 });
    const created = await request('/v4/connect/qualified/credential', 'POST', {
        ref, authenticationModeId: 'token', expectedCredentialRevision: null,
        content: { t: 'plain', v: { v: 1, values: { token: 'synthetic-credential' } } }, metadata: { scopes: [], kind: 'token' },
    });
    expect(created.status).toBe(200);
    QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(await created.json());
});
afterAll(async () => { await home?.close(); await harness?.close(); });

function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function readStored() {
    const response = await request(readPath);
    expect(response.status).toBe(200);
    return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse(await response.json());
}

it('keeps the fake Home health route aligned with authenticated server statuses and retained credential state', async () => {
    const initial = await readStored();
    let credential = initial;
    const fake = Fastify();
    registerAccountHomeHttp(fake, { accountId: 'home-owner', serverId: 'home',
        qualifiedCredential: { read: () => credential, write: next => { credential = next; } } });
    const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse({
        ref, expectedCredentialRevision: initial.credentialRevision, expectedConfigurationRevision: initial.configurationRevision,
        health: { v: 1, status: 'connected', reconnectRequired: false },
        exportProjection: { directExportContract: 'happier.team-credential-manual-connected-account-direct.v1',
            contributionContractVersion: 'current-declaration' },
    });
    const cases = [
        { name: 'malformed input', status: 400, body: { ...patch, unexpected: true } },
        { name: 'foreign provider account', status: 404, body: { ...patch, ref: { ...ref, accountId: 'foreign-provider-account' } } },
        { name: 'stale credential', status: 409, body: { ...patch, expectedCredentialRevision: 'csr_123456789ABCDEFGHJKMNPQRST' } },
        { name: 'stale configuration', status: 409, body: { ...patch, expectedConfigurationRevision: 'foreign-configuration' } },
        { name: 'health and export publication', status: 200, body: patch },
        { name: 'equal repeat', status: 200, body: patch },
        { name: 'health-only retains export', status: 200, body: { ...patch, exportProjection: undefined,
            health: { v: 1, status: 'needs_reauth', reconnectRequired: true } } },
    ];
    try {
        for (const item of cases) {
            const before = await readStored();
            const response = await request(healthPath, 'PATCH', item.body);
            const simulated = await fake.inject({ method: 'PATCH', url: healthPath, payload: item.body });
            expect(response.status, item.name).toBe(item.status);
            expect(simulated.statusCode, item.name).toBe(response.status);
            expect(simulated.json(), item.name).toEqual(await response.json());
            const stored = await readStored();
            expect(credential, item.name).toEqual(stored);
            if (item.status !== 200) expect(stored, item.name).toEqual(before);
            else {
                expect(stored.health, item.name).toEqual(item.body.health);
                expect(stored.exportProjection, item.name).toEqual(patch.exportProjection);
                expect(stored.content, item.name).toEqual(initial.content);
                expect(stored.credentialRevision, item.name).toBe(initial.credentialRevision);
            }
        }
    } finally { await fake.close(); }
});
