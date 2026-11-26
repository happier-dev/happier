import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { buildConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import {
  deleteQualifiedConnectedServiceCredential,
  mutateQualifiedConnectedServiceCredential,
  mutateQualifiedConnectedServiceCredentialHealth,
  readQualifiedConnectedServiceCredentialMutationBasisInTx,
} from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';

import { createTeamDirectActionMaterialFixture } from './credentials/directActionMaterial.testkit';
import { TEAM_CHANGE_ENTITY_ID } from './teamChanges';

type FeedRow = Readonly<{
  accountId: string;
  kind: string;
  entityId: string;
  cursor: number;
}>;

/**
 * A daemon's live Account-change pass invalidates managed Machine policy and
 * re-reads Machines only for an `account:teams` row or a Machine-kind row
 * (`apps/cli/src/api/apiMachine.ts` `hasTeamChange` / `isMachineProjectionChangeKindV1`).
 * The feed rows a write produces are therefore the server-side contract for
 * "0 `/v1/machines/*` and 0 managed-policy requests".
 */
async function readFeed(): Promise<readonly FeedRow[]> {
  return await db.accountChange.findMany({
    select: { accountId: true, kind: true, entityId: true, cursor: true },
  });
}

function changedRows(
  before: readonly FeedRow[],
  after: readonly FeedRow[],
): readonly Omit<FeedRow, 'cursor'>[] {
  const previous = new Map(
    before.map((row) => [
      `${row.accountId}\u0000${row.kind}\u0000${row.entityId}`,
      row.cursor,
    ]),
  );
  return after
    .filter(
      (row) =>
        previous.get(
          `${row.accountId}\u0000${row.kind}\u0000${row.entityId}`,
        ) !== row.cursor,
    )
    .map(({ accountId, kind, entityId }) => ({ accountId, kind, entityId }));
}

describe('Connected Account source writes and Team publication (SQLite integration)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'credential-source-team-publication-',
      initAuth: true,
      initEncrypt: true,
      env: {
        HAPPIER_FEATURE_TEAMS__ENABLED: '1',
        HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
      },
    });
  }, 180_000);
  afterAll(async () => {
    await harness?.close();
  });

  async function sharedSource(deliveryMode: 'direct' | 'brokered') {
    const fixture = await createTeamDirectActionMaterialFixture({
      deliveryMode,
    });
    // A Home administrator reads every Team directory, and a Team-granted
    // Discussion is the audience credential writes used to re-reconcile.
    const admin = await db.account.create({
      data: { encryptionMode: 'plain', publicKey: null, homeRole: 'admin' },
    });
    const discussion = await db.discussion.create({
      data: {
        ownerAccountId: fixture.custodian.id,
        encryptionMode: 'plain',
        dataEncryptionKey: new Uint8Array(
          decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        ),
        creationLocalId: crypto.randomUUID(),
        creationEqualityEvidenceV1: {},
        createdByAccountId: fixture.custodian.id,
        titleContent: { t: 'plain', v: { v: 1, title: 'Team discussion' } },
        lastMessageAt: new Date(),
      },
    });
    await db.discussionGrant.create({
      data: {
        discussionId: discussion.id,
        principalKind: 'team',
        teamId: fixture.team.id,
        accessLevel: 'view',
        createdByAccountId: fixture.custodian.id,
      },
    });
    const basis = await inTx((tx) =>
      readQualifiedConnectedServiceCredentialMutationBasisInTx(tx, {
        accountId: fixture.custodian.id,
        ref: fixture.sourceAccount,
      }),
    );
    if (!basis?.credentialRevision)
      throw new Error('Fixture credential basis missing');
    const rotate = async (
      overrides: Readonly<{ contributionContractVersion?: string }> = {},
    ) => {
      const written = await mutateQualifiedConnectedServiceCredential({
        accountId: fixture.custodian.id,
        ref: fixture.sourceAccount,
        authenticationModeId: 'api-key',
        expectedCredentialRevision: basis.credentialRevision!,
        expectedConfigurationRevision: basis.configurationRevision,
        content: {
          t: 'plain',
          v: { v: 1, values: { token: 'rotated-token' } },
        },
        metadata: { scopes: [] },
        ...overrides,
      });
      expect(written.status).toBe('written');
    };
    const teamsRow = (accountId: string) => ({
      accountId,
      kind: 'account',
      entityId: TEAM_CHANGE_ENTITY_ID,
    });
    const connectedServicesRow = {
      accountId: fixture.custodian.id,
      ...(({ kind, entityId }) => ({ kind, entityId }))(
        buildConnectedServicesAccountChangeV1(fixture.sourceAccount.service),
      ),
    };
    return { ...fixture, admin, basis, rotate, teamsRow, connectedServicesRow };
  }

  it("publishes only the custodian's own Connected Services row for a healthy rotation of a brokered-only source", async () => {
    const shared = await sharedSource('brokered');
    const before = await readFeed();

    await shared.rotate();

    // No Team, Discussion, Machine or managed-policy row reaches any Account:
    // daemons of the recipient, the administrator and the custodian make
    // 0 Machine reads and 0 policy requests for this refresh.
    expect(changedRows(before, await readFeed())).toEqual([
      shared.connectedServicesRow,
    ]);
  });

  it('still wakes the Team when a rotation invalidates published direct material, without Discussion churn', async () => {
    const shared = await sharedSource('direct');
    const before = await readFeed();

    await shared.rotate();

    const changed = changedRows(before, await readFeed());
    // Direct material embeds the credential revision; the custodian's daemon
    // re-delivers on `teams`, and recipients see their material go stale.
    expect(changed).toEqual(
      expect.arrayContaining([
        shared.connectedServicesRow,
        shared.teamsRow(shared.custodian.id),
        shared.teamsRow(shared.recipient.id),
      ]),
    );
    expect(changed.filter((row) => row.kind === 'discussion')).toEqual([]);
  });

  it("wakes the Team when a credential write changes the source's export projection", async () => {
    const shared = await sharedSource('brokered');
    const before = await readFeed();

    await shared.rotate({ contributionContractVersion: 'artifact-example-2' });

    expect(changedRows(before, await readFeed())).toEqual(
      expect.arrayContaining([
        shared.connectedServicesRow,
        shared.teamsRow(shared.recipient.id),
        shared.teamsRow(shared.admin.id),
      ]),
    );
  });

  it("wakes the Team when the source's presented health becomes reconnect-required", async () => {
    const shared = await sharedSource('brokered');
    const before = await readFeed();

    const written = await mutateQualifiedConnectedServiceCredentialHealth({
      accountId: shared.custodian.id,
      ref: shared.sourceAccount,
      health: { v: 1, status: 'needs_reauth', reconnectRequired: true },
      expectedCredentialRevision: shared.basis.credentialRevision!,
      expectedConfigurationRevision: shared.basis.configurationRevision,
    });
    expect(written.status).toBe('written');

    const changed = changedRows(before, await readFeed());
    expect(changed).toEqual(
      expect.arrayContaining([
        shared.teamsRow(shared.recipient.id),
        shared.teamsRow(shared.custodian.id),
      ]),
    );
    expect(changed.filter((row) => row.kind === 'discussion')).toEqual([]);
  });

  it('wakes the Team when the source credential is deleted', async () => {
    const shared = await sharedSource('brokered');
    const before = await readFeed();

    const deleted = await deleteQualifiedConnectedServiceCredential({
      accountId: shared.custodian.id,
      ref: shared.sourceAccount,
      expectedCredentialRevision: shared.basis.credentialRevision!,
      cleanupGroupReferences: true,
    });
    expect(deleted.status).toBe('deleted');

    expect(changedRows(before, await readFeed())).toEqual(
      expect.arrayContaining([shared.teamsRow(shared.recipient.id)]),
    );
  });
});
