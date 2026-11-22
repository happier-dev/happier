import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { callExactMachineRpc } from '../../../../apps/cli/src/session/transport/rpc/machineRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest';
import * as personActionClient from '@happier-tests/ui-action-client';
import { ProjectManifestV1Schema, type ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { PROJECT_TRUST_ROUTE_V1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';

import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { redactHarnessLogText } from '../../src/testkit/process/harnessLogRedaction';
import { addFriend, setUsername } from '../../src/testkit/socialFriends';
import { MachineAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ProjectSetupSetOutputV1Schema } from '@happier-dev/protocol/projects/projectSetupSetV1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN, ScmWorktreeCreateResponseSchema } from '@happier-dev/protocol/scm/worktrees';
import { MachineStorageItemsListResultV1Schema, PileReviewV1Schema, PileApplyResultV1Schema,
  TrashRestoreResultV1Schema, TrashEmptyResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { waitFor } from '../../src/testkit/timing';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createIsolatedFakeClaudeControlShim, fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { buildProjectSourceSetupUrl, parseProjectSourceSetupLink } from '@happier-tests/ui-action-client';
import { parseHomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import { resolveCliHomeTarget } from '../../../../apps/cli/src/server/homeTarget';
import { fetchServerFeaturesSnapshot } from '../../../../apps/cli/src/features/serverFeaturesClient';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createWorktreePortsOwner } from '../../../../apps/cli/src/workspaces/execution/worktreePorts';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipCreateResultV1Schema,
  WorkspaceSyncRelationshipsListActionOutputV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { ProjectWorkerCopyInspectResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';

let fixture: ProjectDaemonFixture | undefined;
let sharedSetupFixture: ProjectDaemonFixture | undefined;
let sharedSetupHome: Awaited<ReturnType<typeof prepareSharedSetupHome>>;
afterEach(async () => {
  if (fixture !== sharedSetupFixture) await fixture?.stop();
  fixture = undefined;
});

type SetupAccount = Awaited<ReturnType<ProjectDaemonFixture['createAccount']>>;
type SetupMachine = Awaited<ReturnType<ProjectDaemonFixture['enrollDaemon']>>;
type PersonAction = SetupAccount['executeAsPerson'];

/** P04: prove existing admitted Project transport before observing missing setup behavior. */
async function proveAdmittedProjectControl(account: SetupAccount, machine: SetupMachine, execute: PersonAction = account.executeAsPerson) {
  const opened = await execute('projects.open', { ...machine.target,
    source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } });
  expect(opened, 'Known-good Project open control').toMatchObject({ ok: true, result: { kind: 'opened' } });
  if (!opened.ok) throw new Error(`Control refused (${opened.errorCode})`);
  const project = OpenProjectResultV1Schema.parse(opened.result);
  if (project.kind !== 'opened') throw new Error(`Control did not open (${project.kind})`);
  const inspected = await account.execute('projects.inspect', { workspace: project.workspace, read: { kind: 'editor' } });
  expect(inspected, 'Known-good admitted daemon inspection control').toMatchObject({ ok: true });
  if (!inspected.ok) throw new Error(`Control inspection refused (${inspected.errorCode})`);
  ProjectDefinitionInspectOutputSchema.parse(inspected.result);
  return project;
}

async function prepareSharedSetupHome(home: ProjectDaemonFixture) {
  const [account, publisher] = await Promise.all([
    home.createAccount('setup-consumer'),
    home.createAccount('setup-publisher'),
  ]);
  const [enrollment, homeClaim] = await Promise.allSettled([
    home.enrollDaemon(account),
    home.claimHomeOwner(publisher),
  ]);
  if (enrollment.status === 'rejected') throw enrollment.reason;
  if (homeClaim.status === 'rejected') throw homeClaim.reason;
  expect(homeClaim.value.result.status).toBe('claimed');
  await requireProjectSetupReview(account);
  const teamId = await publisher.withPersonActionClient(async execute => {
    const teamCreated = await execute('teams.create', { v: 1, name: 'Shared setup readers', requestKey: randomUUID(),
      initialOwnerAccountId: readAccountIdFromToken(publisher.credentials.token) });
    if (!teamCreated.ok) throw new Error(`Team creation refused (${teamCreated.errorCode})`);
    const team = TeamSummaryV1Schema.parse(teamCreated.result);
    const membership = await execute('teams.members.add', { v: 1, teamId: team.id,
      accountId: readAccountIdFromToken(account.credentials.token), role: 'member', historyAccess: 'from_membership' });
    expect(membership).toMatchObject({ ok: true });
    return team.id;
  });
  return { home, account, publisher, enrolled: enrollment.value, teamId };
}

// Each case gets a fresh checkout and Source on the same real PostgreSQL
// Home and daemon. Use the public Action writers to prepare their content.
async function startSharedSetupProject(command: string) {
  const { home, account, publisher, enrolled, teamId } = sharedSetupHome;
  fixture = home;
  const machine = { ...enrolled, workspaceDir: await mkdtemp(join(tmpdir(), 'team-setup-a-checkout-')) };
  const opened = await proveAdmittedProjectControl(account, machine);
  if (!opened.facts?.projectKey) throw new Error('Opened Project omitted its canonical key');
  const projectRef = { serverId: opened.workspace.serverId, projectKey: opened.facts.projectKey };
  const organizationRevision = await account.readProjectOrganizationRevision(projectRef);
  const homeId = fixture.serverId;
  const { ArtifactActionOutputSchemasV1 } = await import('@happier-dev/protocol/artifacts/artifactActionsV1');
  const { ProjectSourcesReadOutputV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
  const publish = async (nextCommand: string | ProjectManifestV1, execute = publisher.executeAsPerson) => {
    const manifest = ProjectManifestV1Schema.parse(typeof nextCommand === 'string' ? { version: 1,
      workspace: { setup: [{ kind: 'command', command: nextCommand }] } } : nextCommand);
    const result = await execute('artifact.create', { artifactId: randomUUID(),
      header: { title: 'Protected shared setup', kind: 'project_setup.v1' },
      body: JSON.stringify({ kind: 'project_setup.v1', manifest }) });
    if (!result.ok) throw new Error(result.errorCode);
    return ArtifactActionOutputSchemasV1['artifact.create'].parse(result.result);
  };
  const attach = async (sourceId: string, publication: Awaited<ReturnType<typeof publish>>, revision: number,
    execute = publisher.executeAsPerson) => {
    const result = await execute('projects.sources.update', { serverId: homeId,
      sourceId, expectedRevision: revision, patch: { attachment: { kind: 'attach', attachment: {
        purpose: 'setup', ref: { kind: 'doc', artifactId: publication.artifactId, serverId: homeId },
        contentRevision: publication.revision,
      } } } });
    if (!result.ok) throw new Error(result.errorCode);
    const updated = ProjectSourcesReadOutputV1Schema.parse(result.result);
    if (!updated.ok) throw new Error(updated.error);
    return updated.source;
  };
  const { published, source } = await publisher.withPersonActionClient(async execute => {
    const published = await publish(command, execute);
    const created = await execute('projects.sources.create', { serverId: homeId,
      name: randomUUID(), requestKey: randomUUID(),
      audience: [{ principal: { kind: 'team', teamId }, level: 'view' }] });
    if (!created.ok) throw new Error(created.errorCode);
    const initial = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!initial.ok) throw new Error(initial.error);
    return { published, source: await attach(initial.source.id, published, initial.source.revision, execute) };
  });
  return { account, publisher, machine, opened, projectRef, organizationRevision, source, published, publish,
    attach: (publication: typeof published, revision: number) => attach(source.id, publication, revision) };
}

async function readSharedSetupOperation(
  current: Pick<Awaited<ReturnType<typeof startSharedSetupProject>>, 'account' | 'machine'>,
  operationId: string,
  includeSetupReview = false,
  execute: PersonAction = current.account.execute,
) {
  const observed = await execute('action.operations.get', {
    ...current.machine.target, operationId, waitForTerminal: true,
    ...(includeSetupReview ? { includeSetupReview: true } : {}),
  });
  if (!observed.ok) throw new Error(`Setup operation read refused (${observed.errorCode})`);
  const result = ActionOperationGetV1ResponseSchema.parse(observed.result);
  if (result.kind !== 'found') throw new Error(`Setup operation ${operationId} was unavailable`);
  return result.operation;
}

async function readSharedSetupReview(
  current: Pick<Awaited<ReturnType<typeof startSharedSetupProject>>, 'account' | 'machine'>,
  operationId: string,
  execute: PersonAction = current.account.execute,
) {
  const review = await readSharedSetupOperation(current, operationId, true, execute);
  if (!review.setupReview) throw new Error(`Setup did not hold for consent (state: ${review.state})`);
  return { operationId, digest: review.setupReview.reviewedEffectDigest };
}

async function requireProjectSetupReview(account: SetupAccount, execute: PersonAction = account.executeAsPerson) {
  expect(await execute('actions.policy.set', {
    actionId: 'projects.prepare', audience: 'ui', mode: 'ask_first',
  })).toMatchObject({ ok: true, result: { mode: 'ask_first' } });
}

async function holdSharedSetup(current: Pick<Awaited<ReturnType<typeof startSharedSetupProject>>, 'account' | 'opened' | 'machine'>,
  execute: PersonAction = current.account.executeAsPerson) {
  const prepared = await execute('projects.prepare', { workspace: current.opened.workspace, phase: 'setup' });
  if (!prepared.ok) throw new Error(prepared.errorCode);
  const { operation } = ProjectCommandActionOutputV1Schema.parse(prepared.result);
  return readSharedSetupReview(current, operation.operationId);
}

async function approveSharedSetup(current: Pick<Awaited<ReturnType<typeof startSharedSetupProject>>, 'account' | 'opened' | 'machine'>,
  held: Awaited<ReturnType<typeof holdSharedSetup>>, consentScope: 'thisTime' | 'untilChanged' = 'untilChanged',
  execute: PersonAction = current.account.executeAsPerson) {
  const approved = await execute('projects.prepare', { workspace: current.opened.workspace, phase: 'setup',
    heldOperationId: held.operationId, expectedEffectDigest: held.digest, consentScope });
  expect(approved).toMatchObject({ ok: true });
  expect(await readSharedSetupOperation(current, held.operationId)).toMatchObject({ state: 'succeeded' });
}

async function resolveSharedSetupLink(current: Awaited<ReturnType<typeof startSharedSetupProject>>) {
  const features = await fetchServerFeaturesSnapshot({ serverUrl: fixture!.server.baseUrl,
    token: current.account.credentials.token, projection: 'authenticated' });
  if (features.status !== 'ready' || !features.features.homeConnectionDescriptor) throw new Error('Link Home omitted its descriptor');
  const descriptor = features.features.homeConnectionDescriptor;
  const url = buildProjectSourceSetupUrl({ applicationOrigin: 'https://app.test', sourceId: current.source.id,
    homeTarget: JSON.stringify({ kind: 'descriptor', authority: 'trusted_enrollment', descriptor }) });
  const link = parseProjectSourceSetupLink(url);
  if (!link) throw new Error('Generated Source setup link was not admitted');
  const target = await resolveCliHomeTarget(parseHomeTargetInput(JSON.parse(link.homeTarget)));
  return { descriptor, link, target };
}

describe('Team setup A: published Project setup', () => {
  beforeAll(async () => {
    sharedSetupFixture = await startProjectDaemonFixture({ testDir: await mkdtemp(join(tmpdir(), 'team-setup-a-apply-')),
      dbProvider: 'postgres', daemonAuthentication: 'existing-terminal', personActionSurface: 'coreAction',
      daemonEnv: { HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_CLAUDE_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'team-setup-a-agent-')) }, observeActionRequests: true });
  });
  beforeAll(async () => {
    if (!sharedSetupFixture) throw new Error('Shared setup Home is unavailable');
    sharedSetupHome = await prepareSharedSetupHome(sharedSetupFixture);
  });
  afterAll(async () => { await sharedSetupFixture?.stop(); });

  it('TS.A.openApply saves accepted setup privately and requires consent before its native effect', async () => {
    const current = await startSharedSetupProject('printf accepted > shared-setup-effect');
    const { descriptor, link, target } = await resolveSharedSetupLink(current);
    expect(target.homeServerIdentityId).toBe(fixture!.serverId);
    expect(new URL(target.applicationUrl).origin).toBe(new URL(fixture!.server.baseUrl).origin);
    fixture!.takeRequestObservations();
    const selected = await current.account.execute('projects.sources.read', { serverId: target.homeServerIdentityId,
      sourceId: link.sourceId });
    expect(selected).toMatchObject({ ok: true, result: { ok: true, source: { id: current.source.id,
      attachments: [{ purpose: 'setup', ref: { artifactId: current.published.artifactId } }] } } });
    expect(fixture!.takeRequestObservations().filter(request => request.path.startsWith('/v1/projects/sources')))
      .toEqual([{ method: 'GET', path: `/v1/projects/sources/${encodeURIComponent(link.sourceId)}?serverId=${encodeURIComponent(fixture!.serverId)}`, statusCode: 200 }]);

    const wrongHomeUrl = buildProjectSourceSetupUrl({ applicationOrigin: 'https://app.test', sourceId: current.source.id,
      homeTarget: JSON.stringify({ kind: 'descriptor', authority: 'trusted_enrollment',
        descriptor: { ...descriptor, homeServerIdentityId: 'srv_unadopted_setup_link' } }) });
    const wrongHomeLink = parseProjectSourceSetupLink(wrongHomeUrl);
    if (!wrongHomeLink) throw new Error('Wrong-Home link did not reach target admission');
    const wrongHome = await resolveCliHomeTarget(parseHomeTargetInput(JSON.parse(wrongHomeLink.homeTarget)));
    const refusedHome = await current.account.execute('projects.sources.read', { serverId: wrongHome.homeServerIdentityId,
      sourceId: wrongHomeLink.sourceId });
    expect(refusedHome).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(fixture!.takeRequestObservations().filter(request => request.path.startsWith('/v1/projects/sources'))).toEqual([]);

    // Credential storage is an OS boundary: absence must settle before the protected HTTP request.
    const signedOut = createCliActionExecutorFromCredentials({ credentials: current.account.credentials,
      readCredentials: async () => null, serverId: fixture!.serverId, serverIdentityId: fixture!.serverId,
      serverApiUrl: fixture!.actionServerApiUrl });
    const refusedSignIn = await signedOut.execute('projects.sources.read', { serverId: target.homeServerIdentityId,
      sourceId: link.sourceId }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: fixture!.serverId, serverIdentityId: fixture!.serverId, actionRequestId: randomUUID() });
    expect(refusedSignIn).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(fixture!.takeRequestObservations().filter(request => request.path.startsWith('/v1/projects/sources'))).toEqual([]);

    const applied = await current.account.executeAsPerson('projects.setup.set', { projectRef: current.projectRef, workspace: current.opened.workspace,
      expectedRevision: current.organizationRevision, intent: { kind: 'accept', sourceId: link.sourceId } });
    expect(applied).toMatchObject({ ok: true, result: { ok: true, row: {
      setupSelection: { sourceId: current.source.id }, setupContent: { artifactId: expect.any(String) },
    } } });
    if (!applied.ok) throw new Error(applied.errorCode);
    const acceptanceRequests = fixture!.takeRequestObservations();
    expect(acceptanceRequests.filter(request => request.method === 'GET'
      && /^\/v1\/artifacts\/[^/?]+(?:\?projectSourceId=[^&]+)?$/u.test(request.path))).toHaveLength(1);
    expect(acceptanceRequests.filter(request => request.path === '/v1/account/project-trust/mutate')).toEqual([]);
    const { z } = await import('@happier-dev/protocol/zodRuntimePolicy');
    expect(JSON.stringify(z.object({ row: z.unknown() }).parse(applied.result).row)).not.toContain('printf accepted');
    const retired = await current.publisher.executeAsPerson('projects.sources.delete', { serverId: current.projectRef.serverId,
      sourceId: current.source.id, expectedRevision: current.source.revision });
    expect(retired).toMatchObject({ ok: true, result: { ok: true } });
    const inspected = await current.account.execute('projects.inspect', { workspace: current.opened.workspace, read: { kind: 'setup' } });
    expect(inspected).toMatchObject({ ok: true, result: { setupReadiness: { kind: 'unprepared' } } });
    await expect(access(join(current.machine.workspaceDir, 'shared-setup-effect'))).rejects.toThrow();
    await current.account.withPersonActionClient(async execute => {
      const held = await holdSharedSetup(current, execute);
      await approveSharedSetup(current, held, 'untilChanged', execute);
    });
    expect(await readFile(join(current.machine.workspaceDir, 'shared-setup-effect'), 'utf8')).toBe('accepted');
  });

  it.each(['thisTime', 'untilChanged'] as const)('TS.A.update keeps the accepted copy until one %s update decision and detects stale organization CAS', async decision => {
    const current = await startSharedSetupProject('printf original > accepted-version');
    const accept = async (expectedRevision: number | 'absent') => current.account.executeAsPerson('projects.setup.set', {
      projectRef: current.projectRef, workspace: current.opened.workspace, expectedRevision, intent: { kind: 'accept', sourceId: current.source.id },
    });
    const accepted = await accept(current.organizationRevision);
    expect(accepted).toMatchObject({ ok: true, result: { ok: true } });
    if (!accepted.ok) throw new Error(accepted.errorCode);
    const { z } = await import('@happier-dev/protocol/zodRuntimePolicy');
    const receipt = z.object({ revision: z.number(), row: z.object({ setupSelection: z.object({ digest: z.string() }) }) }).parse(accepted.result);
    fixture!.takeRequestObservations();
    const unchanged = await accept(receipt.revision);
    expect(unchanged).toMatchObject({ ok: true, result: { ok: true, revision: receipt.revision } });
    expect(fixture!.takeRequestObservations().filter(request => request.method !== 'GET'
      && (request.path.startsWith('/v1/artifacts') && request.path !== '/v1/artifacts/read'
        || request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`))).toEqual([]);
    const initialReview = await current.account.withPersonActionClient(async execute => {
      const held = await holdSharedSetup(current, execute);
      await approveSharedSetup(current, held, 'untilChanged', execute);
      return held;
    });
    expect(await readFile(join(current.machine.workspaceDir, 'accepted-version'), 'utf8')).toBe('original');
    const published = await current.publish('printf updated > accepted-version');
    const updatedSource = await current.attach(published, current.source.revision);
    const stale = await accept(current.organizationRevision);
    expect(stale).toMatchObject({ ok: true, result: { ok: false, errorCode: 'project_setup_conflict' } });
    const inspected = await current.account.execute('projects.inspect', { workspace: current.opened.workspace, read: { kind: 'setup' } });
    expect(JSON.stringify(inspected)).toContain(receipt.row.setupSelection.digest);
    expect(JSON.stringify(inspected)).not.toContain('printf updated');
    const updateReview = await current.account.execute('projects.inspect', { workspace: current.opened.workspace,
      read: { kind: 'setup' }, reviewSharedSetup: { sourceId: current.source.id } });
    expect(updateReview).toMatchObject({ ok: true, result: { sharedSetupChange: { kind: 'changed',
      before: { effectiveManifest: { workspace: { setup: [{ command: 'printf original > accepted-version' }] } } },
      after: { effectiveManifest: { workspace: { setup: [{ command: 'printf updated > accepted-version' }] } } },
      setupReview: { reviewedEffectDigest: expect.any(String) },
      setupReadiness: { kind: 'unprepared', reviewedEffectDigest: expect.any(String) },
    } } });
    expect(await readFile(join(current.machine.workspaceDir, 'accepted-version'), 'utf8')).toBe('original');
    if (!updateReview.ok) throw new Error(updateReview.errorCode);
    const sharedReview = ProjectDefinitionInspectOutputSchema.parse(updateReview.result).sharedSetupChange;
    if (sharedReview?.kind !== 'changed') throw new Error('Update review omitted its proposed copy');
    const { decideProjectSharedSetupUpdate } = personActionClient;
    const updateInput = { projectRef: current.projectRef, expectedRevision: receipt.revision, review: sharedReview,
      workspace: current.opened.workspace, scope: { serverId: fixture!.serverId,
        accountId: readAccountIdFromToken(current.account.credentials.token) },
      execute: current.account.executeAsPerson };
    fixture!.takeRequestObservations();
    expect(await decideProjectSharedSetupUpdate({ ...updateInput, decision: 'keep' })).toEqual({ kind: 'kept' });
    expect(fixture!.takeRequestObservations()).toEqual([]);
    const applied = await decideProjectSharedSetupUpdate({ ...updateInput, decision });
    expect(applied).toMatchObject({ kind: 'accepted' });
    if (applied.kind !== 'accepted' || !('operation' in applied.preparation)) throw new Error('Updated preparation did not retain its operation');
    expect(applied.setup.row.setupSelection?.digest).not.toBe(receipt.row.setupSelection.digest);
    const operationId = applied.preparation.operation.operationId;
    const changedReview = await readSharedSetupReview(current, operationId);
    expect(changedReview.digest).not.toBe(initialReview.digest);
    expect(changedReview.digest).toBe(sharedReview.setupReview?.reviewedEffectDigest);
    expect(await readFile(join(current.machine.workspaceDir, 'accepted-version'), 'utf8')).toBe('original');
    // The controller consumes this existing operation push with the same already-selected choice.
    await approveSharedSetup(current, changedReview, decision);
    expect(await readFile(join(current.machine.workspaceDir, 'accepted-version'), 'utf8')).toBe('updated');
    // Personal declarations survive replacing and detaching the shared selection.
    const appliedReceipt = applied.setup;
    const personal = await current.account.executeAsPerson('projects.setup.set', { projectRef: current.projectRef,
      workspace: current.opened.workspace, expectedRevision: appliedReceipt.revision,
      intent: { kind: 'personal', setupOverrides: { version: 1, scripts: {
        personal: { source: { kind: 'command', command: 'printf personal > personal-version' } },
      } } } });
    expect(personal).toMatchObject({ ok: true, result: { ok: true } });
    if (!personal.ok) throw new Error(personal.errorCode);
    const detached = await current.account.executeAsPerson('projects.setup.set', { projectRef: current.projectRef,
      workspace: current.opened.workspace, expectedRevision: z.object({ revision: z.number() }).parse(personal.result).revision,
      intent: { kind: 'detach' } });
    expect(detached).toMatchObject({ ok: true, result: { ok: true, effectiveDefinition: {
      effectiveManifest: { scripts: { personal: { source: { command: 'printf personal > personal-version' } } } },
    } } });
    if (!detached.ok) throw new Error(detached.errorCode);
    expect(z.object({ row: z.record(z.string(), z.unknown()) }).parse(detached.result).row.setupSelection).toBeUndefined();
    const noLifecycle = await current.publish({ version: 1 });
    const emptySource = await current.attach(noLifecycle, updatedSource.revision);
    const noEffectReview = await current.account.execute('projects.inspect', { workspace: current.opened.workspace,
      read: { kind: 'editor' }, reviewSharedSetup: { sourceId: current.source.id } });
    expect(noEffectReview).toMatchObject({ ok: true, result: { sharedSetupChange: { kind: 'changed',
      setupReadiness: { kind: 'notRequired', reviewedEffectDigest: expect.any(String) },
    } } });
    const teardownOnly = await current.publish({ version: 1, workspace: {
      teardown: [{ kind: 'command', command: 'printf remembered > teardown-only-effect' }],
    } });
    await current.attach(teardownOnly, emptySource.revision);
    const lifecycleReview = await current.account.execute('projects.inspect', { workspace: current.opened.workspace,
      read: { kind: 'editor' }, reviewSharedSetup: { sourceId: current.source.id } });
    expect(lifecycleReview).toMatchObject({ ok: true, result: { sharedSetupChange: { kind: 'changed',
      setupReadiness: { kind: 'unprepared' }, setupReview: { reviewedEffect: { lifecycle: {
        setup: [], teardown: [{ command: 'printf remembered > teardown-only-effect' }],
      } } },
    } } });
    if (!lifecycleReview.ok) throw new Error(lifecycleReview.errorCode);
    const teardownChange = ProjectDefinitionInspectOutputSchema.parse(lifecycleReview.result).sharedSetupChange;
    if (teardownChange?.kind !== 'changed') throw new Error('Teardown lifecycle omitted its proposed review');
    const acceptedTeardown = await decideProjectSharedSetupUpdate({ ...updateInput, review: teardownChange,
      expectedRevision: z.object({ revision: z.number() }).parse(detached.result).revision, decision: 'untilChanged' });
    expect(acceptedTeardown).toMatchObject({ kind: 'accepted' });
    if (acceptedTeardown.kind !== 'accepted' || !('operation' in acceptedTeardown.preparation)) throw new Error('Teardown lifecycle did not retain setup consent');
    const teardownOperationId = acceptedTeardown.preparation.operation.operationId;
    const teardownConsent = await readSharedSetupReview(current, teardownOperationId);
    await approveSharedSetup(current, teardownConsent, 'untilChanged');
    await expect(access(join(current.machine.workspaceDir, 'teardown-only-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
    const cleanup = await current.account.executeAsPerson('projects.prepare', { workspace: current.opened.workspace, phase: 'teardown' });
    if (!cleanup.ok) throw new Error(cleanup.errorCode);
    const cleanupOperation = ProjectCommandActionOutputV1Schema.parse(cleanup.result).operation;
    expect(await readSharedSetupOperation(current, cleanupOperation.operationId, true))
      .toMatchObject({ state: 'succeeded' });
    expect(await readFile(join(current.machine.workspaceDir, 'teardown-only-effect'), 'utf8')).toBe('remembered');
  });

  it('TS.A.publish shares protected setup with a second Account and keeps the checkout free of repository setup files', async () => {
    const current = await startSharedSetupProject('printf shared-setup-private-marker > published-setup-effect');
    const { link, target } = await resolveSharedSetupLink(current);
    const selected = { serverId: target.homeServerIdentityId, sourceId: link.sourceId };
    const outsider = await fixture!.createAccount('outside-audience');
    expect(await outsider.execute('projects.sources.read', selected))
      .toMatchObject({ ok: true, result: { ok: false, error: 'source_unavailable' } });
    const published = await current.account.execute('projects.sources.read', selected);
    const { artifactId } = current.published;
    expect(published).toMatchObject({ ok: true, result: { ok: true, source: {
      attachments: [{ purpose: 'setup', ref: { artifactId } }],
    } } });
    expect(JSON.stringify(published)).not.toContain('shared-setup-private-marker');
    const marker = join(current.machine.workspaceDir, 'published-setup-effect');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const accepted = await current.account.executeAsPerson('projects.setup.set', {
      projectRef: current.projectRef, workspace: current.opened.workspace,
      expectedRevision: current.organizationRevision, intent: { kind: 'accept', sourceId: link.sourceId },
    });
    expect(accepted).toMatchObject({ ok: true, result: { ok: true } });
    const held = await holdSharedSetup(current);
    await approveSharedSetup(current, held);
    expect(await readFile(marker, 'utf8')).toBe('shared-setup-private-marker');
    await expect(access(join(current.machine.workspaceDir, '.happier', 'project.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Project environment preparation', () => {
  let environmentHome: ProjectDaemonFixture;
  let agent: Awaited<ReturnType<typeof createIsolatedFakeClaudeControlShim>>;
  let account: SetupAccount;
  let machine: SetupMachine;

  beforeAll(async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'team-setup-a-env-'));
    agent = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'provider'),
      captureEnvironmentKeys: ['DATABASE_URL'], logFullStdin: false });
    environmentHome = await startProjectDaemonFixture({ testDir, dbProvider: 'postgres', daemonAuthentication: 'existing-terminal',
      personActionSurface: 'coreAction', daemonEnv: { HAPPIER_CLAUDE_PATH: agent.executablePath,
        HAPPIER_CLAUDE_CONFIG_DIR: agent.configDir } });
  });
  beforeAll(async () => {
    if (!environmentHome) throw new Error('Environment Home is unavailable');
    account = await environmentHome.createAccount('environment-owner');
    machine = await environmentHome.enrollDaemon(account, { env: { DATABASE_URL: 'host-sentinel' } });
  });
  beforeAll(async () => {
    await proveAdmittedProjectControl(account, machine);
    await environmentHome.assertKnownGoodSessionControl(account, machine);
  });
  afterAll(async () => { await environmentHome?.stop(); });

  it('TS.A.environment imports names and prepares the same private dotenv input consumed by native launch', async () => {
    await mkdir(join(machine.workspaceDir, '.happier'));
    await writeFile(join(machine.workspaceDir, '.happier/project.json'), JSON.stringify({ version: 1,
      environmentVariables: [{ name: 'DATABASE_URL', kind: 'config', required: true }],
      scripts: { observe: { source: { kind: 'command', command: 'printf "%s" "$DATABASE_URL" > observed-environment' } } },
    }));
    await writeFile(join(machine.workspaceDir, '.env'), 'DATABASE_URL=postgres://private-native-sentinel/base\n');
    await writeFile(join(machine.workspaceDir, '.env.local'), 'DATABASE_URL=postgres://private-native-sentinel/local\n');
    await writeFile(join(machine.workspaceDir, '.env.example'), 'TOKEN=example-secret-sentinel\nDATABASE_URL=never-runtime\nTOKEN=second-secret-sentinel\ninvalid example line\n');
    const openedAction = await account.executeAsPerson('projects.open', { ...machine.target,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } });
    expect(openedAction).toMatchObject({ ok: true });
    if (!openedAction.ok) throw new Error(openedAction.errorCode);
    const opened = OpenProjectResultV1Schema.parse(openedAction.result);
    expect(opened).toMatchObject({ kind: 'opened' });
    if (opened.kind !== 'opened') throw new Error(`Project open: ${opened.kind}`);
    const inspectedAction = await account.execute('projects.inspect', { workspace: opened.workspace, read: { kind: 'imports' } });
    expect(inspectedAction).toMatchObject({ ok: true, result: { environmentImport: { kind: 'environment',
      requirements: [{ name: 'TOKEN', kind: 'config', required: false }, { name: 'DATABASE_URL', kind: 'config', required: false }],
      diagnostics: [{ code: 'malformed_dotenv' }] } } });
    expect(JSON.stringify(inspectedAction)).not.toContain('example-secret-sentinel');
    expect(JSON.stringify(inspectedAction)).not.toContain('second-secret-sentinel');
    if (!inspectedAction.ok || !opened.facts?.projectKey) throw new Error('Personal import requires the accepted Project');
    const imported = ProjectDefinitionInspectOutputSchema.parse(inspectedAction.result).environmentImport;
    if (!imported) throw new Error('Names import omitted its environment offer');
    const repositoryBeforePersonalEdit = await readFile(join(machine.workspaceDir, '.happier/project.json'), 'utf8');
    const projectRef = { serverId: environmentHome.serverId, projectKey: opened.facts.projectKey };
    const personal = await account.executeAsPerson('projects.setup.set', {
      projectRef, workspace: opened.workspace,
      expectedRevision: await account.readProjectOrganizationRevision(projectRef), intent: { kind: 'personal', setupOverrides: { version: 1,
        // Inherited requirements retain their classification; import adds only names not already declared.
        environmentVariables: imported.requirements.filter(requirement => requirement.name !== 'DATABASE_URL'),
        scripts: { observe: { source: { kind: 'command', command:
          'printf "%s" "$DATABASE_URL" > observed-environment; printf personal > personal-command-source' } } },
      } },
    });
    if (!personal.ok) throw new Error(`Personal setup Action refused (${personal.errorCode})`);
    const savedPersonalSetup = ProjectSetupSetOutputV1Schema.parse(personal.result);
    if (!savedPersonalSetup.ok) throw new Error(`Personal setup write refused (${savedPersonalSetup.errorCode})`);
    expect(personal).toMatchObject({ ok: true, result: { ok: true, effectiveDefinition: { effectiveManifest: {
      environmentVariables: [{ name: 'DATABASE_URL', kind: 'config', required: true }, { name: 'TOKEN', kind: 'config', required: false }],
    } } } });
    expect(JSON.stringify(personal)).not.toContain('sentinel');
    expect(await readFile(join(machine.workspaceDir, '.happier/project.json'), 'utf8')).toBe(repositoryBeforePersonalEdit);
    const reviewAction = await account.execute('projects.inspect', { workspace: opened.workspace, read: { kind: 'setup' } });
    if (!reviewAction.ok) throw new Error(reviewAction.errorCode);
    const review = ProjectDefinitionInspectOutputSchema.parse(reviewAction.result);
    expect(review.setupReadiness).toMatchObject({ kind: 'notRequired' });
    expect(JSON.stringify(reviewAction)).not.toContain('private-native-sentinel');
    const prepared = await account.executeAsPerson('projects.prepare', { workspace: opened.workspace, phase: 'setup' });
    if (!prepared.ok) throw new Error(`Environment prepare refused (${prepared.errorCode})`);
    const { operation: preparation } = ProjectCommandActionOutputV1Schema.parse(prepared.result);
    expect(await readSharedSetupOperation({ account, machine }, preparation.operationId)).toMatchObject({ state: 'succeeded' });
    const observeEnvironment = async () => {
      const started = await account.executeAsPerson('projects.script.run', { workspace: opened.workspace, selection: { kind: 'named', name: 'observe' } });
      if (!started.ok) throw new Error(started.errorCode);
      const operation = ProjectCommandActionOutputV1Schema.parse(started.result).operation;
      expect(await readSharedSetupOperation({ account, machine }, operation.operationId, true))
        .toMatchObject({ state: 'succeeded' });
    };
    await observeEnvironment();
    expect(await readFile(join(machine.workspaceDir, 'observed-environment'), 'utf8')).toBe('postgres://private-native-sentinel/local');
    expect(await readFile(join(machine.workspaceDir, 'personal-command-source'), 'utf8')).toBe('personal');
    // A new demand reads current private input, without changing lifecycle consent.
    await writeFile(join(machine.workspaceDir, '.env.local'), 'DATABASE_URL=postgres://private-native-sentinel/next\n');
    const refreshed = await account.execute('projects.inspect', { workspace: opened.workspace, read: { kind: 'setup' } });
    expect(refreshed).toMatchObject({ ok: true, result: { setupReadiness: review.setupReadiness } });
    expect(JSON.stringify(refreshed)).not.toContain('private-native-sentinel');
    await observeEnvironment();
    expect(await readFile(join(machine.workspaceDir, 'observed-environment'), 'utf8')).toBe('postgres://private-native-sentinel/next');
    const { z } = await import('@happier-dev/protocol/zodRuntimePolicy');
    const attestation = z.object({ DATABASE_URL: z.object({ present: z.literal(true), sha256: z.string() }) });
    const observeAgentEnvironment = async (sessionId: string, expected: string) => {
      expect(await account.execute('session.message.send', {
        sessionId, message: 'Observe the configured test environment.',
      })).toMatchObject({ ok: true, result: { status: 'accepted' } });
      const digest = createHash('sha256').update(expected).digest('hex');
      await waitForFakeClaudeInvocation(agent.logPath, invocation => {
        const observed = attestation.safeParse(invocation.environmentAttestation);
        return invocation.cwd === machine.workspaceDir && observed.success && observed.data.DATABASE_URL.sha256 === digest;
      });
    };
    const spawnAndObserveAgent = async (expected: string, profileId?: string) => {
      const updatedAtMs = Date.now();
      const spawned = await account.execute('session.spawn_new', {
        executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        permissionMode: 'read-only', approvalProfileId: null,
        configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
          permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
        connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
        ...(profileId ? { profileId } : {}),
      });
      expect(spawned).toMatchObject({ ok: true, result: { type: 'success' } });
      if (!spawned.ok) throw new Error(spawned.errorCode);
      const created = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
      if (created.type !== 'success') throw new Error('Environment Agent did not start');
      await observeAgentEnvironment(created.sessionId, expected);
    };
    await spawnAndObserveAgent('postgres://private-native-sentinel/next');
    const profileId = `environment-${randomUUID()}`;
    const now = Date.now();
    const profile = await account.executeAsPerson('launch_profiles.create', { expectedRevision: 'absent', profile: {
      v: 2, id: profileId, name: 'Environment precedence', createdAt: now, updatedAt: now,
      extraEnvironmentVariables: [{ name: 'DATABASE_URL', value: 'postgres://profile-choice/db' }],
      envVarRequirements: [{ name: 'DATABASE_URL', kind: 'config', required: true }],
    } });
    expect(profile).toMatchObject({ ok: true, result: { status: 'updated', id: profileId } });
    await spawnAndObserveAgent('postgres://profile-choice/db', profileId);
    // Raw invocation input belongs to the native CLI, outside the Home draft.
    const invocation = 'postgres://invocation-choice/db';
    const launched = await environmentHome.createSessionFromArgv(machine, ['--agent', 'claude', '--permission-mode', 'read-only',
      '--launch-profile', profileId, '--env', `DATABASE_URL=${invocation}`], 'A-invocation-environment');
    const cliFailure = z.object({ code: z.string() }).safeParse(launched.error);
    expect(launched.ok, cliFailure.success ? cliFailure.data.code : launched.kind).toBe(true);
    const { session } = z.object({ session: z.object({ id: z.string() }) }).parse(launched.data);
    await observeAgentEnvironment(session.id, invocation);
    expect(await readFile(agent.logPath, 'utf8')).not.toContain('private-native-sentinel');
    // Plaintext in both the process and dotenv channels cannot satisfy a secret requirement.
    await writeFile(join(machine.workspaceDir, '.env.local'), 'DATABASE_URL=plaintext-is-not-a-reference\n');
    await writeFile(join(machine.workspaceDir, '.happier/project.json'), JSON.stringify({ version: 1,
      environmentVariables: [{ name: 'DATABASE_URL', kind: 'secret', required: true }] }));
    const missingSecret = await account.execute('projects.inspect', { workspace: opened.workspace, read: { kind: 'setup' } });
    expect(missingSecret).toMatchObject({ ok: true, result: { setupReadiness: {
      kind: 'needsReview', code: 'project_environment_binding_unavailable' } } });
    expect(JSON.stringify(missingSecret)).not.toContain('plaintext-is-not-a-reference');
  });
});

describe('TS.A.remove runs trusted teardown before removal and preserves failures', () => {
  let removalFixture: ProjectDaemonFixture | undefined;
  let account: SetupAccount;
  let machine: SetupMachine;
  let repository: string;
  let failedCheckout: string | undefined;
  let ports: ReturnType<typeof createWorktreePortsOwner>;
  let refuseHomeDelete: string | undefined;
  let refusedHomeDeletes = 0;
  beforeAll(async () => {
    removalFixture = await startProjectDaemonFixture({ testDir: await mkdtemp(join(tmpdir(), 'team-setup-a-remove-')),
      dbProvider: 'postgres', daemonAuthentication: 'existing-terminal', personActionSurface: 'coreAction', advertiseRequestObservationEndpoint: true,
      personActionClient,
      serverEnv: { HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1', HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1' },
      daemonEnv: { HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_CLAUDE_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'team-setup-a-agent-')) },
      beforeHttpRequest: request => {
        if (request.method === 'DELETE' && request.path === refuseHomeDelete) {
          refusedHomeDeletes += 1;
          throw new Error('Home deletion refused before mutation');
        }
      } });
  });
  beforeAll(async () => {
    if (!removalFixture) throw new Error('Removal Home is unavailable');
    account = await removalFixture.createAccount('removal-owner');
    machine = await removalFixture.enrollDaemon(account);
  });
  beforeAll(async () => {
    await account.withPersonActionClient(async execute => {
      await requireProjectSetupReview(account, execute);
      await proveAdmittedProjectControl(account, machine, execute);
    });
    repository = join(machine.workspaceDir, 'repository');
    await mkdir(repository);
    execFileSync('git', ['init', '--quiet', repository]);
    execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '--quiet', '--allow-empty', '-m', 'Initial']);
    ports = createWorktreePortsOwner({ statePath: join(machine.homeDir, 'worktree-ports.json') });
  });
  afterAll(async () => { await removalFixture?.stop(); });

  const hasPortAssignment = async (rootPath: string) => {
    const state: unknown = JSON.parse(await readFile(join(machine.homeDir, 'worktree-ports.json'), 'utf8'));
    if (!state || typeof state !== 'object') throw new Error('Port owner state unavailable');
    const assignments: unknown = Reflect.get(state, 'assignments');
    return Boolean(assignments && typeof assignments === 'object' && Object.hasOwn(assignments, rootPath));
  };
  it.each([
    { name: 'removes a reviewed worktree', outcomes: ['removed'] },
    { name: 'requires a fresh teardown review when executable bytes change', outcomes: ['changed-effect'] },
    { name: 'refuses teardown consent from another Account', outcomes: ['foreign-consent'] },
    { name: 'honors Cancel and explicit Skip', outcomes: ['cancelled-and-skip'] },
    { name: 'retires, restores and empties Trash', outcomes: ['retired'] },
    { name: 'keeps a failed checkout during bulk deletion', outcomes: ['cleanup-failed', 'deleted'] },
    { name: 'forgets a checkout without teardown', outcomes: ['forgotten'] },
  ] as const)('$name', async ({ outcomes }) => {
    const lifetime = new AbortController();
    const { signal } = lifetime;
    onTestFinished(() => lifetime.abort());
    if (!removalFixture) throw new Error('Removal Home is unavailable');
    const home = removalFixture;
    // The second daemon can enroll while the requester prepares its own review.
    // Only one signed-in person uses the UI Action client at a time.
    const foreignRequester = outcomes.some(outcome => outcome === 'foreign-consent')
      ? home.createAccount('other-removal-owner').then(async account => ({ account, machine: await home.enrollDaemon(account) }))
      : undefined;
    void foreignRequester?.catch(() => {}); // The foreign control observes enrollment failure.
    let foreignBoundary = 'prepare requester review';
    if (foreignRequester) onTestFailed(() => console.error(`Foreign teardown Trust pending boundary: ${foreignBoundary}`));
    let storageBoundary: string | undefined;
    let failedProjectKey: string | undefined;
    if (outcomes.some(outcome => outcome === 'deleted')) onTestFailed(() => {
      console.error(`Storage bulk deletion pending boundary: ${storageBoundary}`);
      const observations = removalFixture?.takeRequestObservations()
        .filter(({ path }) => path === `${PROJECT_TRUST_ROUTE_V1}/read` || path.startsWith('/v1/approvals/'))
        .map(({ method, path, statusCode }) => ({ method, path: path.replace(/[^/]+$/, '*'), statusCode }));
      console.error('Storage bulk deletion request outcomes', observations);
    });
    for (const outcome of outcomes) {
      const marker = join(machine.workspaceDir, `${outcome}-effects`);
      const permit = join(machine.workspaceDir, `${outcome}-permit`);
      // Project Trust remembers one effect per Project. Give the two bulk
      // items separate Projects so the second approval preserves the first.
      const checkoutRepository = outcome === 'cleanup-failed' ? join(machine.workspaceDir, 'cleanup-failure-repository') : repository;
      if (outcome === 'cleanup-failed') {
        await mkdir(checkoutRepository);
        execFileSync('git', ['init', '--quiet', checkoutRepository]);
        execFileSync('git', ['-C', checkoutRepository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
          'commit', '--quiet', '--allow-empty', '-m', 'Initial cleanup failure Project']);
      }
      const removalContext = {
        presentUserConfirmation: { actionId: 'scm.worktree.remove' },
        externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
          project: { machineId: machine.target.machineId, directory: checkoutRepository } },
      } as const;
      const created = await account.executeAsPerson('scm.worktree.create', { cwd: checkoutRepository, displayName: outcome }, {
        ...removalContext, presentUserConfirmation: { actionId: 'scm.worktree.create' },
      });
      if (!created.ok) throw new Error(`Native worktree creation refused (${created.errorCode})`);
      const createdWorktree = ScmWorktreeCreateResponseSchema.parse(created.result);
      if (!createdWorktree.success) throw new Error(`Native worktree creation failed (${createdWorktree.errorCode})`);
      const checkout = createdWorktree.worktreePath;
      if (outcome === 'cleanup-failed') failedCheckout = checkout;
      await mkdir(join(checkout, '.happier'));
      // Real finite shell processes run on this Linux host; the effect survives checkout deletion.
      const cleanupScript = join(checkout, 'cleanup.sh');
      const scriptBytes = (effect: string) => `test -f '${permit}' && printf ${effect} >> '${marker}'\n`;
      await writeFile(cleanupScript, scriptBytes('cleanup'));
      await writeFile(join(checkout, '.happier/project.json'), JSON.stringify({ version: 1, workspace: {
        teardown: [{ kind: 'command', command: 'sh ./cleanup.sh' }],
      } }));
      execFileSync('git', ['-C', checkout, 'add', '.happier/project.json', 'cleanup.sh']);
      execFileSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
        'commit', '--quiet', '-m', 'Project teardown']);
      const { opened, accepted, initialReview } = await account.withPersonActionClient(async execute => {
        const openedAction = await execute('projects.open', { ...machine.target,
          source: { kind: 'folder', path: checkout }, materialization: { kind: 'attach' } });
        if (!openedAction.ok) throw new Error(openedAction.errorCode);
        const opened = OpenProjectResultV1Schema.parse(openedAction.result);
        if (opened.kind !== 'opened') throw new Error(`Removal fixture open: ${opened.kind}`);
        if (outcome === 'cleanup-failed' || outcome === 'deleted') {
          const projectKey = opened.facts?.projectKey;
          expect(projectKey, 'Bulk item must belong to an accepted Project').toBeDefined();
          if (outcome === 'cleanup-failed') failedProjectKey = projectKey;
          else expect(projectKey, 'Bulk items must keep independent remembered effects').not.toBe(failedProjectKey);
        }
        expect(await ports.assign({ rootPath: checkout, slots: 1 })).toMatchObject({ kind: 'ready' });
        await writeFile(permit, 'allow');
        const preparation = await execute('projects.prepare', { workspace: opened.workspace, phase: 'teardown' });
        if (!preparation.ok) throw new Error(preparation.errorCode);
        const accepted = ProjectCommandActionOutputV1Schema.parse(preparation.result).operation;
        const initialReview = await readSharedSetupReview({ account, machine }, accepted.operationId, execute);
        if (outcome === 'foreign-consent') return { opened, accepted, initialReview };
        const approved = await execute('projects.prepare', { workspace: opened.workspace, phase: 'teardown',
          heldOperationId: accepted.operationId, expectedEffectDigest: initialReview.digest,
          consentScope: 'untilChanged' });
        if (!approved.ok) throw new Error(`Teardown approval refused (${approved.errorCode})`);
        expect(await readSharedSetupOperation({ account, machine }, accepted.operationId, false, execute)).toMatchObject({ state: 'succeeded' });
        expect(await readFile(marker, 'utf8')).toBe('cleanup');
        await unlink(marker);
        if (outcome === 'changed-effect') {
          // The literal command is unchanged; only the executable bytes it reads changed.
          const oldDigest = initialReview.digest;
          await writeFile(cleanupScript, scriptBytes('revised-cleanup'));
          execFileSync('git', ['-C', checkout, 'add', 'cleanup.sh']);
          execFileSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
            'commit', '--quiet', '-m', 'Change cleanup executable bytes']);
          const changed = await execute('projects.prepare', { workspace: opened.workspace, phase: 'teardown' });
          if (!changed.ok) throw new Error(changed.errorCode);
          const changedOperation = ProjectCommandActionOutputV1Schema.parse(changed.result).operation;
          const changedReview = await readSharedSetupReview({ account, machine }, changedOperation.operationId, execute);
          expect(changedReview.digest).not.toBe(oldDigest);
          const stale = await execute('projects.prepare', { workspace: opened.workspace, phase: 'teardown',
            heldOperationId: changedOperation.operationId, expectedEffectDigest: oldDigest, consentScope: 'thisTime' });
          expect(stale).toMatchObject({ ok: true, result: { operation: {
            operationId: changedOperation.operationId, setupReview: { code: 'project_setup_effect_changed' },
          } } });
          await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await execute('projects.prepare', { workspace: opened.workspace, phase: 'teardown',
            heldOperationId: changedOperation.operationId, expectedEffectDigest: changedReview.digest,
            consentScope: 'untilChanged' })).toMatchObject({ ok: true });
          expect(await readSharedSetupOperation({ account, machine }, changedOperation.operationId, false, execute)).toMatchObject({ state: 'succeeded' });
          expect(await readFile(marker, 'utf8')).toBe('revised-cleanup');
          await unlink(marker);
        }
        return { opened, accepted, initialReview };
      });
      if (outcome === 'foreign-consent') {
        if (!foreignRequester) throw new Error('Foreign requester fixture is unavailable');
        foreignBoundary = 'enroll the foreign daemon';
        const { account: otherAccount, machine: otherMachine } = await foreignRequester;
        foreignBoundary = 'open the checkout as the foreign requester';
        await otherAccount.withPersonActionClient(async execute => {
          await requireProjectSetupReview(otherAccount, execute);
          const otherOpen = await execute('projects.open', { ...otherMachine.target,
            source: { kind: 'folder', path: checkout }, materialization: { kind: 'attach' } });
          if (!otherOpen.ok) throw new Error(otherOpen.errorCode);
          const otherProject = OpenProjectResultV1Schema.parse(otherOpen.result);
          if (otherProject.kind !== 'opened') throw new Error(`Other Project open: ${otherProject.kind}`);
          foreignBoundary = 'refuse the borrowed teardown decision';
          const foreignDecision = await execute('projects.prepare', { workspace: otherProject.workspace,
            phase: 'teardown', heldOperationId: accepted.operationId,
            expectedEffectDigest: initialReview.digest, consentScope: 'thisTime' });
          expect(foreignDecision).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
          foreignBoundary = 'hold and cancel the foreign requester’s own review';
          const otherPreparation = await execute('projects.prepare', { workspace: otherProject.workspace, phase: 'teardown' });
          if (!otherPreparation.ok) throw new Error(otherPreparation.errorCode);
          const otherOperation = ProjectCommandActionOutputV1Schema.parse(otherPreparation.result).operation;
          const otherReview = await readSharedSetupOperation({ account: otherAccount, machine: otherMachine },
            otherOperation.operationId, true, execute);
          expect(otherReview.setupReview)
            .toMatchObject({ code: 'project_setup_consent_required' });
          await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await execute('action.operations.cancel', { ...otherMachine.target, operationId: otherOperation.operationId }))
            .toMatchObject({ ok: true, result: { kind: 'requested' } });
          const cancelled = await readSharedSetupOperation({ account: otherAccount, machine: otherMachine },
            otherOperation.operationId, false, execute);
          expect(cancelled).toMatchObject({ state: 'cancelled' });
        });
        foreignBoundary = 'verify the preserved checkout';
        await expect(access(checkout)).resolves.toBeUndefined();
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        continue;
      }
      if (outcome === 'changed-effect') continue;
      if (outcome === 'cleanup-failed') {
        // The bulk Action below owns the first removal attempt on this item.
        await unlink(permit);
        continue;
      }
      if (outcome === 'forgotten') {
        expect(await account.executeReviewed('projects.workspace.forget', { serverId: opened.workspace.serverId,
          workspaceId: opened.workspace.workspaceId })).toMatchObject({ ok: true,
          result: { ok: true, workspaceId: opened.workspace.workspaceId } });
        await expect(access(checkout)).resolves.toBeUndefined();
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await hasPortAssignment(checkout)).toBe(true);
        continue;
      }
      const removalInput = { cwd: repository, worktreePath: checkout,
        confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN };
      if (outcome === 'removed') {
        expect(await account.executeAsPerson('scm.worktree.prune', { cwd: repository }, {
          presentUserConfirmation: { actionId: 'scm.worktree.prune' },
          externalActionTarget: removalContext.externalActionTarget,
        })).toMatchObject({ ok: true, result: { success: true } });
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(checkout)).resolves.toBeUndefined();
      }
      if (outcome === 'cancelled-and-skip') {
        await writeFile(cleanupScript, scriptBytes('changed-cleanup'));
        execFileSync('git', ['-C', checkout, 'add', 'cleanup.sh']);
        execFileSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
          'commit', '--quiet', '-m', 'Require a fresh cleanup review']);
        const requestId = randomUUID();
        let settled: string | undefined;
        const pending = account.executeReviewed('scm.worktree.remove', removalInput,
          { ...removalContext, actionRequestId: requestId, signal }).then(result => {
          settled = result.ok ? 'succeeded' : result.errorCode;
          return result;
        }, error => {
          settled = redactHarnessLogText(error instanceof Error ? error.message : String(error));
          return undefined;
        });
        let operationId: string | undefined;
        await waitFor(async () => {
          if (settled) throw new Error(`Worktree removal settled before the teardown review (${settled})`);
          const listed = await account.execute('action.operations.list', { ...machine.target,
            requestIdentity: { actionId: 'scm.worktree.remove', requestId } });
          if (!listed.ok) throw new Error(listed.errorCode);
          const operations = ActionOperationListV1ResponseSchema.parse(listed.result).items;
          expect(operations.length).toBeLessThanOrEqual(1);
          const held = operations.find(operation => operation.setupReview);
          if (!held) return false;
          expect(held.setupReview).toMatchObject({ code: 'project_setup_consent_required' });
          expect(held.setupReview?.reviewedEffectDigest).not.toBe(initialReview.digest);
          operationId = held.operationId;
          return true;
        }, { failFast: true, context: 'fresh teardown review on the retained removal' });
        expect(await account.executeAsPerson('action.operations.cancel', { ...machine.target, operationId }))
          .toMatchObject({ ok: true, result: { kind: 'requested' } });
        expect(await pending, settled).toMatchObject({ ok: false, errorCode: 'cancelled' });
        await expect(access(checkout)).resolves.toBeUndefined();
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await hasPortAssignment(checkout)).toBe(true);
        // The person explicitly chooses the reviewed removal without cleanup.
        expect(await account.executeReviewed('scm.worktree.remove', { ...removalInput, skipCleanup: true }, removalContext))
          .toMatchObject({ ok: true, result: { success: true } });
        await expect(access(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await waitFor(async () => !await hasPortAssignment(checkout));
        continue;
      }
      if (outcome === 'retired' || outcome === 'deleted') {
        const failedRoot = outcome === 'deleted' ? failedCheckout : undefined;
        if (outcome === 'deleted' && !failedRoot) throw new Error('Bulk deletion requires a failed native checkout');
        const checked = async () => {
          const listed = await account.execute('machines.storage.worktrees.list', machine.target);
          if (!listed.ok) throw new Error(listed.errorCode);
          const inventory = MachineStorageItemsListResultV1Schema.parse(listed.result).items;
          const refs = (failedRoot ? [failedRoot, checkout] : [checkout]).map(path => {
            const item = inventory.find(item => item.path === path);
            if (!item) throw new Error('Accepted worktree missing from storage owner inventory');
            return { itemId: item.itemId, path: item.path };
          });
          const response = await account.execute('machines.storage.items.check', { ...machine.target,
            refs });
          if (!response.ok) throw new Error(response.errorCode);
          const review = PileReviewV1Schema.parse(response.result);
          expect(review.items, `Storage review stayed: ${JSON.stringify(review.staying.map(item => item.reason))}`)
            .toHaveLength(refs.length);
          return review.items;
        };
        const apply = async () => {
          storageBoundary = 'review inventory';
          const items = await checked();
          const actionId = outcome === 'retired' ? 'machines.storage.trash.move' : 'machines.storage.deleteNow';
          storageBoundary = 'continue approved Storage Action';
          if (failedRoot) removalFixture?.takeRequestObservations();
          const response = await account.executeReviewed(actionId, { ...machine.target, items: items.map(item => ({ ref: item.ref,
            expect: item.expect, ...(outcome === 'retired' ? { claimedVerdict: item.verdict, reason: item.reason } : {}) })) },
          { presentUserConfirmation: { actionId }, signal });
          storageBoundary = 'verify Storage outcome';
          expect(response).toMatchObject({ ok: true });
          if (!response.ok) throw new Error(response.errorCode);
          const result = PileApplyResultV1Schema.parse(response.result);
          expect(result.outcomes).toMatchObject(items.map(item => item.ref.path === failedRoot
            ? { itemId: item.ref.itemId, status: 'failed', reason: { code: 'operation_failed' } }
            : { itemId: item.ref.itemId, status: outcome === 'retired' ? 'moved' : 'deleted' }));
          if (failedRoot) {
            await expect(access(failedRoot)).resolves.toBeUndefined();
            expect(await hasPortAssignment(failedRoot)).toBe(true);
            await expect(access(join(machine.workspaceDir, 'cleanup-failed-effects'))).rejects.toMatchObject({ code: 'ENOENT' });
          }
          expect(await readFile(marker, 'utf8')).toBe('cleanup');
          await expect(access(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
          await waitFor(async () => !await hasPortAssignment(checkout));
          return result;
        };
        let result = await apply();
        await unlink(marker);
        if (failedRoot) {
          storageBoundary = 'review failed item for explicit Skip';
          const listed = await account.execute('machines.storage.worktrees.list', machine.target);
          if (!listed.ok) throw new Error(listed.errorCode);
          const failed = MachineStorageItemsListResultV1Schema.parse(listed.result).items.find(item => item.path === failedRoot);
          if (!failed) throw new Error('Failed checkout disappeared before explicit cleanup Skip');
          const checked = await account.execute('machines.storage.items.check', { ...machine.target,
            refs: [{ itemId: failed.itemId, path: failed.path }] });
          if (!checked.ok) throw new Error(checked.errorCode);
          const review = PileReviewV1Schema.parse(checked.result);
          storageBoundary = 'continue approved explicit Skip';
          expect(await account.executeReviewed('machines.storage.deleteNow', { ...machine.target, skipCleanup: true,
            items: review.items.map(item => ({ ref: item.ref, expect: item.expect })) },
          { presentUserConfirmation: { actionId: 'machines.storage.deleteNow' }, signal })).toMatchObject({ ok: true,
            result: { outcomes: [{ itemId: failed.itemId, status: 'deleted' }] } });
          await expect(access(failedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(access(join(machine.workspaceDir, 'cleanup-failed-effects'))).rejects.toMatchObject({ code: 'ENOENT' });
          await waitFor(async () => !await hasPortAssignment(failedRoot));
        }
        if (outcome === 'retired') {
          expect(result.trashEntryIds).toHaveLength(1);
          const restored = await account.executeAsPerson('machines.storage.trash.restore', { ...machine.target,
            entryIds: result.trashEntryIds });
          if (!restored.ok) throw new Error(restored.errorCode);
          expect(TrashRestoreResultV1Schema.parse(restored.result).outcomes)
            .toMatchObject([{ entryId: result.trashEntryIds![0], status: 'restored', path: checkout }]);
          await expect(access(checkout)).resolves.toBeUndefined();
          await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          result = await apply();
          await unlink(marker);
          const emptied = await account.executeAsPerson('machines.storage.trash.empty', { ...machine.target,
            entryIds: result.trashEntryIds });
          if (!emptied.ok) throw new Error(emptied.errorCode);
          expect(TrashEmptyResultV1Schema.parse(emptied.result).outcomes)
            .toEqual([{ entryId: result.trashEntryIds![0], status: 'deleted' }]);
          await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        continue;
      }
      const removalRequestId = randomUUID();
      removalFixture?.takeRequestObservations();
      const removal = await account.executeReviewed('scm.worktree.remove', removalInput,
        { ...removalContext, actionRequestId: removalRequestId });
      const trustResponses = removalFixture?.takeRequestObservations()
        .filter(row => row.path.startsWith(`${PROJECT_TRUST_ROUTE_V1}/`))
        .map(({ method, path, statusCode }) => ({ method, path, statusCode }));
      expect(trustResponses).toEqual([{ method: 'POST', path: `${PROJECT_TRUST_ROUTE_V1}/read`, statusCode: 200 }]);
      const removalOperations = await account.execute('action.operations.list', { ...machine.target,
        requestIdentity: { actionId: 'scm.worktree.remove', requestId: removalRequestId } });
      if (!removalOperations.ok) throw new Error(removalOperations.errorCode);
      const removals = ActionOperationListV1ResponseSchema.parse(removalOperations.result).items;
      expect(removals).toHaveLength(1);
      expect(removals[0]).toMatchObject({ actionId: 'scm.worktree.remove', state: 'succeeded' });
      expect(removal).toMatchObject({ ok: true, result: { success: true } });
      expect(await readFile(marker, 'utf8')).toBe('cleanup');
      await expect(access(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
      await waitFor(async () => !await hasPortAssignment(checkout));
    }
  });

  async function prepareManagedSessionTeardown(execute: PersonAction, label: string) {
    // Original Session deletion must reach managed-directory cleanup while its
    // Home row and requester custody still exist, including the active Stop path.
    const updatedAtMs = Date.now();
    const spawned = await account.execute('session.spawn_new', {
      executionTarget: machine.target, directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      permissionMode: 'read-only', approvalProfileId: null,
      configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
        permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
      connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
    });
    if (!spawned.ok) throw new Error(`Managed removal Session refused (${spawned.errorCode}): ${redactHarnessLogText(spawned.error)}`);
    const created = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
    if (created.type !== 'success') {
      throw new Error(`Managed removal Session did not start (${created.type === 'error' ? created.code : created.type})`);
    }
    const metadata = await account.readSessionMetadata(created.sessionId);
    if (typeof metadata.path !== 'string') throw new Error('Managed Session root unavailable');
    const managedRoot = metadata.path;
    const marker = join(machine.workspaceDir, `${label}-effects`);
    const permit = join(managedRoot, '.permit-cleanup');
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    await mkdir(join(managedRoot, '.happier'), { recursive: true });
    await writeFile(join(managedRoot, '.happier/project.json'), JSON.stringify({ version: 1, workspace: {
      teardown: [{ kind: 'command', command: `test -f .permit-cleanup && printf cleanup >> ${quote(marker)}` }],
    } }));
    const openedAction = await execute('projects.open', { ...machine.target,
      source: { kind: 'folder', path: managedRoot }, materialization: { kind: 'attach' } });
    if (!openedAction.ok) throw new Error(openedAction.errorCode);
    const opened = OpenProjectResultV1Schema.parse(openedAction.result);
    if (opened.kind !== 'opened') throw new Error(`Managed removal Project open: ${opened.kind}`);
    await writeFile(permit, 'allow');
    const preparation = await execute('projects.prepare', { workspace: opened.workspace, phase: 'teardown' });
    if (!preparation.ok) throw new Error(preparation.errorCode);
    const preparationOperation = ProjectCommandActionOutputV1Schema.parse(preparation.result).operation;
    const review = await readSharedSetupReview({ account, machine }, preparationOperation.operationId, execute);
    const decision = await execute('projects.prepare', { workspace: opened.workspace, phase: 'teardown',
      heldOperationId: preparationOperation.operationId, expectedEffectDigest: review.digest, consentScope: 'untilChanged' });
    if (!decision.ok) throw new Error(`Managed teardown approval refused (${decision.errorCode})`);
    expect(await readSharedSetupOperation({ account, machine }, preparationOperation.operationId, false, execute))
      .toMatchObject({ state: 'succeeded' });
    await unlink(marker);
    return { sessionId: created.sessionId, managedRoot, marker, permit };
  }

  it('refuses Session deletion from a different Account with Machine access', () => account.withPersonActionClient(async execute => {
    const { sessionId, managedRoot, marker } = await prepareManagedSessionTeardown(execute, 'managed-session-viewer');
    // G2: a real second principal has Machine Use, not ownership of this Session.
    if (!removalFixture) throw new Error('Removal Home is unavailable');
    const otherAccount = await removalFixture.createAccount('session-removal-viewer');
    const ownerId = readAccountIdFromToken(account.credentials.token);
    const memberId = readAccountIdFromToken(otherAccount.credentials.token);
    if (!ownerId || !memberId) throw new Error('Second principal requires both Account identities');
    const baseUrl = removalFixture.server.baseUrl;
    await Promise.all([
      setUsername(baseUrl, account.credentials.token, 'ts_a_removal_owner'),
      setUsername(baseUrl, otherAccount.credentials.token, 'ts_a_removal_user'),
    ]);
    await addFriend(baseUrl, account.credentials.token, memberId);
    await addFriend(baseUrl, otherAccount.credentials.token, ownerId);
    const principal = { kind: 'account' as const, accountId: memberId };
    const grant = await execute('machines.access.grant.set', { ...machine.target, principal, level: 'view' },
      { presentUserConfirmation: { actionId: 'machines.access.grant.set' } });
    if (!grant.ok) throw new Error(`Second principal Machine grant failed (${grant.errorCode})`);
    expect(MachineAccessMutationResultV1Schema.parse(grant.result), 'Second principal Machine grant')
      .toMatchObject({ kind: 'saved', grant: { level: 'view' } });
    expect(await execute('machines.access.prepareKeys', machine.target))
      .toMatchObject({ ok: true, result: { kind: 'prepared' } });
    const rawMemberCall = (method: string, authorization?: { kind: 'session.write'; sessionId: string }) =>
      callExactMachineRpc({ credentials: otherAccount.credentials, machineId: machine.target.machineId,
        serverUrl: removalFixture!.actionServerApiUrl, method, request: method === SESSION_RPC_METHODS.SESSION_DELETE
          ? { sessionId } : { sessionId: null }, ...(authorization ? { authorization } : {}) });
    expect(await rawMemberCall(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).toMatchObject({ runs: expect.any(Array) });
    // The clear selector is refused by Home; omitting it is refused by the receiver.
    await expect(rawMemberCall(SESSION_RPC_METHODS.SESSION_DELETE,
      { kind: 'session.write', sessionId })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(await rawMemberCall(SESSION_RPC_METHODS.SESSION_DELETE)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(managedRoot)).resolves.toBeUndefined();
  }));

  it('retains the active Session and checkout if teardown or Home deletion fails', () => account.withPersonActionClient(async execute => {
    const { sessionId, managedRoot, marker, permit } = await prepareManagedSessionTeardown(execute, 'managed-session');
    await unlink(permit);
    expect(await ports.assign({ rootPath: managedRoot, slots: 1 })).toMatchObject({ kind: 'ready' });
    const trustResponses = () => removalFixture!.takeRequestObservations()
      .filter(row => row.path.startsWith(`${PROJECT_TRUST_ROUTE_V1}/`))
      .map(({ method, path, statusCode }) => ({ method, path, statusCode }));
    const oneTrustRead = [{ method: 'POST', path: `${PROJECT_TRUST_ROUTE_V1}/read`, statusCode: 200 }];
    trustResponses();
    expect(await execute('session.delete', { sessionId }))
      .toMatchObject({ ok: false, errorCode: 'project_setup_step_failed' });
    expect(trustResponses()).toEqual(oneTrustRead);
    expect((await account.readSessionMetadata(sessionId)).path).toBe(managedRoot);
    await expect(access(managedRoot)).resolves.toBeUndefined();
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await hasPortAssignment(managedRoot)).toBe(true);
    await writeFile(permit, 'allow');
    refuseHomeDelete = `/v1/sessions/${sessionId}`;
    expect(await execute('session.delete', { sessionId })).toMatchObject({ ok: false });
    expect(trustResponses()).toEqual(oneTrustRead);
    expect(refusedHomeDeletes).toBeGreaterThan(0);
    expect((await account.readSessionMetadata(sessionId)).path).toBe(managedRoot);
    await expect(access(managedRoot)).resolves.toBeUndefined();
    expect(await readFile(marker, 'utf8')).toBe('cleanup');
    expect(await hasPortAssignment(managedRoot)).toBe(true);
    refuseHomeDelete = undefined;
    await unlink(marker);
    expect(await execute('session.delete', { sessionId })).toMatchObject({ ok: true });
    expect(trustResponses()).toEqual(oneTrustRead);
    expect(await readFile(marker, 'utf8')).toBe('cleanup');
    await expect(access(managedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(account.readSessionMetadata(sessionId)).rejects.toThrow();
    await waitFor(async () => !await hasPortAssignment(managedRoot));
  }));

  it('removes a retained sync target through its daemon', async () => {
    // Create the native retained target through its real public producer. Both
    // daemons use this E2EE Account; no row, receipt or target authority is seeded.
    const target = await removalFixture!.enrollDaemon({ ...account, name: 'retained-sync-target' });
    console.info('[TS.A.remove sync] target Machine enrolled');
    const syncSource = join(machine.workspaceDir, 'retained-sync-source');
    const syncTarget = join(target.workspaceDir, 'retained-sync-copy');
    const syncMarker = join(target.workspaceDir, 'retained-sync-cleanup-effects');
    const syncPermit = join(target.workspaceDir, 'retained-sync-cleanup-permit');
    await mkdir(join(syncSource, '.happier'), { recursive: true });
    await writeFile(join(syncSource, '.happier/project.json'), JSON.stringify({ version: 1, workspace: {
      teardown: [{ kind: 'command', command: 'test -f ../retained-sync-cleanup-permit && printf cleanup >> ../retained-sync-cleanup-effects' }],
    } }));
    await writeFile(syncPermit, 'allow');
    await account.withPersonActionClient(async execute => {
      const sourceOpenAction = await execute('projects.open', { ...machine.target,
        source: { kind: 'folder', path: syncSource }, materialization: { kind: 'attach' } });
      if (!sourceOpenAction.ok) throw new Error(sourceOpenAction.errorCode);
      const sourceOpen = OpenProjectResultV1Schema.parse(sourceOpenAction.result);
      if (sourceOpen.kind !== 'opened') throw new Error(`Sync removal source open: ${sourceOpen.kind}`);
      const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const linkedAction = await execute('workspace.sync.relationship.create', {
        v: 1, sourceWorkspaceRefId: sourceOpen.workspace.workspaceId, targetMachineId: target.target.machineId,
        targetPath: syncTarget, mode: 'keep_synced', destinationIntent: 'materialize_from_source_workspace',
        purpose: 'worker_clean_copy', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      }, { presentUserConfirmation: { actionId: 'workspace.sync.relationship.create' } });
      if (!linkedAction.ok) throw new Error(linkedAction.errorCode);
      const linked = WorkspaceSyncRelationshipCreateResultV1Schema.parse(linkedAction.result);
      expect(linked.created).toBe(true);
      console.info('[TS.A.remove sync] native relationship created');
      expect(await readFile(join(syncTarget, '.happier/project.json'), 'utf8'))
        .toBe(await readFile(join(syncSource, '.happier/project.json'), 'utf8'));
      const targetOpenAction = await execute('projects.open', { ...target.target,
        source: { kind: 'folder', path: syncTarget }, materialization: { kind: 'attach' } });
      if (!targetOpenAction.ok) throw new Error(targetOpenAction.errorCode);
      const targetOpen = OpenProjectResultV1Schema.parse(targetOpenAction.result);
      if (targetOpen.kind !== 'opened') throw new Error(`Sync removal target open: ${targetOpen.kind}`);
      expect(targetOpen.workspace.workspaceId).toBe(linked.targetWorkspaceRefId);
      console.info('[TS.A.remove sync] target Project opened');
      const syncPrepared = await execute('projects.prepare', { workspace: targetOpen.workspace, phase: 'teardown' });
      if (!syncPrepared.ok) throw new Error(syncPrepared.errorCode);
      const syncPreparation = ProjectCommandActionOutputV1Schema.parse(syncPrepared.result).operation;
      const targetContext = { account, machine: target };
      const syncReview = await readSharedSetupReview(targetContext, syncPreparation.operationId, execute);
      console.info('[TS.A.remove sync] received target teardown review');
      expect(await execute('projects.prepare', { workspace: targetOpen.workspace, phase: 'teardown',
        heldOperationId: syncReview.operationId, expectedEffectDigest: syncReview.digest,
        consentScope: 'untilChanged' })).toMatchObject({ ok: true });
      expect(await readSharedSetupOperation(targetContext, syncReview.operationId, false, execute))
        .toMatchObject({ state: 'succeeded' });

      await unlink(syncMarker);
      console.info('[TS.A.remove sync] confirmed target teardown');
      const listedSync = await account.execute('workspace.sync.relationships.list', { controllerMachineId: linked.controllerMachineId });
      if (!listedSync.ok) throw new Error(listedSync.errorCode);
      const relationship = WorkspaceSyncRelationshipsListActionOutputV1Schema.parse(listedSync.result).relationships
        .find(item => item.definition.relationshipId === linked.relationshipId)?.definition;
      if (!relationship) throw new Error('Native retained copy omitted its committed relationship');
      const copyInput = { workspace: { serverId: removalFixture!.serverId, refId: linked.sourceWorkspaceRefId },
        machineId: linked.controllerMachineId, expectedRelationship: relationship };
      const inspectedCopy = await account.execute('projects.worker.copy.inspect', { ...copyInput, kind: 'preview',
        targetMachineId: target.target.machineId, targetWorkspaceRefId: linked.targetWorkspaceRefId });
      if (!inspectedCopy.ok) throw new Error(inspectedCopy.errorCode);
      const preview = ProjectWorkerCopyInspectResultV1Schema.parse(inspectedCopy.result);
      if (!preview.ok) throw new Error(preview.errorCode);
      const targetPorts = createWorktreePortsOwner({ statePath: join(target.homeDir, 'worktree-ports.json') });
      expect(await targetPorts.assign({ rootPath: syncTarget, slots: 1 })).toMatchObject({ kind: 'ready' });
      const retireInput = { ...copyInput,
        removeTargetCopy: { workspaceRefId: linked.targetWorkspaceRefId, rootFingerprint: preview.preview.rootFingerprint } };
      const retire = (actionRequestId: string) => account.executeReviewed('projects.worker.copy.retire', retireInput,
        { actionRequestId, presentUserConfirmation: { actionId: 'projects.worker.copy.retire' } }, execute);
      const trustResponses = () => removalFixture!.takeRequestObservations()
        .filter(row => row.path.startsWith(`${PROJECT_TRUST_ROUTE_V1}/`))
        .map(({ method, path, statusCode }) => ({ method, path, statusCode }));
      const oneTrustRead = [{ method: 'POST', path: `${PROJECT_TRUST_ROUTE_V1}/read`, statusCode: 200 }];
      await unlink(syncPermit);
      trustResponses();
      const failed = await retire(randomUUID());
      const failedTrustReads = trustResponses();
      const afterFailure = await account.execute('workspace.sync.relationships.list', { controllerMachineId: linked.controllerMachineId });
      if (!afterFailure.ok) throw new Error(afterFailure.errorCode);
      const retained = WorkspaceSyncRelationshipsListActionOutputV1Schema.parse(afterFailure.result).relationships;
      expect(retained.map(item => item.definition.relationshipId)).toContain(linked.relationshipId);
      expect(failed, JSON.stringify({
        outcome: failed.ok ? 'success' : { code: failed.errorCode, message: redactHarnessLogText(failed.error), cause: failed.failureCause },
        trustReads: failedTrustReads,
      })).toMatchObject({ ok: false, errorCode: 'project_setup_step_failed' });
      expect(failedTrustReads).toEqual(oneTrustRead);
      await expect(access(syncTarget)).resolves.toBeUndefined();
      await expect(access(syncMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      const assignmentsAfterFailure = JSON.parse(await readFile(join(target.homeDir, 'worktree-ports.json'), 'utf8'));
      expect(assignmentsAfterFailure).toMatchObject({ assignments: { [syncTarget]: expect.anything() } });

      await writeFile(syncPermit, 'allow');
      const retireRequestId = randomUUID();
      console.info('[TS.A.remove sync] requesting reviewed retirement');
      const retirement = await retire(retireRequestId);
      const successfulTrustReads = trustResponses();
      console.info('[TS.A.remove sync] retirement returned', retirement.ok ? 'ok' : retirement.errorCode);
      if (!retirement.ok) {
        const operations = await account.execute('action.operations.list', { serverId: removalFixture!.serverId,
          machineId: linked.controllerMachineId, requestIdentity: { actionId: 'projects.worker.copy.retire', requestId: retireRequestId } });
        const retained = operations.ok ? ActionOperationListV1ResponseSchema.parse(operations.result).items : [];
        throw new Error(`Sync retirement refused: ${JSON.stringify({
          code: retirement.errorCode, message: redactHarnessLogText(retirement.error), cause: retirement.failureCause,
          operations: retained.map(operation => ({ state: operation.state, code: operation.error?.errorCode })),
        })}`);
      }
      expect(retirement.result).toMatchObject({ status: 'retired' });
      expect(successfulTrustReads).toEqual(oneTrustRead);
      expect(await readFile(syncMarker, 'utf8')).toBe('cleanup');
      await expect(access(syncTarget)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(syncSource)).resolves.toBeUndefined();
      for (const [machineId, count] of [[linked.controllerMachineId, 1], [target.target.machineId, 0]] as const) {
        const operations = await account.execute('action.operations.list', { serverId: removalFixture!.serverId, machineId,
          requestIdentity: { actionId: 'projects.worker.copy.retire', requestId: retireRequestId } });
        if (!operations.ok) throw new Error(operations.errorCode);
        expect(ActionOperationListV1ResponseSchema.parse(operations.result).items).toHaveLength(count);
      }
      await waitFor(async () => {
        const state: unknown = JSON.parse(await readFile(join(target.homeDir, 'worktree-ports.json'), 'utf8'));
        const assignments: unknown = state && typeof state === 'object' ? Reflect.get(state, 'assignments') : undefined;
        return Boolean(assignments && typeof assignments === 'object' && !Object.hasOwn(assignments, syncTarget));
      });
    });
  });
});

describe('Linked Project setup', () => {
  let linkedHome: ProjectDaemonFixture;
  let focusedHome: ProjectDaemonFixture;
  let linkedAccount: SetupAccount;
  let firstFocusedAccount: SetupAccount;
  let nextFocusedAccount: SetupAccount;

  beforeAll(async () => {
    const [linkedDir, focusedDir, agentConfig] = await Promise.all([
      mkdtemp(join(tmpdir(), 'team-setup-a-link-')),
      mkdtemp(join(tmpdir(), 'team-setup-a-link-focus-')),
      mkdtemp(join(tmpdir(), 'team-setup-a-agent-')),
    ]);
    const [linked, focused] = await Promise.allSettled([
      startProjectDaemonFixture({ testDir: linkedDir, dbProvider: 'postgres', daemonAuthentication: 'existing-terminal',
        daemonEnv: { HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), HAPPIER_CLAUDE_CONFIG_DIR: agentConfig },
        observeActionRequests: true, advertiseRequestObservationEndpoint: true,
        personActionSurface: 'coreAction', personActionClient }),
      startProjectDaemonFixture({ testDir: focusedDir, dbProvider: 'postgres', daemonAuthentication: 'existing-terminal',
        observeActionRequests: true, advertiseRequestObservationEndpoint: true,
        personActionSurface: 'coreAction', personActionClient }),
    ]);
    if (linked.status === 'fulfilled') linkedHome = linked.value;
    if (focused.status === 'fulfilled') focusedHome = focused.value;
    if (linked.status === 'rejected') throw linked.reason;
    if (focused.status === 'rejected') throw focused.reason;
  });
  beforeAll(async () => {
    [linkedAccount, firstFocusedAccount, nextFocusedAccount] = await Promise.all([
      linkedHome.createAccount('linked-source-owner'),
      focusedHome.createAccount('first-focused-account'),
      focusedHome.createAccount('next-focused-account'),
    ]);
    const machine = await linkedHome.enrollDaemon(linkedAccount);
    await proveAdmittedProjectControl(linkedAccount, machine);
    await linkedHome.assertKnownGoodSessionControl(linkedAccount, machine);
  });
  afterAll(async () => {
    const results = await Promise.allSettled([linkedHome?.stop(), focusedHome?.stop()]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Linked Project fixture cleanup failed');
  });

  it('TS.A.link retains the linked Home detail and Open draft across delayed credentials and another Account', async () => {
    const [React, { vi }] = await Promise.all([import('react'), import('vitest')]);
    const { act, projectSetupRouter: router, connectUiSignedInActionClient, renderScreen, createDeferred, TokenStorage,
      resolveServerCredentialAccountScope, captureServerCredentialAccountScopeLifetime,
      readProjectSourcesCatalog, createFrontDoorActionExecute, projectSetupStorage: storage, ModalProvider,
      ProjectSourcesScreen, ProjectOpenScreen, getSessionDraftSnapshot } = personActionClient;
    let ui: Awaited<ReturnType<typeof connectUiSignedInActionClient>> | undefined;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let restoreCredentialRead: (() => void) | undefined;
    const releaseRead = createDeferred<void>();
    let phase = 'linked Home sign-in';
    onTestFailed(() => { console.info('[TS.A.link] phase at failure:', phase); });
    try {
      expect(focusedHome.serverId).not.toBe(linkedHome.serverId);
      ui = await connectUiSignedInActionClient({ ...linkedHome.personActionConnection,
        accountSecret: linkedAccount.auth.accountSigningSeed, withAccountLifecycle: false });
      phase = 'linked Account scope';
      await waitFor(async () => ui!.isAccountReady());
      phase = 'empty linked inventory';
      const linkedServerId = ui.serverId;
      const linkedAccountId = readAccountIdFromToken(linkedAccount.credentials.token);
      const resolution = await resolveServerCredentialAccountScope(linkedServerId);
      if (resolution.kind !== 'bound') throw new Error('Known-good linked Home credentials did not bind');
      const lifetime = captureServerCredentialAccountScopeLifetime(resolution);
      const catalog = readProjectSourcesCatalog(lifetime, createFrontDoorActionExecute()).read('', undefined);
      // The real authorized read produces the retained empty state; no store/cache is seeded.
      await catalog.load();
      expect(catalog.getSnapshot()).toMatchObject({ status: 'ready', rows: [] });
      phase = 'linked Source creation';
      const sourceAction = await ui.executeConfirmed('projects.sources.create', { serverId: linkedHome.serverId,
        name: 'Linked Source after empty inventory', requestKey: randomUUID(), repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'acme/linked-source' }, protocol: 'https',
        } }, { actionRequestId: randomUUID(), surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
          serverId: linkedServerId, serverIdentityId: linkedHome.serverId });
      if (!sourceAction.ok) throw new Error(sourceAction.errorCode);
      const { ProjectSourcesReadOutputV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
      const source = ProjectSourcesReadOutputV1Schema.parse(sourceAction.result);
      if (!source.ok) throw new Error(source.error);
      expect(catalog.getSnapshot()).toMatchObject({ status: 'ready', rows: [] });

      phase = 'first focused Account sign-in';
      await ui.close();
      ui = await connectUiSignedInActionClient({ ...focusedHome.personActionConnection,
        accountSecret: firstFocusedAccount.auth.accountSigningSeed, withAccountLifecycle: false });
      await waitFor(async () => storage.getState().profileScope?.accountId === readAccountIdFromToken(firstFocusedAccount.credentials.token));
      const focusedServerId = ui.serverId;
      const url = buildProjectSourceSetupUrl({ applicationOrigin: 'https://app.test', sourceId: source.source.id,
        homeTarget: linkedHome.serverId });
      const link = parseProjectSourceSetupLink(url);
      if (!link) throw new Error('Source link did not reach its canonical route parser');
      let readStarted = false;
      const readCredentials = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
      let delayNextLinkedRead = true;
      // Secure storage is the external boundary. Preserve its real answer, delaying only delivery.
      const readSpy = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (...args) => {
        const credentials = await readCredentials(...args);
        if (delayNextLinkedRead && new URL(args[0]).origin === new URL(linkedHome.personActionConnection.addressAnchorUrl).origin) {
          delayNextLinkedRead = false;
          readStarted = true;
          await releaseRead.promise;
        }
        return credentials;
      });
      restoreCredentialRead = () => readSpy.mockRestore();
      linkedHome.takeRequestObservations();
      focusedHome.takeRequestObservations();
      phase = 'mounted setup link and delayed credential read';
      await act(async () => { router.setParams({ source: link.sourceId, target: link.homeTarget }); });
      screen = await renderScreen(React.createElement(ModalProvider, null,
        React.createElement(ProjectSourcesScreen, { setupLink: true })));
      await waitFor(() => readStarted, { context: 'linked Home secure credential read' });
      expect(screen.findHostByTestId('projects.sources.setup.target')).not.toBeNull();
      expect(linkedHome.takeRequestObservations().filter(request => request.path.startsWith('/v1/projects/sources'))).toEqual([]);

      // The linked credential is still pending while the real focused Home changes Account.
      phase = 'second focused Account sign-in';
      await ui.close();
      ui = await connectUiSignedInActionClient({ ...focusedHome.personActionConnection,
        accountSecret: nextFocusedAccount.auth.accountSigningSeed, withAccountLifecycle: false });
      await waitFor(async () => storage.getState().profileScope?.accountId === readAccountIdFromToken(nextFocusedAccount.credentials.token));
      phase = 'linked detail after releasing the credential';
      await act(async () => { releaseRead.resolve(); });
      await waitFor(async () => {
        expect(screen!.findHostByTestId('projects.sources.detail.header'),
          'Selected linked Source remains visible beside a retained empty inventory').not.toBeNull();
        return true;
      });
      expect(screen.findHostByTestId('projects.sources.empty')).toBeNull();
      expect(screen.getTextContent()).toContain(source.source.name);
      expect(catalog.getSnapshot()).toMatchObject({ status: 'ready', rows: [] });
      expect(linkedHome.takeRequestObservations().filter(request => request.path.startsWith('/v1/projects/sources')))
        .toEqual([{ method: 'GET', path: `/v1/projects/sources/${encodeURIComponent(source.source.id)}?serverId=${encodeURIComponent(linkedServerId)}`, statusCode: 200 }]);
      expect(focusedHome.takeRequestObservations().filter(request => request.path.startsWith('/v1/projects/sources'))).toEqual([]);

      phase = 'Open draft on the linked Home';
      await screen.pressByTestIdAsync('projects.sources.detail.open');
      await waitFor(async () => {
        expect(screen!.findHostByTestId('projects.open.dialog'),
          'Linked Source Open retains its own Home while another Account is focused').not.toBeNull();
        return true;
      });
      await waitFor(async () => screen!.findAllByType(ProjectOpenScreen).length > 0);
      const { z } = await import('@happier-dev/protocol/zodRuntimePolicy');
      const presentation = z.object({ routeParams: z.object({ serverId: z.string(), draftId: z.string() }) })
        .parse(screen.findByType(ProjectOpenScreen).props);
      expect(presentation.routeParams.serverId).toBe(linkedServerId);
      const draft = { kind: 'projectOpen' as const, draftId: presentation.routeParams.draftId };
      expect(getSessionDraftSnapshot({ serverId: linkedServerId, accountId: linkedAccountId }, draft)?.document)
        .toMatchObject({ selection: { value: { serverId: linkedServerId, source: { kind: 'source', id: source.source.id } } } });
      expect(getSessionDraftSnapshot({ serverId: focusedServerId,
        accountId: readAccountIdFromToken(nextFocusedAccount.credentials.token) }, draft)).toBeNull();
      expect(storage.getState().profileScope).toMatchObject({ serverId: focusedServerId,
        accountId: readAccountIdFromToken(nextFocusedAccount.credentials.token) });
      expect(linkedHome.takeRequestObservations().filter(request => request.method !== 'GET'
        && request.path.startsWith('/v1/projects/sources'))).toEqual([]);
    } finally {
      releaseRead.resolve();
      restoreCredentialRead?.();
      await screen?.unmount();
      await act(async () => { router.setParams({ source: undefined, target: undefined }); });
      await ui?.close();
    }
  });
});
