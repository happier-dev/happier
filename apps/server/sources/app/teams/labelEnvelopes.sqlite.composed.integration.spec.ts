import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { prepareSavedSecretResourceRecipientEnvelopesV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import {
  TeamLabelEnvelopeWorkV1Schema,
  type TeamLabelEnvelopeBindingV1,
} from '@happier-dev/protocol/teams';
import {
  parsePrivateLabelStoredV1,
  PrivateLabelStoredV1Schema,
  projectPrivateLabelForRecipientV1,
  serializePrivateLabelStoredV1,
  type PrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import { openCliPrivateLabel } from '../../../../cli/src/api/privateLabels';

import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import {
  prepareE2eePrivateLabelForAccount,
  storedPlainPrivateLabel,
} from '@/testkit/privateLabelFixture';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prisma';
import { admitTeamMemberInTx } from './memberships/membershipService';
import { registerTeamGroupRoutes } from './groups/registerTeamGroupRoutes';

describe('Team label envelope repair for credential, external-key and Pool labels', () => {
  let harness: LightSqliteHarness;
  let app: ReturnType<typeof createAuthenticatedTestApp>;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-team-label-envelopes-',
      initAuth: false,
      env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' },
    });
    app = createAuthenticatedTestApp();
    registerTeamGroupRoutes(app);
    await app.ready();
  }, 180_000);
  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.close();
  });

  async function e2eeAccount() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const account = await db.account.create({
      data: {
        encryptionMode: 'e2ee',
        publicKey: Buffer.from(signing.publicKey).toString('hex'),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: signAccountContentKeyBindingV1({
          accountSigningSecretKey: signing.secretKey,
          contentPublicKey: content.publicKey,
        }),
      },
    });
    return { account, content };
  }

  it('discovers the one owed label without validating 1,001 stored recipient arrays', async () => {
    const { account: owner } = await e2eeAccount();
    const { account: newcomer } = await e2eeAccount();
    const team = await db.team.create({ data: { name: 'Label census at scale' } });
    const members = Array.from({ length: 198 }, () => ({ id: crypto.randomUUID(), encryptionMode: 'plain' }));
    await db.account.createMany({ data: members });
    await db.teamMembership.createMany({ data: [
      { teamId: team.id, accountId: owner.id, role: 'owner' },
      { teamId: team.id, accountId: newcomer.id, role: 'member' },
      ...members.map(({ id }) => ({ teamId: team.id, accountId: id, role: 'member' as const })),
    ] });
    const owedId = crypto.randomUUID();
    const prepared = await prepareE2eePrivateLabelForAccount(owner.id,
      { entity: 'team_group', field: 'name', id: owedId }, 'Prepared label', { accountIds: [newcomer.id] });
    const current = serializePrivateLabelStoredV1(prepared);
    const missing = serializePrivateLabelStoredV1({ ...prepared, recipients: prepared.recipients.filter(row => row.accountId === owner.id) });
    await db.teamGroup.createMany({ data: [
      { id: owedId, teamId: team.id, name: missing },
      ...Array.from({ length: 1_000 }, () => ({ teamId: team.id, name: current })),
    ] });

    const queries: string[] = [];
    const client = await createDbMaintenanceClient('sqlite', undefined, { log: [{ emit: 'event', level: 'query' }] });
    onDbClientQuery(client, event => queries.push(event.query));
    const transaction = db.$transaction;
    db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args) {
      return Reflect.apply(client.$transaction, client, args);
    } });
    const parses = vi.spyOn(PrivateLabelStoredV1Schema, 'safeParse');
    const reparses = vi.spyOn(PrivateLabelStoredV1Schema, 'parse');
    try {
      const response = await app.inject({ method: 'GET', url: '/v2/teams/label-envelopes', headers: { 'x-test-user-id': owner.id } });
      expect(response.statusCode).toBe(200);
      const work = TeamLabelEnvelopeWorkV1Schema.parse(response.json());
      expect(work.teams.flatMap(row => row.labels.map(label => label.binding.id))).toEqual([owedId]);
      expect(queries.filter(query => query.includes('TeamGroup') && query.startsWith('SELECT')).length).toBe(1);
      expect({ parses: parses.mock.calls.length, reparses: reparses.mock.calls.length }).toEqual({ parses: 0, reparses: 0 });
    } finally {
      parses.mockRestore();
      reparses.mockRestore();
      db.$transaction = transaction;
      await client.$disconnect();
    }
  });

  it('delivers existing label keys to a later member and keeps non-members and ciphertext out', async () => {
    const a = await e2eeAccount();
    const nora = await e2eeAccount();
    const outsider = await e2eeAccount();
    const team = await db.team.create({ data: { name: 'Credential labels' } });
    const admitted = await inTx((tx) =>
      admitTeamMemberInTx(tx, {
        teamId: team.id,
        accountId: a.account.id,
        role: 'owner',
        historyAccess: 'all_existing',
      }),
    );
    if (!admitted.ok) throw new Error('Owner fixture admission failed');
    const membership = await db.teamMembership.findUniqueOrThrow({
      where: { teamId_accountId: { teamId: team.id, accountId: a.account.id } },
    });

    const resourceId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    const poolId = crypto.randomUUID();
    const plainResourceId = crypto.randomUUID();
    const seal = (binding: TeamLabelEnvelopeBindingV1, value: string) =>
      prepareE2eePrivateLabelForAccount(a.account.id, binding, value, {
        teamIds: [team.id],
      });
    const sealed = new Map<
      string,
      {
        binding: TeamLabelEnvelopeBindingV1;
        stored: PrivateLabelStoredV1;
        value: string;
      }
    >();
    for (const [binding, value] of [
      [
        {
          entity: 'team_credential_resource',
          field: 'displayName',
          id: resourceId,
        },
        'Shared Anthropic',
      ],
      [
        {
          entity: 'team_credential_external_api_key',
          field: 'label',
          id: keyId,
        },
        'CI key',
      ],
      [{ entity: 'machine_pool', field: 'name', id: poolId }, 'Build pool'],
      [
        { entity: 'machine_pool', field: 'description', id: poolId },
        'Fast runners',
      ],
    ] as const)
      sealed.set(`${binding.entity}:${binding.field}`, {
        binding,
        stored: await seal(binding, value),
        value,
      });
    const stored = (key: string) =>
      serializePrivateLabelStoredV1(sealed.get(key)!.stored);
    const resourceRow = {
      teamId: team.id,
      custodianAccountId: a.account.id,
      disclosureCeiling: '{}',
      sessionUsePolicy: 'personal_allowed',
      sourceBindingJson: '{}',
    };
    await db.teamCredentialResource.create({
      data: {
        id: resourceId,
        ...resourceRow,
        displayName: stored('team_credential_resource:displayName'),
      },
    });
    await db.teamCredentialResource.create({
      data: {
        id: plainResourceId,
        ...resourceRow,
        displayName: storedPlainPrivateLabel('Plain label'),
      },
    });
    await db.teamCredentialExternalApiKey.create({
      data: {
        id: keyId,
        resourceId,
        teamMembershipId: membership.id,
        label: stored('team_credential_external_api_key:label'),
        displayPrefix: 'hk_',
        secretDigest: crypto.randomUUID(),
      },
    });
    await db.machinePool.create({
      data: {
        id: poolId,
        accountId: a.account.id,
        teamId: team.id,
        name: stored('machine_pool:name'),
        description: stored('machine_pool:description'),
      },
    });

    const joined = await inTx((tx) =>
      admitTeamMemberInTx(tx, {
        teamId: team.id,
        accountId: nora.account.id,
        role: 'member',
        historyAccess: 'all_existing',
      }),
    );
    expect(joined.ok).toBe(true);

    const readStored = async () =>
      ({
        'team_credential_resource:displayName': (
          await db.teamCredentialResource.findUniqueOrThrow({
            where: { id: resourceId },
          })
        ).displayName,
        'team_credential_external_api_key:label': (
          await db.teamCredentialExternalApiKey.findUniqueOrThrow({
            where: { id: keyId },
          })
        ).label,
        'machine_pool:name': (
          await db.machinePool.findUniqueOrThrow({ where: { id: poolId } })
        ).name,
        'machine_pool:description': (
          await db.machinePool.findUniqueOrThrow({ where: { id: poolId } })
        ).description!,
      }) as Record<string, string>;
    const openFor = (
      serialized: string,
      binding: TeamLabelEnvelopeBindingV1,
      accountId: string,
      secretKey: Uint8Array,
    ) => {
      const parsed = parsePrivateLabelStoredV1(serialized);
      if (parsed.kind !== 'current') return null;
      const label = projectPrivateLabelForRecipientV1({
        stored: parsed.stored,
        recipientAccountId: accountId,
      });
      if (!label.recipientEnvelope) return null;
      return openCliPrivateLabel({
        binding,
        label,
        readPolicy: { kind: 'team-resource' },
        accountKey: secretKey,
      });
    };
    for (const [key, value] of Object.entries(await readStored())) {
      expect(
        openFor(
          value,
          sealed.get(key)!.binding,
          nora.account.id,
          nora.content.secretKey,
        ),
      ).toBeNull();
    }

    const work = async (accountId: string) =>
      TeamLabelEnvelopeWorkV1Schema.parse(
        (
          await app.inject({
            method: 'GET',
            url: '/v2/teams/label-envelopes',
            headers: { 'x-test-user-id': accountId },
          })
        ).json(),
      );
    expect((await work(outsider.account.id)).teams).toEqual([]);
    expect((await work(nora.account.id)).teams).toEqual([]);
    const pending = await work(a.account.id);
    const teamWork = pending.teams.find((row) => row.teamId === team.id);
    expect(
      teamWork?.labels
        .map((row) => `${row.binding.entity}:${row.binding.field}`)
        .sort(),
    ).toEqual([...sealed.keys()].sort());

    const labels = teamWork!.labels.map((item) => {
      const dataKey = openEncryptedDataKeyEnvelopeV1({
        envelope: decodeBase64(
          item.label.recipientEnvelope!.encryptedDataKey,
          'base64',
        ),
        recipientSecretKeyOrSeed: a.content.secretKey,
      });
      if (!dataKey) throw new Error('Fixture key unavailable');
      const recipients = prepareSavedSecretResourceRecipientEnvelopesV1({
        recipients: item.recipients,
        resourceDataKey: dataKey,
        randomBytes: tweetnacl.randomBytes,
      }).map((row) => ({
        accountId: row.recipientAccountId,
        envelope: {
          encryptedDataKey: row.encryptedDataKey,
          recipientContentPublicKeyFingerprint:
            row.recipientContentPublicKeyFingerprint,
        },
      }));
      expect(recipients.map((row) => row.accountId).sort()).toEqual(
        [a.account.id, nora.account.id].sort(),
      );
      return {
        binding: item.binding,
        label: { content: item.label.content, recipients },
      };
    });
    const publish = (accountId: string) =>
      app.inject({
        method: 'PATCH',
        url: '/v2/teams/label-envelopes',
        headers: { 'x-test-user-id': accountId },
        payload: { teamId: team.id, labels },
      });
    expect((await publish(outsider.account.id)).statusCode).toBe(403);
    const repaired = await publish(a.account.id);
    expect(repaired.statusCode, repaired.body).toBe(200);

    for (const [key, value] of Object.entries(await readStored())) {
      const entry = sealed.get(key)!;
      expect(JSON.parse(value).content).toEqual(entry.stored.content);
      expect(
        openFor(value, entry.binding, nora.account.id, nora.content.secretKey),
      ).toBe(entry.value);
      expect(
        openFor(value, entry.binding, a.account.id, a.content.secretKey),
      ).toBe(entry.value);
      expect(
        openFor(
          value,
          entry.binding,
          outsider.account.id,
          outsider.content.secretKey,
        ),
      ).toBeNull();
    }
    expect(
      (
        await db.teamCredentialResource.findUniqueOrThrow({
          where: { id: plainResourceId },
        })
      ).displayName,
    ).toBe(storedPlainPrivateLabel('Plain label'));
    expect((await work(a.account.id)).teams).toEqual([]);

    // Repair cannot reauthor: a different ciphertext under the same binding is refused.
    const changed = await app.inject({
      method: 'PATCH',
      url: '/v2/teams/label-envelopes',
      headers: { 'x-test-user-id': nora.account.id },
      payload: {
        teamId: team.id,
        labels: [
          {
            ...labels[0]!,
            label: {
              ...labels[0]!.label,
              content: (await seal(labels[0]!.binding, 'Changed')).content,
            },
          },
        ],
      },
    });
    expect(changed.statusCode).toBe(409);
  });
});
