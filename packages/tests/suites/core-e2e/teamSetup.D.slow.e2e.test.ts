import React from 'react';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamInvitationAcceptResultV1Schema, TeamInvitationCreateResultV1Schema } from '@happier-dev/protocol/teams/invitation';
import { OpenProjectResultV1Schema, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectSourcesReadOutputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { TeamJoinedCard } from '../../../../apps/ui/sources/components/teams/join/TeamJoinedCard';
import { TeamJoinedSummary } from '../../../../apps/ui/sources/components/teams/join/TeamJoinedSummary';
import { TeamAuthEntrySurface } from '../../../../apps/ui/sources/components/teams/entry/TeamAuthEntrySurface';
import { renderHook, renderScreen } from '../../../../apps/ui/sources/dev/testkit';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope';
import { storage } from '../../../../apps/ui/sources/sync/domains/state/storage';
import { createMachinePresetCollectionClient } from '../../../../apps/ui/sources/sync/ops/machines/machinePresetCollectionClient';
import { createProjectManifestActionClient } from '../../../../apps/ui/sources/components/projects/projectSetup/projectManifestActionClient';
import { useTeamBinding } from '../../../../apps/ui/sources/hooks/teams/useTeamBinding';
import { createFrontDoorActionExecute } from '../../../../apps/ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { readNewSessionDraftProjectionFromRepository } from '../../../../apps/ui/sources/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { createNewSessionComposerDocumentOwner } from '../../../../apps/ui/sources/components/sessions/composer/newSessionComposerDocumentOwner';
import { resetRuntimeFetch, setRuntimeFetch } from '../../../../apps/ui/sources/utils/system/runtimeFetch';
import { prepareLocalSessionDraftScope } from '../../../../apps/ui/sources/sync/ops/sessionDrafts/sessionDraftRepository';
import { parseOnboardingScanPayload } from '../../../../apps/ui/sources/components/onboarding/state/scanPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const testDir = createRunDirs({ runLabel: 'core' }).testDir(`team-join-${randomUUID()}`);
let fixture: TeamSetupFFixture | undefined;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let machineId: string;
let invitationToken: string;
let invitationUrl: string;
let teamId: string;
let homeId: string;
let teamRepositorySource: ProjectSourceV1;
let member: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
let existingMember: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
let existingMemberInvitationToken: string;
const cliLaunchSpec = { command: process.execPath, args: ['--import',
  resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs'),
  resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: repoRootDir() };

beforeAll(async () => {
  fixture = await startTeamSetupFFixture({ testDir,
    dbProvider: process.env.HAPPIER_E2E_DB_PROVIDER === 'sqlite' ? 'sqlite' : 'postgres' });
  homeId = fixture.serverId;
  const owner = await fixture.createAccount('owner');
  await fixture.claimHomeOwner(owner);
  const ownerMachine = await fixture.enrollDaemon(owner, { cliLaunchSpec });
  const ownerUi = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: owner.uiCredentials });
  try {
    await waitFor(() => ownerUi.isAccountReady(), { timeoutMs: 60_000 });
    const context = { surface: 'ui', authority: 'present_user', serverId: ownerUi.serverId,
      actionCaller: { kind: 'host' } } as const;
    const ownerAccountId = getActiveServerAccountScope()?.accountId;
    if (!ownerAccountId) throw new Error('Fixture owner Account unavailable');
    await waitFor(() => ownerUi.isMachineActive(ownerMachine.target.machineId), { timeoutMs: 60_000 });
    const controlFolder = join(testDir, 'known-good-owner-project');
    await mkdir(controlFolder, { recursive: true });
    const control = await ownerUi.executeConfirmed('projects.open', { serverId: ownerUi.serverId,
      machineId: ownerMachine.target.machineId, source: { kind: 'folder', path: controlFolder },
      materialization: { kind: 'attach' } }, context);
    expect(control).toMatchObject({ ok: true, result: { kind: 'opened', directory: controlFolder } });
    const created = await ownerUi.executeConfirmed('teams.create', { v: 1, name: 'D Join', requestKey: randomUUID(),
      initialOwnerAccountId: ownerAccountId }, context);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`Team creation refused: ${created.errorCode}`);
    teamId = TeamSummaryV1Schema.parse(created.result).id;
    const sharedSource = await ownerUi.executeConfirmed('projects.sources.create', {
      serverId: ownerUi.serverId, requestKey: randomUUID(), name: 'Team first project',
      owner: { kind: 'team', teamId },
      repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'happier-dev/onboarding', cloneUrl: 'https://github.com/happier-dev/onboarding.git' }, protocol: 'https' },
    }, context);
    if (!sharedSource.ok) throw new Error(`Team Source creation refused: ${sharedSource.errorCode}`);
    const createdSource = ProjectSourcesReadOutputV1Schema.parse(sharedSource.result);
    expect(createdSource).toMatchObject({ ok: true });
    if (!createdSource.ok) throw new Error(`Team Source unavailable: ${createdSource.error}`);
    teamRepositorySource = createdSource.source;
    const invited = await ownerUi.executeConfirmed('teams.invitations.create', { v: 1, teamId,
      role: 'member', historyAccess: 'from_membership', recipientEmail: null, requestKey: randomUUID() }, context);
    expect(invited.ok).toBe(true);
    if (!invited.ok) throw new Error(`Invitation creation refused: ${invited.errorCode}`);
    const { joinUrl } = TeamInvitationCreateResultV1Schema.parse(invited.result);
    if (!joinUrl) throw new Error('Invitation did not publish its one-time join URL');
    invitationUrl = joinUrl;
    invitationToken = new URL(joinUrl).pathname.split('/').at(-1)!;
    const existingInvitation = await ownerUi.executeConfirmed('teams.invitations.create', { v: 1, teamId,
      role: 'member', historyAccess: 'from_membership', recipientEmail: null, requestKey: randomUUID() }, context);
    if (!existingInvitation.ok) throw new Error(`Existing-Machine invitation refused: ${existingInvitation.errorCode}`);
    const existingUrl = TeamInvitationCreateResultV1Schema.parse(existingInvitation.result).joinUrl;
    if (!existingUrl) throw new Error('Existing-Machine invitation URL unavailable');
    existingMemberInvitationToken = new URL(existingUrl).pathname.split('/').at(-1)!;
  } finally { await ownerUi.close(); }
  existingMember = await fixture.createAccount('existing-member');
  const enrolled = await fixture.enrollDaemon(existingMember, { cliLaunchSpec });
  machineId = enrolled.target.machineId;
  member = await fixture.createAccount('fresh-member');
  ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: member.uiCredentials });
  await waitFor(() => ui!.isAccountReady(), { timeoutMs: 60_000 });
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const stop of [() => ui?.close(), () => fixture?.stop()]) {
    try { await stop(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'D1 fixture cleanup failed');
});

it('TS.D.join continues the admitted Account into setup instead of ending at Open Team', async () => {
  const admittedScope = getActiveServerAccountScope();
  if (!admittedScope) throw new Error('Fresh member Account unavailable');
  await prepareLocalSessionDraftScope(admittedScope);
  const context = { surface: 'ui', authority: 'present_user', serverId: ui!.serverId,
    expectedAccountId: admittedScope.accountId, actionCaller: { kind: 'host' } } as const;
  // The owner-principal projects.open control ran before this fresh Account was created.
  expect(Object.keys(storage.getState().machines)).toEqual([]);
  expect.soft(parseOnboardingScanPayload(invitationUrl)).toMatchObject({ kind: 'team_join' });
  const requests: string[] = [];
  setRuntimeFetch(async (input, init) => {
    requests.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
    return fetch(input, init);
  });
  const preview = await renderScreen(React.createElement(TeamAuthEntrySurface, {
    target: { kind: 'saved_profile', profileRef: ui!.serverId },
    invitation: { token: invitationToken, accountScope: getActiveServerAccountScope()! },
    onSelectAction: () => {}, onAdmissionComplete: () => {},
  }));
  try {
    await waitFor(() => Boolean(preview.findByTestId('team-auth-entry-join')), { timeoutMs: 60_000 });
    expect(preview.findByTestId('team-joined-resources')).toBeNull();
    // This observes HTTP resource reads only; Machine RPC count is not inferred from it.
    expect(requests.filter(path => path.includes('/projects/sources') || path.includes('/machines/presets'))).toEqual([]);
  } finally { await preview.unmount(); resetRuntimeFetch(); }
  const accepted = await ui!.executeConfirmed('teams.invitations.accept', { v: 1, token: invitationToken }, context);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(`Invitation admission refused: ${accepted.errorCode}`);
  const result = TeamInvitationAcceptResultV1Schema.parse(accepted.result);
  expect(result.outcome).toBe('joined');
  if (result.outcome !== 'joined') throw new Error(`Unexpected admission outcome: ${result.outcome}`);
  const { useTeamSetupPlan } = await import('../../../../apps/ui/sources/components/teams/setup/useTeamSetupPlan');
  const { useTeamSetupResources } = await import('../../../../apps/ui/sources/components/teams/setup/useTeamSetupResources');
  // Resource producers are mounted only after admission, against the real Team binding.
  const bindingHook = await renderHook(() => useTeamBinding(ui!.serverId, teamId));
  await waitFor(() => {
    const binding = bindingHook.getCurrent();
    return binding.kind === 'bound' && binding.state.kind === 'ready';
  }, { timeoutMs: 60_000 });
  const binding = bindingHook.getCurrent();
  const lifetime = captureActiveServerAccountScopeLifetime();
  if (binding.kind !== 'bound' || binding.state.kind !== 'ready' || !lifetime) throw new Error('Admitted Team binding unavailable');
  const resourceContext = { scope: binding.scope, address: binding.address, team: binding.state.team, lifetime };
  const resourceHook = await renderHook(() => useTeamSetupResources(resourceContext));
  await waitFor(() => resourceHook.getCurrent().credentialsEnabled && resourceHook.getCurrent().credentials.resolved,
    { timeoutMs: 60_000 });
  expect(resourceHook.getCurrent().credentials.error).toBeNull();
  expect(resourceHook.getCurrent().credentials.resources).toEqual([]);
  await waitFor(() => resourceHook.getCurrent().sharedResources.status === 'ready', { timeoutMs: 60_000 });
  expect(resourceHook.getCurrent().sharedResources.error).toBeNull();
  expect(resourceHook.getCurrent().sharedResources.kinds).toEqual(expect.arrayContaining([
    { kind: 'sessions', status: 'available', count: 0 },
    { kind: 'projectSources', status: 'available', count: 1 },
  ]));
  let openedTeam = false;
  let continuedSetup = false;
  let continuation: Promise<void> | undefined;
  let freshTaskDraftId: string | undefined;
  const composer = createFrontDoorActionExecute(undefined, { sessionAuthoringPresentation: {
    navigateToNewSession: input => { freshTaskDraftId = input.draftId; },
  } });
  const setupHook = await renderHook(() => useTeamSetupPlan(composer, context));
  let firstProject: Extract<OpenProjectResultV1, { kind: 'opened' }> | undefined;
  let freshMachineId: string | undefined;
  const props = { testID: 'd-joined', result, teamName: 'D Join', accountScope: getActiveServerAccountScope(),
    summary: React.createElement(TeamJoinedSummary, { testID: 'team-joined-resources', context: resourceContext }),
    onOpenTeam: () => { openedTeam = true; },
    setupContinuation: { label: 'Set up for D Join', onContinue: () => continuation = (async () => {
      continuedSetup = true;
      const paired = await fixture!.enrollDaemon(member, { cliLaunchSpec });
      const pairedMachineId = paired.target.machineId;
      freshMachineId = pairedMachineId;
      await waitFor(() => ui!.isMachineActive(pairedMachineId), { timeoutMs: 60_000 });
      const folder = join(testDir, 'first-project');
      await mkdir(folder, { recursive: true });
      const prepared = await setupHook.getCurrent().prepare({ target: { serverId: ui!.serverId, homeId, machineId: pairedMachineId },
        repositories: [{ id: 'first-project', input: { source: { kind: 'folder', path: folder }, materialization: { kind: 'attach' } } }],
        isCurrent: lifetime.isCurrent });
      if (!prepared?.ok) throw new Error('Fresh member setup plan unavailable');
      const settled = await setupHook.getCurrent().run({ plan: prepared.plan });
      expect(settled.repositories).toMatchObject([{ id: 'first-project', result: { ok: true, result: { kind: 'opened', directory: folder } } }]);
      const opened = settled.repositories[0]?.result;
      if (!opened?.ok) throw new Error('Fresh project not opened');
      const project = OpenProjectResultV1Schema.parse(opened.result);
      if (project.kind !== 'opened') throw new Error('Fresh project not ready');
      firstProject = project;
    })() } };
  const screen = await renderScreen(React.createElement(TeamJoinedCard, props));
  try {
    await waitFor(() => Boolean(screen.findByTestId('team-joined-resources-projectSources')), { timeoutMs: 60_000 });
    await act(async () => { await screen.findByTestId('d-joined-action').props.onPress(); });
    expect(continuedSetup).toBe(true);
    expect(openedTeam).toBe(false);
    await continuation;
    expect(freshTaskDraftId).toBeUndefined();
    if (!firstProject || !freshMachineId) throw new Error('First task target unavailable');
    const authored = await setupHook.getCurrent().openFirstTask({ project: firstProject, machineId: freshMachineId,
      prompt: 'Inspect this project and suggest a first task.' });
    expect(authored.ok).toBe(true);
    expect(freshTaskDraftId).toBeTruthy();
    const scope = getActiveServerAccountScope();
    if (!scope || !freshTaskDraftId) throw new Error('Fresh member editable composer unavailable');
    expect(readNewSessionDraftProjectionFromRepository({ scope, draftId: freshTaskDraftId })?.draft).toMatchObject({
      input: 'Inspect this project and suggest a first task.',
    });
  } finally {
    await screen.unmount(); await setupHook.unmount(); await resourceHook.unmount(); await bindingHook.unmount();
  }
});

it('TS.D.selectedEffects applies only selected Machine setup and opens an editable first task', async () => {
  await ui!.close();
  ui = await connectUiActionClient({ serverUrl: fixture!.server.baseUrl, credentials: existingMember.uiCredentials });
  await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
  const scope = getActiveServerAccountScope();
  if (!scope) throw new Error('Member Account not ready');
  await prepareLocalSessionDraftScope(scope);
  const context = { surface: 'ui', authority: 'present_user', serverId: ui!.serverId,
    expectedAccountId: scope.accountId, actionCaller: { kind: 'host' } } as const;
  const admission = await ui!.executeConfirmed('teams.invitations.accept', { v: 1, token: existingMemberInvitationToken }, context);
  expect(admission).toMatchObject({ ok: true, result: { outcome: 'joined', teamId } });
  const marker = join(testDir, 'selected-setup.txt');
  const presets = createMachinePresetCollectionClient(scope, homeId);
  const saved = await presets.saveDraft({ id: randomUUID(), owner: { kind: 'account', accountId: scope.accountId },
    draft: { name: 'Existing member setup', setup: { scripts: [{ body: `printf selected > '${marker.replaceAll("'", "'\\''")}'` }] } } });
  expect(saved.kind).toBe('succeeded');
  if (saved.kind !== 'succeeded' || saved.value.kind !== 'saved') throw new Error('Member setup preset unavailable');
  const directory = join(testDir, 'selected-project');
  await mkdir(directory, { recursive: true });
  execFileSync('git', ['init', '--quiet', directory]);
  execFileSync('git', ['-C', directory, 'config', 'remote.origin.url', 'https://github.com/happier-dev/onboarding.git']);
  const dirtyPath = join(directory, 'person-draft.txt');
  await writeFile(dirtyPath, 'Keep my unfinished work\n');
  const existing = await ui!.executeConfirmed('projects.open', { serverId: ui!.serverId, machineId,
    source: { kind: 'folder', path: directory }, materialization: { kind: 'attach' } }, context);
  if (!existing.ok) throw new Error(`Existing checkout unavailable: ${existing.errorCode}`);
  const checkout = OpenProjectResultV1Schema.parse(existing.result);
  if (checkout.kind !== 'opened' || !('machineId' in checkout.workspace)) throw new Error('Existing checkout not opened on member Machine');
  const source = teamRepositorySource;
  const selector = source.repository;
  if (!selector) throw new Error('Joined Team repository fixture unavailable');
  let draftId: string | undefined;
  let openedProject: Extract<OpenProjectResultV1, { kind: 'opened' }> | undefined;
  let continuation: Promise<void> | undefined;
  const executeAction = createFrontDoorActionExecute(undefined, { sessionAuthoringPresentation: {
    navigateToNewSession: input => { draftId = input.draftId; },
  } });
  const missingFolder = { source: { kind: 'folder' as const, path: join(testDir, 'unavailable-checkout') },
    materialization: { kind: 'attach' as const } };
  // Characterize the real owner refusal, then require the batch receiver to retain it.
  const nativeRefusal = await executeAction.confirmed('projects.open', {
    ...missingFolder, serverId: ui!.serverId, machineId,
  }, context);
  expect(nativeRefusal.ok).toBe(false);
  if (nativeRefusal.ok) throw new Error('Missing-folder refusal fixture did not reach the Project owner');
  expect(nativeRefusal.errorCode).not.toBe('action_failed');
  const { useTeamSetupPlan } = await import('../../../../apps/ui/sources/components/teams/setup/useTeamSetupPlan');
  const { useTeamSetupBatchProgress } = await import('../../../../apps/ui/sources/components/teams/setup/useTeamSetupBatchProgress');
  const setupHook = await renderHook(() => {
    const controller = useTeamSetupPlan(executeAction, context);
    return { ...controller, repositoryProgress: useTeamSetupBatchProgress(controller.batch, source.id) };
  });
  const lifetime = captureActiveServerAccountScopeLifetime();
  if (!lifetime) throw new Error('Member Account lifetime unavailable');
  const prepared = await setupHook.getCurrent().prepare({ target: { serverId: ui!.serverId, homeId, machineId },
    preset: saved.value.preset, isCurrent: lifetime.isCurrent,
    repositories: [{ id: 'unavailable-checkout', input: missingFolder }, { id: source.id, input: {
      source: { kind: 'source', id: source.id, revision: source.revision, selector, checkout: checkout.workspace },
      materialization: { kind: 'attach' },
    } }],
  });
  expect(prepared?.ok).toBe(true);
  if (!prepared?.ok) throw new Error('Machine effects review unavailable');
  // Review alone must not run executable preset bytes.
  await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const screen = await renderScreen(React.createElement(TeamJoinedCard, {
    testID: 'd-selected', result: { outcome: 'already_member', teamId }, teamName: 'D Join', accountScope: scope,
    onOpenTeam: () => {}, setupContinuation: { label: 'Set up for D Join', onContinue: () => continuation = (async () => {
      const settled = await setupHook.getCurrent().run({ plan: prepared.plan,
        selection: { team: { serverId: ui!.serverId, teamId }, lifetime, sources: [source] } });
      expect(settled.machine).toMatchObject({ ok: true, result: { operationId: expect.any(String) } });
      expect(settled.machineSettlement).toBeNull();
      expect(await readFile(marker, 'utf8')).toBe('selected');
      expect(settled.repositories[0]).toMatchObject({ id: 'unavailable-checkout', result: {
        ok: false, errorCode: nativeRefusal.errorCode, error: nativeRefusal.error,
        ...(nativeRefusal.failureCause ? { failureCause: nativeRefusal.failureCause } : {}),
      } });
      const opened = settled.repositories[1]?.result;
      if (!opened) throw new Error('Selected project was not attempted');
      if (!opened.ok) throw new Error(`Selected project refused: ${opened.errorCode}`);
      const project = OpenProjectResultV1Schema.parse(opened.result);
      if (project.kind !== 'opened') throw new Error(`Project not opened: ${project.kind}`);
      openedProject = project;
    })() },
  }));
  try {
    await act(async () => { await screen.findByTestId('d-selected-action').props.onPress(); });
    expect(continuation).toBeTruthy();
    await continuation;
    await waitFor(() => setupHook.getCurrent().repositoryProgress?.ready === true, { timeoutMs: 60_000 });
    expect(setupHook.getCurrent().repositoryProgress).toMatchObject({ phase: 'ready', queued: false,
      team: { serverId: ui!.serverId, teamId }, source: { id: source.id, name: source.name },
      target: { serverId: ui!.serverId, homeId, machineId } });
    expect(setupHook.getCurrent().batch?.selection.repositories).toHaveLength(1);
    expect(openedProject?.directory).toBe(directory);
    expect(await readFile(dirtyPath, 'utf8')).toBe('Keep my unfinished work\n');
    // R-D2: setup edits reference-only Project metadata through the existing writer;
    // agent service choices remain with F defaults and ordinary Session admission.
    if (!openedProject?.facts?.projectKey) throw new Error('Project binding target unavailable');
    const projectRef = { serverId: ui!.serverId, projectKey: openedProject.facts.projectKey };
    const organization = storage.getState().projectAccountRows?.organizations.find(row =>
      row.key.serverId === projectRef.serverId && row.key.projectKey === projectRef.projectKey);
    const projectClient = createProjectManifestActionClient({ workspace: checkout.workspace,
      expectedAccountId: scope.accountId, execute: executeAction, signal: lifetime.signal });
    const reference = { ref: 'happier:shared-secret:v1:member-selected-key', revision: 1 };
    const bound = await projectClient.updateEnvironmentBinding({ projectRef,
      expectedRevision: organization?.revision ?? 'absent', environmentBinding: { name: 'DEPLOY_TOKEN', reference } });
    expect(bound).toMatchObject({ ok: true, row: { environmentBindings: { v: 1,
      bindings: { DEPLOY_TOKEN: reference } } } });
    if (!bound.ok || !('row' in bound)) throw new Error('Project binding writer refused the selected reference');
    const removed = await projectClient.updateEnvironmentBinding({ projectRef, expectedRevision: bound.revision,
      environmentBinding: { name: 'DEPLOY_TOKEN', reference: null } });
    expect(removed.ok).toBe(true);
    if (!removed.ok || !('row' in removed)) throw new Error('Project binding removal refused');
    expect(removed.row.environmentBindings?.bindings.DEPLOY_TOKEN).toBeUndefined();
    expect(draftId).toBeUndefined();
    if (!openedProject) throw new Error('First task project unavailable');
    const authored = await setupHook.getCurrent().openFirstTask({ project: openedProject, machineId,
      prompt: 'Review the project and propose the first change.' });
    expect(authored.ok).toBe(true);
    expect(draftId).toBeTruthy();
    if (!draftId) throw new Error('Normal task composer was not opened');
    await waitFor(async () => {
      try { return await readFile(marker, 'utf8') === 'selected'; } catch { return false; }
    }, { timeoutMs: 60_000 });
    expect(readNewSessionDraftProjectionFromRepository({ scope, draftId })?.draft).toMatchObject({
      input: 'Review the project and propose the first change.', selectedMachineId: machineId, selectedPath: directory,
    });
    const composer = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', draftId } });
    const current = composer.read();
    composer.apply(current.revision, { text: 'My edited first task', references: [], attachments: [] });
    expect(readNewSessionDraftProjectionFromRepository({ scope, draftId })?.draft.input).toBe('My edited first task');
  } finally { await screen.unmount(); await setupHook.unmount(); }
});
