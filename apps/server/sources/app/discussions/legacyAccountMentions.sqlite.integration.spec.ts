import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { runSqliteMigrationDeploy } from '../../../scripts/migrate.sqlite.deploy';
import { createDiscussion, postDiscussionMessage } from './mutations';
import { validateDiscussionStoredContent } from './projection';
import { listDiscussions, readDiscussionMessages } from './queries';

const migrationId = '20261019120000_discussion_typed_account_mentions';
const migrationsDir = fileURLToPath(new URL('../../../prisma/sqlite/migrations', import.meta.url));
const authentication = createPresentUserSessionAccessAuthentication();

describe('Retained legacy Account mentions', () => {
    let harness: LightSqliteHarness;
    let predecessorDir: string | undefined;

    beforeAll(async () => {
        predecessorDir = await mkdtemp(join(tmpdir(), 'happier-discussion-mention-predecessor-'));
        // Deploy current predecessors, seed retained rows, then use the same
        // canonical deploy owner to discover/apply the forward migration.
        await Promise.all((await readdir(migrationsDir)).filter(name => name !== migrationId)
            .map(name => cp(join(migrationsDir, name), join(predecessorDir!, name), { recursive: true })));
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-mention-upgrade-', initAuth: false,
            env: { HAPPIER_SQLITE_MIGRATIONS_DIR: predecessorDir,
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => {
        await harness?.close();
        if (predecessorDir) await rm(predecessorDir, { recursive: true, force: true });
    });

    it('converts old plain mention bodies for validation, list and history without rewriting ciphertext or identity', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const invitee = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, invitee.id);
        const typed = { v: 1 as const, parts: [{ t: 'mention' as const,
            participant: { kind: 'account' as const, accountId: invitee.id } }, { t: 'text' as const, text: ' please review' }] };
        const created = await createDiscussion({ authentication, actorAccountId: owner.id,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
                titleContent: { t: 'plain', v: { v: 1, title: 'Retained mentions' } },
                participants: [{ kind: 'account', accountId: invitee.id }],
                firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: typed }, authoredContent: typed,
                    mentionedAccountIds: [invitee.id] } }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const posted = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
                content: { t: 'plain', v: typed }, authoredContent: typed, mentionedAccountIds: [invitee.id] }) });
        if (!posted.ok) throw new Error(posted.error);
        const oldContent = { t: 'plain', v: { v: 1, parts: [
            { t: 'mention', accountId: invitee.id }, { t: 'text', text: ' please review' },
        ] } };
        await db.discussionMessage.update({ where: { id: posted.value.message.id }, data: { content: oldContent } });
        const original = await db.discussionMessage.findUniqueOrThrow({ where: { id: posted.value.message.id } });
        const typedOriginal = await db.discussionMessage.findUniqueOrThrow({ where: { discussionId_seq: { discussionId, seq: 1 } } });
        expect(validateDiscussionStoredContent(original.content, 'plain', 'message')).toBe('discussion_invalid_content');

        // R1's legacy key-unavailable case is intentionally opaque, even when
        // the ciphertext text resembles the retired Account-mention grammar.
        const encryptedOwner = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const encryptedDiscussion = await db.discussion.create({ data: { ownerAccountId: encryptedOwner.id,
            createdByAccountId: encryptedOwner.id, encryptionMode: 'e2ee', dataEncryptionKey: new Uint8Array(0),
            creationLocalId: crypto.randomUUID(), creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'retained-create' },
            titleContent: { t: 'encrypted', c: 'opaque-title' }, lastMessageAt: new Date(), messageSeq: 1 } });
        const encrypted = await db.discussionMessage.create({ data: { discussionId: encryptedDiscussion.id,
            localId: crypto.randomUUID(), requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'retained-message' },
            seq: 1, authorAccountId: encryptedOwner.id,
            content: { t: 'encrypted', c: JSON.stringify(oldContent.v) } } });

        await runSqliteMigrationDeploy({ env: { ...process.env, HAPPIER_SQLITE_MIGRATIONS_DIR: migrationsDir } });
        const migrated = await db.discussionMessage.findUniqueOrThrow({ where: { id: original.id } });
        // Soft assertions independently expose the three broken reader paths
        // before the forward migration exists, rather than failing on ENOENT.
        expect.soft(validateDiscussionStoredContent(migrated.content, 'plain', 'message')).toBeNull();
        expect.soft(await listDiscussions({ authentication, actorAccountId: invitee.id }))
            .toMatchObject({ ok: true, value: { discussions: [{ id: discussionId,
                latestMessage: { id: original.id, content: { t: 'plain', v: typed } } }] } });
        const history = await readDiscussionMessages({ authentication, actorAccountId: invitee.id, discussionId });
        expect.soft(history).toMatchObject({ ok: true, value: { messages: [
            { id: typedOriginal.id, content: { t: 'plain', v: typed } },
            { id: original.id, content: { t: 'plain', v: typed } },
        ] } });
        const { content: _oldContent, ...identity } = original;
        const { content: _newContent, ...retained } = migrated;
        expect(retained).toEqual(identity);
        expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: typedOriginal.id } })).toEqual(typedOriginal);
        expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: encrypted.id } })).toEqual(encrypted);
    }, 120_000);
});
