import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { db, prismaRuntime } from '@/storage/prisma';
import { inTx, type Tx } from '@/storage/inTx';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { acquireDiscussionMutationAccountsInTx, resolveDiscussionContextInTx } from './access';
import { readDocEditProposalInTx } from './docEditProposals';
import { createDiscussion } from './mutations';

const authentication = createPresentUserSessionAccessAuthentication();

// Keep the native PostgreSQL connection while exercising both SQL-selection profiles.
describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Discussion PostgreSQL-compatible backend dialect', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'discussion-dialect-', initAuth: false,
            env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    });
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Dialect locks' } },
            firstMessage: { localId: randomUUID(), mentionedAccountIds: [],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'First message' }] } } },
        } });
        if (!created.ok) throw new Error(created.error);
        return { owner, discussionId: created.value.discussion.id,
            proposalRef: createDiscussionMessageRefV1({ serverId: 'home', discussionId: created.value.discussion.id }, created.value.firstMessage) };
    }

    async function expectRowShareLock(tx: Tx, table: string) {
        const locks = await tx.$queryRaw<{ mode: string }[]>(prismaRuntime.sql`SELECT mode FROM pg_locks
            WHERE pid = pg_backend_pid() AND relation = ${'"' + table + '"'}::regclass AND mode = 'RowShareLock'`);
        expect(locks).toEqual([{ mode: 'RowShareLock' }]);
    }

    describe.each(['postgres', 'pglite'])('%s profile', backend => {
        it('locks the Discussion parent during mutation admission', async () => {
            const current = await fixture();
            const previous = process.env.HAPPIER_DB_PROVIDER;
            try {
                process.env.HAPPIER_DB_PROVIDER = backend;
                await inTx(async tx => {
                    await acquireDiscussionMutationAccountsInTx(tx, { discussionId: current.discussionId });
                    await expectRowShareLock(tx, 'Discussion');
                });
            } finally {
                process.env.HAPPIER_DB_PROVIDER = previous;
                await db.account.delete({ where: { id: current.owner.id } });
            }
        });

        it('locks the exact message before reading a document edit proposal', async () => {
            const current = await fixture();
            const previous = process.env.HAPPIER_DB_PROVIDER;
            try {
                process.env.HAPPIER_DB_PROVIDER = backend;
                await inTx(async tx => {
                    expect(await readDocEditProposalInTx(tx, { actorAccountId: current.owner.id, authentication,
                        proposalRef: current.proposalRef })).toMatchObject({ ok: false, error: 'discussion_invalid_reply_target' });
                    await expectRowShareLock(tx, 'DiscussionMessage');
                });
            } finally {
                process.env.HAPPIER_DB_PROVIDER = previous;
                await db.account.delete({ where: { id: current.owner.id } });
            }
        });

        it.each(['team', 'group'] as const)('locks %s membership authority before projecting access', async kind => {
            const current = await fixture();
            const team = await db.team.create({ data: { name: 'Dialect team' } });
            const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: current.owner.id, role: 'owner' } });
            const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Dialect group' } });
            await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
                nativeContribution: true } });
            await db.discussionGrant.create({ data: { discussionId: current.discussionId, principalKind: kind,
                ...(kind === 'team' ? { teamId: team.id } : { teamGroupId: group.id }),
                createdByAccountId: current.owner.id, accessLevel: 'view' } });
            const previous = process.env.HAPPIER_DB_PROVIDER;
            try {
                process.env.HAPPIER_DB_PROVIDER = backend;
                await inTx(async tx => {
                    expect(await resolveDiscussionContextInTx(tx, { discussionId: current.discussionId,
                        accountId: current.owner.id, authentication, lockMembershipAuthority: true })).not.toBeNull();
                    await expectRowShareLock(tx, kind === 'team' ? 'TeamMembership' : 'TeamGroupMembership');
                });
            } finally {
                process.env.HAPPIER_DB_PROVIDER = previous;
                await db.team.delete({ where: { id: team.id } });
                await db.account.delete({ where: { id: current.owner.id } });
            }
        });
    });
});
