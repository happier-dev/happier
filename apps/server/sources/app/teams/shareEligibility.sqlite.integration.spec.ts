import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createDiscussion } from '@/app/discussions/mutations';
import { setDiscussionGrant } from '@/app/discussions/accessService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';

type ShareKind = 'artifact' | 'machine' | 'discussion' | 'projectSource';

/**
 * Owner ruling Q10 (2026-10-30): every resource admits a NEW share only for a
 * friend, a teammate, or a Team (or its Group) the sharer belongs to. Each case
 * goes through the resource's real grant writer.
 */
describe('share eligibility across resource writers (real SQLite)', () => {
  let harness: LightSqliteHarness;
  const authentication = createPresentUserSessionAccessAuthentication();
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-share-eligibility-',
      initEncrypt: true,
      initAuth: true,
      env: {
        HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST:
          'server_sealed',
      },
    });
  }, 180_000);
  afterAll(async () => {
    if (harness) await harness.close();
  });

  const account = () =>
    db.account.create({
      data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' },
    });

  /** One shareable resource owned by `ownerId`; `share` grants it to a principal through the real writer. */
  async function resource(
    kind: ShareKind,
    ownerId: string,
  ): Promise<(principal: PrincipalRefV1) => Promise<boolean>> {
    if (kind === 'artifact') {
      const artifact = await db.artifact.create({
        data: {
          id: crypto.randomUUID(),
          accountId: ownerId,
          header: privacyKit.decodeBase64(
            encodePlainArtifactStoredContent({
              kind: 'workflow-definition.v1',
            }),
          ),
          body: privacyKit.decodeBase64(
            encodePlainArtifactStoredContent({ value: 'body' }),
          ),
          dataEncryptionKey: privacyKit.decodeBase64(
            ARTIFACT_PLAIN_DATA_KEY_MARKER,
          ),
          headerVersion: 1,
          bodyVersion: 1,
        },
      });
      return async (principal) =>
        (
          await inTx((tx) =>
            setArtifactAccessGrantInTx(tx, {
              actorAccountId: ownerId,
              artifactId: artifact.id,
              principal,
              accessLevel: 'view',
            }),
          )
        ).ok;
    }
    if (kind === 'machine') {
      const machine = await db.machine.create({
        data: {
          id: crypto.randomUUID(),
          accountId: ownerId,
          metadata: encodePlainMachineStoredContent({
            host: 'host',
            platform: 'linux',
            happyCliVersion: 'test',
            homeDir: '/home/test',
            happyHomeDir: '/home/test/.happier',
          }),
          daemonState: encodePlainMachineStoredContent({ status: 'running' }),
          installationId: 'install',
          active: false,
          dataEncryptionKey: new Uint8Array(
            Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
          ),
        },
      });
      return async (principal) =>
        (
          await inTx((tx) =>
            setMachineAccessGrantInTx(tx, {
              actorAccountId: ownerId,
              machineId: machine.id,
              principal,
              level: 'view',
            }),
          )
        ).kind === 'saved';
    }
    if (kind === 'discussion') {
      const created = await createDiscussion({
        actorAccountId: ownerId,
        authentication,
        request: {
          creationLocalId: crypto.randomUUID(),
          titleContent: { t: 'plain', v: { v: 1, title: 'Shared discussion' } },
          firstMessage: {
            localId: crypto.randomUUID(),
            content: {
              t: 'plain',
              v: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
            },
            mentionedAccountIds: [],
          },
        },
      });
      if (!created.ok)
        throw new Error(`discussion fixture failed: ${created.error}`);
      const discussionId = created.value.discussion.id;
      return async (principal) =>
        (
          await setDiscussionGrant({
            actorAccountId: ownerId,
            discussionId,
            authentication,
            request: { principal, accessLevel: 'view' },
          })
        ).ok;
    }
    return async (principal) =>
      (
        await inTx((tx) =>
          createProjectSourceInTx(tx, ownerId, {
            serverId: 'home',
            requestKey: crypto.randomUUID(),
            name: 'Shared Source',
            audience: [{ principal, level: 'view' }],
          }),
        )
      ).ok;
  }

  it.each(['artifact', 'machine', 'discussion', 'projectSource'] as const)(
    '%s: admits friends, teammates and own Teams; refuses strangers and foreign Teams',
    async (kind) => {
      const [owner, friend, teammate, stranger, foreigner] = await Promise.all(
        Array.from({ length: 5 }, account),
      );
      await db.userRelationship.create({
        data: { fromUserId: friend.id, toUserId: owner.id, status: 'friend' },
      });
      const ownTeam = await db.team.create({ data: { name: 'Own Team' } });
      const foreignTeam = await db.team.create({
        data: { name: 'Foreign Team' },
      });
      await db.teamMembership.createMany({
        data: [
          { teamId: ownTeam.id, accountId: owner.id, role: 'owner' },
          { teamId: ownTeam.id, accountId: teammate.id, role: 'member' },
          { teamId: foreignTeam.id, accountId: foreigner.id, role: 'owner' },
        ],
      });
      const ownGroup = await db.teamGroup.create({
        data: { teamId: ownTeam.id, name: storedPlainPrivateLabel('Own Group') },
      });
      const foreignGroup = await db.teamGroup.create({
        data: {
          teamId: foreignTeam.id,
          name: storedPlainPrivateLabel('Foreign Group'),
        },
      });
      const share = await resource(kind, owner.id);

      expect(await share({ kind: 'account', accountId: stranger.id })).toBe(
        false,
      );
      expect(await share({ kind: 'team', teamId: foreignTeam.id })).toBe(false);
      expect(
        await share({
          kind: 'group',
          teamId: foreignTeam.id,
          groupId: foreignGroup.id,
        }),
      ).toBe(false);
      expect(await share({ kind: 'account', accountId: friend.id })).toBe(true);
      expect(await share({ kind: 'account', accountId: teammate.id })).toBe(
        true,
      );
      expect(await share({ kind: 'team', teamId: ownTeam.id })).toBe(true);
      expect(
        await share({
          kind: 'group',
          teamId: ownTeam.id,
          groupId: ownGroup.id,
        }),
      ).toBe(true);
    },
  );

  it.each(['artifact', 'machine', 'discussion'] as const)(
    '%s: an existing share stays editable after the friendship ends',
    async (kind) => {
      const [owner, friend] = await Promise.all([account(), account()]);
      await db.userRelationship.create({
        data: { fromUserId: owner.id, toUserId: friend.id, status: 'friend' },
      });
      const share = await resource(kind, owner.id);
      expect(await share({ kind: 'account', accountId: friend.id })).toBe(true);
      await db.userRelationship.deleteMany({
        where: { fromUserId: owner.id, toUserId: friend.id },
      });
      expect(await share({ kind: 'account', accountId: friend.id })).toBe(true);
    },
  );
});
