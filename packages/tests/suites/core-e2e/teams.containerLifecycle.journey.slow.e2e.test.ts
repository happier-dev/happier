import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectUiActionClient, installBundledPluginUiDeclarationsForTests, mountUiManagedMachineDetail } from '@happier-tests/ui-action-client';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { TeamSummaryV1Schema, TeamsPageV1Schema } from '@happier-dev/protocol/teams/projections';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MachinePresetActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetRecipientCensusResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { createManagedMachinePresetAcquireOverrideV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedAcceptedV1Schema, ManagedDeleteOutputV1Schema, ManagedListOutputV1Schema, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';
import { projectBundledPluginUiDeclaration } from '../../../../apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { repoRootDir } from '../../src/testkit/paths';
import { waitFor } from '../../src/testkit/timing';

let fixture: TeamSetupFFixture | undefined;
let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let testDir: string;
let restoreDeclarations: (() => void) | undefined;
const ownedContainerIds = new Set<string>();
const ownedManagedIds = new Set<string>();

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'teams-container-lifecycle-journey-'));
  console.info(`[TH.J5.fixture] ${testDir}`);
  const manifest = PluginManifestV2LoadSchema.parse(JSON.parse(await readFile(resolve(repoRootDir(),
    'apps/cli/assets/bundled-plugin-manifests/devcontainer.json'), 'utf8')));
  restoreDeclarations = installBundledPluginUiDeclarationsForTests([await projectBundledPluginUiDeclaration({
    packageName: '@happier-dev/plugins-devcontainer', packageVersion: manifest.version, manifest, artifactGraphs: [],
  })]);
  const guestHomeHost = execFileSync('docker', ['network', 'inspect', 'bridge',
    '--format', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' }).trim();
  if (!guestHomeHost) throw new Error('The Docker bridge has no Home ingress address');
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', observeActionRequests: true,
    guestReachableHome: { host: guestHomeHost },
    serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl, HAPPIER_DEV_GUEST_CLI_EXPORT: '1' } });
}, 0);

afterAll(async () => {
  try {
    await fixture?.stop();
  } finally {
    try {
      for (const managedId of ownedManagedIds) {
        const ids = execFileSync('docker', ['ps', '--all', '--filter', `label=happier.managed-machine=${managedId}`,
          '--format', '{{.ID}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        for (const id of ids) ownedContainerIds.add(id);
      }
      // These exact IDs were observed after this journey's acquire, never a
      // controller-wide or label-wide cleanup of another journey's resources.
      for (const containerId of ownedContainerIds) {
        if (spawnSync('docker', ['inspect', containerId], { stdio: 'ignore' }).status === 0) {
          execFileSync('docker', ['rm', '--force', containerId], { stdio: 'pipe' });
        }
      }
      for (const managedId of ownedManagedIds) {
        expect(execFileSync('docker', ['ps', '--all', '--filter', `label=happier.managed-machine=${managedId}`,
          '--format', '{{.ID}}'], { encoding: 'utf8' }).trim()).toBe('');
      }
    } finally { try { await postgres?.stop(); } finally { restoreDeclarations?.(); } }
  }
}, 0);

it('TH.J5 creates and archives a Team and lets its member delete their own container with typed lifecycle refusals', async ({ onTestFinished }) => {
  if (!fixture) throw new Error('Team container lifecycle fixture did not start');
  const owner = await fixture.createAccount('lifecycle-owner');
  const member = await fixture.createAccount('lifecycle-member');
  const outsider = await fixture.createAccount('lifecycle-outsider');
  try { await fixture.claimHomeOwner(owner); }
  catch (error) {
    const stderr = await readFile(join(fixture.server.dataDir, 'claim-owner.stderr.log'), 'utf8');
    throw new Error(`Fixture Home owner claim failed: ${stderr}`, { cause: error });
  }
  const ownerId = readAccountIdFromToken(owner.credentials.token);
  const memberId = readAccountIdFromToken(member.credentials.token);
  if (!ownerId || !memberId) throw new Error('Lifecycle fixture Account token identity is missing');
  const machine = await fixture.enrollDaemon(owner);
  // A real Session must work on this exact controller before offline and access
  // refusals count: authentication or fixture failure cannot satisfy the case.
  await fixture.assertKnownGoodSessionControl(owner, machine);
  console.info('[TH.J5.control] The controller created its known-good Session');
  const created = await owner.execute('teams.create', { v: 1, name: 'Container lifecycle',
    initialOwnerAccountId: ownerId, requestKey: randomUUID() },
  { presentUserConfirmation: { actionId: 'teams.create' } });
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  expect(fixture.takeRequestObservations()).toContainEqual({ method: 'POST', path: '/v1/teams/create', statusCode: 200 });
  if (!created.ok) throw new Error(created.errorCode);
  const team = TeamSummaryV1Schema.parse(created.result);
  const memberCreate = await member.execute('teams.create', { v: 1, name: 'Member cannot create', requestKey: randomUUID() },
    { presentUserConfirmation: { actionId: 'teams.create' } });
  expect(memberCreate, JSON.stringify(memberCreate)).toMatchObject({ ok: false, errorCode: 'team_forbidden',
    details: { error: 'team_forbidden', details: { reason: 'managed_only' } } });
  expect(fixture.takeRequestObservations()).toContainEqual({ method: 'POST', path: '/v1/teams/create', statusCode: 403 });
  const missingOwner = await owner.execute('teams.create', { v: 1, name: 'Missing initial owner', requestKey: randomUUID() },
    { presentUserConfirmation: { actionId: 'teams.create' } });
  expect(missingOwner, JSON.stringify(missingOwner)).toMatchObject({ ok: false, errorCode: 'invalid_team_input',
    details: { error: 'invalid_team_input', details: { field: 'initialOwnerAccountId', reason: 'required' } } });
  expect(fixture.takeRequestObservations()).toContainEqual({ method: 'POST', path: '/v1/teams/create', statusCode: 400 });
  const afterRefusal = await owner.execute('teams.list', { v: 1, scope: 'administered', archived: 'active' });
  expect(afterRefusal, JSON.stringify(afterRefusal)).toMatchObject({ ok: true });
  if (!afterRefusal.ok) throw new Error(afterRefusal.errorCode);
  const teamsAfterRefusal = TeamsPageV1Schema.parse(afterRefusal.result);
  expect(teamsAfterRefusal.nextCursor).toBeNull();
  expect(teamsAfterRefusal.items.some(row => row.name === 'Missing initial owner')).toBe(false);
  expect(await owner.execute('teams.members.add', { v: 1, teamId: team.id, accountId: memberId,
    role: 'member', historyAccess: 'all_existing' },
  { presentUserConfirmation: { actionId: 'teams.members.add' } })).toMatchObject({ ok: true });
  expect(await member.execute('teams.get', { v: 1, teamId: team.id }))
    .toMatchObject({ ok: true, result: { id: team.id } });
  expect(await outsider.execute('teams.get', { v: 1, teamId: team.id }))
    .toMatchObject({ ok: false, errorCode: 'team_not_found' });

  const listed = await owner.execute('machines.list', { serverId: fixture.serverId });
  expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
  if (!listed.ok) throw new Error(listed.errorCode);
  const outputSchema = getActionSpec('machines.list').outputSchema;
  if (!outputSchema) throw new Error('Machine list has no output schema');
  const inventory = outputSchema.parse(listed.result);
  if (!inventory || typeof inventory !== 'object' || !('items' in inventory) || !Array.isArray(inventory.items)) {
    throw new Error('Machine inventory did not contain its public items');
  }
  const controllerRow: unknown = inventory.items.find((row: unknown) => row && typeof row === 'object'
    && 'machineId' in row && row.machineId === machine.target.machineId);
  if (!controllerRow || typeof controllerRow !== 'object' || !('installationId' in controllerRow)
    || typeof controllerRow.installationId !== 'string') throw new Error('Controller installation is missing');
  const controller = { machineId: machine.target.machineId, installationId: controllerRow.installationId };
  const presetOwner = { kind: 'team' as const, teamId: team.id };
  const presetId = randomUUID();
  const response = await fetch(`${fixture.server.baseUrl}/v1/machines/presets/recipient-census`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ homeId: fixture.serverId, owner: presetOwner, controller }),
  });
  expect(response.status).toBe(200);
  const census = ManagedMachinePresetRecipientCensusResultV1Schema.parse(await response.json());
  if (census.kind !== 'ready') throw new Error(`Preset census refused: ${census.code}`);
  const guestHomeCa = fixture.guestHomeCaCertificatePath;
  if (!guestHomeCa) throw new Error('The delegated Docker guest needs the fixture Home public CA');
  const ca = (await readFile(guestHomeCa)).toString('base64');
  const content = { v: 1 as const, name: 'Member container', launch: {
    provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
    name: 'Member container', choices: { runtime: 'docker', configuration: {
      // Install the fixture Home CA as the image user, just as the native Docker journey does.
      kind: 'image', image: process.env.HAPPIER_TEST_SANDBOX_IMAGE?.trim()
        || 'docker.io/library/buildpack-deps@sha256:5bac6b3020afcf0358de87990605d5dc4c3f060629381912266b9b9278375af3',
      setupScript: `printf '%s' '${ca}' | base64 -d > /usr/local/share/ca-certificates/happier-fixture.crt && update-ca-certificates`,
    } },
  } };
  const sealed = sealManagedMachinePresetContentV1({ presetId, mode: 'e2ee', content,
    recipientCensus: census.recipients, randomBytes: length => new Uint8Array(randomBytes(length)) });
  const savedExecution = await owner.execute('machines.presets.create', { id: presetId, homeId: fixture.serverId,
    owner: presetOwner, controller, teamAcquireDelegated: true, contentEncryptionMode: 'e2ee', ...sealed },
  { presentUserConfirmation: { actionId: 'machines.presets.create' } });
  expect(savedExecution, JSON.stringify(savedExecution)).toMatchObject({ ok: true });
  if (!savedExecution.ok) throw new Error(savedExecution.errorCode);
  const saved = MachinePresetActionOutputSchemasV1['machines.presets.create'].parse(savedExecution.result);
  if (saved.kind !== 'saved') throw new Error(`Preset save refused: ${JSON.stringify(saved)}`);
  const recipientEnvelope = sealed.recipients.find(recipient => recipient.accountId === memberId)?.envelope;
  if (!recipientEnvelope) throw new Error('Member preset recipient envelope is missing');
  const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'e2ee',
    projection: { content: sealed.content, recipientEnvelope }, accountId: memberId,
    accountKey: member.auth.accountMachineKey, enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
    randomBytes: length => new Uint8Array(randomBytes(length)) });
  if (!presetContentOverride) throw new Error('Member preset enrollment choices could not be sealed');
  const discovery = await fetch(`${fixture.server.baseUrl}/v1/features`);
  expect(discovery.status).toBe(200);
  const home = FeaturesResponseSchema.parse(await discovery.json()).homeConnectionDescriptor;
  if (!home) throw new Error('The fixture Home did not publish its connection descriptor');
  expect(home.homeServerIdentityId).toBe(fixture.serverId);
  const ui = await connectUiActionClient({ serverUrl: home.canonicalServerUrl, credentials: member.uiCredentials });
  onTestFinished(() => ui.close());
  expect(ui.serverId).toBe(fixture.serverId);
  const memberUiContext = () => ({ surface: 'ui' as const, authority: 'present_user' as const,
    actionCaller: { kind: 'host' as const }, serverId: ui.serverId, serverIdentityId: home.homeServerIdentityId,
    actionRequestId: randomUUID() });
  await ui.waitForPluginAccountAvailability();
  const acquired = await ui.executeConfirmed('machines.managed.acquire', { presetContentOverride, selection: {
    kind: 'preset', homeId: fixture.serverId, id: presetId, revision: saved.preset.revision,
  } }, memberUiContext());
  expect(acquired, JSON.stringify(acquired)).toMatchObject({ ok: true, result: { managedId: expect.any(String) } });
  if (!acquired.ok) throw new Error(acquired.errorCode);
  const acquiredOutput = ManagedAcceptedV1Schema.parse(acquired.result);
  const managedId = acquiredOutput.managedId;
  ownedManagedIds.add(managedId);
  const waitForOperation = async (operation: typeof acquiredOutput.operation) => {
    if (!operation) return;
    // The member can observe this managed resource through Home admission.
    // A direct Machine RPC would require visibility of the owner's controller.
    const result = await ui.execute('action.operations.get', {
      serverId: fixture!.serverId, machineId: machine.target.machineId,
      managed: { homeId: fixture!.serverId, managedId }, operationId: operation.operationId, waitForTerminal: true,
    }, memberUiContext());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`Managed operation unavailable: ${result.errorCode}`);
    const observed = ActionOperationGetV1ResponseSchema.parse(result.result);
    expect(observed.kind).toBe('found');
    return observed;
  };
  const read = async () => {
    const result = await member.execute('machines.managed.list', { homeId: fixture!.serverId, presetId });
    if (!result.ok) throw new Error(`Member inventory: ${result.errorCode}`);
    return ManagedListOutputV1Schema.parse(result.result).machines.map(unwrapManagedMachineReadV1)
      .find(row => row.id === managedId);
  };
  const allocation = await waitForOperation(acquiredOutput.operation);
  const managed = await read();
  expect(managed?.allocation, JSON.stringify(allocation)).toBe('bound');
  expect(managed).toMatchObject({ enrollmentAccountId: memberId, custodianAccountId: ownerId });
  console.info('[TH.J5.container] The member-created container bound through the owner controller');
  if (!managed) throw new Error('Created container disappeared');
  const containerId = execFileSync('docker', ['ps', '--all', '--filter', `label=happier.managed-machine=${managedId}`,
    '--format', '{{.ID}}'], { encoding: 'utf8' }).trim();
  expect(containerId).not.toBe('');
  ownedContainerIds.add(containerId);

  // The real member UI consumes the same admitted resource. This is the
  // creator Delete regression: their controller is private to the Team owner.
  const screen = await mountUiManagedMachineDetail({ serverId: ui.serverId, managedId });
  try {
    await waitFor(() => screen.readControls().delete, { context: 'Creator Delete control on the member detail' });
    expect(screen.readControls()).toMatchObject({ stop: false, remove: false });
  } finally { await screen.close(); }

  const inspected = await owner.execute('machines.managed.inspect', { homeId: fixture.serverId, managedId });
  expect(inspected, JSON.stringify(inspected)).toMatchObject({ ok: true });
  await machine.daemon.stop();
  const input = { homeId: fixture.serverId, managedId, when: 'now', expectedRevision: managed.intentRevision,
    intent: 'delete', reviewedDependencies: true };
  const offlineDelete = await member.execute('machines.managed.delete', input,
    { presentUserConfirmation: { actionId: 'machines.managed.delete' } });
  expect(offlineDelete, JSON.stringify(offlineDelete)).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  await machine.restart();
  const deleted = await member.execute('machines.managed.delete', input,
    { presentUserConfirmation: { actionId: 'machines.managed.delete' } });
  expect(deleted, JSON.stringify(deleted)).toMatchObject({ ok: true });
  if (!deleted.ok) throw new Error(deleted.errorCode);
  const deleteOutput = ManagedDeleteOutputV1Schema.parse(deleted.result);
  if (deleteOutput.kind !== 'accepted') throw new Error(`Member Delete did not start: ${JSON.stringify(deleteOutput)}`);
  expect(deleteOutput.managedId).toBe(managedId);
  const deletion = await waitForOperation(deleteOutput.operation);
  expect((await read())?.allocation, JSON.stringify(deletion)).toBe('confirmed-absent');
  expect(execFileSync('docker', ['ps', '--all', '--filter', `label=happier.managed-machine=${managedId}`,
    '--format', '{{.ID}}'], { encoding: 'utf8' }).trim()).toBe('');
  ownedContainerIds.delete(containerId);
  ownedManagedIds.delete(managedId);
  expect(await owner.execute('teams.archive', { v: 1, teamId: team.id },
    { presentUserConfirmation: { actionId: 'teams.archive' } })).toMatchObject({ ok: true });
  expect(await owner.execute('teams.get', { v: 1, teamId: team.id }))
    .toMatchObject({ ok: true, result: { archivedAt: expect.any(Number) } });
}, 0);
