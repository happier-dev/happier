import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { HomeSettingsProjectionV1Schema } from '@happier-dev/protocol/home/governance/settings';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let fixture: TeamSetupFFixture | undefined;
let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'teams-home-governance-journey-'));
  console.info(`[TH.J7.fixture] ${testDir}`);
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres',
    serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
}, 0);

afterAll(async () => {
  try { await fixture?.stop(); } finally { await postgres?.stop(); }
}, 0);

it('TH.J7 keeps a Team default profile tighten-only until its member picks it and round-trips Home settings revisions', async () => {
  if (!fixture) throw new Error('Home governance fixture did not start');
  const owner = await fixture.createAccount('governance-owner');
  const member = await fixture.createAccount('governance-member');
  const ownerId = readAccountIdFromToken(owner.credentials.token);
  const memberId = readAccountIdFromToken(member.credentials.token);
  await fixture.claimHomeOwner(owner);
  const agent = await createIsolatedFakeClaudeControlShim({ testDir, invocationId: 'governance-control',
    captureEnvironmentKeys: [], logFullStdin: true });
  const machine = await fixture.enrollDaemon(member, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });

  // The same member, Home, terminal credential and daemon must work before an
  // inherited-profile Ask can count as a meaningful refusal.
  const control = await fixture.assertKnownGoodSessionControl(member, machine);
  const prompt = 'Confirm the Team governance journey reaches its enrolled Agent.';
  expect(await member.execute('session.message.send', { sessionId: control.sessionId, message: prompt }))
    .toMatchObject({ ok: true });
  expect(await waitForFakeClaudeUserText(agent.logPath, text => text.includes(prompt),
    { invocationId: 'governance-control' })).toContain(prompt);
  console.info('[TH.J7.control] The enrolled Agent received the known-good Session input');
  const guardedAction = 'artifact.create';
  const profileWrite = await member.execute('actions.policy.set', { profileChange: { kind: 'create', profile: {
    name: 'Team suggested waiver', approvalWaivedSurfaces: { [guardedAction]: ['agent'] },
  } } }, { presentUserConfirmation: { actionId: 'actions.policy.set' } });
  expect(profileWrite, JSON.stringify(profileWrite)).toMatchObject({ ok: true });
  if (!profileWrite.ok) throw new Error(profileWrite.errorCode);
  const profileOutput = ActionPolicyOutputSchemas['actions.policy.set'].parse(profileWrite.result);
  if (!('profileChange' in profileOutput)) throw new Error('Profile write did not return its catalog entry');
  const profileId = profileOutput.profileChange.id;
  if (!profileId) throw new Error('Profile write returned no id');
  const controlStored = await fetchSessionV2(fixture.server.baseUrl, member.credentials.token, control.sessionId);
  expect(await member.execute('session.approval_profile.set', { sessionId: control.sessionId,
    serverId: fixture.serverId, expectedMetadataRevision: controlStored.metadataVersion, approvalProfileId: profileId },
  { presentUserConfirmation: { actionId: 'session.approval_profile.set' } })).toMatchObject({ ok: true });
  expect(await member.readSessionMetadata(control.sessionId)).toMatchObject({
    approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: false,
  });
  const controlArtifactId = randomUUID();
  const controlWrite = await member.execute(guardedAction, { artifactId: controlArtifactId,
    header: { title: 'Known-good Session artifact control' }, body: 'The real artifact path works' },
  { surface: 'agent', authority: 'account_automation', defaultSessionId: control.sessionId,
    actionCaller: { kind: 'session', sessionId: control.sessionId, starterDepth: 0, turnDepth: 0 } });
  expect(controlWrite, JSON.stringify(controlWrite)).toMatchObject({ ok: true, result: { artifactId: controlArtifactId } });
  expect(await member.execute('artifact.get', { artifactId: controlArtifactId }))
    .toMatchObject({ ok: true, result: { artifact: { artifactId: controlArtifactId, body: 'The real artifact path works' } } });

  const initialSettings = await owner.execute('home.settings.get', {});
  expect(initialSettings).toMatchObject({ ok: true });
  if (!initialSettings.ok) throw new Error(initialSettings.errorCode);
  const before = HomeSettingsProjectionV1Schema.parse(initialSettings.result);
  const displayName = `Governed Home ${randomUUID()}`;
  const savedSettings = await owner.execute('home.settings.set', { expectedRevision: before.revision,
    values: { HAPPIER_HOME_DISPLAY_NAME: displayName } },
  { presentUserConfirmation: { actionId: 'home.settings.set' } });
  expect(savedSettings).toMatchObject({ ok: true });
  if (!savedSettings.ok) throw new Error(savedSettings.errorCode);
  const saved = HomeSettingsProjectionV1Schema.parse(savedSettings.result);
  expect(saved.revision).toBe(before.revision + 1);
  const rereadSettings = await owner.execute('home.settings.get', {});
  expect(rereadSettings).toMatchObject({ ok: true });
  if (!rereadSettings.ok) throw new Error(rereadSettings.errorCode);
  const reread = HomeSettingsProjectionV1Schema.parse(rereadSettings.result);
  expect(reread.revision).toBe(saved.revision);
  expect(reread.entries.find(entry => entry.key === 'HAPPIER_HOME_DISPLAY_NAME'))
    .toMatchObject({ value: displayName, source: 'home' });
  expect(await owner.execute('home.settings.set', { expectedRevision: before.revision,
    values: { HAPPIER_HOME_DISPLAY_NAME: 'Stale editor' } },
  { presentUserConfirmation: { actionId: 'home.settings.set' } }))
    .toMatchObject({ ok: false, errorCode: 'home_settings_revision_conflict' });

  const created = await owner.execute('teams.create', { v: 1, name: 'Governance defaults',
    initialOwnerAccountId: ownerId, requestKey: randomUUID() },
  { presentUserConfirmation: { actionId: 'teams.create' } });
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw new Error(created.errorCode);
  const team = TeamSummaryV1Schema.parse(created.result);
  expect(await owner.execute('teams.members.add', { v: 1, teamId: team.id, accountId: memberId,
    role: 'member', historyAccess: 'all_existing' },
  { presentUserConfirmation: { actionId: 'teams.members.add' } })).toMatchObject({ ok: true });

  expect(await member.execute('actions.policy.set', { actionId: guardedAction, audience: 'agent', mode: 'ask_first' },
    { presentUserConfirmation: { actionId: 'actions.policy.set' } }))
    .toMatchObject({ ok: true, result: { actionId: guardedAction, audience: 'agent', mode: 'ask_first' } });
  expect(await member.execute('actions.policy.get', { actionId: guardedAction, audience: 'agent' }))
    .toMatchObject({ ok: true, result: { actionId: guardedAction, audience: 'agent', mode: 'ask_first' } });
  expect(await owner.execute('teams.policy.set', { v: 1, teamId: team.id,
    managedDefaults: { team: { approvalProfileId: profileId }, groups: {} } },
  { presentUserConfirmation: { actionId: 'teams.policy.set' } })).toMatchObject({ ok: true });
  const createdSource = await owner.execute('projects.sources.create', { serverId: fixture.serverId,
    name: 'Team governance Project', owner: { kind: 'team', teamId: team.id }, requestKey: randomUUID() },
  { presentUserConfirmation: { actionId: 'projects.sources.create' } });
  expect(createdSource).toMatchObject({ ok: true });
  if (!createdSource.ok) throw new Error(createdSource.errorCode);
  const source = ProjectSourcesReadOutputV1Schema.parse(createdSource.result);
  if (!source.ok) throw new Error(source.error);
  const spawned = await member.execute('session.spawn_new', { executionTarget: machine.target,
    directory: { kind: 'path', path: machine.workspaceDir },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    projectContext: { sourceRef: { serverId: fixture.serverId, sourceId: source.source.id } },
    terminal: { mode: 'plain' } });
  expect(spawned).toMatchObject({ ok: true });
  if (!spawned.ok) throw new Error(spawned.errorCode);
  const session = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
  if (session.type !== 'success') throw new Error(`Governed Session did not start (${session.type})`);
  expect(await member.readSessionMetadata(session.sessionId)).toMatchObject({
    approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: true,
  });
  console.info('[TH.J7.inherited] The Team default reached the committed Session');

  const caller = { surface: 'agent', authority: 'account_automation', defaultSessionId: session.sessionId,
    actionCaller: { kind: 'session', sessionId: session.sessionId, starterDepth: 0, turnDepth: 0 } } as const;
  const pending = await member.execute(guardedAction, { artifactId: randomUUID(),
    header: { title: 'Inherited profile must still ask' }, body: 'Governance approval control' }, caller);
  expect(pending).toMatchObject({ ok: true });
  if (!pending.ok) throw new Error(pending.errorCode);
  const approval = ActionApprovalRequestCreatedResultSchema.parse(pending.result);
  expect(await member.execute('approval.request.get', { artifactId: approval.artifactId }))
    .toMatchObject({ ok: true, result: { request: { status: 'open', actionId: guardedAction } } });
  expect(await member.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'reject' },
    { presentUserConfirmation: { actionId: 'approval.request.decide' } })).toMatchObject({ ok: true });

  const stored = await fetchSessionV2(fixture.server.baseUrl, member.credentials.token, session.sessionId);
  expect(await member.execute('session.approval_profile.set', { sessionId: session.sessionId,
    serverId: fixture.serverId, expectedMetadataRevision: stored.metadataVersion, approvalProfileId: profileId },
  { presentUserConfirmation: { actionId: 'session.approval_profile.set' } })).toMatchObject({ ok: true });
  expect(await member.readSessionMetadata(session.sessionId)).toMatchObject({
    approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: false,
  });
  const artifactId = randomUUID();
  expect(await member.execute(guardedAction, { artifactId,
    header: { title: 'Member explicitly picked the profile' }, body: 'Explicit waiver applied' }, caller))
    .toMatchObject({ ok: true, result: { artifactId } });
  expect(await member.execute('artifact.get', { artifactId }))
    .toMatchObject({ ok: true, result: { artifact: { artifactId, body: 'Explicit waiver applied' } } });
}, 0);
