import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { resolveUsageMeasuredTokens } from '@happier-dev/protocol/usage/usageAggregation';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createIsolatedFakeClaudeControlShim, readFakeClaudeLogEvents, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { createTempDirHandle, type TempDirHandle } from '../../src/testkit/fs/tempDir';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { createRunDirs } from '../../src/testkit/runDir';

let fixture: TeamSetupFFixture | undefined;
let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let workspace: TempDirHandle | undefined;
afterEach(async () => {
  try { await fixture?.stop(); } finally {
    try { await database?.stop(); } finally { await workspace?.cleanup(); }
  }
}, 0);

it('MACH.J5 keeps a Can-use member Session acting as its member and refuses the next request after withdrawal', async () => {
  const startedAt = performance.now();
  const invocationId = randomUUID();
  const testDir = createRunDirs({ runLabel: 'core' }).testDir(`mach-member-journey-${invocationId}`);
  const vendor = await createIsolatedFakeClaudeControlShim({ testDir, invocationId,
    captureEnvironmentKeys: [], logFullStdin: true });
  const suppliedDatabaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
  database = suppliedDatabaseUrl ? undefined : await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', serverEnv: {
    DATABASE_URL: suppliedDatabaseUrl ?? database!.homeDatabaseUrl,
  } });
  const owner = await fixture.createAccount('owner');
  const member = await fixture.createAccount('member');
  await fixture.claimHomeOwner(owner);
  const teamResult = await owner.executeAsPerson('teams.create', { v: 1, name: 'Member journey',
    initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token), requestKey: randomUUID() });
  if (!teamResult.ok) throw new Error(`Member journey Team creation refused: ${JSON.stringify(teamResult)}`);
  const team = TeamSummaryV1Schema.parse(teamResult.result);
  const membership = await owner.executeAsPerson('teams.members.add', { v: 1, teamId: team.id,
    accountId: readAccountIdFromToken(member.credentials.token), role: 'member', historyAccess: 'all_existing' });
  if (!membership.ok) throw new Error(`Member journey Team join refused: ${JSON.stringify(membership)}`);
  workspace = await createTempDirHandle({ prefix: 'machine-member-journey-' });
  const machine = await fixture.enrollDaemon(owner, { workspaceDir: workspace.path,
    env: { HAPPIER_CLAUDE_PATH: vendor.executablePath } });
  const principal = { kind: 'account' as const, accountId: readAccountIdFromToken(member.credentials.token) };
  const grant = await owner.executeAsPerson('machines.access.grant.set', { ...machine.target, principal, level: 'view' });
  expect(grant).toMatchObject({ ok: true, result: { kind: 'saved' } });
  const memberAccess = () => member.execute('machines.access.grants.list', machine.target);
  let access = await memberAccess();
  const initialAccess = access.ok ? MachineAccessGrantsListResponseV1Schema.parse(access.result).access : null;
  let keyPreparation: Awaited<ReturnType<typeof owner.executeAsPerson>> | undefined;
  if (initialAccess?.accessState === 'key_pending') {
    // The Grant is already saved. Use the owner's existing Retry action for key delivery.
    keyPreparation = await owner.executeAsPerson('machines.access.prepareKeys', machine.target);
    access = await memberAccess();
  }
  expect(access, JSON.stringify(keyPreparation)).toMatchObject({ ok: true, result: { access: { accessState: 'ready' } } });
  const signInTarget = { machineId: machine.target.machineId, agentId: 'claude' };
  expect(await member.execute('machines.agents.signIn.status', signInTarget)).toMatchObject({ ok: true });
  const skillText = '---\nname: member-journey\ndescription: Member-owned Session skill\n---\nMember-only skill content.\n';
  const createdSkill = await member.executeAsPerson('skills.create', { name: 'member-journey', files: [
    { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(skillText).toString('base64') },
  ] });
  expect(createdSkill).toMatchObject({ ok: true });
  if (!createdSkill.ok) throw new Error('Member skill creation refused');
  const skill = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(createdSkill.result);
  // A member explicitly confirms the requester's credential disclosure in the
  // real UI review before creating a Session on someone else's Machine.
  const updatedAtMs = Date.now();
  const spawned = await member.executeAsPerson('session.spawn_new', {
    executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    permissionMode: 'read-only', approvalProfileId: null,
    configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
      permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
    connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
  });
  if (!spawned.ok) throw new Error(`Member Session creation refused: ${JSON.stringify(spawned)}`);
  const session = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
  expect(session).toMatchObject({ type: 'success' });
  if (session.type !== 'success') throw new Error(`Member Session creation failed: ${JSON.stringify(session)}`);
  expect(await member.readSessionMetadata(session.sessionId)).toMatchObject({ machineId: machine.target.machineId });
  // The member's outer Send carries the MCP action prompt. The inner Send must
  // execute with the same member authority and reach the provider exactly once.
  const nativeSession = { sessionId: session.sessionId, logPath: vendor.logPath };
  const agentAction = (actionId: ActionId, input: unknown) =>
    fixture!.executeSessionMcpAction(member, nativeSession, actionId, input);
  const signedPrompt = `Hosted signed send ${invocationId}`;
  const isSignedPrompt = (text: string) => text.split('\n').includes(`message=${JSON.stringify(signedPrompt)}`);
  // The requesting tool is in this Session's current turn. Admit its Send as
  // a follow-up so it can be delivered after that turn finishes.
  const send = await agentAction('session.message.send', { sessionId: session.sessionId, message: signedPrompt,
    requestedAction: { v: 1, kind: 'enqueue' } });
  expect(send).toMatchObject({ ok: true, result: { status: 'accepted', localId: expect.any(String) } });
  try {
    await waitForFakeClaudeUserText(vendor.logPath, isSignedPrompt, { invocationId });
  } catch (error) {
    const pending = await listPendingQueueV2({ baseUrl: fixture.server.baseUrl, token: member.auth.token,
      sessionId: session.sessionId, includeDiscarded: true });
    const rows = pending.data.pending?.map(({ localId, status, discardedReason, authorAccountId }) =>
      ({ localId, status, discardedReason, authoredByMember: authorAccountId === principal.accountId }));
    throw new Error(`Signed Send delivery timed out. Pending status ${pending.status}, rows ${JSON.stringify(rows)}`, { cause: error });
  }
  await fixture.assertSessionAgentOutput(member, session.sessionId, 'FAKE_CLAUDE_OK_2');
  const readInput = { sessionId: session.sessionId, skillId: skill.skillId };
  expect(await agentAction('skills.read', readInput)).toMatchObject({ ok: true,
    result: { skillId: skill.skillId, skillMd: skillText } });
  const usage = await member.execute('usage.query', { queries: [{ session: session.sessionId,
    period: { relative: 'today' }, includeTranscriptEvidence: false, includeWorkEvidence: false,
    includeSessionEvidence: false, includeQuotaHistory: false, includeComparison: false }] });
  expect(usage).toMatchObject({ ok: true });
  if (!usage.ok) throw new Error('Member usage unavailable');
  const accounting = UsageQueryBatchResultSchema.parse(usage.result).results[0]?.accounting;
  if (!accounting) throw new Error('Member usage accounting unavailable');
  // The fake vendor reports input/output parts without an aggregate total.
  expect(resolveUsageMeasuredTokens(accounting.totals.tokens).total).toBeGreaterThan(0);
  expect(await member.execute('session.archive', { sessionId: session.sessionId })).toMatchObject({ ok: true });
  expect(await owner.executeAsPerson('machines.access.grant.remove', { ...machine.target, principal }))
    .toMatchObject({ ok: true, result: { kind: 'removed', effectiveAccess: 'none' } });
  expect(await member.execute('machines.agents.signIn.status', signInTarget)).toMatchObject({ ok: false });
  expect(await owner.execute('machines.agents.signIn.status', signInTarget)).toMatchObject({ ok: true });
  const nativeSends = (await readFakeClaudeLogEvents(vendor.logPath)).filter(event =>
    event.invocationId === invocationId && event.type === 'sdk_stdin'
    && isSignedPrompt(event.userText ?? event.userTextPreview ?? ''));
  expect(nativeSends).toHaveLength(1);
  console.info(JSON.stringify({ journey: 'MACH.J5', runtimeMs: Math.round(performance.now() - startedAt), testDir }));
}, 0);
