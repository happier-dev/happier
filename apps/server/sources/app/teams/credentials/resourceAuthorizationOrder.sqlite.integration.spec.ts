import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { deleteTeamCredentialResourceInTx } from './resourceDelete';
import { setTeamCredentialAudienceInTx } from './resourceAudience';
import { updateTeamCredentialResourceInTx } from './resourceUpdate';
import { upsertTeamCredentialUsageLimitInTx } from './resourceLimits';
import { prepareTeamCredentialRequestPolicySupportInTx } from './resourceRequestPolicySupport';
import { readCurrentTeamCredentialRecipientMaterialInTx } from './recipientMaterial';

const TEST_AUTHENTICATION = {
  env: process.env,
  authenticationAuthority: 'present_user',
  authenticationEvidence: [],
} as const;
/** A truncated private-label envelope: never readable as a legacy plaintext label. */
const CORRUPT_DISPLAY_NAME = '{"content":';
const VALID_SOURCE = JSON.stringify({
  v: 1,
  kind: 'provider_connection',
  connectionId: 'pc_source',
  connectionSecurityFingerprint: 'connection-security:v1:source',
  credentialSlotId: 'apiKey',
});

/**
 * Stored-row and revision facts are disclosed only to an actor the owner has
 * already authorized and qualified. Everyone else receives the owner's
 * existing unauthorized refusal, whatever state the row is in.
 */
describe('Team credential owners authorize before disclosing stored-row state', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-credential-authz-order-',
      initAuth: false,
    });
  }, 180_000);
  afterAll(async () => {
    await harness?.close();
  });

  async function fixture(
    row: Readonly<{
      displayName?: string;
      sourceBindingJson?: string;
      enabled?: boolean;
    }> = {},
  ) {
    const custodian = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const manager = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const member = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const outsider = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const team = await db.team.create({
      data: { name: 'Authorization order' },
    });
    await db.teamMembership.create({
      data: { teamId: team.id, accountId: custodian.id, role: 'member' },
    });
    await db.teamMembership.create({
      data: { teamId: team.id, accountId: manager.id, role: 'admin' },
    });
    await db.teamMembership.create({
      data: { teamId: team.id, accountId: member.id, role: 'member' },
    });
    const resource = await db.teamCredentialResource.create({
      data: {
        teamId: team.id,
        custodianAccountId: custodian.id,
        displayName: row.displayName ?? 'Shared connection',
        disclosureCeiling: 'direct_allowed',
        sessionUsePolicy: 'personal_allowed',
        sourceBindingJson: row.sourceBindingJson ?? VALID_SOURCE,
        enabled: row.enabled ?? true,
      },
    });
    const restrictTeam = () =>
      db.team.update({
        where: { id: team.id },
        data: {
          authenticationPolicy: {
            v: 1,
            mode: 'restricted',
            accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
          },
        },
      });
    const unchanged = async () => {
      expect(
        await db.teamCredentialResource.findUniqueOrThrow({
          where: { id: resource.id },
        }),
      ).toMatchObject({
        revision: resource.revision,
        enabled: resource.enabled,
      });
      expect(
        await db.teamCredentialActivityEvent.count({
          where: { resourceId: resource.id },
        }),
      ).toBe(0);
      expect(
        await db.teamCredentialUsageLimit.count({
          where: { resourceId: resource.id },
        }),
      ).toBe(0);
    };
    const remove = (
      actorAccountId: string,
      expectedRevision = resource.revision,
    ) =>
      inTx((tx) =>
        deleteTeamCredentialResourceInTx(tx, {
          actorAccountId,
          resourceId: resource.id,
          expectedRevision,
          authentication: TEST_AUTHENTICATION,
        }),
      );
    const setAudience = (
      actorAccountId: string,
      expectedRevision = resource.revision,
    ) =>
      inTx((tx) =>
        setTeamCredentialAudienceInTx(tx, {
          actorAccountId,
          authentication: TEST_AUTHENTICATION,
          input: {
            resourceId: resource.id,
            expectedRevision,
            allMembersAllowedRoutes: null,
            groupGrants: [],
            memberGrants: [],
          },
        }),
      );
    const patch = (
      actorAccountId: string,
      expectedRevision = resource.revision,
    ) =>
      inTx((tx) =>
        updateTeamCredentialResourceInTx(tx, {
          actorAccountId,
          authentication: TEST_AUTHENTICATION,
          patch: { resourceId: resource.id, expectedRevision, enabled: false },
        }),
      );
    const replace = (
      actorAccountId: string,
      expectedRevision = resource.revision,
    ) =>
      inTx((tx) =>
        updateTeamCredentialResourceInTx(tx, {
          actorAccountId,
          authentication: TEST_AUTHENTICATION,
          patch: {
            resourceId: resource.id,
            expectedRevision,
            replacement: { enabled: false },
          },
        }),
      );
    const upsertLimit = (
      actorAccountId: string,
      expectedRevision = resource.revision,
    ) =>
      inTx((tx) =>
        upsertTeamCredentialUsageLimitInTx(tx, {
          actorAccountId,
          authentication: TEST_AUTHENTICATION,
          body: {
            resourceId: resource.id,
            expectedRevision,
            limit: {
              subjectKind: 'team_member',
              subjectId: member.id,
              period: 'month',
              metric: 'total_tokens',
              maximum: '10',
              enabled: true,
            },
          },
        }),
      );
    const prepareSupport = (actorAccountId: string) =>
      inTx((tx) =>
        prepareTeamCredentialRequestPolicySupportInTx(tx, {
          actorAccountId,
          authentication: TEST_AUTHENTICATION,
          scope: 'resource',
          resourceId: resource.id,
        }),
      );
    const readMaterial = (recipientAccountId: string) =>
      inTx((tx) =>
        readCurrentTeamCredentialRecipientMaterialInTx(tx, {
          teamId: team.id,
          resourceId: resource.id,
          recipientAccountId,
          slot: { kind: 'provider_model' },
          sourceMemberKey: 'member',
          consumer: { kind: 'platform_operation', operationId: 'operation' },
          sessionAuthentication: {
            env: process.env,
            authority: 'present_user',
            authenticationEvidence: [],
          },
          authentication: TEST_AUTHENTICATION,
        }),
      );
    return {
      custodian,
      manager,
      member,
      outsider,
      team,
      resource,
      restrictTeam,
      unchanged,
      remove,
      setAudience,
      patch,
      replace,
      upsertLimit,
      prepareSupport,
      readMaterial,
    };
  }

  it('refuses outsiders and non-managing members before reading a corrupt stored label', async () => {
    const f = await fixture({ displayName: CORRUPT_DISPLAY_NAME });

    await expect(f.remove(f.outsider.id)).resolves.toEqual({
      ok: false,
      error: 'not_found_or_not_visible',
    });
    await expect(f.remove(f.member.id)).resolves.toEqual({
      ok: false,
      error: 'not_found_or_not_visible',
    });
    await expect(f.setAudience(f.outsider.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.setAudience(f.member.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.patch(f.outsider.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.patch(f.member.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.replace(f.outsider.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.replace(f.member.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.upsertLimit(f.outsider.id)).resolves.toEqual({
      ok: false,
      error: 'not_found_or_not_visible',
    });
    await expect(f.upsertLimit(f.member.id)).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
    // The opaque refusal is the same one a missing resource id receives.
    await expect(
      inTx((tx) =>
        upsertTeamCredentialUsageLimitInTx(tx, {
          actorAccountId: f.outsider.id,
          authentication: TEST_AUTHENTICATION,
          body: {
            resourceId: 'missing-resource',
            expectedRevision: 0,
            limit: {
              subjectKind: 'team_member', subjectId: f.member.id,
              period: 'month', metric: 'total_tokens', maximum: '10', enabled: true,
            },
          },
        }),
      ),
    ).resolves.toEqual({ ok: false, error: 'not_found_or_not_visible' });
    await expect(f.remove(f.outsider.id)).resolves.toEqual(
      await inTx((tx) =>
        deleteTeamCredentialResourceInTx(tx, {
          actorAccountId: f.outsider.id, resourceId: 'missing-resource', expectedRevision: 0,
          authentication: TEST_AUTHENTICATION,
        }),
      ),
    );
    await f.unchanged();
  });

  it('refuses a suspended custodian before reading a corrupt stored label', async () => {
    const f = await fixture({ displayName: CORRUPT_DISPLAY_NAME });
    await db.account.update({
      where: { id: f.custodian.id },
      data: { status: 'suspended' },
    });

    await expect(f.remove(f.custodian.id)).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
    await expect(f.setAudience(f.custodian.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.replace(f.custodian.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await f.unchanged();
  });

  it('refuses unauthorized replacement before comparing the revision', async () => {
    const f = await fixture();
    const stale = f.resource.revision + 1;

    await expect(f.replace(f.outsider.id, stale)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.replace(f.member.id, stale)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await f.unchanged();
  });

  it('requires Team authentication from a manager before disclosing row state', async () => {
    const corrupt = await fixture({ displayName: CORRUPT_DISPLAY_NAME });
    await corrupt.restrictTeam();
    const refused = { ok: false, error: 'team_authentication_required' };
    await expect(corrupt.remove(corrupt.manager.id)).resolves.toEqual(refused);
    await expect(corrupt.setAudience(corrupt.manager.id)).resolves.toEqual(
      refused,
    );
    await expect(corrupt.patch(corrupt.manager.id)).resolves.toEqual(refused);
    await expect(corrupt.replace(corrupt.manager.id)).resolves.toEqual(refused);
    await expect(corrupt.upsertLimit(corrupt.manager.id)).resolves.toEqual(
      refused,
    );
    await corrupt.unchanged();

    const stale = await fixture();
    await stale.restrictTeam();
    const staleRevision = stale.resource.revision + 1;
    await expect(
      stale.setAudience(stale.manager.id, staleRevision),
    ).resolves.toEqual(refused);
    await expect(stale.patch(stale.manager.id, staleRevision)).resolves.toEqual(
      refused,
    );
    await expect(
      stale.replace(stale.manager.id, staleRevision),
    ).resolves.toEqual(refused);
    await expect(
      stale.upsertLimit(stale.manager.id, staleRevision),
    ).resolves.toEqual(refused);
    await stale.unchanged();
  });

  it('still reports corrupt and stale rows to a qualified manager without writing', async () => {
    const corrupt = await fixture({ displayName: CORRUPT_DISPLAY_NAME });
    const corruptRefusal = { ok: false, error: 'resource_corrupt' };
    await expect(corrupt.remove(corrupt.manager.id)).resolves.toEqual(
      corruptRefusal,
    );
    await expect(corrupt.setAudience(corrupt.manager.id)).resolves.toEqual(
      corruptRefusal,
    );
    await expect(corrupt.patch(corrupt.manager.id)).resolves.toEqual(
      corruptRefusal,
    );
    await expect(corrupt.replace(corrupt.manager.id)).resolves.toEqual(
      corruptRefusal,
    );
    await expect(corrupt.upsertLimit(corrupt.manager.id)).resolves.toEqual(
      corruptRefusal,
    );
    await corrupt.unchanged();

    const stale = await fixture();
    const staleRevision = stale.resource.revision + 1;
    const changed = { ok: false, error: 'resource_changed' };
    await expect(
      stale.remove(stale.manager.id, staleRevision),
    ).resolves.toEqual(changed);
    await expect(
      stale.setAudience(stale.manager.id, staleRevision),
    ).resolves.toEqual(changed);
    await expect(stale.patch(stale.manager.id, staleRevision)).resolves.toEqual(
      changed,
    );
    await expect(
      stale.replace(stale.manager.id, staleRevision),
    ).resolves.toEqual(changed);
    await expect(
      stale.upsertLimit(stale.manager.id, staleRevision),
    ).resolves.toEqual(changed);
    await stale.unchanged();
  });

  it('refuses request-policy support preparation before reading a corrupt source binding', async () => {
    const f = await fixture({ sourceBindingJson: '{' });
    await expect(f.prepareSupport(f.outsider.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.prepareSupport(f.member.id)).resolves.toEqual({
      ok: false,
      error: 'resource_forbidden',
    });
    await expect(f.prepareSupport(f.manager.id)).resolves.toEqual({
      ok: false,
      error: 'resource_corrupt',
    });
    await f.restrictTeam();
    await expect(f.prepareSupport(f.manager.id)).resolves.toEqual({
      ok: false,
      error: 'team_authentication_required',
    });
  });

  it('does not tell a non-member recipient that a resource is disabled', async () => {
    const f = await fixture({ enabled: false });
    await expect(f.readMaterial(f.outsider.id)).resolves.toEqual({
      ok: false,
      outcome: 'unavailable',
      reason: 'access_removed',
    });
    await f.restrictTeam();
    await expect(f.readMaterial(f.member.id)).resolves.toEqual({
      ok: false,
      outcome: 'operation_error',
      error: 'team_authentication_required',
    });
  });
});
