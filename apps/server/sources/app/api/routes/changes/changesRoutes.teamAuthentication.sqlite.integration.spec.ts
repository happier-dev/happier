import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { changesRoutes } from './changesRoutes';

// A Team's restricted authentication policy decides access per Session. A
// credential that does not satisfy it loses those Sessions only; the rest of the
// Account change feed stays readable, as the Session list already does. An
// unavailable accepted method is indeterminate access and is never acknowledged.
describe('Account changes under a Team authentication policy (SQLite)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '1');
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-changes-team-auth-',
      initAuth: false,
      env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' },
    });
  }, 180_000);
  afterAll(async () => {
    if (harness) await harness.close();
    vi.unstubAllEnvs();
  });

  it('keeps the feed readable and withholds only the Team Session from an unqualified credential', async () => {
    const owner = await db.account.create({
      data: {
        encryptionMode: 'plain',
        publicKey: `owner-${crypto.randomUUID()}`,
      },
    });
    // A key-challenge credential qualifies against the Account's signed key binding.
    const memberBinding = createSignedAccountContentBinding();
    const member = await db.account.create({
      data: {
        encryptionMode: 'e2ee',
        publicKey: memberBinding.publicKey,
        contentPublicKey: Buffer.from(memberBinding.contentPublicKey),
        contentPublicKeySig: Buffer.from(memberBinding.contentPublicKeySig),
      },
    });
    const team = await db.team.create({
      data: {
        name: 'Engineering',
        authenticationPolicy: {
          v: 1,
          mode: 'restricted',
          accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        },
      },
    });
    await db.teamMembership.createMany({
      data: [
        { teamId: team.id, accountId: owner.id, role: 'owner' },
        { teamId: team.id, accountId: member.id, role: 'member' },
      ],
    });
    const teamSession = await db.session.create({
      data: {
        accountId: owner.id,
        tag: 'team-session',
        encryptionMode: 'plain',
        metadata: '{}',
      },
    });
    await db.sessionTeamGrant.create({
      data: {
        sessionId: teamSession.id,
        teamId: team.id,
        accessLevel: 'view',
        effectiveAt: new Date(0),
      },
    });
    const ownSession = await db.session.create({
      data: {
        accountId: member.id,
        tag: 'own-session',
        encryptionMode: 'plain',
        metadata: '{}',
      },
    });
    await inTx((tx) =>
      markAccountChanged(tx, {
        accountId: member.id,
        kind: 'session',
        entityId: teamSession.id,
      }),
    );
    await inTx((tx) =>
      markAccountChanged(tx, {
        accountId: member.id,
        kind: 'session',
        entityId: ownSession.id,
      }),
    );
    const headers = {
      'x-test-user-id': member.id,
      'x-happier-account-stored-content-protocol': String(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION,
      ),
    };

    await withAuthenticatedTestApp(changesRoutes, async (app) => {
      const unqualified = await app.inject({
        method: 'GET',
        url: '/v2/changes?after=0&limit=200',
        headers,
      });
      expect(unqualified.statusCode, unqualified.body).toBe(200);
      const page = unqualified.json();
      expect(
        page.changes.map((change: { entityId: string }) => change.entityId),
      ).toEqual(expect.arrayContaining([teamSession.id, ownSession.id]));
      expect(page.sessionAccessWitness.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: teamSession.id,
            status: 'unavailable',
          }),
          expect.objectContaining({
            sessionId: ownSession.id,
            status: 'available',
          }),
        ]),
      );

      // The same Account with a qualifying credential sees the Team Session.
      const qualified = await app.inject({
        method: 'GET',
        url: '/v2/changes?after=0&limit=200',
        headers: {
          ...headers,
          'x-test-authentication-evidence': JSON.stringify([
            { kind: 'home_method', methodId: 'key_challenge' },
          ]),
        },
      });
      expect(qualified.statusCode, qualified.body).toBe(200);
      expect(qualified.json().sessionAccessWitness.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: teamSession.id,
            status: 'available',
          }),
        ]),
      );

      // The Team's accepted method becoming unavailable at the Home is a
      // transient, indeterminate access fact, not a refusal of this
      // credential: the page is not acknowledged (retryable, no nextCursor and
      // no `unavailable` witness), so the client neither purges the Team
      // Session nor advances its cursor past the change.
      vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '0');
      try {
        const methodUnavailable = await app.inject({
          method: 'GET',
          url: '/v2/changes?after=0&limit=200',
          headers,
        });
        expect(methodUnavailable.statusCode, methodUnavailable.body).toBe(503);
        expect(methodUnavailable.json()).toEqual({ error: 'session_access_authentication_unavailable' });
      } finally {
        vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '1');
      }
    });
  });

  it('reads the Session access witness for a catch-up page with one Session read, not one per Session', async () => {
    const viewer = await db.account.create({
      data: { encryptionMode: 'plain', publicKey: `catch-up-${crypto.randomUUID()}` },
    });
    const sessionIds: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const session = await db.session.create({
        data: { accountId: viewer.id, tag: `catch-up-${index}`, encryptionMode: 'plain', metadata: '{}' },
      });
      sessionIds.push(session.id);
      await inTx((tx) => markAccountChanged(tx, { accountId: viewer.id, kind: 'session', entityId: session.id }));
    }
    const sessionReads: string[] = [];
    await withAuthenticatedTestApp(changesRoutes, async (app) => {
      const stop = observeSqliteRequests({
        before: (request) => {
          if (request.model === 'Session') sessionReads.push(request.action);
        },
      });
      let response;
      try {
        response = await app.inject({
          method: 'GET',
          url: '/v2/changes?after=0&limit=200',
          headers: {
            'x-test-user-id': viewer.id,
            'x-happier-account-stored-content-protocol': String(
              CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION,
            ),
          },
        });
      } finally {
        stop();
      }
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json();
      expect(page.sessionAccessWitness.entries.map((entry: { sessionId: string; status: string }) =>
        [entry.sessionId, entry.status])).toEqual(sessionIds.map((id) => [id, 'available']));
    });
    // One batched access projection for the whole page; the per-Session
    // resolver issued one Session read for each of the 30 changed Sessions.
    expect(sessionReads).toHaveLength(1);
  });
});
