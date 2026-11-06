import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilityHttpHeadersV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { SESSION_READ_STATE_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { eventRouter } from '@/app/events/eventRouter';
import { auth } from '@/app/auth/auth';
import { initEncrypt } from '@/modules/encrypt';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { registerAccountSettingsRoutes } from '../account/registerAccountSettingsRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAuthPingRoute } from '../auth/registerAuthPingRoute';
import { registerSessionPatchRoute } from './registerSessionPatchRoute';
import { registerSessionListingRoutes } from './registerSessionListingRoutes';
import { registerSessionReadStateRoutes } from './registerSessionReadStateRoutes';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';
import { registerSessionCreateOrLoadRoute } from './registerSessionCreateOrLoadRoute';
import { observePostgresSessionRows } from './sessionDetailSql.postgres.testkit';

// Reuses the canonical disposable provider, HTTP and physical SQL testkits.
// Bearer authentication, admission, transactions and publication all run.
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Living Bots inherited PostgreSQL costs', () => {
    let wire: Awaited<ReturnType<typeof observePostgresSessionRows>>;
    beforeAll(async () => {
        const url = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!url || url !== process.env.DATABASE_URL || !process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) {
            throw new Error('Run with the disposable PostgreSQL DB-contract runner');
        }
        wire = await observePostgresSessionRows(url);
        vi.stubEnv('DATABASE_URL', wire.databaseUrl);
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HANDY_MASTER_SECRET', 'living-bots-disposable-postgres-test-secret');
        initDbPostgres();
        await db.$connect();
        await auth.init();
        await initEncrypt();
    });
    afterAll(async () => {
        await shutdownDbClient();
        await wire?.close();
        vi.unstubAllEnvs();
    });

    it.each([
        ['plain', 1, 1], ['plain', 1000, 121],
        ['e2ee', 1, 1], ['e2ee', 1000, 121],
    ] as const)('%s, %i Sessions and %i Machines: records real changed/no-op/conflict costs', async (mode, sessions, machines) => {
        const secret = new Uint8Array(32).fill(17);
        const encode = (value: unknown) => {
            const json = JSON.stringify(value);
            if (mode === 'plain') return json;
            const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
            const ciphertext = tweetnacl.secretbox(new TextEncoder().encode(json), nonce, secret);
            return encodeBase64(new Uint8Array([...nonce, ...ciphertext]));
        };
        const metadata = { path: '/repo', host: 'host', bot: { kind: 'bot' }, botFace: { seed: 'before' }, work: { memoryEnabled: true } };
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Invalid owner fixture');
        const ownerEnvelope = mode === 'plain' ? createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata)
            : sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret }, ownerMetadata: owner.ownerMetadata,
                randomBytes: length => tweetnacl.randomBytes(length) });
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: mode } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const sessionId = randomUUID();
        await db.session.createMany({ data: Array.from({ length: sessions }, (_, index) => ({
            id: index === 0 ? sessionId : randomUUID(), accountId: account.id, tag: randomUUID(),
            metadata: encode(projectSessionSharedMetadataV1({ metadata })), ownerMetadata: JSON.stringify(ownerEnvelope),
            metadataLayoutVersion: 1, encryptionMode: mode, seq: 1,
        })) });
        await db.machine.createMany({ data: Array.from({ length: machines }, () => ({
            id: randomUUID(), accountId: account.id, metadata: '{}',
        })) });
        await db.artifact.createMany({ data: Array.from({ length: sessions }, () => ({
            id: randomUUID(), accountId: account.id, header: new Uint8Array([1]),
            body: new Uint8Array([2]), dataEncryptionKey: new Uint8Array(32),
        })) });
        const publications = vi.spyOn(eventRouter, 'emitUpdate');
        try {
            await withAuthenticatedTestApp(app => {
                registerSessionPatchRoute(app);
                registerSessionListingRoutes(app);
                registerSessionReadStateRoutes(app);
                registerSessionReadBatchRoute(app);
                registerSessionCreateOrLoadRoute(app);
                registerAccountSettingsRoutes(app);
                registerAccountEncryptionRoutes(app);
                registerAuthPingRoute(app);
            }, async app => {
                const headers = { authorization: `Bearer ${token}`,
                    ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
                const counts: Array<{ operation: string; status: number; sql: number; sessionWrites: number;
                    sessionRows: number; facePublications: number; shapes: Record<string, number> }> = [];
                const request = async (operation: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
                    const start = wire.statements.length;
                    const published = publications.mock.calls.length;
                    const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
                    const statements = wire.statements.slice(start);
                    const shapes: Record<string, number> = {};
                    for (const { query } of statements) {
                        const shape = query === 'SELECT 1' ? 'SELECT 1'
                            : `${query.split(/\s/, 1)[0]} ${query.match(/(?:FROM|UPDATE|INTO) "public"\."(\w+)"/)?.[1] ?? ''}`.trim();
                        shapes[shape] = (shapes[shape] ?? 0) + 1;
                    }
                    counts.push({ operation, status: response.statusCode, sql: statements.length,
                        sessionWrites: statements.filter(({ query }) => /^(UPDATE|INSERT INTO) "public"\."Session"(?:\s|$)/.test(query)).length,
                        sessionRows: statements.filter(({ query }) => /^SELECT\b/.test(query) && /FROM "public"\."Session"(?:\s|$)/.test(query))
                            .reduce((total, statement) => total + statement.rows, 0), shapes,
                        facePublications: publications.mock.calls.slice(published).filter(([event]) => event.payload.body.t === 'update-session').length });
                    return response;
                };
                expect((await request('auth-cold', 'GET', '/v1/auth/ping')).statusCode).toBe(200);
                expect((await request('auth-warm', 'GET', '/v1/auth/ping')).statusCode).toBe(200);
                expect((await request('account-mode', 'GET', '/v1/account/encryption')).statusCode).toBe(200);
                // Cold and admitted-warm target reads retain the existing projection path.
                for (const operation of ['target-cold', 'target-warm']) {
                    expect((await request(operation, 'GET', `/v2/sessions/${sessionId}?accessProjectionVersion=1`)).statusCode).toBe(200);
                }
                expect((await request('target-batch', 'POST', '/v2/sessions/read-batch', {
                    sessionIds: [sessionId], accessProjectionVersion: 1, includeSnapshot: true, includeTurns: false,
                })).statusCode).toBe(200);
                const currentness = await request('currentness', 'GET', '/v1/account/encryption/currentness');
                expect(currentness.statusCode).toBe(200);
                const current = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
                const face = { style: 'dither', body: 'spider', palette: 'lagoon', seed: 'chosen-before-conflict' };
                const nextShared = encode(projectSessionSharedMetadataV1({ metadata: { ...metadata, botFace: face } }));
                const patch = { mode: 'owner', metadataLayoutVersion: 1, expectedOwnerMetadata: ownerEnvelope,
                    ownerMetadata: ownerEnvelope, sharedMetadata: { ciphertext: nextShared, expectedVersion: current.metadataVersion },
                    agentState: { ciphertext: null, expectedVersion: current.agentStateVersion } };
                expect((await request('face-change', 'PATCH', `/v2/sessions/${sessionId}`, patch)).statusCode).toBe(200);
                expect(counts.at(-1)?.facePublications).toBe(1);
                expect((await request('face-replay', 'PATCH', `/v2/sessions/${sessionId}`, patch)).statusCode).toBe(200);
                expect(counts.at(-1)?.facePublications).toBe(0);
                const conflicting = { ...patch, sharedMetadata: { ...patch.sharedMetadata, ciphertext: encode({ v: 1, botFace: { seed: 'other' } }) } };
                expect((await request('face-conflict', 'PATCH', `/v2/sessions/${sessionId}`, conflicting)).statusCode).toBe(409);
                expect(counts.at(-1)?.facePublications).toBe(0);
                expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).metadata).toBe(nextShared);
                const legacyMetadata = encode(metadata);
                const legacy = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
                    metadata: legacyMetadata, metadataLayoutVersion: 0, encryptionMode: mode } });
                expect((await request('legacy-target-batch', 'POST', '/v2/sessions/read-batch', {
                    sessionIds: [legacy.id], accessProjectionVersion: 1, includeSnapshot: true, includeTurns: false,
                })).statusCode).toBe(200);
                const upgrade = await request('privacy-upgrade', 'PATCH', `/v2/sessions/${legacy.id}`, {
                    mode: 'owner_migration', expectedAccountEncryptionMode: mode,
                    expectedAccountContentPublicKeyFingerprint: mode === 'plain' ? null : computeContentPublicKeyFingerprint(account.contentPublicKey!),
                    source: { metadataLayoutVersion: 0, metadata: { version: legacy.metadataVersion, ciphertext: legacyMetadata },
                        ownerMetadata: null, agentState: { version: legacy.agentStateVersion, ciphertext: null } },
                    target: { metadataLayoutVersion: 1, sharedMetadata: { ciphertext: encode(projectSessionSharedMetadataV1({ metadata })) },
                        ownerMetadata: ownerEnvelope, agentState: { ciphertext: null } },
                });
                expect(upgrade.statusCode, upgrade.body).toBe(200);
                const settings = await request('settings-read', 'GET', '/v2/account/settings');
                expect(settings.statusCode).toBe(200);
                const settingsPayload = { expectedVersion: settings.json().version,
                    content: mode === 'plain' ? { t: 'plain', v: { botFaceStyle: 'pixel' } } : { t: 'encrypted', c: encode({ botFaceStyle: 'pixel' }) } };
                expect((await request('settings-change', 'POST', '/v2/account/settings', settingsPayload)).json()).toMatchObject({ success: true });
                expect((await request('settings-conflict', 'POST', '/v2/account/settings', settingsPayload)).json()).toMatchObject({ success: false, error: 'version-mismatch' });
                const readPath = SESSION_READ_STATE_HTTP_PATHS_V1.set.replace(':sessionId', sessionId);
                expect((await request('personal-read', 'POST', readPath, { state: 'read' })).json()).toMatchObject({ success: true });
                expect((await request('personal-read-replay', 'POST', readPath, { state: 'read' })).json()).toMatchObject({ success: true, didChange: false });
                for (const withFace of [false, true]) {
                    const birthMetadata = { ...metadata, botFace: withFace ? face : undefined };
                    const born = await request(withFace ? 'birth-face' : 'birth-baseline', 'POST', '/v1/sessions', {
                        tag: randomUUID(), encryptionMode: mode, metadataLayoutVersion: 1,
                        sharedMetadata: { ciphertext: encode(projectSessionSharedMetadataV1({ metadata: birthMetadata })) },
                        ownerMetadata: ownerEnvelope,
                    });
                    expect(born.statusCode, born.body).toBe(200);
                    expect(born.json()).toMatchObject({ created: true });
                }
                const baseline = counts.find(count => count.operation === 'birth-baseline')!;
                const chosen = counts.find(count => count.operation === 'birth-face')!;
                wire.assertHealthy();
                console.info('LIVING_BOTS_POSTGRES', JSON.stringify({ mode, sessions, machines, artifacts: sessions, authentication: 'real', counts }));
                expect(chosen.sessionWrites).toBe(baseline.sessionWrites);
                // Connection/transaction commands vary between request windows.
                // Retain them in the physical census; compare domain-query parity.
                const domainQueryShapes = (shapes: Record<string, number>) => Object.fromEntries(
                    Object.entries(shapes).filter(([shape]) => ![
                        'BEGIN', 'SET', 'SHOW', 'COMMIT', 'ROLLBACK', 'SELECT 1',
                    ].includes(shape)),
                );
                expect(domainQueryShapes(chosen.shapes)).toEqual(domainQueryShapes(baseline.shapes));
            }, { authentication: 'real' });
        } finally {
            publications.mockRestore();
        }
    });
});
