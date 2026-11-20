import * as React from 'react';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams';
import { HomeHubLayoutResultSchema } from '@happier-dev/protocol/actions/specs/homeHub';
import { ProjectSourcesListOutputV1Schema, ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ProjectManifestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { z } from '@happier-dev/protocol/zodRuntimePolicy';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';

import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

// Only native UI/platform APIs are substituted. Home, Team discovery, Actions,
// Artifact persistence, socket delivery and the enrolled daemon stay real.
vi.mock('react-native-unistyles', async () =>
  (await import('../../../../apps/ui/sources/dev/testkit/mocks/unistyles')).createUnistylesMock());

const run = createRunDirs({ runLabel: 'team-home-demand' });
const testDir = run.testDir(`team-home-${randomUUID()}`);
let fixture: TeamSetupFFixture | undefined;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let credentials: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>['uiCredentials'];
let machineId: string;
let accountId: string;
let memberAccount: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;

beforeAll(async () => {
  fixture = await startTeamSetupFFixture({ testDir });
  const account = await fixture.createAccount('member');
  memberAccount = account;
  accountId = readAccountIdFromToken(account.credentials.token);
  await fixture.claimHomeOwner(account);
  credentials = account.uiCredentials;
  const enrolled = await fixture.enrollDaemon(account);
  machineId = enrolled.target.machineId;
  await fixture.assertKnownGoodMachineControl(account, enrolled);
  // Let the server and daemon startup phases report their own failures.
}, 0);

// The UI test environment clears saved Homes before each test. Restore the
// mounted client after that reset while retaining the same PostgreSQL Home.
beforeEach(async () => {
  if (!fixture) throw new Error('Team Home fixture not started');
  ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials });
  await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
});

afterEach(async () => {
  const client = ui;
  ui = undefined;
  await client?.close();
});

afterAll(async () => { await fixture?.stop(); });

it('TS.D.homeDemand offers the latest joined Team with setup without demanding it or revealing older joins on dismissal', async () => {
  if (!ui) throw new Error('UI Action client not started');
  const context = { surface: 'ui', authority: 'present_user', serverId: ui.serverId,
    actionCaller: { kind: 'host' } } as const;
  // P04: prove this fresh Account's admitted UI → server → daemon path before
  // a missing Home offer can count as the behavior RED.
  const folder = join(testDir, 'member-project');
  await mkdir(folder, { recursive: true });
  const openInput = { serverId: ui.serverId, machineId,
    source: { kind: 'folder' as const, path: folder }, materialization: { kind: 'attach' as const } };
  const control = await ui.executeConfirmed('projects.open', openInput, context);
  expect(control).toMatchObject({ ok: true, result: { kind: 'opened', directory: folder,
    workspace: { machineId, rootPath: folder } } });
  const { renderScreen } = await import('../../../../apps/ui/sources/dev/testkit');
  const { InjectedAuthProvider } = await import('../../../../apps/ui/sources/auth/context/AuthContext');
  const { AppShellPluginUiProjectionValueProvider } = await import('../../../../apps/ui/sources/components/appShell/plugins/AppShellPluginUiProjection');
  const { EMPTY_PLUGIN_UI_PROJECTION } = await import('../../../../apps/ui/sources/sync/domains/plugins/ui/projection');
  const { captureActiveServerAccountScopeLifetime } = await import('../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope');
  const { apiSocket } = await import('../../../../apps/ui/sources/sync/api/session/apiSocket');
  const machineCalls = vi.spyOn(apiSocket, 'machineRPC');
  const { HubSetupSection } = await import('../../../../apps/ui/sources/components/hub/HubSetupSection');
  const { WorkspaceNavigationProvider } = await import('../../../../apps/ui/sources/components/appShell/workspace/WorkspaceNavigationContext');
  const { createWorkspaceState } = await import('../../../../apps/ui/sources/components/appShell/workspace/workspaceState');
  const workspace = {
    active: true,
    state: createWorkspaceState({ id: 'home', target: { kind: 'home', params: {} }, pinned: false, preview: true }),
    canGoBack: false, canGoForward: false, openHref: () => true,
    activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
    navigationForTab: () => { throw new Error('Unexpected tab navigation'); },
    registerBackStep: () => () => {}, back: () => {}, forward: () => {},
  } satisfies import('../../../../apps/ui/sources/components/appShell/workspace/WorkspaceNavigationContext').WorkspaceNavigationContextValue;
  const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials,
    children: React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
      pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current',
      interactionEnabled: true, machineId: null, serverId: ui.serverId, platform: 'web',
      accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
      reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
    } }, React.createElement(WorkspaceNavigationProvider, { value: workspace }, React.createElement(HubSetupSection))) }));
  const teams = [];
  // Owner's live census: eleven memberships previously became eleven tiles.
  for (let index = 0; index < 11; index++) {
    const created = await ui.executeConfirmed('teams.create', { v: 1, name: 'Same team', initialOwnerAccountId: accountId,
      requestKey: randomUUID() }, context);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`Team creation refused (${created.errorCode})`);
    teams.push(TeamSummaryV1Schema.parse(created.result));
  }
  // Only the two earliest joins share setup. Newer empty memberships must not
  // displace their offer, and Source push must update the already-mounted Home.
  for (const team of teams.slice(0, 2)) {
    const source = await ui.executeConfirmed('projects.sources.create', {
      serverId: ui.serverId, requestKey: randomUUID(), name: `Setup for ${team.id}`,
      owner: { kind: 'team', teamId: team.id },
    }, context);
    if (!source.ok) throw new Error(`Shared Source creation refused (${source.errorCode})`);
    expect(ProjectSourcesReadOutputV1Schema.parse(source.result)).toMatchObject({ ok: true });
  }
  const latest = teams[1]!;
  expect(latest.viewerJoinedAt).toBeGreaterThan(teams[0]!.viewerJoinedAt!);
  const offerTestId = (teamId: string) => `hub-setup.team:${ui!.serverId}:${teamId}`;
  await vi.waitFor(() => expect(screen.findByTestId(offerTestId(latest.id))).not.toBeNull(),
    { timeout: 10_000 });
  for (const team of teams) if (team.id !== latest.id) {
    expect(screen.findByTestId(offerTestId(team.id))).toBeNull();
  }
  expect(machineCalls.mock.calls.filter(([, method]) => method === 'machines.setup.plan' || method === 'machines.setup.apply')).toHaveLength(0);
  const beforeDismiss = await ui.execute('home.hub.layout.get', {}, context);
  expect(beforeDismiss.ok).toBe(true);
  if (!beforeDismiss.ok) throw new Error(`Home layout unavailable (${beforeDismiss.errorCode})`);
  const beforeHidden = HomeHubLayoutResultSchema.parse(beforeDismiss.result).hiddenSetupStepIds;
  await screen.pressByTestIdAsync(`${offerTestId(latest.id)}.dismiss`);
  await waitFor(() => screen.findByTestId(offerTestId(latest.id)) === null,
    { context: 'Home setup tile dismissal persisted through PostgreSQL' });
  for (const team of teams) expect(screen.findByTestId(offerTestId(team.id))).toBeNull();
  const hidden = await ui.execute('home.hub.layout.get', {}, context);
  expect(hidden.ok).toBe(true);
  if (!hidden.ok) throw new Error(`Home layout unavailable (${hidden.errorCode})`);
  expect(HomeHubLayoutResultSchema.parse(hidden.result).hiddenSetupStepIds).toHaveLength(beforeHidden.length + 1);
  // Dismissal changes discovery only. An explicit Team read and selected native
  // project open still use their owning Actions after the tile has gone away.
  const reopened = await ui.execute('teams.get', { v: 1, teamId: latest.id }, context);
  expect(reopened).toMatchObject({ ok: true, result: { id: latest.id } });
  const opened = await ui.executeConfirmed('projects.open', openInput, context);
  expect(opened).toMatchObject({ ok: true, result: { kind: 'opened', directory: folder,
    workspace: { machineId, rootPath: folder } } });
  machineCalls.mockRestore();
});

it('TS.D.homeDemand pages the selected Team Sources at the server owner before a native open', async () => {
  if (!ui) throw new Error('UI Action client not started');
  const context = { surface: 'ui', authority: 'present_user', serverId: ui.serverId,
    actionCaller: { kind: 'host' } } as const;
  const folder = join(testDir, 'scoped-source-project');
  await mkdir(folder, { recursive: true });
  const openInput = { serverId: ui.serverId, machineId, source: { kind: 'folder' as const, path: folder },
    materialization: { kind: 'attach' as const } };
  expect(await ui.executeConfirmed('projects.open', openInput, context)).toMatchObject({ ok: true,
    result: { kind: 'opened', directory: folder, workspace: { machineId, rootPath: folder } } });
  const prefix = randomUUID();
  const created = await ui.executeConfirmed('teams.create', { v: 1, name: 'Source Team',
    initialOwnerAccountId: accountId, requestKey: randomUUID() }, context);
  if (!created.ok) throw new Error(`Team creation refused (${created.errorCode})`);
  const team = TeamSummaryV1Schema.parse(created.result);
  const sourceIds: string[] = [];
  for (const [index, ownership] of [
    { owner: { kind: 'team', teamId: team.id } },
    { audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }] },
    {},
  ].entries()) {
    const result = await ui.executeConfirmed('projects.sources.create', { serverId: ui.serverId,
      name: `${prefix}-${index}`, requestKey: randomUUID(), ...ownership }, context);
    if (!result.ok) throw new Error(`Source creation refused (${result.errorCode})`);
    const output = ProjectSourcesReadOutputV1Schema.parse(result.result);
    if (!output.ok) throw new Error(`Source creation refused (${output.error})`);
    sourceIds.push(output.source.id);
  }
  const control = await ui.execute('projects.sources.list', { serverId: ui.serverId, query: prefix }, context);
  expect(control).toMatchObject({ ok: true });
  if (!control.ok) throw new Error(`Source control refused (${control.errorCode})`);
  expect(ProjectSourcesListOutputV1Schema.parse(control.result)).toMatchObject({ ok: true,
    sources: expect.arrayContaining(sourceIds.map(id => expect.objectContaining({ id }))) });
  const page = await ui.execute('projects.sources.list', { serverId: ui.serverId,
    sharedWithTeamId: team.id, query: prefix, limit: 1 }, context);
  expect(page).toMatchObject({ ok: true });
  if (!page.ok) throw new Error(`Scoped Source page refused (${page.errorCode})`);
  const first = ProjectSourcesListOutputV1Schema.parse(page.result);
  expect(first).toMatchObject({ ok: true, sources: [expect.anything()], coverage: { complete: false } });
  if (!first.ok) throw new Error(`Scoped Source page refused (${first.error})`);
  const more = await ui.execute('projects.sources.list', { serverId: ui.serverId, sharedWithTeamId: team.id,
    query: prefix, cursor: first.coverage.nextCursor!, limit: 1 }, context);
  expect(more).toMatchObject({ ok: true });
  if (!more.ok) throw new Error(`Scoped Source page refused (${more.errorCode})`);
  const last = ProjectSourcesListOutputV1Schema.parse(more.result);
  expect(last).toMatchObject({ ok: true, coverage: { complete: true, nextCursor: null } });
  if (!last.ok) throw new Error(`Scoped Source page refused (${last.error})`);
  expect([...first.sources, ...last.sources].map(source => source.id).sort()).toEqual(sourceIds.slice(0, 2).sort());
  expect(await ui.executeConfirmed('projects.open', openInput, context)).toMatchObject({ ok: true,
    result: { kind: 'opened', directory: folder } });
});

it('TS.D.changedReferences receives a Source push and keeps accepted input until explicit review and native apply', async () => {
  if (!ui || !fixture) throw new Error('UI Action client not started');
  const context = { surface: 'ui', authority: 'present_user', serverId: ui.serverId,
    actionCaller: { kind: 'host' } } as const;
  const folder = join(testDir, 'changed-reference-project');
  await mkdir(folder, { recursive: true });
  const openedResult = await ui.executeConfirmed('projects.open', { serverId: ui.serverId, machineId,
    source: { kind: 'folder', path: folder }, materialization: { kind: 'attach' } }, context);
  expect(openedResult).toMatchObject({ ok: true, result: { kind: 'opened', directory: folder } });
  if (!openedResult.ok) throw new Error(openedResult.errorCode);
  const opened = OpenProjectResultV1Schema.parse(openedResult.result);
  if (opened.kind !== 'opened' || !opened.facts?.projectKey) throw new Error('Control omitted the admitted Project');
  const projectRef = { serverId: ui.serverId, projectKey: opened.facts.projectKey };
  const author = await fixture.createAccount('setup-author');
  const authorAccountId = readAccountIdFromToken(author.credentials.token);
  expect(authorAccountId).not.toBe(accountId);
  // The Home owner assigns the new Team to its author. The author then admits
  // the consuming Account as a member; Source publication and native consent
  // therefore cross real Account authorities rather than two clients of one.
  const createdTeam = await ui.executeConfirmed('teams.create', { v: 1, name: 'Changed references',
    initialOwnerAccountId: authorAccountId, requestKey: randomUUID() }, context);
  if (!createdTeam.ok) throw new Error(createdTeam.errorCode);
  const team = TeamSummaryV1Schema.parse(createdTeam.result);
  expect(await author.execute('teams.members.add', { v: 1, teamId: team.id, accountId,
    role: 'member', historyAccess: 'from_membership' },
  { presentUserConfirmation: { actionId: 'teams.members.add' } })).toMatchObject({ ok: true });
  const createdSource = await author.execute('projects.sources.create', { serverId: ui.serverId,
    name: 'Changed setup', owner: { kind: 'team', teamId: team.id }, requestKey: randomUUID() },
  { presentUserConfirmation: { actionId: 'projects.sources.create' } });
  if (!createdSource.ok) throw new Error(createdSource.errorCode);
  const created = ProjectSourcesReadOutputV1Schema.parse(createdSource.result);
  if (!created.ok) throw new Error(created.error);
  expect(created.source.createdByAccountId).toBe(authorAccountId);
  const publish = async (command: string, sourceRevision: number) => {
    const manifest = ProjectManifestV1Schema.parse({ version: 1, workspace: { setup: [{ kind: 'command', command }] } });
    // These are the author's protected executable command bytes. The member's
    // Machine runs neither version until that member accepts and consents.
    const publication = await author.execute('artifact.create', { artifactId: randomUUID(),
      header: { title: 'Changed setup', kind: 'project_setup.v1' }, body: JSON.stringify({ kind: 'project_setup.v1', manifest }) },
    { presentUserConfirmation: { actionId: 'artifact.create' } });
    if (!publication.ok) throw new Error(publication.errorCode);
    const artifact = ArtifactActionOutputSchemasV1['artifact.create'].parse(publication.result);
    const updated = await author.execute('projects.sources.update', { serverId: ui!.serverId,
      sourceId: created.source.id, expectedRevision: sourceRevision, patch: { attachment: { kind: 'attach', attachment: {
        purpose: 'setup', ref: { kind: 'doc', artifactId: artifact.artifactId, serverId: ui!.serverId },
        contentRevision: artifact.revision,
      } } } }, { presentUserConfirmation: { actionId: 'projects.sources.update' } });
    if (!updated.ok) throw new Error(updated.errorCode);
    const source = ProjectSourcesReadOutputV1Schema.parse(updated.result);
    if (!source.ok) throw new Error(source.error);
    return source.source;
  };
  const original = await publish('printf original > accepted-version', created.source.revision);
  expect(await ui.execute('projects.sources.read', { serverId: ui.serverId, sourceId: original.id }, context))
    .toMatchObject({ ok: true, result: { ok: true, canManage: false, source: { id: original.id } } });
  const accept = (expectedRevision: number | 'absent') => ui!.executeConfirmed('projects.setup.set', {
    projectRef, workspace: opened.workspace, expectedRevision, intent: { kind: 'accept', sourceId: original.id },
  }, context);
  const accepted = await accept('absent');
  expect(accepted).toMatchObject({ ok: true, result: { ok: true } });
  if (!accepted.ok) throw new Error(accepted.errorCode);
  const receipt = z.object({ revision: z.number(), row: z.object({ setupSelection: z.object({ digest: z.string() }) }) }).parse(accepted.result);
  const observe = async (operationId: string) => {
    const result = await ui!.execute('action.operations.get', { serverId: ui!.serverId, machineId, operationId }, context);
    if (!result.ok) throw new Error(result.errorCode);
    const observed = ActionOperationGetV1ResponseSchema.parse(result.result);
    if (observed.kind !== 'found') throw new Error(`Operation unavailable (${observed.kind})`);
    return observed.operation;
  };
  const hold = async () => {
    const prepared = await ui!.executeConfirmed('projects.prepare', { workspace: opened.workspace, phase: 'setup' }, context);
    if (!prepared.ok) throw new Error(prepared.errorCode);
    const { operationId } = ProjectCommandActionOutputV1Schema.parse(prepared.result).operation;
    let operation = await observe(operationId);
    await waitFor(async () => { operation = await observe(operationId); return Boolean(operation.setupReview); });
    if (!operation.setupReview) throw new Error('Setup did not offer the native review');
    return { operationId, digest: operation.setupReview.reviewedEffectDigest };
  };
  const apply = async (review: Awaited<ReturnType<typeof hold>>) => {
    expect(await memberAccount.executeAsPerson('projects.prepare', { workspace: opened.workspace, phase: 'setup',
      heldOperationId: review.operationId, expectedEffectDigest: review.digest, consentScope: 'untilChanged' },
    { presentUserConfirmation: { actionId: 'projects.prepare' } })).toMatchObject({ ok: true });
    await waitFor(async () => (await observe(review.operationId)).state === 'succeeded');
  };
  const initialReview = await hold();
  await apply(initialReview);
  expect(await readFile(join(folder, 'accepted-version'), 'utf8')).toBe('original');

  // Mount the actual scoped Source consumer. Its incumbent Account-change owner
  // supplies the update; the test never calls refresh/load after publication.
  const { useProjectSources } = await import('../../../../apps/ui/sources/components/projects/sources/useProjectSources');
  const { captureActiveServerAccountScopeLifetime } = await import('../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope');
  const { InjectedAuthProvider } = await import('../../../../apps/ui/sources/auth/context/AuthContext');
  const { renderScreen } = await import('../../../../apps/ui/sources/dev/testkit');
  const lifetime = captureActiveServerAccountScopeLifetime();
  if (!lifetime) throw new Error('Expected the admitted UI Account lifetime');
  let catalog: ReturnType<typeof useProjectSources> | null = null;
  function SelectedSources() {
    catalog = useProjectSources(lifetime!.scope, { lifetime, sharedWithTeamId: team.id });
    return null;
  }
  await renderScreen(React.createElement(InjectedAuthProvider, { credentials, children: React.createElement(SelectedSources) }));
  await vi.waitFor(() => expect(catalog?.state.rows.find(source => source.id === original.id)?.revision).toBe(original.revision));
  const updated = await publish('printf updated > accepted-version', original.revision);
  await vi.waitFor(() => expect(catalog?.state.rows.find(source => source.id === updated.id)?.revision).toBe(updated.revision),
    { timeout: 10_000 });
  const retained = await ui.execute('projects.inspect', { workspace: opened.workspace, read: { kind: 'setup' } }, context);
  expect(retained).toMatchObject({ ok: true });
  expect(JSON.stringify(retained)).toContain(receipt.row.setupSelection.digest);
  expect(JSON.stringify(retained)).not.toContain('printf updated');
  expect(await readFile(join(folder, 'accepted-version'), 'utf8')).toBe('original');
  // Only the person's explicit accept changes the attached input, and only
  // native consent runs it. A stale reviewed digest keeps the owner's reason.
  expect(await accept(receipt.revision)).toMatchObject({ ok: true, result: { ok: true } });
  const changedReview = await hold();
  expect(changedReview.digest).not.toBe(initialReview.digest);
  expect(await memberAccount.executeAsPerson('projects.prepare', { workspace: opened.workspace, phase: 'setup',
    heldOperationId: changedReview.operationId, expectedEffectDigest: initialReview.digest, consentScope: 'thisTime' },
  { presentUserConfirmation: { actionId: 'projects.prepare' } })).toMatchObject({ ok: true });
  expect((await observe(changedReview.operationId)).setupReview).toMatchObject({ code: 'project_setup_effect_changed' });
  expect(await readFile(join(folder, 'accepted-version'), 'utf8')).toBe('original');
  await apply(changedReview);
  expect(await readFile(join(folder, 'accepted-version'), 'utf8')).toBe('updated');
});
