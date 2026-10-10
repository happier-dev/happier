import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { HOME_GOVERNANCE_POLICY_ID } from '@/app/home/governance/governancePolicy';
import type { HomeRole } from '@/storage/enums.generated';

import { archiveTeamInTx, readTeamSummaryForActorInTx } from './lifecycle';
import {
  listTeamsForActorInTx,
  resolveGrantableTeamForActorInTx,
} from './queries';

describe('Team directory (SQLite integration)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-team-directory-',
      initAuth: false,
    });
    await db.homeGovernancePolicy.upsert({
      where: { id: HOME_GOVERNANCE_POLICY_ID },
      create: {
        id: HOME_GOVERNANCE_POLICY_ID,
        revision: 1,
        teamCreationPolicy: 'self_service',
      },
      update: { teamCreationPolicy: 'self_service' },
    });
  }, 180_000);
  afterAll(async () => {
    if (harness) await harness.close();
  });

  async function account(
    homeRole: HomeRole = 'member',
    encryptionMode: 'plain' | 'e2ee' = 'plain',
  ) {
    return db.account.create({
      data: { publicKey: crypto.randomUUID(), encryptionMode, homeRole },
    });
  }

  async function team(
    name: string,
    members: ReadonlyArray<Readonly<{ id: string }>> = [],
  ) {
    const created = await db.team.create({ data: { name } });
    for (const member of members) {
      await db.teamMembership.create({
        data: { teamId: created.id, accountId: member.id, role: 'owner' },
      });
    }
    return created;
  }

  async function list(
    actorAccountId: string,
    input: Record<string, unknown> = {},
  ) {
    return inTx((tx) =>
      listTeamsForActorInTx(tx, {
        actorAccountId,
        v: 1,
        scope: 'member',
        archived: 'active',
        ...input,
      } as Parameters<typeof listTeamsForActorInTx>[1]),
    );
  }

  it("shows only the viewer's active Teams and hides archived ones from the active page", async () => {
    const viewer = await account();
    const stranger = await account();
    const mine = await team(`AA ${crypto.randomUUID()}`, [viewer]);
    const theirs = await team(`AB ${crypto.randomUUID()}`, [stranger]);
    const archived = await team(`AC ${crypto.randomUUID()}`, [viewer]);
    await inTx((tx) =>
      archiveTeamInTx(tx, { actorAccountId: viewer.id, teamId: archived.id }),
    );

    const active = await list(viewer.id);
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const ids = active.page.items.map((item) => item.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(archived.id);

    const archivedPage = await list(viewer.id, { archived: 'archived' });
    expect(archivedPage.ok).toBe(true);
    if (!archivedPage.ok) return;
    expect(archivedPage.page.items.map((item) => item.id)).toEqual([
      archived.id,
    ]);
    expect(archivedPage.page.items[0]?.capabilities.restoreTeam).toBe(true);
  });

  it('excludes a suspended membership, which confers nothing', async () => {
    const viewer = await account();
    const suspended = await team(`AD ${crypto.randomUUID()}`, [viewer]);
    await db.teamMembership.updateMany({
      where: { teamId: suspended.id, accountId: viewer.id },
      data: { status: 'suspended' },
    });

    const page = await list(viewer.id);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.page.items.map((item) => item.id)).not.toContain(suspended.id);
  });

  it('keeps the administrative scope explicit and reserved to Home authority', async () => {
    const admin = await account('admin');
    const stranger = await account();
    const foreign = await team(`AE ${crypto.randomUUID()}`, [stranger]);

    // The administrator's ordinary directory is still the Teams they belong to.
    const asMember = await list(admin.id);
    expect(asMember.ok).toBe(true);
    if (!asMember.ok) return;
    expect(asMember.page.items.map((item) => item.id)).not.toContain(
      foreign.id,
    );

    const administered = await list(admin.id, { scope: 'administered' });
    expect(administered.ok).toBe(true);
    if (!administered.ok) return;
    const row = administered.page.items.find((item) => item.id === foreign.id);
    expect(row).toBeDefined();
    // Administrative visibility is not membership.
    expect(row?.viewerRole).toBeNull();
    expect(row?.capabilities.manageMembers).toBe(false);

    expect(await list(stranger.id, { scope: 'administered' })).toEqual({
      ok: false,
      error: 'team_forbidden',
    });
  });

  it('qualifies member-derived rows while preserving the independent Home directory', async () => {
    const viewer = await account('member', 'e2ee');
    const inherited = await team(`Inherited ${crypto.randomUUID()}`, [viewer]);
    const restricted = await team(`Restricted ${crypto.randomUUID()}`, [
      viewer,
    ]);
    await db.team.update({
      where: { id: restricted.id },
      data: {
        authenticationPolicy: {
          v: 1,
          mode: 'restricted',
          accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        },
      },
    });

    // One Team this credential has not qualified for withholds its own
    // capabilities; it must not take the Teams this viewer satisfies, or
    // their page position, down with it.
    const unqualified = await list(viewer.id);
    expect(unqualified.ok).toBe(true);
    if (!unqualified.ok) return;
    const unqualifiedInherited = unqualified.page.items.find(
      (item) => item.id === inherited.id,
    );
    expect(unqualifiedInherited?.capabilities.viewTeam).toBe(true);
    expect(unqualifiedInherited?.capabilities.manageMembers).toBe(true);
    const unqualifiedRestricted = unqualified.page.items.find(
      (item) => item.id === restricted.id,
    );
    expect(unqualifiedRestricted).toBeDefined();
    expect(unqualifiedRestricted?.viewerRole).toBe('owner');
    expect(unqualifiedRestricted?.capabilities).toEqual(
      NO_TEAM_CAPABILITIES_V1,
    );

    const qualified = await list(viewer.id, {
      authentication: {
        authenticationEvidence: [
          { kind: 'home_method', methodId: 'key_challenge' },
        ],
        authenticationAuthority: 'present_user',
      },
    });
    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(
      qualified.page.items.find((item) => item.id === restricted.id)
        ?.capabilities.manageMembers,
    ).toBe(true);

    const homeAdmin = await account('admin', 'e2ee');
    const administered = await list(homeAdmin.id, { scope: 'administered' });
    expect(administered.ok).toBe(true);
    if (!administered.ok) return;
    expect(administered.page.items.map((item) => item.id)).toContain(
      restricted.id,
    );

    // Adding a Team role must not silently qualify that independent Home
    // administrator's ordinary credential in the administered scope.
    await db.teamMembership.create({
      data: { teamId: restricted.id, accountId: homeAdmin.id, role: 'owner' },
    });
    const combined = await list(homeAdmin.id, { scope: 'administered' });
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    const combinedRow = combined.page.items.find(
      (item) => item.id === restricted.id,
    );
    expect(combinedRow?.capabilities).toEqual(
      administered.page.items.find((item) => item.id === restricted.id)
        ?.capabilities,
    );
    const qualifiedAdmin = await list(homeAdmin.id, {
      scope: 'administered',
      authentication: {
        authenticationEvidence: [
          { kind: 'home_method', methodId: 'key_challenge' },
        ],
        authenticationAuthority: 'present_user',
      },
    });
    expect(qualifiedAdmin.ok).toBe(true);
    if (!qualifiedAdmin.ok) return;
    expect(
      qualifiedAdmin.page.items.find((item) => item.id === restricted.id)
        ?.capabilities.manageMembers,
    ).toBe(true);
  });

  it.each(['member', 'administered'] as const)(
    'bounds authentication fact reads for one versus a full %s page of restricted Teams',
    async (scope) => {
      const authenticationPolicy = {
        v: 1,
        mode: 'restricted',
        accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
      } as const;
      const createViewerWithTeams = async (prefix: string, count: number) => {
        const viewer = await account(
          scope === 'administered' ? 'admin' : 'member',
          'e2ee',
        );
        const teams = Array.from({ length: count }, (_, index) => ({
          id: `${prefix}-team-${index}`,
          name: `${prefix} Team ${String(index).padStart(3, '0')}`,
          authenticationPolicy,
        }));
        await db.team.createMany({ data: teams });
        await db.teamMembership.createMany({
          data: teams.map((created) => ({
            teamId: created.id,
            accountId: viewer.id,
            role: 'member' as const,
          })),
        });
        return viewer;
      };
      // Sort this bounded page before earlier fixtures, including in the
      // Home-admin scope that intentionally sees other Accounts' Teams.
      const viewer = await createViewerWithTeams(`!!bounded-${scope}`, 100);

      const listWithQueryCount = async (viewerId: string, limit: number) =>
        await inTx(async (tx) => {
          let queryCount = 0;
          const observedTx = new Proxy(tx, {
            get(target, property, receiver) {
              const delegate = Reflect.get(target, property, receiver);
              if (typeof delegate !== 'object' || delegate === null)
                return delegate;
              return new Proxy(delegate, {
                get(delegateTarget, method, delegateReceiver) {
                  const operation = Reflect.get(
                    delegateTarget,
                    method,
                    delegateReceiver,
                  );
                  if (
                    typeof method !== 'string' ||
                    !method.startsWith('find') ||
                    typeof operation !== 'function'
                  ) {
                    return operation;
                  }
                  return (...args: readonly unknown[]) => {
                    queryCount += 1;
                    return Reflect.apply(operation, delegateTarget, args);
                  };
                },
              });
            },
          }) as typeof tx;
          const result = await listTeamsForActorInTx(observedTx, {
            actorAccountId: viewerId,
            v: 1,
            scope,
            archived: 'active',
            limit,
            authentication: {
              authenticationEvidence: [
                { kind: 'home_method', methodId: 'key_challenge' },
              ],
              authenticationAuthority: 'present_user',
            },
          } as Parameters<typeof listTeamsForActorInTx>[1]);
          return { result, queryCount };
        });

      const one = await listWithQueryCount(viewer.id, 1);
      const many = await listWithQueryCount(viewer.id, 100);
      expect(one.result.ok).toBe(true);
      expect(many.result.ok).toBe(true);
      if (!one.result.ok || !many.result.ok) return;
      expect(one.result.page.items).toHaveLength(1);
      expect(many.result.page.items).toHaveLength(100);
      expect(
        many.result.page.items.every(
          (item) => item.viewerRole === 'member' && item.capabilities.viewTeam,
        ),
      ).toBe(true);
      expect(one.queryCount).toBeGreaterThan(0);
      expect(many.queryCount).toBe(one.queryCount);
    },
  );

  it('lets structural Team administrators list a malformed policy only as repair-required', async () => {
    const owner = await account();
    const admin = await account();
    const ordinary = await account();
    const outsider = await account();
    const malformed = await team(`Malformed ${crypto.randomUUID()}`, [owner]);
    await db.teamMembership.createMany({
      data: [
        { teamId: malformed.id, accountId: admin.id, role: 'admin' },
        { teamId: malformed.id, accountId: ordinary.id, role: 'member' },
      ],
    });
    await db.team.update({
      where: { id: malformed.id },
      data: {
        authenticationPolicy: {
          v: 99,
          mode: 'restricted',
          providerSecret: 'must-not-leak',
        },
      },
    });

    for (const actorAccountId of [owner.id, admin.id]) {
      const result = await list(actorAccountId);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const projected = result.page.items.find(
        (item) => item.id === malformed.id,
      );
      expect(projected?.policy).toMatchObject({
        authenticationPolicy: null,
        authenticationPolicyStatus: 'repair_required',
      });
      expect(JSON.stringify(projected)).not.toContain('must-not-leak');
    }

    // A member who cannot repair the policy keeps the row — redacted and
    // without capabilities — instead of losing the whole directory to it.
    const asOrdinary = await list(ordinary.id);
    expect(asOrdinary.ok).toBe(true);
    if (!asOrdinary.ok) return;
    const ordinaryRow = asOrdinary.page.items.find(
      (item) => item.id === malformed.id,
    );
    expect(ordinaryRow?.capabilities).toEqual(NO_TEAM_CAPABILITIES_V1);
    expect(ordinaryRow?.policy).toMatchObject({
      authenticationPolicy: null,
      authenticationPolicyStatus: 'repair_required',
    });
    expect(JSON.stringify(ordinaryRow)).not.toContain('must-not-leak');
    const outside = await list(outsider.id);
    expect(outside.ok).toBe(true);
    if (outside.ok)
      expect(outside.page.items.map((item) => item.id)).not.toContain(
        malformed.id,
      );
  });

  it('projects owner recovery for every visible row without granting recovery authority to Team roles', async () => {
    const homeAdmin = await account('admin');
    const teamAdmin = await account();
    const ordinaryMember = await account();
    const ownerless = await db.team.create({
      data: { name: `Ownerless ${crypto.randomUUID()}` },
    });
    await db.teamMembership.createMany({
      data: [
        { teamId: ownerless.id, accountId: teamAdmin.id, role: 'admin' },
        { teamId: ownerless.id, accountId: ordinaryMember.id, role: 'member' },
      ],
    });

    let administered = await list(homeAdmin.id, { scope: 'administered' });
    while (
      administered.ok &&
      !administered.page.items.some((item) => item.id === ownerless.id) &&
      administered.page.nextCursor !== null
    ) {
      administered = await list(homeAdmin.id, {
        scope: 'administered',
        cursor: administered.page.nextCursor,
      });
    }
    expect(administered.ok).toBe(true);
    if (!administered.ok) return;
    expect(
      administered.page.items.find((item) => item.id === ownerless.id)
        ?.recovery,
    ).toEqual({
      kind: 'owner_required',
      canAppointOwner: true,
    });

    const asTeamAdmin = await list(teamAdmin.id);
    expect(asTeamAdmin.ok).toBe(true);
    if (!asTeamAdmin.ok) return;
    expect(
      asTeamAdmin.page.items.find((item) => item.id === ownerless.id)?.recovery,
    ).toEqual({
      kind: 'owner_required',
      canAppointOwner: false,
    });

    const asMember = await list(ordinaryMember.id);
    expect(asMember.ok).toBe(true);
    if (!asMember.ok) return;
    expect(
      asMember.page.items.find((item) => item.id === ownerless.id)?.recovery,
    ).toEqual({
      kind: 'owner_required',
      canAppointOwner: false,
    });
  });

  it('projects bounded Overview counts only to viewers who may read them', async () => {
    const owner = await account();
    const member = await account();
    const suspended = await account();
    const homeAdmin = await account('admin');
    const counted = await team(`Counted ${crypto.randomUUID()}`, [owner]);
    await db.teamMembership.createMany({
      data: [
        { teamId: counted.id, accountId: member.id, role: 'member' },
        {
          teamId: counted.id,
          accountId: suspended.id,
          role: 'member',
          status: 'suspended',
        },
      ],
    });
    await db.teamGroup.createMany({
      data: [
        { teamId: counted.id, name: 'Engineering', nameKey: 'engineering' },
        { teamId: counted.id, name: 'On call', nameKey: 'on call' },
        {
          teamId: counted.id,
          name: 'Retired',
          nameKey: 'retired',
          archivedAt: new Date(),
        },
      ],
    });
    const hour = 60 * 60 * 1000;
    const invitation = (expiresAt: Date, revokedAt: Date | null = null) => ({
      teamId: counted.id,
      tokenHash: Buffer.from(crypto.randomUUID()),
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      expiresAt,
      revokedAt,
    });
    await db.teamInvitation.createMany({
      data: [
        invitation(new Date(Date.now() + hour)),
        invitation(new Date(Date.now() - hour)),
        invitation(new Date(Date.now() + hour), new Date()),
      ],
    });

    const ownerPage = await list(owner.id);
    expect(ownerPage.ok).toBe(true);
    if (!ownerPage.ok) return;
    expect(
      ownerPage.page.items.find((item) => item.id === counted.id)?.counts,
    ).toEqual({
      members: 3,
      suspendedMembers: 1,
      groups: 2,
      waitingInvitations: 1,
    });
    // `teams.get` and every mutation result project through the same owner.
    const ownerRead = await inTx((tx) =>
      readTeamSummaryForActorInTx(tx, {
        teamId: counted.id,
        actorAccountId: owner.id,
      }),
    );
    expect(ownerRead.ok && ownerRead.team.counts).toEqual({
      members: 3,
      suspendedMembers: 1,
      groups: 2,
      waitingInvitations: 1,
    });

    // A member reads the roster and Groups but not the invitation list.
    const memberPage = await list(member.id);
    expect(memberPage.ok).toBe(true);
    if (!memberPage.ok) return;
    expect(
      memberPage.page.items.find((item) => item.id === counted.id)?.counts,
    ).toEqual({
      members: 3,
      suspendedMembers: 1,
      groups: 2,
      waitingInvitations: null,
    });

    // Administrative visibility is not Team view authority: no counts.
    let administered = await list(homeAdmin.id, { scope: 'administered' });
    while (
      administered.ok &&
      !administered.page.items.some((item) => item.id === counted.id) &&
      administered.page.nextCursor !== null
    ) {
      administered = await list(homeAdmin.id, {
        scope: 'administered',
        cursor: administered.page.nextCursor,
      });
    }
    expect(administered.ok).toBe(true);
    if (!administered.ok) return;
    const adminRow = administered.page.items.find(
      (item) => item.id === counted.id,
    );
    // Home administration composes `viewTeam` for the row but never admits the
    // roster, so the counts stay withheld.
    expect(adminRow?.capabilities.viewTeam).toBe(true);
    expect(adminRow?.capabilities.viewRoster).toBe(false);
    expect(adminRow?.counts).toBeNull();

    // Losing the last active owner admits safe roster recovery through the
    // same capability, without granting invitation-management authority.
    await db.teamMembership.updateMany({
      where: { teamId: counted.id, accountId: owner.id },
      data: { status: 'suspended' },
    });
    const recoveryRead = await inTx((tx) =>
      readTeamSummaryForActorInTx(tx, {
        teamId: counted.id,
        actorAccountId: homeAdmin.id,
      }),
    );
    expect(recoveryRead.ok).toBe(true);
    if (!recoveryRead.ok) return;
    expect(recoveryRead.team.capabilities.viewRoster).toBe(true);
    expect(recoveryRead.team.counts).toEqual({
      members: 3,
      suspendedMembers: 2,
      groups: 2,
      waitingInvitations: null,
    });
  });

  it('projects null recovery while a structurally active owner exists', async () => {
    const owner = await account();
    const owned = await team(`Owned ${crypto.randomUUID()}`, [owner]);

    const page = await list(owner.id);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(
      page.page.items.find((item) => item.id === owned.id)?.recovery,
    ).toBeNull();
  });

  it('pages by name then opaque ID, so duplicate names stay ordered and complete', async () => {
    const viewer = await account();
    const prefix = `Dup ${crypto.randomUUID()}`;
    const created = [
      await team(prefix, [viewer]),
      await team(prefix, [viewer]),
      await team(prefix, [viewer]),
    ];
    const expected = created.map((row) => row.id).sort();

    const first = await list(viewer.id, { limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstPage = first.page.items.filter((item) => item.name === prefix);
    expect(first.page.nextCursor).not.toBeNull();

    const second = await list(viewer.id, {
      limit: 2,
      cursor: first.page.nextCursor,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const seen = [
      ...firstPage,
      ...second.page.items.filter((item) => item.name === prefix),
    ].map((item) => item.id);
    expect([...new Set(seen)].sort()).toEqual(expected);
  });

  it('rejects a cursor minted for a different query rather than restarting at page one', async () => {
    const viewer = await account();
    await team(`AF ${crypto.randomUUID()}`, [viewer]);
    const active = await list(viewer.id, { limit: 1 });
    expect(active.ok).toBe(true);
    if (!active.ok || active.page.nextCursor === null) return;

    expect(
      await list(viewer.id, {
        archived: 'archived',
        cursor: active.page.nextCursor,
      }),
    ).toEqual({ ok: false, error: 'invalid_team_cursor' });
    expect(await list(viewer.id, { cursor: 'not-a-cursor' })).toEqual({
      ok: false,
      error: 'invalid_team_cursor',
    });
  });

  it('refuses a directory read from an inactive Account', async () => {
    const viewer = await account();
    await team(`AG ${crypto.randomUUID()}`, [viewer]);
    await db.account.update({
      where: { id: viewer.id },
      data: { status: 'suspended' },
    });

    expect(await list(viewer.id)).toEqual({
      ok: false,
      error: 'team_forbidden',
    });
  });

  it("resolves grantability only for an active Account's active membership in an active Team", async () => {
    const viewer = await account('admin');
    const active = await team(`Grantable ${crypto.randomUUID()}`, [viewer]);
    const unrelated = await team(`Admin-only ${crypto.randomUUID()}`);
    await expect(
      inTx((tx) =>
        resolveGrantableTeamForActorInTx(tx, {
          actorAccountId: viewer.id,
          teamId: active.id,
        }),
      ),
    ).resolves.toEqual({ teamId: active.id });
    await expect(
      inTx((tx) =>
        resolveGrantableTeamForActorInTx(tx, {
          actorAccountId: viewer.id,
          teamId: unrelated.id,
        }),
      ),
    ).resolves.toBeNull();
    await db.teamMembership.updateMany({
      where: { teamId: active.id, accountId: viewer.id },
      data: { status: 'suspended' },
    });
    await expect(
      inTx((tx) =>
        resolveGrantableTeamForActorInTx(tx, {
          actorAccountId: viewer.id,
          teamId: active.id,
        }),
      ),
    ).resolves.toBeNull();
  });
});
