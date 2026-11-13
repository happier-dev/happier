import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionReadBatchResponseV1Schema, SessionReadBatchTurnsV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import { db } from '@/storage/db';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import * as sessionAccessOwner from '@/app/session/access/sessionAccess';
import { readSessionDetails } from './registerSessionListingRoutes';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { parseAccountStoredContentCompatibilityHttpHeadersV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';

const turnsAdmissions = vi.hoisted(() => ({ count: 0 }));
// Counts whole-component parses of the real turns schema; the real parse still runs.
vi.mock('@happier-dev/protocol/sessions/read/sessionReadBatchV1', async importOriginal => {
    const original = await importOriginal<typeof import('@happier-dev/protocol/sessions/read/sessionReadBatchV1')>();
    let owner: object = original.SessionReadBatchTurnsV1Schema._zod;
    while (!Object.hasOwn(owner, 'run')) owner = Object.getPrototypeOf(owner);
    const run = Reflect.get(owner, 'run') as (...args: unknown[]) => unknown;
    Reflect.set(owner, 'run', function (this: unknown, ...args: unknown[]) { turnsAdmissions.count++; return run.apply(this, args); });
    return original;
});

describe('POST /v2/sessions/read-batch shared Session rows (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-read-batch-shared-rows-' });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    async function seed() {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const ids: string[] = [];
        for (let index = 0; index < 3; index++) {
            const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
                metadata: JSON.stringify({ name: `s${index}` }), encryptionMode: 'plain', latestTurnId: `turn-${index}` } });
            await db.sessionTurn.create({ data: { sessionId: session.id, turnId: `turn-${index}`, status: 'completed',
                startedAt: 100n, updatedAt: 200n, terminalAt: 200n } });
            ids.push(session.id);
        }
        return { owner, ids, headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' } };
    }

    // One Session facts read serves the detail and transcript capability bundle.
    it('reads the Session rows once for detail and turns', async () => {
        const { ids, headers } = await seed();
        const bundles = vi.spyOn(sessionAccessOwner, 'resolveSessionAccessCapabilitiesForRowsInTx');
        try { await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
            const sessionReads: string[] = [];
            const stop = observeSqliteRequests({ before: request => {
                const args = request.args as { select?: Record<string, unknown> } | undefined;
                // Session rows carrying the access projection: the rows both permissions are decided from.
                if (request.model === 'Session' && request.action === 'findMany' && args?.select?.primaryTeamId === true) sessionReads.push(request.action);
            } });
            let response;
            try {
                response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers, payload: { sessionIds: ids } });
            } finally { stop(); }
            expect(response.statusCode, response.body).toBe(200);
            const results = SessionReadBatchResponseV1Schema.parse(response.json()).results;
            expect(results.map(result => [result.detail?.status, result.turns?.status])).toEqual(ids.map(() => [200, 200]));
            expect(results.map(result => result.turns?.status === 200 ? result.turns.body.turns.map(turn => turn.turnId) : []))
                .toEqual(ids.map((_, index) => [`turn-${index}`]));
            expect(sessionReads.length).toBe(1);
            expect(bundles.mock.calls.map(([, , rows, requests]) => [rows.length, requests.length])).toEqual([[ids.length, 2]]);
        }); } finally { bundles.mockRestore(); }
    });

    it('retains detail when cross-Session disclosure refuses transcript content', async () => {
        const { owner, ids } = await seed();
        const destinationOwner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const destination = await db.session.create({ data: { accountId: destinationOwner.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted' } });
        const turnResults: NonNullable<Parameters<typeof readSessionDetails>[0]['turnResults']> = new Map();
        const details = await readSessionDetails({ userId: owner.id, sessionIds: ids, accessProjectionVersion: 1,
            authentication: { ...readSessionAccessAuthenticationFromRequest({ authAuthority: 'present_user' }),
                contentDisclosureSessionId: destination.id },
            storedContentCompatibility: evaluateAccountStoredContentCompatibility(
                parseAccountStoredContentCompatibilityHttpHeadersV1(currentAccountStoredContentCompatibilityHeaders)),
            turnResults,
        });
        for (const id of ids) {
            expect(details.get(id)).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
            expect(turnResults.get(id)).toMatchObject({ status: 'fulfilled', value: { status: 404 } });
        }
    });
    it('keeps independent direct reads available beside a Session the recipient cannot read', async () => {
        const { owner, ids } = await seed();
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        await db.session.updateMany({ where: { id: { in: ids } }, data: { metadataLayoutVersion: 1,
            metadata: JSON.stringify({ v: 1 }), ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }) } });
        await db.sessionGrant.createMany({ data: (ids.slice(0, 2).map(sessionId => ({ sessionId,
            createdByAccountId: owner.id, accountId: recipient.id, accessLevel: 'view' as const }))).map(data => ({ ...data, principalKind: 'account' })) });
        await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { 'x-test-user-id': recipient.id, 'x-happier-account-stored-content-protocol': '4' },
                payload: { sessionIds: ids, accessProjectionVersion: 1 } });
            expect(response.statusCode, response.body).toBe(200);
            const results = SessionReadBatchResponseV1Schema.parse(response.json()).results;
            expect(results.map(result => [result.detail?.status, result.turns?.status])).toEqual([[200, 200], [200, 200], [404, undefined]]);
        });
    });
    // Each turns component was parsed again after the turns owner validated every stored
    // turn (about 0.6 MB per 50-Session batch). It is emitted as validated, byte-identical.
    it('emits turns components without a re-parse, byte-identical to their admission', async () => {
        const { ids, headers } = await seed();
        await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
            turnsAdmissions.count = 0;
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers, payload: { sessionIds: ids } });
            const parsesDuringRequest = turnsAdmissions.count;
            expect(response.statusCode, response.body).toBe(200);
            const turns = response.json().results.map((result: { turns: unknown }) => result.turns);
            expect(turns).toHaveLength(3);
            for (const component of turns) {
                expect(JSON.stringify(SessionReadBatchTurnsV1Schema.parse(component))).toBe(JSON.stringify(component));
            }
            expect(parsesDuringRequest).toBe(0);
        });
    });
});
