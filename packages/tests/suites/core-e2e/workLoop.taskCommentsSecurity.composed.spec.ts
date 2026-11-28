import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ACTION_INVOKE_ACTION_ID_V1, SESSION_PERMISSION_MODE_SET_ACTION_ID_V1, type ActionId,
} from '@happier-dev/protocol/actions/actionIds';
import { ActionExecuteResultSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  InternalTaskDeleteOutputSchema, InternalTaskMutationOutputSchema, InternalTaskReadOutputSchema, TaskResourceV1Schema,
  type TaskResourceAddressV1,
} from '@happier-dev/protocol/actions/internalTaskActions';
import {
  buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
  DiscussionCreateResultV1Schema,
  DiscussionListResultV1Schema,
  DiscussionPostResultV1Schema,
  DiscussionReadResultV1Schema,
} from '@happier-dev/protocol/discussions/actions';
import { DISCUSSION_HTTP_PATHS_V1, DiscussionAttentionResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { isExternalTaskDiscussionId } from '@happier-dev/protocol/discussions/references';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_PLUGIN_ID } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { encodeGithubTriageConfiguration, GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1 } from '../../../plugins/scm-github/src/triage/configuration';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1, GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { GithubCommentCreateInputV1Schema } from '../../../plugins/scm-github/src/triage/mutations/contracts';
import { createIsolatedFakeClaudeControlShim, FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS, readFakeClaudeLogEvents } from '../../src/testkit/fakeClaude';
import { fetchAccountId } from '../../src/testkit/socialFriends';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createServerLightDatabaseClient } from '../../src/testkit/process/serverLightDatabase';
import { createRunDirs } from '../../src/testkit/runDir';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { waitFor } from '../../src/testkit/timing';

type Account = Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
const run = createRunDirs({ runLabel: 'work-loop-task-comments-security' });
let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let fixture: TeamSetupFFixture;
let owner: Account;
let agent: Readonly<{ sessionId: string; logPath: string }>;

async function act(account: Account, actionId: ActionId, input: unknown) {
  const result = await account.execute(actionId, input, { presentUserConfirmation: { actionId } });
  if (!result.ok) throw createActionExecuteFailureError(result);
  return result.result;
}

async function readHttp(account: Account, path: string) {
  const response = await fetch(new URL(path, fixture.server.baseUrl), { headers: {
    Authorization: `Bearer ${account.credentials.token}`,
    ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
  } });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return body;
}

async function readTaskResource(account: Account, address: TaskResourceAddressV1) {
  return TaskResourceV1Schema.parse(await readHttp(account,
    `/v1/tasks/${encodeURIComponent(address.ownerAccountId)}/${encodeURIComponent(address.taskId)}`));
}

beforeAll(async () => {
  const testDir = run.testDir('task-comments');
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({
    testDir,
    dbProvider: 'postgres',
    daemonAuthentication: 'existing-terminal',
    personActionSurface: 'coreAction',
    observeActionRequests: true,
    advertiseRequestObservationEndpoint: true,
    serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl, HAPPIER_FEATURE_TEAMS__ENABLED: '1',
      HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1' },
  });
  owner = await fixture.createAccount('task-owner');
  expect((await fixture.claimHomeOwner(owner)).result.status).toBe('claimed');
  const vendor = await createIsolatedFakeClaudeControlShim({
    testDir: run.testDir('addressed-agent'), captureEnvironmentKeys: [], logFullStdin: false,
  });
  const { sessionControl } = await fixture.prepareSessionControl(owner, { env: {
    HAPPIER_CLAUDE_PATH: vendor.executablePath, GH_CONFIG_DIR: vendor.configDir,
    GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
  } })();
  agent = { sessionId: sessionControl.sessionId, logPath: vendor.logPath };
}, 0);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const stop of [() => fixture?.stop(), () => postgres?.stop()]) {
    try { await stop(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Task comments fixture cleanup failed');
}, 0);

it('writes and reopens an ordinary encrypted Discussion through the signed Action executor', async () => {
  const title = `Control discussion ${randomUUID()}`;
  const content = textContent('Control message');
  const result = await owner.executeAsPerson('discussion.create', { title, firstMessage: { content } });
  if (!result.ok) throw createActionExecuteFailureError(result);
  const created = DiscussionCreateResultV1Schema.parse(result.result);
  const discussionId = created.discussion.id;
  const listed = DiscussionListResultV1Schema.parse(await act(owner, 'discussion.list', {}));
  expect(listed.discussions).toContainEqual(expect.objectContaining({ id: discussionId, title }));
  const read = DiscussionReadResultV1Schema.parse(await act(owner, 'discussion.read', { discussionId }));
  expect(read.messages).toContainEqual(expect.objectContaining({ content }));
}, 0);

async function createTask(title: string) {
  const created = InternalTaskMutationOutputSchema.parse(await act(owner, 'tasks.internal.create', { fields: { title } }));
  if (created.status !== 'applied') throw new Error(`Task creation settled as ${created.status}`);
  const address = { taskId: created.todo.id, ownerAccountId: created.scope.accountId };
  return { address, scope: created.scope,
    anchorTask: { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(address.taskId, address.ownerAccountId) } };
}

async function createTeam(name: string) {
  const accountId = await fetchAccountId(fixture.server.baseUrl, owner.credentials.token);
  const result = await owner.executeAsPerson('teams.create', { v: 1, name, requestKey: randomUUID(), initialOwnerAccountId: accountId });
  if (!result.ok) throw createActionExecuteFailureError(result);
  return TeamSummaryV1Schema.parse(result.result);
}

async function addMember(teamId: string, member: Account) {
  const accountId = await fetchAccountId(fixture.server.baseUrl, member.credentials.token);
  await act(owner, 'teams.members.add', { v: 1, teamId, accountId, role: 'member', historyAccess: 'all_existing' });
}

const textContent = (text: string) => ({ v: 1, parts: [{ t: 'text', text }] });

it('uses the Task grant for the encrypted thread and rejects an ungranted mention without delivery', async () => {
  const [member, outsider] = await Promise.all([fixture.createAccount('late-team-member'), fixture.createAccount('outsider')]);
  const title = `Unannounced Task ${randomUUID()}`;
  const task = await createTask(title);
  const team = await createTeam('Task comment readers');
  expect((await readTaskResource(owner, task.address)).encryptedDataKey).toBeNull();
  const priorCommentBody = `Written before Team membership ${randomUUID()}`;
  const priorComment = textContent(priorCommentBody);
  const secondComment = textContent('Second comment while opening the same Task');
  const [first, second] = await Promise.all([priorComment, secondComment].map(async content =>
    DiscussionPostResultV1Schema.parse(await act(owner, 'discussion.post', {
      anchorTask: task.anchorTask, content, localId: randomUUID(),
    }))));
  const discussionId = first.message.discussionId;
  expect(second.message.discussionId).toBe(discussionId);
  const promoted = await readTaskResource(owner, task.address);
  expect(promoted.encryptionMode).toBe('e2ee');
  expect(promoted.encryptedDataKey).not.toBeNull();
  const ownerPage = DiscussionListResultV1Schema.parse(await act(owner, 'discussion.list', { anchorTask: task.anchorTask }));
  expect(ownerPage.discussions.map(row => row.id)).toEqual([discussionId]);
  const defaultList = DiscussionListResultV1Schema.parse(await act(owner, 'discussion.list', {}));
  expect(defaultList.discussions.map(row => row.id)).not.toContain(discussionId);

  const outsiderId = await fetchAccountId(fixture.server.baseUrl, outsider.credentials.token);
  const mentionBody = `Before sharing ${randomUUID()}`;
  const mention = await owner.execute('discussion.post', {
    anchorTask: task.anchorTask,
    content: { v: 1, parts: [
      { t: 'mention', participant: { kind: 'account', accountId: outsiderId } }, { t: 'text', text: mentionBody },
    ] },
    localId: randomUUID(),
  }, { presentUserConfirmation: { actionId: 'discussion.post' } });
  expect(mention).toMatchObject({ ok: false, errorCode: 'discussion_task_share_required' });
  const outsiderPage = DiscussionListResultV1Schema.parse(await act(outsider, 'discussion.list', { anchorTask: task.anchorTask }));
  expect(outsiderPage.discussions).toEqual([]);
  const attention = DiscussionAttentionResponseV1Schema.parse(await readHttp(outsider, DISCUSSION_HTTP_PATHS_V1.attention));
  expect(attention.discussions).toEqual([]);
  const outsiderRead = await outsider.execute('discussion.read', { discussionId });
  expect(outsiderRead).toMatchObject({ ok: false });
  const outsiderResponse = JSON.stringify([outsiderRead, outsiderPage, attention]);
  for (const sentinel of [title, priorCommentBody, mentionBody]) expect(outsiderResponse).not.toContain(sentinel);

  const shared = await act(owner, 'tasks.internal.share', { scope: task.scope, ...task.address,
    principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' });
  expect(shared).toMatchObject({ status: 'applied' });
  const takeKeyReads = () => fixture.takeRequestObservations()
    .filter(({ method }) => method === 'GET')
    .map(({ path }) => new URL(path, fixture.server.baseUrl).pathname);
  const discussionKeyReads = (paths: readonly string[]) => paths.filter(path =>
    path.startsWith(`${DISCUSSION_HTTP_PATHS_V1.collection}/`) && path.includes('/data-key/'));
  fixture.takeRequestObservations();
  const { connectUiActionClient } = await import('@happier-tests/ui-action-client');
  const ownerUi = await connectUiActionClient({
    serverUrl: fixture.actionServerApiUrl, addressAnchorUrl: fixture.server.baseUrl, credentials: owner.uiCredentials,
  });
  try {
    await waitFor(() => ownerUi.isAccountReady(), { context: 'Task keyholder Account sync ready' });
    expect(discussionKeyReads(takeKeyReads())).toEqual([]);
    await addMember(team.id, member);
    await waitFor(async () => {
      const read = InternalTaskReadOutputSchema.parse(await act(member, 'tasks.internal.read', task.address));
      return read.status === 'applied' && read.todo.title === title;
    }, { context: 'membership push delivers the existing Task key to the new member' });
    const delivery = takeKeyReads();
    expect(delivery).toContain('/v1/tasks/recipients/owed');
    expect(discussionKeyReads(delivery)).toEqual([]);
    const history = DiscussionReadResultV1Schema.parse(await act(member, 'discussion.read', { discussionId }));
    expect(history.messages.map(message => message.content)).toEqual(expect.arrayContaining([priorComment, secondComment]));
    expect(history.messages).toHaveLength(2);
    expect(history.incomplete).toBe(false);
  } finally {
    await ownerUi.close();
  }

  const databaseUrl = fixture.server.databaseUrl;
  if (!databaseUrl) throw new Error('Task comments fixture omitted its disposable PostgreSQL URL');
  const database = await createServerLightDatabaseClient('postgres', databaseUrl);
  try {
    expect(await database.$queryRawUnsafe('SELECT id FROM "DiscussionGrant" WHERE "discussionId" = $1', discussionId)).toEqual([]);
    expect(await database.$queryRawUnsafe('SELECT "recipientAccountId" FROM "DiscussionKeyEnvelope" WHERE "discussionId" = $1', discussionId)).toEqual([]);
  } finally {
    await database.$disconnect();
  }
}, 0);

it('requires a qualified Team sign-in on both Task and Task Discussion actions', async () => {
  const member = await fixture.createAccount('member-without-required-sign-in');
  const title = `Restricted Team Task ${randomUUID()}`;
  const task = await createTask(title);
  const team = await createTeam('Restricted Task readers');
  const posted = DiscussionPostResultV1Schema.parse(await act(owner, 'discussion.post', {
    anchorTask: task.anchorTask, content: textContent('Comment on a Team Task'), localId: randomUUID(),
  }));
  const discussionId = posted.message.discussionId;
  await addMember(team.id, member);
  expect(await act(owner, 'tasks.internal.share', { scope: task.scope, ...task.address,
    principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' })).toMatchObject({ status: 'applied' });
  expect(await act(member, 'tasks.internal.read', task.address)).toMatchObject({ status: 'applied', todo: { title } });
  expect(await act(member, 'discussion.read', { discussionId })).toMatchObject({
    messages: [expect.objectContaining({ content: textContent('Comment on a Team Task') })],
  });
  // Start with a policy previously set by a qualified administrator. This fixture's
  // credentials are issued by the real key-challenge route, so they lack password proof.
  const databaseUrl = fixture.server.databaseUrl;
  if (!databaseUrl) throw new Error('Task comments fixture omitted its disposable PostgreSQL URL');
  const database = await createServerLightDatabaseClient('postgres', databaseUrl);
  const authenticationPolicy = { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'email_password' }] };
  try {
    await database.$transaction(tx => tx.$executeRawUnsafe(
      'UPDATE "Team" SET "authenticationPolicy" = $1::jsonb WHERE id = $2', JSON.stringify(authenticationPolicy), team.id));
  } finally {
    await database.$disconnect();
  }
  const restricted = await member.execute('teams.get', { v: 1, teamId: team.id });
  expect(restricted).toMatchObject({ ok: false, errorCode: 'team_authentication_required' });
  const taskRead = await act(member, 'tasks.internal.read', task.address);
  const discussionList = await member.execute('discussion.list', { anchorTask: task.anchorTask });
  const discussionRead = await member.execute('discussion.read', { discussionId });
  expect.soft(taskRead).toEqual({ status: 'refused', reason: 'team_authentication_required' });
  expect.soft(discussionList).toMatchObject({ ok: false, errorCode: 'team_authentication_required' });
  expect(discussionRead).toMatchObject({ ok: false, errorCode: 'team_authentication_required' });
});

it('keeps a Discussion-addressed Agent turn from invoking a public provider comment', async () => {
  // The shared Session control defaults to read-only. Exercise the Internal
  // destination admission with ordinary Agent permissions available.
  const permission = await owner.executeAsPerson(SESSION_PERMISSION_MODE_SET_ACTION_ID_V1, {
    sessionId: agent.sessionId, permissionMode: 'default', applyTiming: 'immediate',
  });
  expect(permission).toMatchObject({ ok: true, result: { ok: true } });
  expect(await owner.readSessionMetadata(agent.sessionId)).toMatchObject({ permissionMode: 'default' });
  const action = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentCreate };
  const actionId = formatQualifiedPluginActionId(action);
  const discovered = await fixture.executeSessionMcpAction(owner, agent, 'action.spec.get', { id: actionId });
  expect(discovered).toMatchObject({ ok: true, result: { actionSpec: { id: actionId, executionPlacement: 'machine' } } });

  const source = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 };
  const localRef = { kindId: 'issue', collisionScope: 'github:8815', entryId: '7' };
  const target = 'happier-test-fixtures/internal-only';
  const token = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: [target] } });
  if (!token) throw new Error('GitHub source fixture configuration could not encode');
  const input = GithubCommentCreateInputV1Schema.parse({
    v: 1, localRef, routingToken: target, body: 'Stay in the addressed Internal Discussion',
    instance: { v: 1, instance: { source, sourceInstanceId: randomUUID() }, localInstanceKey: GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1,
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
      configuration: { v: 1, token } },
  });
  const requestId = randomUUID();
  await owner.withPersonActionClient(async execute => {
    const opened = await execute('discussion.post', {
      anchorTask: { source, ...localRef }, content: textContent('Private context'), localId: randomUUID(),
    });
    if (!opened.ok) throw createActionExecuteFailureError(opened);
    const discussionId = DiscussionPostResultV1Schema.parse(opened.result).message.discussionId;
    expect(isExternalTaskDiscussionId(discussionId)).toBe(true);
    const participant = { kind: 'session', sessionId: agent.sessionId };
    const invited = await execute('discussion.invite', { discussionId, participant, answerPolicy: 'when_addressed' });
    if (!invited.ok) throw createActionExecuteFailureError(invited);
    const marker = `SESSION_MCP_ACTION_JSON:${JSON.stringify({ requestId, actionId: ACTION_INVOKE_ACTION_ID_V1, input: { action, input } })}`;
    const addressed = await execute('discussion.post', { discussionId, localId: randomUUID(), content: { v: 1,
      parts: [{ t: 'mention', participant }, { t: 'text', text: ` ${marker}` }] } });
    if (!addressed.ok) throw createActionExecuteFailureError(addressed);
  });

  let result: unknown;
  await waitFor(async () => {
    const event = (await readFakeClaudeLogEvents(agent.logPath)).find(entry =>
      entry.type === 'session_mcp_action_result' && entry.requestId === requestId);
    result = event?.result;
    return event !== undefined;
  }, { timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS, context: 'committed Internal Discussion mention reaches the Agent Action host' });
  expect(ActionExecuteResultSchema.parse(result)).toMatchObject({
    ok: false, errorCode: 'discussion_internal_reply_required', effectAttempted: false,
  });
}, 0);

it('shares an external Internal Discussion with a Team via canonical grants while keeping outsiders out and M7 intact', async () => {
  const [member, outsider] = await Promise.all([
    fixture.createAccount('external-internal-team-member'),
    fixture.createAccount('external-internal-outsider'),
  ]);
  const memberAccountId = await fetchAccountId(fixture.server.baseUrl, member.credentials.token);
  const team = await createTeam('External Internal Team');
  await addMember(team.id, member);

  const source = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 };
  const localRef = { kindId: 'issue', collisionScope: 'github:9912', entryId: '42' };
  const anchorTask = { source, ...localRef };
  const ownerMessageBody = `External Internal owner context ${randomUUID()}`;
  const memberReplyBody = `External Internal Team member reply ${randomUUID()}`;

  const opened = DiscussionPostResultV1Schema.parse(await act(owner, 'discussion.post', {
    anchorTask, content: textContent(ownerMessageBody), localId: randomUUID(),
  }));
  const discussionId = opened.message.discussionId;
  expect(isExternalTaskDiscussionId(discussionId)).toBe(true);

  const granted = await owner.executeAsPerson('discussion.access.grants.set', {
    discussionId,
    principal: { kind: 'team', teamId: team.id },
    accessLevel: 'edit',
  });
  if (!granted.ok) throw createActionExecuteFailureError(granted);

  const databaseUrl = fixture.server.databaseUrl;
  if (!databaseUrl) throw new Error('Task comments fixture omitted its disposable PostgreSQL URL');
  const database = await createServerLightDatabaseClient('postgres', databaseUrl);
  try {
    expect(await database.$queryRawUnsafe(
      'SELECT "teamId", "accessLevel" FROM "DiscussionGrant" WHERE "discussionId" = $1 AND "teamId" = $2',
      discussionId, team.id,
    )).toEqual([{ teamId: team.id, accessLevel: 'edit' }]);
    expect(await database.$queryRawUnsafe(
      'SELECT "recipientAccountId" FROM "DiscussionKeyEnvelope" WHERE "discussionId" = $1 AND "recipientAccountId" = $2',
      discussionId, memberAccountId,
    )).toEqual([{ recipientAccountId: memberAccountId }]);
  } finally {
    await database.$disconnect();
  }

  const memberList = DiscussionListResultV1Schema.parse(await act(member, 'discussion.list', { anchorTask }));
  expect(memberList.discussions.map(row => row.id)).toEqual([discussionId]);
  const memberRead = DiscussionReadResultV1Schema.parse(await act(member, 'discussion.read', { discussionId }));
  expect(memberRead.incomplete).toBe(false);
  expect(memberRead.messages).toContainEqual(expect.objectContaining({ content: textContent(ownerMessageBody) }));

  const memberPosted = DiscussionPostResultV1Schema.parse(await act(member, 'discussion.post', {
    discussionId, content: textContent(memberReplyBody), localId: randomUUID(),
  }));
  expect(memberPosted.message.discussionId).toBe(discussionId);
  const ownerRead = DiscussionReadResultV1Schema.parse(await act(owner, 'discussion.read', { discussionId }));
  expect(ownerRead.messages).toContainEqual(expect.objectContaining({ content: textContent(memberReplyBody) }));

  const outsiderList = DiscussionListResultV1Schema.parse(await act(outsider, 'discussion.list', { anchorTask }));
  expect(outsiderList.discussions).toEqual([]);
  const outsiderRead = await outsider.execute('discussion.read', { discussionId });
  expect(outsiderRead).toMatchObject({ ok: false });
  const outsiderPayload = JSON.stringify([outsiderList, outsiderRead]);
  for (const sentinel of [ownerMessageBody, memberReplyBody]) expect(outsiderPayload).not.toContain(sentinel);

  // Verify M7 public-leak guard still blocks an addressed Agent on the Team-shared external Internal Discussion.
  const permission = await owner.executeAsPerson(SESSION_PERMISSION_MODE_SET_ACTION_ID_V1, {
    sessionId: agent.sessionId, permissionMode: 'default', applyTiming: 'immediate',
  });
  expect(permission).toMatchObject({ ok: true, result: { ok: true } });
  const action = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentCreate };
  const target = 'happier-test-fixtures/internal-team-shared';
  const token = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: [target] } });
  if (!token) throw new Error('GitHub source fixture configuration could not encode');
  const input = GithubCommentCreateInputV1Schema.parse({
    v: 1, localRef, routingToken: target, body: 'Must stay inside Team-shared Internal Discussion',
    instance: { v: 1, instance: { source, sourceInstanceId: randomUUID() }, localInstanceKey: GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1,
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
      configuration: { v: 1, token } },
  });
  const requestId = randomUUID();
  await owner.withPersonActionClient(async execute => {
    const participant = { kind: 'session', sessionId: agent.sessionId };
    const invited = await execute('discussion.invite', { discussionId, participant, answerPolicy: 'when_addressed' });
    if (!invited.ok) throw createActionExecuteFailureError(invited);
    const marker = `SESSION_MCP_ACTION_JSON:${JSON.stringify({ requestId, actionId: ACTION_INVOKE_ACTION_ID_V1, input: { action, input } })}`;
    const addressed = await execute('discussion.post', { discussionId, localId: randomUUID(), content: { v: 1,
      parts: [{ t: 'mention', participant }, { t: 'text', text: ` ${marker}` }] } });
    if (!addressed.ok) throw createActionExecuteFailureError(addressed);
  });
  let result: unknown;
  await waitFor(async () => {
    const event = (await readFakeClaudeLogEvents(agent.logPath)).find(entry =>
      entry.type === 'session_mcp_action_result' && entry.requestId === requestId);
    result = event?.result;
    return event !== undefined;
  }, { timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS, context: 'committed Team-shared Internal Discussion mention reaches the Agent Action host' });
  expect(ActionExecuteResultSchema.parse(result)).toMatchObject({
    ok: false, errorCode: 'discussion_internal_reply_required', effectAttempted: false,
  });
}, 0);

it('atomically deletes the anchored Discussion when its Happier Task is deleted', async () => {
  const task = await createTask(`Atomic delete Task ${randomUUID()}`);
  const posted = DiscussionPostResultV1Schema.parse(await act(owner, 'discussion.post', {
    anchorTask: task.anchorTask, content: textContent('Comment deleted with its Task'), localId: randomUUID(),
  }));
  const discussionId = posted.message.discussionId;
  const beforeList = DiscussionListResultV1Schema.parse(await act(owner, 'discussion.list', { anchorTask: task.anchorTask }));
  expect(beforeList.discussions.map(row => row.id)).toEqual([discussionId]);

  const deleted = InternalTaskDeleteOutputSchema.parse(await act(owner, 'tasks.internal.delete', {
    taskId: task.address.taskId,
  }));
  expect(deleted).toMatchObject({ status: 'deleted', taskId: task.address.taskId });

  const afterList = DiscussionListResultV1Schema.parse(await act(owner, 'discussion.list', { anchorTask: task.anchorTask }));
  expect(afterList.discussions).toEqual([]);
  const afterRead = await owner.execute('discussion.read', { discussionId });
  expect(afterRead).toMatchObject({ ok: false });

  const httpResponse = await fetch(new URL(`${DISCUSSION_HTTP_PATHS_V1.collection}/${encodeURIComponent(discussionId)}`, fixture.server.baseUrl), {
    headers: {
      Authorization: `Bearer ${owner.credentials.token}`,
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
    },
  });
  expect(httpResponse.status).toBe(404);

  const databaseUrl = fixture.server.databaseUrl;
  if (!databaseUrl) throw new Error('Task comments fixture omitted its disposable PostgreSQL URL');
  const database = await createServerLightDatabaseClient('postgres', databaseUrl);
  try {
    expect(await database.$queryRawUnsafe('SELECT id FROM "Discussion" WHERE id = $1', discussionId)).toEqual([]);
  } finally {
    await database.$disconnect();
  }
}, 0);
