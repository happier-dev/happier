import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionMessage as createSessionMessageWithAuthentication } from '@/app/session/sessionWriteService';
import { deleteSessionTree } from '@/app/session/delete/deleteSessionTree';
import { runSessionSidechainMessageRetentionRule } from '@/app/retention/rules/sessionSidechainMessageRetentionRule';
import { readCanonicalSessionMessagesPage } from './homeSearchCanonicalSessionMessages';
import { startHomeSearchLifecycle } from './homeSearchLifecycle';

const authentication = createPresentUserSessionAccessAuthentication();

type AuthenticatedSessionMessageInput = Omit<
    Extract<Parameters<typeof createSessionMessageWithAuthentication>[0], { content: unknown }>,
    'authentication' | 'inputAdmission'
>;

function createSessionMessage(params: AuthenticatedSessionMessageInput) {
    return createSessionMessageWithAuthentication({
        ...params,
        inputAdmission: 'authenticatedAccount',
        authentication,
    });
}

async function eventually(assertion: () => void): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try { assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assertion();
}

describe('Home search canonical SQLite composition', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-home-search-canonical-',
            initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only' },
        });
    }, 120_000);

    afterAll(async () => { await harness.close(); });

    it('projects genuine nested SessionMessage rows and follows committed write, edit, empty edit, and session delete', async () => {
        const account = await db.account.create({
            data: { publicKey: `home-search-${randomUUID()}`, encryptionMode: 'plain' },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `home-search-${randomUUID()}`,
                accountId: account.id,
                metadata: 'metadata',
                encryptionMode: 'plain',
                currentStorageState: 'hosted',
            },
            select: { id: true, updatedAt: true },
        });
        const lifecycle = await startHomeSearchLifecycle({
            dbPath: join(harness.baseDir, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_home_search',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: readCanonicalSessionMessagesPage,
        });
        await lifecycle.prepare([session.id]);

        const first = await createSessionMessage({
            actorUserId: account.id,
            sessionId: session.id,
            localId: 'search-local-id',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'first searchable phrase' } } },
        });
        expect(first).toMatchObject({ ok: true, didWrite: true });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
        await eventually(() => expect(lifecycle.search({ v: 1, query: 'first', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: session.id })] }));

        const page = await readCanonicalSessionMessagesPage({ sessionIds: [session.id], limit: 250 });
        expect(page.messages).toEqual(expect.arrayContaining([expect.objectContaining({
            sessionId: session.id,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'first searchable phrase' } } },
        })]));

        // Unspaced CJK and emoji survive canonical nested plaintext parsing into the derived index.
        const cjk = await createSessionMessage({
            actorUserId: account.id,
            sessionId: session.id,
            localId: 'search-local-id-cjk',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: '今日は東京のテスト 🦘' } } },
        });
        expect(cjk).toMatchObject({ ok: true, didWrite: true });
        await eventually(() => {
            expect(lifecycle.search({ v: 1, query: '東京のテスト', scope: { type: 'global' }, mode: 'auto' }))
                .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: session.id, homeServerIdentityId: 'srv_home_search' })] });
            expect(lifecycle.search({ v: 1, query: '🦘', scope: { type: 'global' }, mode: 'auto' }))
                .toMatchObject({ ok: true, hits: [expect.anything()] });
        });

        const edited = await createSessionMessage({
            actorUserId: account.id,
            sessionId: session.id,
            localId: 'search-local-id',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'revised searchable phrase' } } },
        });
        expect(edited).toMatchObject({ ok: true, didUpdate: true });
        await eventually(() => {
            expect(lifecycle.search({ v: 1, query: 'first', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [] });
            expect(lifecycle.search({ v: 1, query: 'revised', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [expect.anything()] });
        });

        const emptied = await createSessionMessage({
            actorUserId: account.id,
            sessionId: session.id,
            localId: 'search-local-id',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: '' } } },
        });
        expect(emptied).toMatchObject({ ok: true, didUpdate: true });
        await eventually(() => expect(lifecycle.search({ v: 1, query: 'revised', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [] }));

        const retained = await createSessionMessage({
            actorUserId: account.id,
            sessionId: session.id,
            localId: 'search-delete-id',
            sidechainId: 'expired-search-sidechain',
            content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'retention deletion phrase' } } },
        });
        expect(retained).toMatchObject({ ok: true, didWrite: true });
        if (!retained.ok) throw new Error('expected canonical sidechain write');
        await eventually(() => expect(lifecycle.search({ v: 1, query: 'retention', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [expect.anything()] }));
        await db.sessionMessage.update({
            where: { id: retained.message.id },
            data: { createdAt: new Date('2025-01-01T00:00:00.000Z') },
        });
        await expect(runSessionSidechainMessageRetentionRule({
            cutoff: new Date('2026-01-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
        })).resolves.toMatchObject({ deleted: 1 });
        await eventually(() => expect(lifecycle.search({ v: 1, query: 'retention', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [] }));

        const beforeSessionDelete = await createSessionMessage({
            actorUserId: account.id,
            sessionId: session.id,
            localId: 'search-session-delete-id',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'whole session deletion phrase' } } },
        });
        expect(beforeSessionDelete).toMatchObject({ ok: true, didWrite: true });
        await eventually(() => expect(lifecycle.search({ v: 1, query: 'whole', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [expect.anything()] }));

        const current = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { updatedAt: true } });
        await inTx(async (tx) => { await deleteSessionTree(tx, { sessionId: session.id, sessionUpdatedAt: current.updatedAt, actorAccountId: account.id, reason: 'user_request' }); });
        await eventually(() => expect(lifecycle.search({ v: 1, query: 'whole', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [] }));
        await eventually(() => expect(lifecycle.search({ v: 1, query: '東京', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [] }));
        await lifecycle.stop();
    }, 120_000);

    it('excludes a plaintext envelope whose canonical Session mode is E2EE', async () => {
        const account = await db.account.create({
            data: { publicKey: `home-search-mode-${randomUUID()}`, encryptionMode: 'e2ee' },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `home-search-mode-${randomUUID()}`,
                accountId: account.id,
                metadata: 'metadata',
                encryptionMode: 'e2ee',
                currentStorageState: 'hosted',
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                localId: 'inconsistent-plain-envelope',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'must remain private' } } },
            },
        });

        const page = await readCanonicalSessionMessagesPage({ sessionIds: [session.id], limit: 250 });
        expect(page.messages).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ sessionId: session.id }),
        ]));
    });
});
