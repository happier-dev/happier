import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ProjectOrganizationUpdateOutputV1Schema } from '@happier-dev/protocol/projects/projectOrganizationV1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamMembershipV1Schema } from '@happier-dev/protocol/teams/membership';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { fetchJson } from '../../src/testkit/http';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

describe('Team setup F: project defaults persistence', () => {
  let fixture: TeamSetupFFixture;
  let admin: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  let agent: Awaited<ReturnType<typeof createIsolatedFakeClaudeControlShim>>;
  const defaults = { defaultAgentTarget: { kind: 'agent', identity: {
    pluginId: 'happier.agent.claude', localId: 'claude',
  } } };

  beforeAll(async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'team-setup-f-storage-'));
    fixture = await startTeamSetupFFixture({ testDir });
    agent = await createIsolatedFakeClaudeControlShim({
      testDir: join(testDir, 'provider'), captureEnvironmentKeys: [], logFullStdin: false,
    });
    admin = await fixture.createAccount('defaults-admin');
    machine = await fixture.enrollDaemon(admin, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
    expect((await fixture.claimHomeOwner(admin)).result.status).toBe('claimed');
  });
  afterAll(async () => { await fixture?.stop(); });

  it('TS.F.projectThin launches as a member with the model from the Team Project defaults leaf', async () => {
    await fixture.assertKnownGoodSessionControl(admin, machine);
    const model = { source: 'native', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-project-model' } as const;
    const teamProjectDefaults = { ...defaults, modelByAgentTargetKey: {
      [model.agentTargetKey]: { v: 2, updatedAt: Date.now(), ref: model },
    } };
    const createdTeam = await admin.executeReviewed('teams.create', { v: 1, name: 'F Project defaults', requestKey: randomUUID(),
      initialOwnerAccountId: readAccountIdFromToken(admin.credentials.token) });
    if (!createdTeam.ok) throw new Error(`Team creation refused (${createdTeam.errorCode})`);
    expect(createdTeam.ok).toBe(true);
    const teamId = TeamSummaryV1Schema.parse(createdTeam.result).id;
    const created = await admin.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'F Project', owner: { kind: 'team', teamId }, requestKey: randomUUID() });
    if (!created.ok) throw new Error(`Source creation refused (${created.errorCode})`);
    expect(created.ok).toBe(true);
    const initial = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!initial.ok) throw new Error(`Source creation refused (${initial.error})`);
    const updated = await admin.executeReviewed('projects.sources.update', { serverId: fixture.serverId,
      sourceId: initial.source.id, expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults: teamProjectDefaults } } });
    // Initial behavioral RED: the existing Source Action rejects this defaults edit.
    if (!updated.ok) throw new Error(`Defaults write refused (${updated.errorCode})`);
    expect(updated.ok).toBe(true);
    expect(updated.result).toMatchObject({ ok: true, source: { revision: initial.source.revision },
      sessionDefaults: { revision: expect.any(Number), defaults: teamProjectDefaults } });
    const read = await admin.execute('projects.sources.read', { serverId: fixture.serverId, sourceId: initial.source.id });
    if (!read.ok) throw new Error(`Defaults read refused (${read.errorCode})`);
    expect(read.ok).toBe(true);
    expect(read.result).toMatchObject({ sessionDefaults: { defaults: teamProjectDefaults } });
    const missingMachine = await admin.executeReviewed('projects.sources.update', { serverId: fixture.serverId,
      sourceId: initial.source.id, expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 1, defaults: {
        ...defaults, placement: { kind: 'machine', target: { serverId: fixture.serverId, machineId: randomUUID() } },
      } } } });
    expect(missingMachine).toMatchObject({ ok: true, result: {
      ok: false, error: 'managed_default_machine_not_member_usable',
    } });
    const listed = await admin.execute('projects.sources.list', { serverId: fixture.serverId });
    if (!listed.ok) throw new Error(`Source listing refused (${listed.errorCode})`);
    expect(listed.ok).toBe(true);
    expect(listed.result).toMatchObject({ sources: [expect.not.objectContaining({ sessionDefaults: expect.anything() })] });

    const member = await fixture.createAccount('defaults-member');
    const outsider = await fixture.createAccount('defaults-outsider');
    const audienceTeam = await admin.executeReviewed('teams.create', { v: 1, name: 'F Audience only', requestKey: randomUUID(),
      initialOwnerAccountId: readAccountIdFromToken(admin.credentials.token) });
    if (!audienceTeam.ok) throw new Error(`Audience Team creation refused (${audienceTeam.errorCode})`);
    const audienceTeamId = TeamSummaryV1Schema.parse(audienceTeam.result).id;
    expect(await admin.executeReviewed('teams.members.add', { v: 1, teamId: audienceTeamId,
      accountId: readAccountIdFromToken(outsider.credentials.token), role: 'admin', historyAccess: 'all_existing' }))
      .toMatchObject({ ok: true });
    const membership = await admin.executeReviewed('teams.members.add', { v: 1, teamId,
      accountId: readAccountIdFromToken(member.credentials.token), role: 'member', historyAccess: 'all_existing' });
    if (!membership.ok) throw new Error(`Member admission refused (${membership.errorCode})`);
    expect(membership.ok).toBe(true);
    const membershipId = TeamMembershipV1Schema.parse(membership.result).id;
    const selected = { serverId: fixture.serverId, sourceId: initial.source.id };
    const memberRead = await member.execute('projects.sources.read', selected);
    expect(memberRead).toMatchObject({ ok: true, result: { sessionDefaults: { defaults: teamProjectDefaults } } });
    const memberMachine = await fixture.enrollDaemon(member);
    const memberControl = await fixture.assertKnownGoodSessionControl(member, memberMachine);
    const launched = await member.executeAsPerson('session.spawn_new', {
      executionTarget: memberMachine.target, directory: { kind: 'path', path: memberMachine.workspaceDir },
      projectContext: { sourceRef: selected }, terminal: { mode: 'plain' },
    });
    if (!launched.ok) throw new Error(`Member Project launch refused (${launched.errorCode})`);
    const createdSession = SessionSpawnNewActionResultV1Schema.parse(launched.result);
    if (createdSession.type !== 'success') throw new Error(`Member Project launch did not create a Session (${createdSession.type})`);
    expect(await member.readSessionMetadata(createdSession.sessionId)).toMatchObject({
      machineId: memberMachine.target.machineId, path: memberMachine.workspaceDir,
      modelSelectionIntentV2: { v: 2, ref: model },
    });
    expect(memberControl.metadata.modelSelectionIntentV2?.ref).not.toEqual(model);
    const memberWrite = await member.executeReviewed('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults: null } } });
    expect(memberWrite).toMatchObject({ ok: true, result: { ok: false, error: 'source_access_denied' } });
    const placementWrite = await admin.executeReviewed('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 1,
        defaults: { ...defaults, placement: { kind: 'machine', target: machine.target } } } } });
    expect(placementWrite).toMatchObject({ ok: true, result: {
      ok: false, error: 'managed_default_machine_not_member_usable',
    } });
    const staleWrite = await admin.executeReviewed('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults: null } } });
    expect(staleWrite).toMatchObject({ ok: true, result: { ok: false, error: 'source_conflict' } });
    const granted = await admin.executeReviewed('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { audience: [{ principal: { kind: 'team', teamId: audienceTeamId }, level: 'view' }] } });
    if (!granted.ok) throw new Error(`Audience grant refused (${granted.errorCode})`);
    expect(granted.ok).toBe(true);
    const grantedSource = ProjectSourcesReadOutputV1Schema.parse(granted.result);
    if (!grantedSource.ok) throw new Error(`Audience grant refused (${grantedSource.error})`);
    const outsiderRead = await outsider.execute('projects.sources.read', selected);
    if (!outsiderRead.ok) throw new Error(`Audience Source read refused (${outsiderRead.errorCode})`);
    expect(outsiderRead.ok).toBe(true);
    // Audience Team admins manage Source metadata and read defaults, but the owner side alone writes them.
    expect(outsiderRead.result).toMatchObject({ canManage: true, canManageSessionDefaults: false,
      sessionDefaults: { revision: 1, defaults: teamProjectDefaults } });
    const outsiderDefaults = await outsider.execute('projects.sessionDefaults.get', { sourceRef: selected });
    expect(outsiderDefaults).toMatchObject({ ok: true, result: {
      context: { projectDefaults: teamProjectDefaults, teamDefaults: null },
      sourceDefaultsRow: { revision: 1, defaults: teamProjectDefaults }, canManageSource: false,
    } });
    const outsiderWrite = await outsider.executeReviewed('projects.sources.update', { ...selected,
      expectedRevision: grantedSource.source.revision,
      patch: { sessionDefaults: { expectedRevision: 1, defaults: null } } });
    expect(outsiderWrite).toMatchObject({ ok: true, result: { ok: false, error: 'source_access_denied' } });
    // Defaults have their own CAS, independent of an intervening ordinary Source edit.
    const clear = await admin.executeReviewed('projects.sources.update', { ...selected,
      expectedRevision: initial.source.revision,
      patch: { sessionDefaults: { expectedRevision: 1, defaults: null } } });
    expect(clear).toMatchObject({ ok: true, result: { ok: true, canManageSessionDefaults: true,
      source: { revision: grantedSource.source.revision }, sessionDefaults: { revision: 2, defaults: null } } });
    const restore = await admin.executeReviewed('projects.sources.update', { ...selected,
      expectedRevision: grantedSource.source.revision,
      patch: { sessionDefaults: { expectedRevision: 2, defaults: teamProjectDefaults } } });
    expect(restore).toMatchObject({ ok: true, result: { ok: true, sessionDefaults: { revision: 3, defaults: teamProjectDefaults } } });
    expect(await admin.executeReviewed('teams.members.remove', { v: 1, teamId, membershipId })).toMatchObject({ ok: true });
    const revokedRead = await member.execute('projects.sources.read', selected);
    expect(revokedRead).toMatchObject({ ok: true, result: { ok: false, error: 'source_unavailable' } });
  });

  it('TS.F.accountSource uses the same defaults leaf and existing Source authority', async () => {
    await fixture.assertKnownGoodSessionControl(admin, machine);
    const other = await fixture.createAccount('defaults-account-unrelated');
    const created = await admin.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'F Account Project', requestKey: randomUUID() });
    if (!created.ok) throw new Error(`Account Source creation refused (${created.errorCode})`);
    const initial = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!initial.ok) throw new Error(`Account Source creation refused (${initial.error})`);
    const selected = { serverId: fixture.serverId, sourceId: initial.source.id };
    const saved = await admin.executeReviewed('projects.sources.update', { ...selected, expectedRevision: initial.source.revision,
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
    if (!absent.ok) throw new Error(`Demanded defaults read refused (${absent.errorCode})`);
    expect(absent.ok).toBe(true);
    expect(absent.result).toMatchObject({ personalDefaultsRow: null });
    const saved = await admin.executeReviewed('projects.organization.update', { projectRef, expectedRevision: 'absent',
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

  it('TS.F.personalProject saves a deliberate pick for a real Project and applies it to a new CLI Session', async () => {
    const control = await fixture.assertKnownGoodSessionControl(admin, machine);
    const opened = await admin.executeAsPerson('projects.open', { ...machine.target,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } });
    if (!opened.ok) throw new Error(`Opening the defaults Project refused (${opened.errorCode})`);
    const project = OpenProjectResultV1Schema.parse(opened.result);
    if (project.kind !== 'opened' || !project.facts?.projectKey) throw new Error('Opened Project omitted its canonical key');
    const projectRef = { serverId: fixture.serverId, projectKey: project.facts.projectKey };
    const model = { source: 'native', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'personal-project-model' } as const;
    const personalDefaults = { ...defaults, placement: { kind: 'machine', target: machine.target },
      modelByAgentTargetKey: { [model.agentTargetKey]: { v: 2, updatedAt: Date.now(), ref: model } } };
    const saved = await admin.executeReviewed('projects.organization.update', { projectRef, expectedRevision: 'absent',
      sessionDefaults: { expectedRevision: 'absent', defaults: personalDefaults } });
    if (!saved.ok) throw new Error(`Personal defaults write refused (${saved.errorCode})`);
    const savedDefaults = ProjectOrganizationUpdateOutputV1Schema.parse(saved.result);
    if (!savedDefaults.ok || !('sessionDefaults' in savedDefaults)) {
      throw new Error('Personal Project write did not return its defaults leaf');
    }
    expect(savedDefaults.sessionDefaults.defaults).toEqual(personalDefaults);
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

    const launched = await fixture.createSessionFromArgv(machine,
      ['--project-context-json', JSON.stringify({ projectRef })], 'personal-project-defaults');
    expect(launched).toMatchObject({ ok: true, kind: 'session_create', data: { session: { id: expect.any(String) } } });
    if (!isRecord(launched.data) || !isRecord(launched.data.session) || typeof launched.data.session.id !== 'string') {
      throw new Error('CLI did not return the personal Project Session identity');
    }
    const sessionId = launched.data.session.id;
    const inherited = await admin.readSessionMetadata(sessionId);
    expect(inherited).toMatchObject({ machineId: machine.target.machineId, path: machine.workspaceDir,
      modelSelectionIntentV2: { v: 2, ref: model } });
    expect(control.metadata.modelSelectionIntentV2?.ref).not.toEqual(model);

    const sent = await admin.execute('session.message.send', { sessionId, message: 'Verify the selected Project model.' });
    expect(sent).toMatchObject({ ok: true, result: { status: 'accepted' } });
    await fixture.assertSessionAgentOutput(admin, sessionId);
    const invocation = await waitForFakeClaudeInvocation(agent.logPath, item =>
      item.cwd === machine.workspaceDir && item.argv.includes(model.modelId));
    expect(invocation.argv[invocation.argv.indexOf('--model') + 1]).toBe(model.modelId);

    const cleared = await admin.executeReviewed('projects.organization.update', { projectRef, expectedRevision: 'absent',
      sessionDefaults: { expectedRevision: savedDefaults.sessionDefaults.revision, defaults: null } });
    expect(cleared).toMatchObject({ ok: true, result: { ok: true, sessionDefaults: { defaults: null } } });
    const afterClear = await admin.execute('projects.sessionDefaults.get', { projectRef });
    expect(afterClear).toMatchObject({ ok: true, result: { context: { personalProjectDefaults: null } } });
    expect(await admin.readSessionMetadata(sessionId)).toMatchObject({
      modelSelectionIntentV2: { v: 2, ref: model },
    });
  });
});
