import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  db,
  getDbProviderFromEnv,
  initDbPostgres,
  shutdownDbClient,
} from '@/storage/db';
import {
  createDbMaintenanceClient,
  type PrismaClientType,
} from '@/storage/prisma';

import { setTeamIdentityConnectionEnabledForActor } from './teamIdentityConnectionAdministration';

/**
 * Disabling a Home identity connection decides its withdrawal blocker only
 * after it holds the Home provider admission fence. A concurrent fenced writer
 * that adds a dependent (here a Team policy accepting the method) commits first,
 * and the ReadCommitted blocker read must observe it rather than a pre-wait view.
 */
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')(
  'Home identity connection disable admission (PostgreSQL)',
  () => {
    let peer: PrismaClientType | undefined;

    beforeAll(async () => {
      if (
        !process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL ||
        process.env.DATABASE_URL !==
          process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
      ) {
        throw new Error(
          'Run with the disposable PostgreSQL DB-contract harness',
        );
      }
      initDbPostgres();
      await db.$connect();
      peer = await createDbMaintenanceClient('postgres');
      await peer.$connect();
    });

    afterAll(async () => {
      await peer?.$disconnect();
      await shutdownDbClient();
    });

    async function enabledHomeConnection() {
      const owner = await db.account.create({
        data: {
          publicKey: `home-disable-${randomUUID()}`,
          homeRole: 'owner',
          status: 'active',
        },
      });
      const provider = await db.identityProviderInstance.create({
        data: {
          ownerTeamId: null,
          kind: 'oidc',
          displayName: 'Home OIDC',
          enabled: true,
          config: {
            v: 1,
            kind: 'oidc',
            issuer: 'https://identity.example.test',
            clientId: 'happier',
            clientAuthenticationMethod: 'client_secret_post',
            scopes: 'openid profile email',
            httpTimeoutSeconds: 30,
            claims: {
              login: 'preferred_username',
              email: 'email',
              groups: 'groups',
            },
            allow: {
              usersAllowlist: [],
              emailDomains: [],
              groupsAny: [],
              groupsAll: [],
            },
            fetchUserInfo: true,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: 'oidc' },
          },
        },
      });
      const connection = await db.teamIdentityConnection.create({
        data: {
          teamId: null,
          providerInstanceId: provider.id,
          enabled: true,
          externalReference: { v: 1, kind: 'oidc' },
          settings: {
            v: 1,
            kind: 'oidc',
            allowedUsers: [],
            allowedEmailDomains: [],
            groupsAny: [],
            groupsAll: [],
          },
        },
      });
      return { owner, provider, connection };
    }

    it('refuses the disable when a fenced writer commits a dependent while the disable waits on the fence', async () => {
      const { owner, provider, connection } = await enabledHomeConnection();
      let releasePeer!: () => void;
      const peerMayCommit = new Promise<void>((resolve) => {
        releasePeer = resolve;
      });
      let peerHoldsFence!: () => void;
      const peerFenced = new Promise<void>((resolve) => {
        peerHoldsFence = resolve;
      });

      // The peer stands in for any Home identity writer: it holds the shared
      // exclusive Home administrator fence, adds a dependent, and commits later.
      const peerCommit = peer!.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${owner.id} FOR UPDATE`;
          await tx.team.create({
            data: {
              name: `Accepts Home method ${randomUUID()}`,
              authenticationPolicy: {
                v: 1,
                mode: 'restricted',
                accepted: [{ kind: 'home_method', methodId: provider.id }],
              },
            },
          });
          peerHoldsFence();
          await peerMayCommit;
        },
        { timeout: 60_000 },
      );
      await peerFenced;

      const disable = setTeamIdentityConnectionEnabledForActor({
        actorAccountId: owner.id,
        teamId: null,
        connectionId: connection.id,
        expectedRevision: connection.revision,
        enabled: false,
        env: process.env,
      });
      // The disable must be blocked inside its transaction, behind the fence,
      // while the dependent is still uncommitted.
      await expect
        .poll(
          async () =>
            (
              await peer!.$queryRaw<Array<{ waiting: bigint }>>`
            SELECT count(*) AS "waiting" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
        `
            )[0]?.waiting,
          { timeout: 30_000, interval: 20 },
        )
        .toBeGreaterThan(0n);
      releasePeer();
      await peerCommit;

      await expect(disable).resolves.toEqual({
        ok: false,
        error: 'identity_connection_policy_in_use',
      });
      expect(
        (
          await db.teamIdentityConnection.findUniqueOrThrow({
            where: { id: connection.id },
          })
        ).enabled,
      ).toBe(true);
    });
  },
);
