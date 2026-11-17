import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ProjectDefinitionInspectOutputSchema, ProjectManifestUpdateOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectSourcesReadOutputV1Schema, ProjectSourcesListOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const testDir = createRunDirs({ runLabel: 'core' }).testDir(`project-sources-journey-${randomUUID()}`);
let fixture: ProjectDaemonFixture;
let owner: Awaited<ReturnType<ProjectDaemonFixture['createAccount']>>;
let member: Awaited<ReturnType<ProjectDaemonFixture['createAccount']>>;
let machine: Awaited<ReturnType<ProjectDaemonFixture['enrollDaemon']>>;

beforeAll(async () => {
  fixture = await startProjectDaemonFixture({ testDir });
  owner = await fixture.createAccount('source-author');
  await fixture.claimHomeOwner(owner);
  machine = await fixture.enrollDaemon(owner);
  member = await fixture.createAccount('source-recipient');
});
afterAll(async () => { await fixture?.stop(); });

async function action(account: typeof owner, actionId: ActionId, input: unknown) {
  const result = await account.executeAsPerson(actionId, input);
  expect(result.ok, `${actionId}: ${result.ok ? 'ok' : result.errorCode}`).toBe(true);
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
  await action(owner, 'teams.members.add', { v: 1, teamId: team.id, accountId: recipientIdentity.createdByAccountId,
    role: 'member', historyAccess: 'all_existing' });
  const address = { serverId: fixture.serverId, sourceId: created.id };
  expect(await member.executeAsPerson('projects.sources.read', address)).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
  const shared = source(await action(owner, 'projects.sources.update', { ...address, expectedRevision: created.revision,
    patch: { audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }] } }));
  expect(source(await action(member, 'projects.sources.read', address))).toMatchObject({ id: created.id, name: created.name });
  const list = ProjectSourcesListOutputV1Schema.parse(await action(member, 'projects.sources.list', {
    serverId: fixture.serverId, sharedWithTeamId: team.id }));
  expect(list).toMatchObject({ ok: true, sources: [expect.objectContaining({ id: created.id })] });
  const renamed = source(await action(owner, 'projects.sources.update', { ...address, expectedRevision: shared.revision,
    patch: { name: 'Revised onboarding' } }));
  expect(source(await action(member, 'projects.sources.read', address)).name).toBe('Revised onboarding');
  await action(owner, 'teams.members.remove', { v: 1, teamId: team.id, accountId: recipientIdentity.createdByAccountId });
  expect(await member.executeAsPerson('projects.sources.read', address)).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
  const withdrawn = ProjectSourcesListOutputV1Schema.parse(await action(member, 'projects.sources.list', { serverId: fixture.serverId }));
  if (!withdrawn.ok) throw new Error(`Recipient list failed: ${withdrawn.error}`);
  expect(withdrawn.sources.some(row => row.id === created.id)).toBe(false);
  expect(source(await action(owner, 'projects.sources.read', address)).revision).toBe(renamed.revision);
  await action(owner, 'teams.members.add', { v: 1, teamId: team.id, accountId: recipientIdentity.createdByAccountId,
    role: 'member', historyAccess: 'all_existing' });
  expect(source(await action(member, 'projects.sources.read', address))).toMatchObject({ id: created.id, name: 'Revised onboarding' });
  expect(await owner.executeAsPerson('projects.sources.delete', { ...address, expectedRevision: renamed.revision }))
    .toEqual({ ok: true, result: { ok: true, sourceId: created.id, revision: renamed.revision } });
  expect(await owner.executeAsPerson('projects.sources.read', address)).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
  expect(await member.executeAsPerson('projects.sources.read', address)).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
});

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
  const nativeTask = imports.importCandidates.find(row => row.usage === 'script'
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
  const receipt = retained.items.find(row => {
    const result = OpenProjectResultV1Schema.safeParse(row.result);
    return row.actionId === 'projects.open' && row.state === 'succeeded' && result.success
      && result.data.kind === 'opened' && result.data.directory === checkout;
  });
  expect(receipt).toBeDefined();
  if (!receipt) throw new Error('Successful Open did not publish its operation receipt');
  for (const restart of [1, 2]) {
    await machine.restart();
    const read = ActionOperationGetV1ResponseSchema.parse(await action(owner, 'action.operations.get', {
      ...machine.target, operationId: receipt.operationId }));
    expect(read, `Open receipt after restart ${restart}`).toEqual({ kind: 'found', operation: receipt });
    const listed = ActionOperationListV1ResponseSchema.parse(await action(owner, 'action.operations.list', machine.target));
    expect(listed.items.find(row => row.operationId === receipt.operationId)).toEqual(receipt);
    expect(await readFile(join(checkout, 'unfinished.bin'))).toEqual(sentinel);
    expect((await inspect('editor')).definition.document).toMatchObject({ status: 'valid', bytes: draft,
      manifest: { scripts: { onboarding: { source: nativeTask.source } } } });
  }
});

it('Withdrawing held Setup settles cancelled and leaves its command unexecuted', async () => {
  const root = join(testDir, 'withdrawn-setup');
  await mkdir(join(root, '.happier'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
    workspace: { setup: [{ kind: 'command', command: 'printf forbidden > setup-effect' }] } }));
  const opened = OpenProjectResultV1Schema.parse(await action(owner, 'projects.open', { ...machine.target,
    source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }));
  if (opened.kind !== 'opened') throw new Error(`Withdrawal fixture failed: ${opened.kind}`);
  const accepted = ProjectCommandActionOutputV1Schema.parse(await action(owner, 'projects.prepare', {
    workspace: opened.workspace, phase: 'setup' })).operation;
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
});
