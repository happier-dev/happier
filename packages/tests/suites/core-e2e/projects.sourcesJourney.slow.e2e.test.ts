import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ProjectDefinitionInspectOutputSchema, ProjectManifestUpdateOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema, projectActionOperationListSnapshotV1, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectSourcesReadOutputV1Schema, ProjectSourcesListOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamMembershipV1Schema } from '@happier-dev/protocol/teams/membership';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const testDir = createRunDirs({ runLabel: 'core' }).testDir(`project-sources-journey-${randomUUID()}`);
let fixture: ProjectDaemonFixture;
let owner: Awaited<ReturnType<ProjectDaemonFixture['createAccount']>>;
let member: Awaited<ReturnType<ProjectDaemonFixture['createAccount']>>;
let machine: Awaited<ReturnType<ProjectDaemonFixture['enrollDaemon']>>;

beforeAll(async () => {
  fixture = await startProjectDaemonFixture({ testDir, observeActionRequests: true });
  owner = await fixture.createAccount('source-author');
  await fixture.claimHomeOwner(owner);
  machine = await fixture.enrollDaemon(owner);
  member = await fixture.createAccount('source-recipient');
}, 0);
afterAll(async () => { await fixture?.stop(); }, 0);

async function action(account: typeof owner, actionId: ActionId, input: unknown) {
  const result = await account.executeAsPerson(actionId, input);
  const requests = fixture.takeRequestObservations();
  expect(result.ok, `${actionId}: ${result.ok ? 'ok' : result.errorCode}; requests=${JSON.stringify(requests)}`).toBe(true);
  if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
  return result.result;
}
function source(result: unknown) {
  const read = ProjectSourcesReadOutputV1Schema.parse(result);
  if (!read.ok) throw new Error(`Source unavailable: ${read.error}`);
  return read.source;
}

it('Source author shares with a Team, recipient reads it, and withdrawal removes access at the next open', async () => {
  const created = source(await action(owner, 'projects.sources.create', { serverId: fixture.serverId,
    name: 'Onboarding journey', requestKey: randomUUID() }));
  const team = TeamSummaryV1Schema.parse(await action(owner, 'teams.create', { v: 1,
    name: 'Source journey Team', initialOwnerAccountId: created.createdByAccountId, requestKey: randomUUID() }));
  const recipientIdentity = source(await action(member, 'projects.sources.create', { serverId: fixture.serverId,
    name: 'Recipient identity', requestKey: randomUUID() }));
  const membership = TeamMembershipV1Schema.parse(await action(owner, 'teams.members.add', {
    v: 1, teamId: team.id, accountId: recipientIdentity.createdByAccountId,
    role: 'member', historyAccess: 'all_existing' }));
  const address = { serverId: fixture.serverId, sourceId: created.id };
  expect(ProjectSourcesReadOutputV1Schema.parse(await action(member, 'projects.sources.read', address)))
    .toMatchObject({ ok: false, error: 'source_unavailable' });
  const shared = source(await action(owner, 'projects.sources.update', { ...address, expectedRevision: created.revision,
    patch: { audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }] } }));
  expect(source(await action(member, 'projects.sources.read', address))).toMatchObject({ id: created.id, name: created.name });
  const list = ProjectSourcesListOutputV1Schema.parse(await action(member, 'projects.sources.list', {
    serverId: fixture.serverId, sharedWithTeamId: team.id }));
  expect(list).toMatchObject({ ok: true, sources: [expect.objectContaining({ id: created.id })] });
  const renamed = source(await action(owner, 'projects.sources.update', { ...address, expectedRevision: shared.revision,
    patch: { name: 'Revised onboarding' } }));
  expect(source(await action(member, 'projects.sources.read', address)).name).toBe('Revised onboarding');
  await action(owner, 'teams.members.remove', { v: 1, teamId: team.id, membershipId: membership.id });
  expect(ProjectSourcesReadOutputV1Schema.parse(await action(member, 'projects.sources.read', address)))
    .toMatchObject({ ok: false, error: 'source_unavailable' });
  const withdrawn = ProjectSourcesListOutputV1Schema.parse(await action(member, 'projects.sources.list', { serverId: fixture.serverId }));
  if (!withdrawn.ok) throw new Error(`Recipient list failed: ${withdrawn.error}`);
  expect(withdrawn.sources.some(row => row.id === created.id)).toBe(false);
  expect(source(await action(owner, 'projects.sources.read', address)).revision).toBe(renamed.revision);
  await action(owner, 'teams.members.add', { v: 1, teamId: team.id, accountId: recipientIdentity.createdByAccountId,
    role: 'member', historyAccess: 'all_existing' });
  expect(source(await action(member, 'projects.sources.read', address))).toMatchObject({ id: created.id, name: 'Revised onboarding' });
  expect(await owner.executeAsPerson('projects.sources.delete', { ...address, expectedRevision: renamed.revision }))
    .toEqual({ ok: true, result: { ok: true, sourceId: created.id, revision: renamed.revision } });
  expect(ProjectSourcesReadOutputV1Schema.parse(await action(owner, 'projects.sources.read', address)))
    .toMatchObject({ ok: false, error: 'source_unavailable' });
  expect(ProjectSourcesReadOutputV1Schema.parse(await action(member, 'projects.sources.read', address)))
    .toMatchObject({ ok: false, error: 'source_unavailable' });
}, 0);

it('Team Source Open links the existing checkout and its recipient inherits the effective project default', async () => {
  const checkout = join(testDir, 'source-open');
  await mkdir(checkout, { recursive: true });
  execFileSync('git', ['init', '--quiet', checkout]);
  const selector = {
    provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'octocat/Hello-World', cloneUrl: 'https://github.com/octocat/Hello-World.git' },
    protocol: 'https',
  } as const;
  execFileSync('git', ['-C', checkout, 'config', 'remote.origin.url', selector.repository.cloneUrl]);
  // Establish the checkout through the CLI Action before mounting the UI caller.
  // This case tests the Source carrier; first-Open push materialization has its
  // own composed coverage and must not hide the Source read behind its wait.
  const attached = await owner.executeReviewed('projects.open', { ...machine.target,
    source: { kind: 'folder', path: checkout }, materialization: { kind: 'attach' } });
  expect(attached.ok, JSON.stringify(attached)).toBe(true);
  if (!attached.ok) throw new Error(attached.errorCode);
  const control = OpenProjectResultV1Schema.parse(attached.result);
  expect(control).toMatchObject({ kind: 'opened', directory: checkout });
  if (control.kind !== 'opened') throw new Error(`Source Open control failed: ${control.kind}`);
  const team = TeamSummaryV1Schema.parse(await action(owner, 'teams.create', { v: 1,
    initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token),
    name: 'Source Open defaults', requestKey: randomUUID() }));
  await action(owner, 'teams.members.add', { v: 1, teamId: team.id,
    accountId: readAccountIdFromToken(member.credentials.token), role: 'member', historyAccess: 'all_existing' });
  const createProfile = async (name: string) => {
    const created = ActionPolicyOutputSchemas['actions.policy.set'].parse(await action(owner, 'actions.policy.set', {
      profileChange: { kind: 'create', profile: { name, actions: { 'session.stop': { approvalRequiredSurfaces: ['agent', 'mcp'] } } } },
    }));
    if (!('profileChange' in created) || !('id' in created.profileChange)
      || typeof created.profileChange.id !== 'string') throw new Error('Profile Artifact id missing');
    const id = created.profileChange.id;
    const granted = await owner.executeReviewed('artifact.access.grants.set', { artifactId: id,
      principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' });
    expect(granted, JSON.stringify(granted)).toMatchObject({ ok: true });
    return id;
  };
  const teamProfileId = await createProfile('Source Team fallback');
  const projectProfileId = await createProfile('Source project default');
  await action(owner, 'teams.policy.set', { v: 1, teamId: team.id,
    managedDefaults: { team: { approvalProfileId: teamProfileId }, groups: {} } });
  const created = source(await action(owner, 'projects.sources.create', { serverId: fixture.serverId,
    requestKey: randomUUID(), name: 'Source Open requester regression', repository: selector,
    owner: { kind: 'team', teamId: team.id } }));
  const savedResult = await owner.executeReviewed('projects.sources.update', { serverId: fixture.serverId,
    sourceId: created.id, expectedRevision: created.revision,
    patch: { sessionDefaults: { expectedRevision: 'absent', defaults: { approvalProfileId: projectProfileId } } } });
  expect(savedResult.ok, JSON.stringify(savedResult)).toBe(true);
  if (!savedResult.ok) throw new Error(savedResult.errorCode);
  const saved = source(savedResult.result);
  expect(source(await action(owner, 'projects.sources.read', { serverId: fixture.serverId, sourceId: saved.id })))
    .toMatchObject({ id: saved.id, repository: selector });
  // B authenticates independently; A's successful write cannot prove B's inheritance.
  expect(await member.executeAsPerson(PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1,
    { sourceRef: { serverId: fixture.serverId, sourceId: saved.id } })).toMatchObject({ ok: true, result: {
    canManageSource: false, sourceDefaultsRow: { defaults: { approvalProfileId: projectProfileId } },
    context: { projectDefaults: { approvalProfileId: projectProfileId }, teamDefaults: { team: { approvalProfileId: teamProfileId } } },
  } });
  const { connectUiPersonActionClient } = await import('@happier-tests/ui-action-client');
  const requestBoundary = fixture.requestProxy?.entries().length ?? 0;
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
    addressAnchorUrl: fixture.server.baseUrl, accountSecret: owner.auth.accountSigningSeed });
  try {
    console.info('Source selector phase', { phase: 'credential_capture_started' });
    const callerCredentials = owner.auth;
    console.info('Source selector phase', { phase: 'credential_capture_completed' });
    console.info('Source selector phase', { phase: 'ui_open_started' });
    const result = await ui.executeConfirmed('projects.open', { ...machine.target,
      source: { kind: 'source', id: saved.id, revision: saved.revision, selector, checkout: control.workspace },
      materialization: { kind: 'attach' } }, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: fixture.serverId, actionRequestId: randomUUID() });
    console.info('Source selector phase', { phase: 'ui_open_completed' });
    const observedRequests = fixture.requestProxy?.entries().slice(requestBoundary) ?? [];
    const openRequest = observedRequests.find(request => request.method === 'POST'
      && new URL(request.path, fixture.server.baseUrl).pathname === '/v1/actions/projects.open');
    const rowReads = observedRequests.filter(request => request.method === 'POST'
      && ['/v1/account/project-rows/list', '/v1/account/project-rows/read']
        .includes(new URL(request.path, fixture.server.baseUrl).pathname));
    // The UI signs in afresh; its bearer need not equal the Account's first token.
    const callerAuthorization = typeof openRequest?.headers.authorization === 'string'
      ? openRequest.headers.authorization : null;
    const requester = {
      hasOpenRequest: openRequest !== undefined,
      sameAccount: callerAuthorization?.startsWith('Bearer ') === true
        && readAccountIdFromToken(callerAuthorization.slice('Bearer '.length)) === readAccountIdFromToken(callerCredentials.token),
      usesTerminalCredential: callerAuthorization === `Bearer ${owner.credentials.token}`,
      rowReads: rowReads.length,
      allRowsUseRequester: rowReads.every(request => request.headers.authorization === callerAuthorization),
    };
    expect(requester, JSON.stringify(requester)).toMatchObject({
      hasOpenRequest: true, sameAccount: true, usesTerminalCredential: false, allRowsUseRequester: true,
    });
    expect(requester.rowReads).toBeGreaterThan(0);
    const requests = fixture.takeRequestObservations();
    expect(result, JSON.stringify(requests)).toMatchObject({ ok: true, result: { kind: 'opened' } });
    if (!result.ok) throw new Error(`Source Open refused: ${result.errorCode}`);
    const opened = OpenProjectResultV1Schema.parse(result.result);
    expect(opened, JSON.stringify(requests)).toMatchObject({ kind: 'opened', directory: checkout,
      workspace: { workspaceId: control.workspace.workspaceId } });
  } finally {
    console.info('Source selector phase', { phase: 'ui_close_started' });
    await ui.close();
    console.info('Source selector phase', { phase: 'ui_close_completed' });
  }
}, 0);

it('Open imports a native task, preserves dirty work, and retains its receipt across two daemon restarts', async () => {
  const checkout = join(testDir, 'onboarding');
  await mkdir(checkout, { recursive: true });
  execFileSync('git', ['init', '--quiet', checkout]);
  await writeFile(join(checkout, 'README'), 'Onboarding project\n');
  const opened = OpenProjectResultV1Schema.parse(await action(owner, 'projects.open', { ...machine.target,
    source: { kind: 'folder', path: checkout }, materialization: { kind: 'attach' } }));
  expect(opened).toMatchObject({ kind: 'opened', directory: checkout, workspace: { rootPath: checkout, ...machine.target } });
  if (opened.kind !== 'opened') throw new Error(`Project folder did not open: ${opened.kind}`);
  expect((await readFile(join(checkout, 'README'), 'utf8')).length).toBeGreaterThan(0);
  const sentinel = Buffer.from([0, 255, 13, 10, 128]);
  await writeFile(join(checkout, 'unfinished.bin'), sentinel);
  const reopened = OpenProjectResultV1Schema.parse(await action(owner, 'projects.open', { ...machine.target,
    source: { kind: 'workspace', workspaceId: opened.workspace.workspaceId, checkout: opened.workspace },
    materialization: { kind: 'attach' } }));
  expect(reopened).toMatchObject({ kind: 'opened', workspace: opened.workspace, directory: checkout });
  expect(await readFile(join(checkout, 'unfinished.bin'))).toEqual(sentinel);
  // Import the native reference produced by inspection through the same guarded writer as the editor.
  await writeFile(join(checkout, 'Makefile'), 'journey-task:\n\t@printf native-task\n');
  const inspect = async (kind: 'editor' | 'imports') => ProjectDefinitionInspectOutputSchema.parse(
    await action(owner, 'projects.inspect', { workspace: opened.workspace, read: { kind } }));
  const imports = await inspect('imports');
  const nativeTask = imports.importCandidates.find(row => row.usage === 'script' && row.source.kind === 'native'
    && row.source.tool === 'make' && row.source.target === 'journey-task');
  expect(nativeTask).toMatchObject({ availability: 'available' });
  if (!nativeTask) throw new Error('Native Make target was not offered for import');
  const editor = await inspect('editor');
  expect(editor.definition.basis).toEqual({ kind: 'absent' });
  const draft = JSON.stringify({ version: 1, scripts: { onboarding: { source: nativeTask.source } } }, null, 2);
  const saved = ProjectManifestUpdateOutputSchema.parse(await action(owner, 'projects.manifest.update', {
    workspace: opened.workspace, expectedBasis: editor.definition.basis, bytes: draft }));
  expect(saved.status).toBe('saved');
  if (saved.status !== 'saved') throw new Error(`Native import was not saved: ${saved.status}`);
  expect((await inspect('editor')).definition.document).toMatchObject({ status: 'valid', bytes: draft,
    manifest: { scripts: { onboarding: { source: nativeTask.source } } } });
  const externalBytes = `${draft}\n`;
  await writeFile(join(checkout, '.happier/project.json'), externalBytes);
  const conflicted = ProjectManifestUpdateOutputSchema.parse(await action(owner, 'projects.manifest.update', {
    workspace: opened.workspace, expectedBasis: saved.basis, bytes: draft }));
  expect(conflicted).toMatchObject({ status: 'conflict', current: { document: { bytes: externalBytes } } });
  expect(await readFile(join(checkout, '.happier/project.json'), 'utf8')).toBe(externalBytes);
  const reloaded = await inspect('editor');
  expect(reloaded.definition.document).toMatchObject({ status: 'valid', bytes: externalBytes });
  expect(ProjectManifestUpdateOutputSchema.parse(await action(owner, 'projects.manifest.update', {
    workspace: opened.workspace, expectedBasis: reloaded.definition.basis, bytes: draft }))).toMatchObject({ status: 'saved' });
  const retained = ActionOperationListV1ResponseSchema.parse(await action(owner, 'action.operations.list', machine.target));
  let receipt: ActionOperationSnapshotV1 | undefined;
  for (const row of retained.items.filter(row => row.actionId === 'projects.open' && row.state === 'succeeded')) {
    const read = ActionOperationGetV1ResponseSchema.parse(await action(owner, 'action.operations.get', {
      ...machine.target, operationId: row.operationId }));
    if (read.kind !== 'found') continue;
    const result = OpenProjectResultV1Schema.safeParse(read.operation.result);
    if (result.success && result.data.kind === 'opened' && result.data.directory === checkout) {
      receipt = read.operation;
      break;
    }
  }
  expect(receipt).toBeDefined();
  if (!receipt) throw new Error('Successful Open did not publish its operation receipt');
  for (const restart of [1, 2]) {
    await machine.restart();
    const read = ActionOperationGetV1ResponseSchema.parse(await action(owner, 'action.operations.get', {
      ...machine.target, operationId: receipt.operationId }));
    expect(read, `Open receipt after restart ${restart}`).toEqual({ kind: 'found', operation: receipt });
    const listed = ActionOperationListV1ResponseSchema.parse(await action(owner, 'action.operations.list', machine.target));
    expect(listed.items.find(row => row.operationId === receipt.operationId)).toEqual(projectActionOperationListSnapshotV1(receipt));
    expect(await readFile(join(checkout, 'unfinished.bin'))).toEqual(sentinel);
    expect((await inspect('editor')).definition.document).toMatchObject({ status: 'valid', bytes: draft,
      manifest: { scripts: { onboarding: { source: nativeTask.source } } } });
  }
}, 0);

it('Withdrawing held Setup settles cancelled and leaves its command unexecuted', async () => {
  const root = join(testDir, 'withdrawn-setup');
  await mkdir(join(root, '.happier'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
    workspace: { setup: [{ kind: 'command', command: 'printf forbidden > setup-effect' }] },
    scripts: { withheld: { source: { kind: 'command', command: 'printf forbidden > script-effect' } } } }));
  const opened = OpenProjectResultV1Schema.parse(await action(owner, 'projects.open', { ...machine.target,
    source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }));
  if (opened.kind !== 'opened') throw new Error(`Withdrawal fixture failed: ${opened.kind}`);
  const accepted = ProjectCommandActionOutputV1Schema.parse(await action(owner, 'projects.script.run', {
    workspace: opened.workspace, selection: { kind: 'named', name: 'withheld' } })).operation;
  const address = { ...machine.target, operationId: accepted.operationId };
  let observed: ActionOperationSnapshotV1 | undefined;
  const observe = async () => {
    const result = ActionOperationGetV1ResponseSchema.parse(await action(owner, 'action.operations.get', address));
    if (result.kind !== 'found') throw new Error('Held Setup disappeared');
    observed = result.operation;
    return observed;
  };
  await waitFor(async () => Boolean((await observe()).setupReview), { context: 'Setup awaits person consent' });
  await expect(access(join(root, 'setup-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
  await action(owner, 'action.operations.cancel', address);
  await waitFor(async () => (await observe()).state === 'cancelled', { context: 'Held Setup withdrawal settles' });
  expect(observed?.state).toBe('cancelled');
  await expect(access(join(root, 'setup-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(root, 'script-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 0);
