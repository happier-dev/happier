import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import axios from 'axios';
import { SessionInputResultGetResultV1Schema } from '../../../../packages/protocol/src/sessions/messages/sessionInputResultV1';
import { db, initDbPostgres } from '../../../../apps/server/sources/storage/db';
import { auth } from '../../../../apps/server/sources/app/auth/auth';
import { createLightSqliteHarness } from '../../../../apps/server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../apps/server/sources/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from '../../../../apps/server/sources/app/api/routes/session/registerSessionMessageRoutes';
import { registerSessionListingRoutes } from '../../../../apps/server/sources/app/api/routes/session/registerSessionListingRoutes';
import { readSessionInputResult } from '../../../../apps/cli/src/session/services/sendSessionMessage';
import { installAxiosFastifyAdapter } from '../../../../apps/cli/src/testkit/http/axiosAdapter';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { createAccountEncryptionCurrentnessFixture } from '../../../../apps/cli/src/testkit/backends/sessionFixtures';
import { reloadConfiguration } from '../../../../apps/cli/src/configuration';

const origin = normalizeServerHttpBaseUrl('http:' + '//localhost');
let harness;
beforeAll(async () => {
    // Both disposable database providers need the same synthetic auth fixture.
    vi.stubEnv('HANDY_MASTER_SECRET', randomUUID());
    for (const [name, value] of Object.entries({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
    })) vi.stubEnv(name, value);
    if (process.env.HAPPIER_DB_PROVIDER === 'postgres') {
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) throw new Error('Use the disposable PostgreSQL DB-contract harness');
        initDbPostgres();
        await db.$connect();
    } else {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-recovery-disposition-' });
    }
    vi.stubEnv('HAPPIER_SERVER_URL', origin);
    reloadConfiguration();
    await auth.init();
}, 180_000);
afterAll(async () => {
    if (harness) await harness.close(); else await db.$disconnect();
    vi.unstubAllEnvs();
    reloadConfiguration();
});

// This cross-package harness owns CLI reader -> real HTTP registration -> Pending
// storage and the exact Action output schema, with no internal mocks.
it('returns the existing unavailable recovery disposition through the real input-result reader without retries', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
    const localId = 'unavailable-run-recovery';
    await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: 1,
        targetExecutionRunId: 'unavailable-run', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Recover' } } },
        requestedAction: { v: 2, kind: 'recover_execution_run' }, status: 'queued', deliveryState: 'blocked',
        deliveryBlockedReason: 'session_input_target_unavailable', providerAction: null } });
    const app = createAuthenticatedTestApp();
    const paths = [];
    app.addHook('onRequest', async request => {
        request.headers['x-test-user-id'] = account.id;
        paths.push(new URL(request.url, origin).pathname);
    });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    registerSessionListingRoutes(app);
    registerSessionMessageRoutes(app);
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    try {
        expect((await axios.get(`${origin}/v1/account/encryption/currentness`)).data)
            .toEqual(createAccountEncryptionCurrentnessFixture());
        const produced = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/messages/by-local-id/${localId}` });
        expect(produced.statusCode).toBe(404);
        expect(produced.json()).toEqual({ error: 'Message not found', inputDisposition: { localId,
            result: { status: 'rejected', code: 'session_input_target_unavailable' } } });
        paths.length = 0;
        const accountToken = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        // Canonical plain-Account credentials contain no client encryption material.
        const credentials = { token: accountToken, encryption: null };
        paths.length = 0;
        const result = await runWithServerHttpBaseUrl(origin, () => readSessionInputResult({
            credentials, idOrPrefix: session.id, localId,
        }));
        expect(paths.filter(path => path.includes('/messages/')), JSON.stringify({ paths, result }))
            .toEqual([`/v2/sessions/${session.id}/messages/by-local-id/${localId}`]);
        expect(result).toEqual({ ok: false, code: 'session_input_target_unavailable' });
        expect(SessionInputResultGetResultV1Schema.parse(result)).toEqual(result);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
        expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId } } }))
            .toMatchObject({ deliveryState: 'blocked', deliveryBlockedReason: 'session_input_target_unavailable', providerAction: null });

        // Claimed/uncertain custody is not proof of a pre-effect refusal.
        await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { providerAction: 'send' } });
        expect(await runWithServerHttpBaseUrl(origin, () => readSessionInputResult({
            credentials, idOrPrefix: session.id, localId,
        }))).toEqual({ ok: false, code: 'result_read_failed' });
        await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { providerAction: null } });

        // Exact released reader fixture from cli-v0.2.17 (a2c45c86804b),
        // apps/cli/src/api/session/transcriptMessageLookup.ts:45-57. That release
        // has no session.input.result.get Action; its transcript reader ignores
        // the additive diagnostic and retains typed not_found without throwing.
        function asRecord(value) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
            return value;
        }
        function isV2MessageNotFoundError(error) {
            if (!axios.isAxiosError(error)) return false;
            if (error.response?.status !== 404) return false;
            const record = asRecord(error.response?.data);
            if (!record) return false;
            return record.error === 'Message not found';
        }
        const response = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/messages/by-local-id/${localId}` });
        const failure = new axios.AxiosError('Missing transcript', undefined, undefined, undefined, {
            status: response.statusCode, statusText: 'Not Found', headers: {}, config: { headers: new axios.AxiosHeaders() }, data: response.json(),
        });
        expect(isV2MessageNotFoundError(failure)).toBe(true);
    } finally {
        restore();
        await app.close();
    }
});
