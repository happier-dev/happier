import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import { initEncrypt } from '@/modules/encrypt';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { deleteTeamCredentialResourceInTx } from './resourceDelete';
import { TEST_TEAM_AUTHENTICATION } from './sessionBinding.testkit';

// Withdrawal admission must not need every audience Account row free: ordinary
// writers hold KEY SHARE on Account rows (content admission, FK checks), and an
// exclusive admission starves behind any continuous overlap of them. Credential
// consumers admit at NO KEY UPDATE and must still serialize with withdrawal.
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')(
  'Team credential withdrawal admission contention (PostgreSQL)',
  () => {
    const accountIds: string[] = [];
    const teamIds: string[] = [];
    const previousEnv = new Map<string, string | undefined>();
    let connected = false;

    beforeAll(async () => {
      const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
      if (!supplied || process.env.DATABASE_URL !== supplied)
        throw new Error('Use the disposable PostgreSQL DB-contract harness');
      for (const [key, value] of Object.entries({
        HANDY_MASTER_SECRET: 'withdrawal-admission-disposable',
        HAPPIER_FEATURE_TEAMS__ENABLED: '1',
        HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
        HAPPIER_SERVER_IDENTITY_ID: `srv_${'b'.repeat(32)}`,
        HAPPIER_DB_CONNECTION_LIMIT: '10',
      })) {
        previousEnv.set(key, process.env[key]);
        process.env[key] = value;
      }
      await initEncrypt();
      initDbPostgres();
      await db.$connect();
      connected = true;
    });

    afterAll(async () => {
      if (connected) {
        await db.teamCredentialResource.deleteMany({
          where: { teamId: { in: teamIds } },
        });
        await db.team.deleteMany({ where: { id: { in: teamIds } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        await db.$disconnect();
      }
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    async function fixture() {
      const custodian = await db.account.create({
        data: { encryptionMode: 'plain', publicKey: null },
      });
      const member = await db.account.create({
        data: { encryptionMode: 'plain', publicKey: null },
      });
      accountIds.push(custodian.id, member.id);
      const team = await db.team.create({
        data: { name: 'Withdrawal admission' },
      });
      teamIds.push(team.id);
      await db.teamMembership.create({
        data: { teamId: team.id, accountId: custodian.id, role: 'owner' },
      });
      const membership = await db.teamMembership.create({
        data: { teamId: team.id, accountId: member.id, role: 'member' },
      });
      const credential = await db.teamCredentialResource.create({
        data: {
          teamId: team.id,
          custodianAccountId: custodian.id,
          displayName: 'Shared Gateway',
          sessionUsePolicy: 'personal_allowed',
          disclosureCeiling: JSON.stringify({
            policy: { preferredAllowedModes: ['brokered'] },
            experimentalBindingConfirmations: [],
          }),
          sourceBindingJson: JSON.stringify({
            v: 1,
            kind: 'provider_connection',
            connectionId: 'pc_withdrawal',
            connectionSecurityFingerprint: 'connection-security:v1:withdrawal',
            credentialSlotId: 'apiKey',
          }),
          memberGrants: {
            create: {
              teamMembershipId: membership.id,
              deliveryMode: 'brokered',
            },
          },
        },
      });
      return { custodian, member, credential };
    }

    /** Hold `lock` in an open transaction until the returned release is called. */
    async function holdOpen(lock: (tx: Tx) => Promise<unknown>) {
        let release!: () => void;
        let ready!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { ready = resolve; });
        const holder = inTx(async tx => {
            await lock(tx);
            ready();
            await held;
        }, { isolationLevel: "ReadCommitted" });
        await Promise.race([started, holder.then(() => { throw new Error("Holder missed rendezvous"); })]);
        return { release: async () => { release(); await holder; } };
    }

    function withdraw(f: Awaited<ReturnType<typeof fixture>>) {
      let pid: number | undefined;
      const result = inTx(
        async (tx) => {
          const [row] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          pid = row.pid;
          return deleteTeamCredentialResourceInTx(tx, {
            actorAccountId: f.custodian.id,
            resourceId: f.credential.id,
            expectedRevision: f.credential.revision,
            authentication: TEST_TEAM_AUTHENTICATION,
          });
        },
        { isolationLevel: 'ReadCommitted', deadlineAtMs: Date.now() + 5_000 },
      );
      return { result, pid: () => pid };
    }

    it('completes while an ordinary writer holds KEY SHARE on a member Account', async () => {
      const f = await fixture();
      const holder = await holdOpen((tx) =>
        tx.$queryRawUnsafe(
          `SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE`,
          f.member.id,
        ),
      );
      try {
        expect(await withdraw(f).result).toEqual({ ok: true });
      } finally {
        await holder.release();
      }
      expect(
        await db.teamCredentialResource.findUnique({
          where: { id: f.credential.id },
        }),
      ).toBeNull();
    });

    it("still waits for a credential consumer's serializing custodian admission", async () => {
      const f = await fixture();
      const holder = await holdOpen(async (tx) => {
        await acquireAccountChangePublicationLocksInTx(
          tx,
          [f.custodian.id],
          { includeSingleAccount: true, intent: 'serializing' },
        );
      });
      let finished = false;
      let blocked = false;
      const attempt = withdraw(f);
      const outcome = attempt.result.finally(() => {
        finished = true;
      });
      try {
        while (!finished && !blocked) {
          const pid = attempt.pid();
          if (pid === undefined) {
            await new Promise((resolve) => setImmediate(resolve));
            continue;
          }
          const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                `;
          blocked = row.blocked;
        }
        expect(finished).toBe(false);
        expect(blocked).toBe(true);
      } finally {
        await holder.release();
      }
      expect(await outcome).toEqual({ ok: true });
    });
  },
);
