import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_TEAM_CAPABILITIES_V1, TeamSummaryV1Schema } from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { HOME_GOVERNANCE_POLICY_ID } from '@/app/home/governance/governancePolicy';
import type { HomeRole } from '@/storage/enums.generated';
import { qualifyTeamProjectionReadAuthenticationsInTx, resolveTeamActorContextsInTx, type TeamActorContext } from './actorContext';

import { archiveTeamInTx, readTeamSummaryForActorInTx } from './lifecycle';
import {
  listTeamsForActorInTx,
  resolveGrantableTeamForActorInTx,
  resolveGrantableTeamsForActorInTx,
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

  it('projects hasSetup only for readable Team or own Group Sources, with no empty or preset-only Team offer fact', async () => {
    const viewer = await account();
    const author = await account();
    const [empty, preset, owned, direct, ownGroupTeam, foreignGroupTeam, deleted] = await Promise.all(
      ['empty', 'preset', 'owned', 'direct', 'own-group', 'foreign-group', 'deleted'].map(name => team(name, [viewer])));
    await db.team.update({ where: { id: preset.id }, data: { managedDefaults: {
      team: { placement: { kind: 'preset', homeId: 'home', presetId: 'configured-unavailable-preset' } }, groups: {},
    } } });
    const ownMembership = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: ownGroupTeam.id, accountId: viewer.id } } });
    const ownGroup = await db.teamGroup.create({ data: { teamId: ownGroupTeam.id, name: 'Own group' } });
    const foreignGroup = await db.teamGroup.create({ data: { teamId: foreignGroupTeam.id, name: 'Other group' } });
    await db.teamGroupMembership.create({ data: { teamId: ownGroupTeam.id, teamGroupId: ownGroup.id,
      teamMembershipId: ownMembership.id, nativeContribution: true } });
    const personal = { kind: 'account', accountId: author.id };
    for (const [selected, owner, principal, deletedAt] of [
      [owned, { kind: 'team', teamId: owned.id }, null, null],
      [direct, personal, { kind: 'team', teamId: direct.id }, null],
      [ownGroupTeam, personal, { kind: 'group', teamId: ownGroupTeam.id, groupId: ownGroup.id }, null],
      [foreignGroupTeam, personal, { kind: 'group', teamId: foreignGroupTeam.id, groupId: foreignGroup.id }, null],
      [deleted, { kind: 'team', teamId: deleted.id }, null, new Date()],
    ] as const) await db.projectSource.create({ data: { id: crypto.randomUUID(), name: selected.name,
      createdByAccountId: author.id, owner, audience: principal ? [{ principal, level: 'view' }] : [], attachments: [], deletedAt } });
    const { countScopedTeamProjectSourcesInTx } = await import('../projects/sources/projectSourceQuery');
    expect(await inTx(tx => countScopedTeamProjectSourcesInTx(tx, {
      actorAccountId: viewer.id, sharedWithTeamId: owned.id,
    }))).toEqual({ ok: true, count: 1 });
    const page = await list(viewer.id);
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error(page.error);
    expect(page.page.items).toHaveLength(7);
    expect(Object.fromEntries(page.page.items.map(row => [row.id, row.hasSetup]))).toEqual({
      [empty.id]: false, [preset.id]: false, [owned.id]: true, [direct.id]: true,
      [ownGroupTeam.id]: true, [foreignGroupTeam.id]: false, [deleted.id]: false,
    });
    expect(await inTx(tx => readTeamSummaryForActorInTx(tx, { actorAccountId: viewer.id, teamId: owned.id })))
      .toMatchObject({ ok: true, team: { hasSetup: true } });
    await db.teamGroupMembership.deleteMany({ where: { teamId: ownGroupTeam.id } });
    const removed = await list(viewer.id);
    expect(removed).toMatchObject({ ok: true, page: { items: expect.arrayContaining([
      expect.objectContaining({ id: ownGroupTeam.id, hasSetup: false }),
    ]) } });
  });

  it('uses one native Source query per directory page for the hasSetup projection', async () => {
    const viewer = await account();
    const teams = Array.from({ length: 100 }, (_, index) => ({ id: crypto.randomUUID(), name: `Page ${index}` }));
    await db.team.createMany({ data: teams });
    await db.teamMembership.createMany({ data: teams.map(row => ({ teamId: row.id, accountId: viewer.id, role: 'member' as const })) });
    const sourceId = crypto.randomUUID();
    await db.projectSource.create({ data: { id: sourceId, name: 'Visible source', createdByAccountId: viewer.id,
      owner: { kind: 'team', teamId: teams[0]!.id }, audience: [], attachments: [] } });
    try {
      const { countScopedTeamProjectSourcesInTx } = await import('../projects/sources/projectSourceQuery');
      expect(await inTx(tx => countScopedTeamProjectSourcesInTx(tx, {
        actorAccountId: viewer.id, sharedWithTeamId: teams[0]!.id,
      }))).toEqual({ ok: true, count: 1 });
      const observe = (limit: number) => inTx(async tx => {
        let sourceReads = 0;
        const counted = new Proxy(tx, { get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property === '$queryRaw' && typeof value === 'function') return (...args: unknown[]) => {
            const sql = (args[0] as { strings?: readonly string[] }).strings?.join(' ') ?? '';
            if (sql.includes('SELECT') && sql.includes('ProjectSource')) sourceReads++;
            return Reflect.apply(value, target, args);
          };
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const started = performance.now();
        const result = await listTeamsForActorInTx(counted, { actorAccountId: viewer.id, v: 1, scope: 'member', archived: 'active', limit });
        return { result, sourceReads, elapsedMs: Math.round(performance.now() - started) };
      });
      const measurements = [];
      for (const limit of [1, 11, 100]) {
        const measured = await observe(limit);
        expect(measured.result).toMatchObject({ ok: true });
        if (!measured.result.ok) throw new Error(measured.result.error);
        expect(measured.result.page.items).toHaveLength(limit);
        if (limit === 100) expect(measured.result.page.items.filter(row => row.hasSetup)).toHaveLength(1);
        measurements.push({ teams: limit, sourceQueries: measured.sourceReads, elapsedMs: measured.elapsedMs });
      }
      console.info('hasSetup native count cost', JSON.stringify(measurements));
      expect(measurements.map(({ sourceQueries }) => sourceQueries)).toEqual([1, 1, 1]);
    } finally {
      await db.projectSource.deleteMany({ where: { id: sourceId } });
      await db.team.deleteMany({ where: { id: { in: teams.map(row => row.id) } } });
    }
  });

  it('keeps hasSetup parity when a selected-Team guest reads its Source through another Team outside the page', async () => {
    const viewer = await account();
    const guestTeam = await team('A guest Team', [viewer]);
    const memberTeam = await team('Z other Team', [viewer]);
    await db.teamMembership.updateMany({ where: { teamId: guestTeam.id, accountId: viewer.id }, data: { role: 'guest' } });
    await db.projectSource.create({ data: { id: crypto.randomUUID(), name: 'Independently granted source', createdByAccountId: viewer.id,
      owner: { kind: 'team', teamId: guestTeam.id }, audience: [{ principal: { kind: 'team', teamId: memberTeam.id }, level: 'view' }], attachments: [] } });
    const { listProjectSourcesInTx } = await import('../projects/sources/projectSourceService');
    expect(await inTx(tx => listProjectSourcesInTx(tx, viewer.id, { serverId: 'home', sharedWithTeamId: guestTeam.id })))
      .toMatchObject({ ok: true, sources: [expect.anything()] });
    expect(await list(viewer.id, { limit: 1 })).toMatchObject({ ok: true, page: { items: [{ id: guestTeam.id, hasSetup: true }] } });
    expect(await inTx(tx => readTeamSummaryForActorInTx(tx, { actorAccountId: viewer.id, teamId: guestTeam.id })))
      .toMatchObject({ ok: true, team: { hasSetup: true } });
  });

  it('withholds the hasSetup Source fact from a repair-readable malformed-policy Team', async () => {
    const viewer = await account();
    const selected = await team('Repair-readable Team', [viewer]);
    await db.projectSource.create({ data: { id: crypto.randomUUID(), name: 'Protected source', createdByAccountId: viewer.id,
      owner: { kind: 'team', teamId: selected.id }, audience: [], attachments: [] } });
    const { listProjectSourcesInTx } = await import('../projects/sources/projectSourceService');
    expect(await inTx(tx => listProjectSourcesInTx(tx, viewer.id, { serverId: 'home', sharedWithTeamId: selected.id })))
      .toMatchObject({ ok: true, sources: [expect.anything()] });
    await db.team.update({ where: { id: selected.id }, data: { authenticationPolicy: { malformed: true } } });
    expect(await inTx(tx => listProjectSourcesInTx(tx, viewer.id, { serverId: 'home', sharedWithTeamId: selected.id })))
      .toMatchObject({ ok: false, error: 'source_unavailable' });
    expect(await list(viewer.id)).toMatchObject({ ok: true, page: { items: [{ id: selected.id, hasSetup: null,
      policy: { authenticationPolicyStatus: 'repair_required' } }] } });
    expect(await inTx(tx => readTeamSummaryForActorInTx(tx, { actorAccountId: viewer.id, teamId: selected.id })))
      .toMatchObject({ ok: true, team: { hasSetup: null } });
  });

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
    // Home offers use this existing membership lifetime rather than fetching
    // each Team's setup. Point reads must preserve the same summary fact.
    const membership = await db.teamMembership.findUniqueOrThrow({
      where: { teamId_accountId: { teamId: mine.id, accountId: viewer.id } },
    });
    const joinedAt = membership.createdAt.getTime();
    expect(active.page.items.find(item => item.id === mine.id)).toMatchObject({ viewerJoinedAt: joinedAt });
    expect(await inTx(tx => readTeamSummaryForActorInTx(tx, { teamId: mine.id, actorAccountId: viewer.id })))
      .toMatchObject({ ok: true, team: { viewerJoinedAt: joinedAt } });

    const archivedPage = await list(viewer.id, { archived: 'archived' });
    expect(archivedPage.ok).toBe(true);
    if (!archivedPage.ok) return;
    expect(archivedPage.page.items.map((item) => item.id)).toEqual([
      archived.id,
    ]);
    expect(archivedPage.page.items[0]?.capabilities.restoreTeam).toBe(true);
  });

  it('retains a suspended native membership for self-leave without Team read authority', async () => {
    const viewer = await account();
    const suspended = await team(`AD ${crypto.randomUUID()}`, [viewer]);
    await db.teamMembership.updateMany({
      where: { teamId: suspended.id, accountId: viewer.id },
      data: { status: 'suspended' },
    });

    const page = await list(viewer.id);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.page.items.find((item) => item.id === suspended.id)).toMatchObject({
      capabilities: { ...NO_TEAM_CAPABILITIES_V1, leave: true },
      counts: null,
    });
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
    expect(row).toMatchObject({ viewerJoinedAt: null });
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
    'batches projection authentication facts for one versus a full %s page of restricted Teams',
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
        return { viewer, teamIds: teams.map(created => created.id) };
      };
      // Sort this bounded page before earlier fixtures, including in the
      // Home-admin scope that intentionally sees other Accounts' Teams.
      const { viewer, teamIds } = await createViewerWithTeams(`!!bounded-${scope}`, 100);

      const listWithQueryCount = async (viewerId: string, limit: number) =>
        await inTx(async (tx) => {
          const contexts = await resolveTeamActorContextsInTx(tx, {
            teamIds: teamIds.slice(0, limit), actorAccountId: viewerId,
          });
          let queryCount = 0;
          const observedTx = new Proxy(tx, {
            get(target, property, receiver) {
              const delegate = Reflect.get(target, property, receiver);
              if (typeof delegate === 'function') return delegate.bind(target);
              if (typeof delegate !== 'object' || delegate === null) return delegate;
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
          const result = await qualifyTeamProjectionReadAuthenticationsInTx(observedTx, {
            contexts: [...contexts.values()],
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            authenticationAuthority: 'present_user',
          });
          return { result, queryCount };
        });

      const one = await listWithQueryCount(viewer.id, 1);
      const many = await listWithQueryCount(viewer.id, 100);
      expect(one.result.size).toBe(1);
      expect(many.result.size).toBe(100);
      expect([...one.result.values()].every(result => result.ok)).toBe(true);
      expect([...many.result.values()].every(result => result.ok)).toBe(true);
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

  it('keeps zero, archived and restored Group counts readable through the strict Team summary consumer', async () => {
    const owner = await account();
    const counted = await team(`Group counts ${crypto.randomUUID()}`, [owner]);
    const read = async () => {
      const result = await inTx(tx => readTeamSummaryForActorInTx(tx, { teamId: counted.id, actorAccountId: owner.id }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      return TeamSummaryV1Schema.parse(result.team);
    };
    expect((await read()).counts).toMatchObject({ groups: 0, archivedGroups: 0 });
    const group = await db.teamGroup.create({ data: { teamId: counted.id, name: storedPlainPrivateLabel('Archived'), archivedAt: new Date() } });
    expect((await read()).counts).toMatchObject({ groups: 0, archivedGroups: 1 });
    await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: null } });
    expect((await read()).counts).toMatchObject({ groups: 1, archivedGroups: 0 });
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
        { teamId: counted.id, name: storedPlainPrivateLabel('Engineering') },
        { teamId: counted.id, name: storedPlainPrivateLabel('On call') },
        {
          teamId: counted.id,
          name: storedPlainPrivateLabel('Retired'),
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
      archivedGroups: 1,
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
      archivedGroups: 1,
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
      archivedGroups: 1,
      waitingInvitations: null,
    });

    // Home Team visibility permits coarse membership totals, never roster,
    // Group or invitation facts (docs/teams.md, Summary counts).
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
    // Home administration composes `viewTeam` without granting roster access.
    expect(adminRow?.capabilities.viewTeam).toBe(true);
    expect(adminRow?.capabilities.viewRoster).toBe(false);
    expect(adminRow?.counts).toEqual({
      members: 3,
      suspendedMembers: 1,
      groups: null,
      archivedGroups: null,
      waitingInvitations: null,
    });

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
      archivedGroups: 1,
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

  it('falls back to current authority for absent or mismatched admitted Team contexts', async () => {
    const viewer = await account('owner');
    const stranger = await account();
    const mine = await team(`Context mine ${crypto.randomUUID()}`, [viewer]);
    const foreign = await team(`Context foreign ${crypto.randomUUID()}`, [stranger]);
    await inTx(async tx => {
      const contexts = await resolveTeamActorContextsInTx(tx, {
        actorAccountId: viewer.id, teamIds: [mine.id, foreign.id],
      });
      const strangerContexts = await resolveTeamActorContextsInTx(tx, {
        actorAccountId: stranger.id, teamIds: [foreign.id],
      });
      const ownContext = contexts.get(mine.id);
      const strangerContext = strangerContexts.get(foreign.id);
      if (!ownContext || !strangerContext) throw new Error('Fixture Team contexts must exist');
      for (const actorContexts of [
        contexts,
        new Map([[foreign.id, strangerContext]]),
        new Map([[foreign.id, ownContext]]),
        new Map<string, TeamActorContext>(),
      ]) {
        expect([...await resolveGrantableTeamsForActorInTx(tx, {
          actorAccountId: viewer.id, teamIds: [mine.id, foreign.id], actorContexts,
        })]).toEqual([mine.id]);
      }
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
