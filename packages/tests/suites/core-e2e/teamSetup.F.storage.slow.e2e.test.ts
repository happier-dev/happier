import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamMembershipV1Schema } from '@happier-dev/protocol/teams/membership';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { fetchJson } from '../../src/testkit/http';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

describe('Team setup F: project defaults persistence', () => {
  let fixture: TeamSetupFFixture;
  let admin: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  const defaults = { defaultAgentTarget: { kind: 'agent', identity: {
    pluginId: 'happier.agent.claude', localId: 'claude',
  } } };

  beforeAll(async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'team-setup-f-storage-')) });
    admin = await fixture.createAccount('defaults-admin');
    machine = await fixture.enrollDaemon(admin);
  });
  afterAll(async () => { await fixture?.stop(); });

  it('TS.F.projectThin persists a Team-owned defaults leaf without changing Source revision or catalog shape', async () => {
    await fixture.assertKnownGoodSessionControl(admin, machine);
    const createdTeam = await admin.execute('teams.create', { v: 1, name: 'F Project defaults', requestKey: randomUUID() });
    expect(createdTeam.ok).toBe(true);
    if (!createdTeam.ok) throw new Error(`Team creation refused (${createdTeam.errorCode})`);
    const teamId = TeamSummaryV1Schema.parse(createdTeam.result).id;
    const created = await admin.execute('projects.sources.create', { serverId: fixture.serverId,
      name: 'F Project', owner: { kind: 'team', teamId }, requestKey: randomUUID() });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`Source creation refused (${created.errorCode})`);
    const initial = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!initial.ok) throw new Error(`Source creation refused (${initial.error})`);
    const updated = await admin.execute('projects.sources.update', { serverId: fixture.serverId,
      sourceId: initial.source.id, expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults } } });
    // Initial behavioral RED: the existing Source Action rejects this defaults edit.
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(`Defaults write refused (${updated.errorCode})`);
    expect(updated.result).toMatchObject({ ok: true, source: { revision: initial.source.revision },
      sessionDefaults: { revision: expect.any(Number), defaults } });
    const read = await admin.execute('projects.sources.read', { serverId: fixture.serverId, sourceId: initial.source.id });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`Defaults read refused (${read.errorCode})`);
    expect(read.result).toMatchObject({ sessionDefaults: { defaults } });
    const missingMachine = await admin.execute('projects.sources.update', { serverId: fixture.serverId,
      sourceId: initial.source.id, expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 1, defaults: {
        ...defaults, placement: { kind: 'machine', target: { serverId: fixture.serverId, machineId: randomUUID() } },
      } } } });
    expect(missingMachine).toMatchObject({ ok: true, result: {
      ok: false, error: 'managed_default_machine_not_member_usable',
    } });
    const listed = await admin.execute('projects.sources.list', { serverId: fixture.serverId });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(`Source listing refused (${listed.errorCode})`);
    expect(listed.result).toMatchObject({ sources: [expect.not.objectContaining({ sessionDefaults: expect.anything() })] });

    const member = await fixture.createAccount('defaults-member');
    const outsider = await fixture.createAccount('defaults-outsider');
    const audienceTeam = await admin.execute('teams.create', { v: 1, name: 'F Audience only', requestKey: randomUUID() });
    if (!audienceTeam.ok) throw new Error(`Audience Team creation refused (${audienceTeam.errorCode})`);
    const audienceTeamId = TeamSummaryV1Schema.parse(audienceTeam.result).id;
    expect((await admin.execute('teams.members.add', { v: 1, teamId: audienceTeamId,
      accountId: readAccountIdFromToken(outsider.credentials.token), role: 'admin', historyAccess: 'all_existing' })).ok).toBe(true);
    const membership = await admin.execute('teams.members.add', { v: 1, teamId,
      accountId: readAccountIdFromToken(member.credentials.token), role: 'member', historyAccess: 'all_existing' });
    expect(membership.ok).toBe(true);
    if (!membership.ok) throw new Error(`Member admission refused (${membership.errorCode})`);
    const membershipId = TeamMembershipV1Schema.parse(membership.result).id;
    const selected = { serverId: fixture.serverId, sourceId: initial.source.id };
    const memberRead = await member.execute('projects.sources.read', selected);
    expect(memberRead).toMatchObject({ ok: true, result: { sessionDefaults: { defaults } } });
    const memberWrite = await member.execute('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults: null } } });
    expect(memberWrite).toMatchObject({ ok: true, result: { ok: false, error: 'source_access_denied' } });
    const placementWrite = await admin.execute('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 1,
        defaults: { ...defaults, placement: { kind: 'machine', target: machine.target } } } } });
    expect(placementWrite).toMatchObject({ ok: true, result: {
      ok: false, error: 'managed_default_machine_not_member_usable',
    } });
    const staleWrite = await admin.execute('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults: null } } });
    expect(staleWrite).toMatchObject({ ok: true, result: { ok: false, error: 'source_conflict' } });
    const granted = await admin.execute('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { audience: [{ principal: { kind: 'team', teamId: audienceTeamId }, level: 'view' }] } });
    expect(granted.ok).toBe(true);
    if (!granted.ok) throw new Error(`Audience grant refused (${granted.errorCode})`);
    const grantedSource = ProjectSourcesReadOutputV1Schema.parse(granted.result);
    if (!grantedSource.ok) throw new Error(`Audience grant refused (${grantedSource.error})`);
    const outsiderRead = await outsider.execute('projects.sources.read', selected);
    expect(outsiderRead.ok).toBe(true);
    if (!outsiderRead.ok) throw new Error(`Audience Source read refused (${outsiderRead.errorCode})`);
    // Audience Team admins manage Source metadata and read defaults, but the owner side alone writes them.
    expect(outsiderRead.result).toMatchObject({ canManage: true, canManageSessionDefaults: false,
      sessionDefaults: { revision: 1, defaults } });
    const outsiderDefaults = await outsider.execute('projects.sessionDefaults.get', { sourceRef: selected });
    expect(outsiderDefaults).toMatchObject({ ok: true, result: {
      context: { projectDefaults: defaults, teamDefaults: null },
      sourceDefaultsRow: { revision: 1, defaults }, canManageSource: false,
    } });
    const outsiderWrite = await outsider.execute('projects.sources.update', { ...selected,
      expectedRevision: grantedSource.source.revision,
      patch: { sessionDefaults: { expectedRevision: 1, defaults: null } } });
    expect(outsiderWrite).toMatchObject({ ok: true, result: { ok: false, error: 'source_access_denied' } });
    // Defaults have their own CAS, independent of an intervening ordinary Source edit.
    const clear = await admin.execute('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 1, defaults: null } } });
    expect(clear).toMatchObject({ ok: true, result: { ok: true, canManageSessionDefaults: true,
      source: { revision: grantedSource.source.revision }, sessionDefaults: { revision: 2, defaults: null } } });
    const restore = await admin.execute('projects.sources.update', { ...selected,
      expectedRevision: grantedSource.source.revision,
      patch: { sessionDefaults: { expectedRevision: 2, defaults } } });
    expect(restore).toMatchObject({ ok: true, result: { ok: true, sessionDefaults: { revision: 3, defaults } } });
    expect((await admin.execute('teams.members.remove', { v: 1, teamId, membershipId })).ok).toBe(true);
    const revokedRead = await member.execute('projects.sources.read', selected);
    expect(revokedRead).toMatchObject({ ok: true, result: { ok: false, error: 'source_unavailable' } });
  });

  it('TS.F.accountSource uses the same defaults leaf and existing Source authority', async () => {
    await fixture.assertKnownGoodSessionControl(admin, machine);
    const other = await fixture.createAccount('defaults-account-unrelated');
    const created = await admin.execute('projects.sources.create', { serverId: fixture.serverId,
      name: 'F Account Project', requestKey: randomUUID() });
    if (!created.ok) throw new Error(`Account Source creation refused (${created.errorCode})`);
    const initial = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!initial.ok) throw new Error(`Account Source creation refused (${initial.error})`);
    const selected = { serverId: fixture.serverId, sourceId: initial.source.id };
    const saved = await admin.execute('projects.sources.update', { ...selected, expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults } } });
    expect(saved).toMatchObject({ ok: true, result: { ok: true, sessionDefaults: { revision: 1, defaults } } });
    const foreign = await other.execute('projects.sources.read', selected);
    expect(foreign).toMatchObject({ ok: true, result: { ok: false, error: 'source_unavailable' } });
  });

  it('TS.F.personalProjectDemand loads only the selected project and preserves Account isolation', async () => {
    await fixture.assertKnownGoodSessionControl(admin, machine);
    const other = await fixture.createAccount('defaults-demand-other');
    const projectRef = { serverId: fixture.serverId, projectKey: `selected-${randomUUID()}` };
    const absent = await admin.execute('projects.sessionDefaults.get', { projectRef });
    // P04: the real admitted Session control above must settle before this
    // missing Action is accepted as behavioral RED.
    expect(absent.ok).toBe(true);
    if (!absent.ok) throw new Error(`Demanded defaults read refused (${absent.errorCode})`);
    expect(absent.result).toMatchObject({ personalDefaultsRow: null });
    const saved = await admin.execute('projects.organization.update', { projectRef, expectedRevision: 'absent',
      sessionDefaults: { expectedRevision: 'absent', defaults } });
    expect(saved.ok).toBe(true);
    const selected = await admin.execute('projects.sessionDefaults.get', { projectRef });
    expect(selected).toMatchObject({ ok: true, result: { personalDefaultsRow: { defaults },
      context: { personalProjectDefaults: defaults } } });
    const unrelated = await admin.execute('projects.sessionDefaults.get', { projectRef: { ...projectRef,
      projectKey: `unrelated-${randomUUID()}` } });
    expect(unrelated).toMatchObject({ ok: true, result: { personalDefaultsRow: null } });
    const foreign = await other.execute('projects.sessionDefaults.get', { projectRef });
    expect(foreign).toMatchObject({ ok: true, result: { personalDefaultsRow: null } });
  });

  it('TS.F.personalProject saves a deliberate project pick through the existing organization Action', async () => {
    await fixture.assertKnownGoodSessionControl(admin, machine);
    const projectRef = { serverId: fixture.serverId, projectKey: `project-${randomUUID()}` };
    const saved = await admin.execute('projects.organization.update', { projectRef, expectedRevision: 'absent',
      sessionDefaults: { expectedRevision: 'absent', defaults } });
    // Initial behavioral RED: private project defaults are absent from the existing Action grammar.
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(`Personal defaults write refused (${saved.errorCode})`);
    expect(saved.result).toMatchObject({ ok: true, sessionDefaults: { revision: expect.any(Number), defaults } });
    const request = async (route: 'read' | 'list', input: unknown) => fetchJson<unknown>(
      `${fixture.server.baseUrl}/v1/account/project-rows/${route}`, { method: 'POST',
        headers: { Authorization: `Bearer ${admin.credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input) });
    const exact = await request('read', { key: { kind: 'project-session-defaults', ...projectRef } });
    expect(exact.status).toBe(200);
    expect(exact.data).toMatchObject({ status: 'present', row: { content: { t: 'encrypted', c: expect.any(String) } } });
    const census = await request('list', {});
    expect(census.status).toBe(200);
    expect(census.data).toMatchObject({ status: 'listed', rows: expect.not.arrayContaining([
      expect.objectContaining({ key: expect.objectContaining({ kind: 'project-session-defaults' }) }),
    ]) });
  });
});
