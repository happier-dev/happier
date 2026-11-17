import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  encodePlainArtifactStoredContent,
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListPageV1';
import { prepareOwnedArtifactRecipientKeysV1 } from '@happier-dev/protocol/artifacts/artifactRecipientKeyPreparationV1';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';

// The owner's Team-change wake repair drives the real Artifact list, census and key-envelope routes;
// only HTTP transport is an adapter, and the owner's key opening stands in for the app's Account cipher.
describe('Artifact keys for later Team and Group members (real SQLite)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-artifact-later-member-',
      initEncrypt: true,
      initAuth: true,
      env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' },
    });
  }, 180_000);
  afterAll(async () => {
    if (harness) await harness.close();
  });

  const protocolHeaders = {
    'x-happier-account-stored-content-protocol': String(
      CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    ),
  };
  async function e2eeAccount() {
    const content = tweetnacl.box.keyPair();
    const account = await db.account.create({
      data: {
        ...createSignedAccountContentBinding(content.publicKey),
        encryptionMode: 'e2ee',
      },
    });
    return {
      id: account.id,
      secretKey: content.secretKey,
      publicKey: content.publicKey,
    };
  }
  async function e2eeArtifact(
    owner: Readonly<{ id: string; publicKey: Uint8Array }>,
  ) {
    const dataKey = tweetnacl.randomBytes(32);
    const artifact = await db.artifact.create({
      data: {
        id: crypto.randomUUID(),
        accountId: owner.id,
        header: new TextEncoder().encode('opaque header'),
        body: new TextEncoder().encode('opaque body'),
        dataEncryptionKey: new Uint8Array(
          sealEncryptedDataKeyEnvelopeV1({
            dataKey,
            recipientPublicKey: owner.publicKey,
            randomBytes: tweetnacl.randomBytes,
          }),
        ),
        headerVersion: 1,
        bodyVersion: 1,
      },
    });
    return { id: artifact.id, dataKey };
  }

  it('seals an existing shared Artifact key for a later Team or Group member, never for an outsider or a removed member', async () => {
    const owner = await e2eeAccount();
    const early = await e2eeAccount();
    const removed = await e2eeAccount();
    const later = await e2eeAccount();
    const groupLater = await e2eeAccount();
    const outsider = await e2eeAccount();
    const team = await db.team.create({ data: { name: 'Artifact audience' } });
    const groupTeam = await db.team.create({
      data: { name: 'Artifact group audience' },
    });
    await db.teamMembership.createMany({
      data: [
        { teamId: team.id, accountId: owner.id, role: 'owner' },
        { teamId: team.id, accountId: early.id, role: 'member' },
        { teamId: team.id, accountId: removed.id, role: 'member' },
        { teamId: groupTeam.id, accountId: owner.id, role: 'owner' },
      ],
    });
    const groupLaterMembership = await db.teamMembership.create({
      data: { teamId: groupTeam.id, accountId: groupLater.id, role: 'member' },
    });
    const group = await db.teamGroup.create({
      data: {
        teamId: groupTeam.id,
        name: storedPlainPrivateLabel('Reviewers'),
      },
    });
    const teamShared = await e2eeArtifact(owner);
    const groupShared = await e2eeArtifact(owner);
    const unshared = await e2eeArtifact(owner);
    await db.artifactGrant.create({
      data: {
        principalKind: 'team',
        artifactId: teamShared.id,
        teamId: team.id,
        accessLevel: 'view',
        createdByAccountId: owner.id,
      },
    });
    await db.artifactGrant.create({
      data: {
        principalKind: 'group',
        artifactId: groupShared.id,
        teamGroupId: group.id,
        accessLevel: 'view',
        createdByAccountId: owner.id,
      },
    });

    await withAuthenticatedTestApp(artifactsRoutes, async (app) => {
      const request = async (
        accountId: string,
        method: 'GET' | 'POST',
        url: string,
        payload?: object,
      ) => {
        const response = await app.inject({
          method,
          url,
          headers: { 'x-test-user-id': accountId, ...protocolHeaders },
          ...(payload ? { payload } : {}),
        });
        if (response.statusCode !== 200)
          throw Object.assign(new Error(response.body), {
            status: response.statusCode,
          });
        return response.json();
      };
      const pageReads: string[] = [];
      const censusReads: string[] = [];
      const wake = () =>
        prepareOwnedArtifactRecipientKeysV1({
          ownerAccountId: owner.id,
          randomBytes: tweetnacl.randomBytes,
          readOwnedPage: async (cursor) => {
            pageReads.push(cursor ?? 'first');
            const items = await request(
              owner.id,
              'GET',
              `/v1/artifacts?limit=${ARTIFACT_LIST_PAGE_MAX_ITEMS_V1}&ownerAccountId=${owner.id}`,
            );
            return { items, nextCursor: null };
          },
          openKeys: async (row) => {
            const dataKey = openEncryptedDataKeyEnvelopeV1({
              envelope: privacyKit.decodeBase64(row.dataEncryptionKey!),
              recipientSecretKeyOrSeed: owner.secretKey,
            });
            return dataKey ? { dataKey, provenanceDataKey: null } : null;
          },
          readCensus: (artifactId) => {
            censusReads.push(artifactId);
            return request(
              owner.id,
              'GET',
              `/v1/artifacts/${artifactId}/access/recipients`,
            );
          },
          commit: (input) =>
            request(
              owner.id,
              'POST',
              `/v1/artifacts/${input.artifactId}/access/key-envelopes`,
              input,
            ),
        });
      const opens = async (
        account: Readonly<{ id: string; secretKey: Uint8Array }>,
        artifact: Readonly<{ id: string; dataKey: Uint8Array }>,
      ) => {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/artifacts/${artifact.id}`,
          headers: { 'x-test-user-id': account.id, ...protocolHeaders },
        });
        if (response.statusCode !== 200) return response.statusCode;
        const opened = openEncryptedDataKeyEnvelopeV1({
          envelope: privacyKit.decodeBase64(response.json().dataEncryptionKey),
          recipientSecretKeyOrSeed: account.secretKey,
        });
        return opened !== null &&
          Buffer.from(opened).equals(Buffer.from(artifact.dataKey))
          ? 'opened'
          : 'unopenable';
      };

      // Share time: the members of that moment are prepared.
      await wake();
      expect(await opens(early, teamShared)).toBe('opened');

      // The audience changes: one member leaves, one joins the Team, one joins the Group.
      await db.teamMembership.delete({
        where: { teamId_accountId: { teamId: team.id, accountId: removed.id } },
      });
      await db.teamMembership.create({
        data: { teamId: team.id, accountId: later.id, role: 'member' },
      });
      await db.teamGroupMembership.create({
        data: {
          teamId: groupTeam.id,
          teamGroupId: group.id,
          teamMembershipId: groupLaterMembership.id,
          nativeContribution: true,
        },
      });
      expect(await opens(later, teamShared)).toBe(409);
      expect(await opens(groupLater, groupShared)).toBe(409);

      pageReads.length = 0;
      censusReads.length = 0;
      // The Team-change wake: one owned inventory, then each owned E2EE Artifact's census.
      await wake();
      expect(pageReads).toEqual(['first']);
      expect(censusReads.sort()).toEqual(
        [teamShared.id, groupShared.id, unshared.id].sort(),
      );

      expect(await opens(later, teamShared)).toBe('opened');
      expect(await opens(groupLater, groupShared)).toBe('opened');
      expect(await opens(outsider, teamShared)).toBe(404);
      expect(await opens(removed, teamShared)).toBe(404);
      const recipients = async (artifactId: string) =>
        (
          await db.artifactKeyEnvelope.findMany({
            where: { artifactId },
            select: { recipientAccountId: true },
          })
        )
          .map((row) => row.recipientAccountId)
          .sort();
      // The removed member's earlier wrap is kept (no retraction); the outsider never gets one.
      expect(await recipients(teamShared.id)).toEqual(
        [early.id, later.id, removed.id].sort(),
      );
      expect(await recipients(groupShared.id)).toEqual([groupLater.id]);
      expect(await recipients(unshared.id)).toEqual([]);

      // Nothing owed: a second wake commits nothing.
      const before = await db.artifactKeyEnvelope.findMany({
        orderBy: { recipientAccountId: 'asc' },
      });
      await wake();
      expect(
        await db.artifactKeyEnvelope.findMany({
          orderBy: { recipientAccountId: 'asc' },
        }),
      ).toEqual(before);
    });
  });

  it("asks nothing of a Plain owner's Artifacts", async () => {
    const owner = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const member = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const team = await db.team.create({ data: { name: 'Plain audience' } });
    await db.teamMembership.createMany({
      data: [
        { teamId: team.id, accountId: owner.id, role: 'owner' },
        { teamId: team.id, accountId: member.id, role: 'member' },
      ],
    });
    const artifact = await db.artifact.create({
      data: {
        id: crypto.randomUUID(),
        accountId: owner.id,
        header: privacyKit.decodeBase64(
          encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }),
        ),
        body: privacyKit.decodeBase64(
          encodePlainArtifactStoredContent({ value: 'plain' }),
        ),
        dataEncryptionKey: privacyKit.decodeBase64(
          ARTIFACT_PLAIN_DATA_KEY_MARKER,
        ),
        headerVersion: 1,
        bodyVersion: 1,
      },
    });
    await db.artifactGrant.create({
      data: {
        principalKind: 'team',
        artifactId: artifact.id,
        teamId: team.id,
        accessLevel: 'view',
        createdByAccountId: owner.id,
      },
    });
    await withAuthenticatedTestApp(artifactsRoutes, async (app) => {
      const asked: string[] = [];
      await prepareOwnedArtifactRecipientKeysV1({
        ownerAccountId: owner.id,
        randomBytes: tweetnacl.randomBytes,
        readOwnedPage: async () => {
          const response = await app.inject({
            method: 'GET',
            url: `/v1/artifacts?ownerAccountId=${owner.id}`,
            headers: { 'x-test-user-id': owner.id, ...protocolHeaders },
          });
          expect(response.statusCode).toBe(200);
          return { items: response.json(), nextCursor: null };
        },
        openKeys: async () => {
          asked.push('open');
          return null;
        },
        readCensus: async (artifactId) => {
          asked.push(artifactId);
          throw new Error('unexpected census');
        },
        commit: async () => {
          throw new Error('unexpected commit');
        },
      });
      expect(asked).toEqual([]);
      const read = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${artifact.id}`,
        headers: { 'x-test-user-id': member.id, ...protocolHeaders },
      });
      expect(read.statusCode).toBe(200);
    });
    expect(
      await db.artifactKeyEnvelope.count({
        where: { artifactId: artifact.id },
      }),
    ).toBe(0);
  });
});
