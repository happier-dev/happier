import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { setTeamMembershipStatusInTx } from '../memberships/membershipService';
import { revokeTeamCredentialAudienceForMembershipInTx } from './resourceAudience';
import { authorizeTeamCredentialResourceTestActorInTx } from './resourceTest';
import { updateTeamCredentialResourceInTx } from './resourceUpdate';

const TEST_AUTHENTICATION = {
  env: process.env,
  authenticationAuthority: 'present_user',
  authenticationEvidence: [],
} as const;
const SOURCE = {
  v: 1,
  kind: 'provider_connection',
  connectionId: 'pc_custodian',
  connectionSecurityFingerprint: 'connection-security:v1:custodian',
  credentialSlotId: 'apiKey',
} as const;

type Standing = 'member' | 'removed' | 'suspended' | 'archived' | 'unqualified';

/**
 * The source custodian may always take their own credential out of service,
 * but every expanding or retargeting change is a current, Team-qualified
 * custodian's consent, identically for patch, replacement and the saved test.
 */
describe('Team credential custodian authority', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-credential-custodian-authority-',
      initAuth: false,
    });
  }, 180_000);
  afterAll(async () => {
    await harness?.close();
  });

  async function brokerMachine(accountId: string) {
    return await db.machine.create({
      data: {
        id: crypto.randomUUID(),
        accountId,
        active: true,
        kind: 'persistent',
        metadata: '{}',
        metadataVersion: 1,
        operationProtocolCapabilities: {
          providerBrokerIngress: { protocolVersions: [1] },
        },
        operationProtocolCapabilitiesRevision: 1,
      },
    });
  }

  async function fixture(standing: Standing = 'member') {
    const custodian = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const recipient = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const team = await db.team.create({
      data: { name: `Custodian ${crypto.randomUUID()}` },
    });
    const custodianMembership = await db.teamMembership.create({
      data: { teamId: team.id, accountId: custodian.id, role: 'member' },
    });
    const recipientMembership = await db.teamMembership.create({
      data: { teamId: team.id, accountId: recipient.id, role: 'member' },
    });
    const stored = await brokerMachine(custodian.id);
    const next = await brokerMachine(custodian.id);
    const resource = await db.teamCredentialResource.create({
      data: {
        teamId: team.id,
        custodianAccountId: custodian.id,
        displayName: 'Shared connection',
        disclosureCeiling: 'direct_allowed',
        sessionUsePolicy: 'personal_allowed',
        brokerMachineId: stored.id,
        sourceBindingJson: JSON.stringify(SOURCE),
        memberGrants: {
          create: {
            teamMembershipId: recipientMembership.id,
            deliveryMode: 'brokered',
          },
        },
      },
    });
    if (standing === 'removed') {
      await db.teamMembership.delete({ where: { id: custodianMembership.id } });
    } else if (standing === 'suspended') {
      await db.teamMembership.update({
        where: { id: custodianMembership.id },
        data: { status: 'suspended' },
      });
    } else if (standing === 'archived') {
      await db.team.update({
        where: { id: team.id },
        data: { archivedAt: new Date() },
      });
    } else if (standing === 'unqualified') {
      await db.team.update({
        where: { id: team.id },
        data: {
          authenticationPolicy: {
            v: 1,
            mode: 'restricted',
            accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
          },
        },
      });
    }
    const patch = (body: Record<string, unknown>) =>
      inTx((tx) =>
        updateTeamCredentialResourceInTx(tx, {
          actorAccountId: custodian.id,
          authentication: TEST_AUTHENTICATION,
          patch: {
            resourceId: resource.id,
            expectedRevision: resource.revision,
            ...body,
          },
        }),
      );
    const current = () =>
      db.teamCredentialResource.findUniqueOrThrow({
        where: { id: resource.id },
      });
    return {
      custodian,
      recipient,
      team,
      custodianMembership,
      recipientMembership,
      stored,
      next,
      resource,
      patch,
      current,
    };
  }

  const refusalFor = (standing: Exclude<Standing, 'member'>) =>
    standing === 'unqualified'
      ? { ok: false, error: 'team_authentication_required' }
      : { ok: false, error: 'resource_forbidden' };

  it.each(['removed', 'suspended', 'archived', 'unqualified'] as const)(
    'refuses a %s custodian retargeting the broker placement by patch',
    async (standing) => {
      const f = await fixture(standing);
      await expect(
        f.patch({ brokerPlacement: { kind: 'machine', machineId: f.next.id } }),
      ).resolves.toEqual(refusalFor(standing));
      expect(await f.current()).toMatchObject({
        brokerMachineId: f.stored.id,
        revision: f.resource.revision,
      });
    },
  );

  it.each(['removed', 'suspended', 'archived', 'unqualified'] as const)(
    'refuses a %s custodian widening route consent by patch',
    async (standing) => {
      const f = await fixture(standing);
      await db.teamCredentialResource.update({
        where: { id: f.resource.id },
        data: { disclosureCeiling: 'brokered_only' },
      });
      await expect(
        f.patch({
          deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
        }),
      ).resolves.toEqual(refusalFor(standing));
      expect(await f.current()).toMatchObject({
        disclosureCeiling: 'brokered_only',
        revision: f.resource.revision,
      });
    },
  );

  it('still lets a qualified member custodian retarget the broker placement', async () => {
    const f = await fixture('member');
    await expect(
      f.patch({ brokerPlacement: { kind: 'machine', machineId: f.next.id } }),
    ).resolves.toEqual({
      ok: true,
      resourceId: f.resource.id,
      revision: f.resource.revision + 1,
    });
  });

  it.each(['removed', 'suspended', 'archived', 'unqualified'] as const)(
    'lets a %s custodian disable or narrow their own credential by patch',
    async (standing) => {
      const narrowed = await fixture(standing);
      await expect(
        narrowed.patch({
          deliveryPolicy: { preferredAllowedModes: ['brokered'] },
        }),
      ).resolves.toMatchObject({ ok: true });
      const disabled = await fixture(standing);
      await expect(disabled.patch({ enabled: false })).resolves.toMatchObject({
        ok: true,
      });
      expect(await disabled.current()).toMatchObject({ enabled: false });
    },
  );

  // An archived Team is omitted: replacement re-validates the whole stored
  // audience, whose memberships are no longer effective there, for every actor.
  it.each(['removed', 'suspended', 'unqualified'] as const)(
    'lets a %s custodian disable their own credential by replacement, as by patch',
    async (standing) => {
      const f = await fixture(standing);
      await expect(
        f.patch({ replacement: { enabled: false } }),
      ).resolves.toMatchObject({ ok: true });
      expect(await f.current()).toMatchObject({
        enabled: false,
        revision: f.resource.revision + 1,
      });
    },
  );

  it.each(['removed', 'suspended', 'archived', 'unqualified'] as const)(
    'refuses a %s custodian retargeting the broker placement by replacement',
    async (standing) => {
      const f = await fixture(standing);
      await expect(
        f.patch({
          replacement: {
            custodian: {
              source: SOURCE,
              deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
              brokerPlacement: { kind: 'machine', machineId: f.next.id },
            },
          },
        }),
      ).resolves.toEqual(refusalFor(standing));
      expect(await f.current()).toMatchObject({
        brokerMachineId: f.stored.id,
        revision: f.resource.revision,
      });
    },
  );

  it.each([
    ['removed', { ok: false, error: 'not_found_or_not_visible' }],
    ['suspended', { ok: false, error: 'not_found_or_not_visible' }],
    ['archived', { ok: false, error: 'not_found_or_not_visible' }],
    ['unqualified', { ok: false, error: 'team_authentication_required' }],
  ] as const)(
    'refuses the saved-resource test to a %s custodian',
    async (standing, refusal) => {
      const f = await fixture(standing);
      await expect(
        inTx((tx) =>
          authorizeTeamCredentialResourceTestActorInTx(tx, {
            teamId: f.team.id,
            custodianAccountId: f.custodian.id,
            actorAccountId: f.custodian.id,
            authentication: TEST_AUTHENTICATION,
          }),
        ),
      ).resolves.toEqual(refusal);
    },
  );

  it('admits the saved-resource test for a qualified member custodian', async () => {
    const f = await fixture('member');
    await expect(
      inTx((tx) =>
        authorizeTeamCredentialResourceTestActorInTx(tx, {
          teamId: f.team.id,
          custodianAccountId: f.custodian.id,
          actorAccountId: f.custodian.id,
          authentication: TEST_AUTHENTICATION,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, authority: 'source_owner' });
  });

  it('advances the revision of resources whose custodian membership is suspended', async () => {
    const f = await fixture('member');
    await inTx((tx) =>
      setTeamMembershipStatusInTx(tx, {
        teamId: f.team.id,
        membershipId: f.custodianMembership.id,
        accountId: f.custodian.id,
        status: 'suspended',
      }),
    );
    expect((await f.current()).revision).toBe(f.resource.revision + 1);
  });

  it('advances the revision of resources whose custodian membership is removed', async () => {
    const f = await fixture('member');
    await inTx((tx) =>
      revokeTeamCredentialAudienceForMembershipInTx(tx, {
        teamId: f.team.id,
        teamMembershipId: f.custodianMembership.id,
        accountId: f.custodian.id,
        actor: { kind: 'system' },
      }),
    );
    expect((await f.current()).revision).toBe(f.resource.revision + 1);
  });
});
