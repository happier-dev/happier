import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol';
import { SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { buildSessionApprovalConsentsHeaderV1 } from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';

/**
 * "Allow for this Session" rows are written by a person (their app or their own CLI) onto a
 * Session their Account owns. One predicate inside the Artifact write owner decides it for
 * create, re-kind, re-bind and content writes (design F-3, F-7).
 */
describe('Session consent record writers (real SQLite, real Artifact routes)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'session-consents-',
      initAuth: true,
      initEncrypt: true,
      env: {
        HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST:
          'server_sealed',
      },
    });
  }, 180_000);
  afterAll(async () => {
    if (harness) await harness.close();
  });

  const body = (sessionId: string, mode = 'allowed') =>
    encodePlainArtifactStoredContent({
      body: JSON.stringify({
        v: 1,
        kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
        sessionId,
        rows: [{ actionId: 'deployments.deploy', audience: 'agent', mode }],
      }),
    });
  const headers = (
    accountId: string,
    kind: 'account' | 'terminal' | 'api_token' | 'account_directory',
  ) => ({
    'x-test-user-id': accountId,
    'x-test-auth-token-kind': kind,
    ...(kind === 'api_token'
      ? {
          'x-test-api-token-account-id': accountId,
          'x-test-api-token-principal-id': 'principal',
          'x-test-api-token-credential-id': 'credential',
        }
      : {}),
    'x-happier-account-stored-content-protocol': String(
      CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    ),
  });

  it("admits the person's app and CLI on their own Session and refuses every other writer or binding", async () => {
    const alice = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const bob = await db.account.create({ data: { encryptionMode: 'plain' } });
    const own = await db.session.create({
      data: { accountId: alice.id, tag: randomUUID(), metadata: '{}' },
    });
    const foreign = await db.session.create({
      data: { accountId: bob.id, tag: randomUUID(), metadata: '{}' },
    });
    await withAuthenticatedTestApp(
      (app) => {
        artifactsRoutes(app);
      },
      async (app) => {
        const create = async (
          kind: Parameters<typeof headers>[1],
          sessionId: string,
        ) => {
          const id = randomUUID();
          const response = await app.inject({
            method: 'POST',
            url: '/v1/artifacts',
            headers: headers(alice.id, kind),
            payload: {
              id,
              header: encodePlainArtifactStoredContent(
                buildSessionApprovalConsentsHeaderV1(sessionId),
              ),
              body: body(sessionId),
              dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            },
          });
          return { id, response };
        };
        // Owner positives: the person's devices and their own CLI.
        const created = await create('account', own.id);
        expect(created.response.statusCode, created.response.body).toBe(200);
        expect(
          await db.artifact.findUnique({
            where: { id: created.id },
            select: { approvalSessionId: true, kind: true },
          }),
        ).toEqual({
          approvalSessionId: own.id,
          kind: `v1:other:${SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1}`,
        });
        const update = await app.inject({
          method: 'POST',
          url: `/v1/artifacts/${created.id}`,
          headers: headers(alice.id, 'terminal'),
          payload: {
            header: encodePlainArtifactStoredContent(
              buildSessionApprovalConsentsHeaderV1(own.id),
            ),
            expectedHeaderVersion: 1,
            body: body(own.id, 'ask_first'),
            expectedBodyVersion: 1,
          },
        });
        expect(update.statusCode, update.body).toBe(200);

        // Scoped credentials are never a person.
        for (const kind of ['api_token', 'account_directory'] as const) {
          const refused = await create(kind, own.id);
          expect(
            refused.response.statusCode,
            `${kind} ${refused.response.body}`,
          ).toBe(403);
          expect(
            await db.artifact.findUnique({ where: { id: refused.id } }),
            kind,
          ).toBeNull();
        }
        // A Session another Account owns.
        const foreignBind = await create('account', foreign.id);
        expect(foreignBind.response.statusCode, foreignBind.response.body).toBe(
          403,
        );
        expect(foreignBind.response.json()).toEqual({
          error: 'artifact_access_forbidden',
        });
        expect(
          await db.artifact.findUnique({ where: { id: foreignBind.id } }),
        ).toBeNull();

        // Re-binding the record to another Account's Session.
        const rebind = await app.inject({
          method: 'POST',
          url: `/v1/artifacts/${created.id}`,
          headers: headers(alice.id, 'account'),
          payload: {
            header: encodePlainArtifactStoredContent(
              buildSessionApprovalConsentsHeaderV1(foreign.id),
            ),
            expectedHeaderVersion: 2,
            body: body(foreign.id),
            expectedBodyVersion: 2,
          },
        });
        expect(rebind.statusCode, rebind.body).toBe(403);
        // A content write from a scoped credential.
        const scopedWrite = await app.inject({
          method: 'POST',
          url: `/v1/artifacts/${created.id}`,
          headers: headers(alice.id, 'api_token'),
          payload: {
            header: encodePlainArtifactStoredContent(
              buildSessionApprovalConsentsHeaderV1(own.id),
            ),
            expectedHeaderVersion: 2,
            body: body(own.id),
            expectedBodyVersion: 2,
          },
        });
        expect(scopedWrite.statusCode, scopedWrite.body).toBe(403);
        expect(
          await db.artifact.findUnique({
            where: { id: created.id },
            select: { approvalSessionId: true, bodyVersion: true },
          }),
        ).toEqual({ approvalSessionId: own.id, bodyVersion: 2 });

        // Re-kinding an ordinary Artifact into the consent kind, bound to another Account's Session.
        const ordinaryId = randomUUID();
        const ordinary = await app.inject({
          method: 'POST',
          url: '/v1/artifacts',
          headers: headers(alice.id, 'account'),
          payload: {
            id: ordinaryId,
            header: encodePlainArtifactStoredContent({
              kind: 'note.v1',
              title: 'Note',
            }),
            body: encodePlainArtifactStoredContent({ body: 'text' }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          },
        });
        expect(ordinary.statusCode, ordinary.body).toBe(200);
        const rekind = await app.inject({
          method: 'POST',
          url: `/v1/artifacts/${ordinaryId}`,
          headers: headers(alice.id, 'account'),
          payload: {
            header: encodePlainArtifactStoredContent(
              buildSessionApprovalConsentsHeaderV1(foreign.id),
            ),
            expectedHeaderVersion: 1,
            body: body(foreign.id),
            expectedBodyVersion: 1,
          },
        });
        expect(rekind.statusCode, rekind.body).toBe(403);
        expect(
          await db.artifact.findUnique({
            where: { id: ordinaryId },
            select: { approvalSessionId: true },
          }),
        ).toEqual({ approvalSessionId: null });

        // The private kind has no people sharing.
        const share = await app.inject({
          method: 'PUT',
          url: `/v1/artifacts/${created.id}/access/grants`,
          headers: headers(alice.id, 'account'),
          payload: { artifactId: created.id, principal: { kind: 'account', accountId: bob.id }, accessLevel: 'view' },
        });
        expect(share.statusCode, share.body).not.toBe(200);
        expect(
          await db.artifactGrant.count({ where: { artifactId: created.id } }),
        ).toBe(0);
      },
    );

    // Deleting the Session ends its record.
    await expect(
      deleteOwnedSession({
        sessionId: own.id,
        ownerAccountId: alice.id,
        reason: 'user_request',
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      await db.artifact.count({ where: { approvalSessionId: own.id } }),
    ).toBe(0);
  });
});
