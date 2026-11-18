import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installBundledPluginUiDeclarationsForTests, mountUiManagedMachineDetail } from '@happier-tests/ui-action-client';
import { TeamSummaryV1Schema, TeamsPageV1Schema } from '@happier-dev/protocol/teams/projections';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MachinePresetActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetRecipientCensusResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { createManagedMachinePresetAcquireOverrideV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedAcceptedV1Schema, ManagedListOutputV1Schema, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
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
  await mkdir(testDir, { recursive: true });
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', observeActionRequests: true, guestReachableHome: true,
    serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
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

it('TH.J5 creates and archives a Team and lets its member delete their own container with typed lifecycle refusals', async () => {
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
  // Guest enrollment is outside creator Delete. Substitute only that OS
  // executable, as in the existing managed-inspect journey; Docker allocation
  // and the controller's native reports remain real.
  const payloadRoot = join(testDir, 'non-enrolling-guest-payload');
  await mkdir(payloadRoot, { recursive: true });
  await writeFile(join(payloadRoot, 'happier'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const machine = await fixture.enrollDaemon(owner, { env: {
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: payloadRoot } });
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
  const content = { v: 1 as const, name: 'Member container', launch: {
    provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
    name: 'Member container', choices: { runtime: 'docker', configuration: {
      kind: 'image', image: process.env.HAPPIER_TEST_SANDBOX_IMAGE ?? 'codercom/example-base:ubuntu',
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
  const acquired = await member.execute('machines.managed.acquire', { presetContentOverride, selection: {
    kind: 'preset', homeId: fixture.serverId, id: presetId, revision: saved.preset.revision,
  } }, { presentUserConfirmation: { actionId: 'machines.managed.acquire' } });
  expect(acquired, JSON.stringify(acquired)).toMatchObject({ ok: true, result: { managedId: expect.any(String) } });
  if (!acquired.ok) throw new Error(acquired.errorCode);
  const acquiredOutput = ManagedAcceptedV1Schema.parse(acquired.result);
  const managedId = acquiredOutput.managedId;
  ownedManagedIds.add(managedId);
  const waitForOperation = async (operation: typeof acquiredOutput.operation) => {
    if (!operation) return;
    const result = await member.executeAsPerson('action.operations.get', {
      serverId: fixture!.serverId, machineId: machine.target.machineId,
      managed: { homeId: fixture!.serverId, managedId }, operationId: operation.operationId, waitForTerminal: true,
    });
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
  const { connectUiPersonActionClient } = await import('@happier-tests/ui-action-client');
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl,
    accountSecret: member.auth.accountSigningSeed });
  try {
    const screen = await mountUiManagedMachineDetail({ serverId: ui.serverId, managedId });
    try {
      await waitFor(() => screen.readControls().delete, { context: 'Creator Delete control on the member detail' });
      expect(screen.readControls()).toMatchObject({ stop: false, remove: false });
    } finally { await screen.close(); }
  } finally { await ui.close(); }

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
  expect(deleted, JSON.stringify(deleted)).toMatchObject({ ok: true, result: { kind: 'accepted' } });
  if (!deleted.ok) throw new Error(deleted.errorCode);
  const deletion = await waitForOperation(ManagedAcceptedV1Schema.parse(deleted.result).operation);
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
