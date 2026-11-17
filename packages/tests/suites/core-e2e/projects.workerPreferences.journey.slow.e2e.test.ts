import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectWorkerActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ProjectServicePlacementActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectServicePlacement';
import { createDefaultWorkspaceWorkerPreferenceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';

let fixture: ProjectDaemonFixture | undefined;
let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;

afterAll(async () => {
  try { await ui?.close(); }
  finally {
    try { await fixture?.stop(); }
    finally { await database?.stop(); }
  }
}, 0);

it('L12 rows15/16 keeps checkout worker choices across fresh reads, rejects stale edits and resets without changing the neighboring checkout', async () => {
  database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startProjectDaemonFixture({
    testDir: createRunDirs({ runLabel: 'core' }).testDir(`worker-preferences-journey-${randomUUID()}`),
    dbProvider: 'postgres', serverEnv: { ...process.env, DATABASE_URL: database.homeDatabaseUrl },
  });
  const owner = await fixture.createAccount('worker-preferences-owner');
  const source = await fixture.enrollDaemon(owner);
  const worker = await fixture.enrollDaemon({ ...owner, name: 'worker-preferences-target' });
  expect(source.target.machineId).not.toBe(worker.target.machineId);
  const person = ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl,
    accountSecret: owner.auth.accountSigningSeed });
  expect(person.isAccountReady()).toBe(true);
  expect(person.isMachineActive(source.target.machineId)).toBe(true);
  expect(person.isMachineActive(worker.target.machineId)).toBe(true);
  const execute = (actionId: Parameters<typeof person.executeConfirmed>[0], input: unknown) => person.executeConfirmed(actionId, input,
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: person.serverId, serverIdentityId: fixture!.serverId, actionRequestId: randomUUID() });
  const openCheckout = async (machine: typeof source) => {
    const result = await execute('projects.open', { serverId: person.serverId, machineId: machine.target.machineId,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } });
    if (!result.ok) throw new Error(`Project open refused (${result.errorCode}): ${JSON.stringify(result)}`);
    const opened = OpenProjectResultV1Schema.parse(result.result);
    if (opened.kind !== 'opened') throw new Error(`Project did not open: ${JSON.stringify(opened)}`);
    return { serverId: person.serverId, refId: opened.workspace.workspaceId };
  };
  const workspace = await openCheckout(source);
  const neighbor = await openCheckout(worker);
  const read = async (address: typeof workspace) => {
    const result = await execute('projects.worker.preferences.get', { workspace: address });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.errorCode);
    const current = ProjectWorkerActionOutputSchemasV1['projects.worker.preferences.get'].parse(result.result);
    if (current.status !== 'ready') throw new Error(`Worker preferences unavailable: ${current.status}`);
    return current;
  };
  const initial = await read(workspace);
  const neighborBefore = await read(neighbor);
  const next = { enabled: true as const, destination: { kind: 'machine' as const, machineId: worker.target.machineId },
    unavailable: 'ask' as const, allowAdHoc: true, scriptOverrides: { local: 'primary' as const } };
  const expectation = initial.revision === 'absent'
    ? { kind: 'absent' as const } : { kind: 'value' as const, value: initial.preference };
  const saved = await execute('projects.worker.preferences.set', {
    workspace, expectedRevision: initial.revision, expected: expectation, next,
  });
  expect(saved).toMatchObject({ ok: true, result: { status: 'applied', preference: next } });
  if (!saved.ok) throw new Error(saved.errorCode);
  ProjectWorkerActionOutputSchemasV1['projects.worker.preferences.set'].parse(saved.result);
  const persisted = await read(workspace);
  expect(persisted).toMatchObject({ provenance: 'saved', preference: next });
  const stale = await execute('projects.worker.preferences.set', {
    workspace, expectedRevision: initial.revision, expected: expectation,
    next: { ...next, unavailable: 'fail' },
  });
  expect(stale).toMatchObject({ ok: true, result: { status: 'conflict', preference: next } });
  expect(await read(workspace)).toEqual(persisted);
  expect(await read(neighbor)).toEqual(neighborBefore);
  const serviceName = 'preview';
  const placement = { runsOn: { kind: 'workers' as const, destination: next.destination }, unavailable: 'fail' as const };
  const serviceSaved = await execute('projects.service.placement.set', {
    workspace, serviceName, expectedRevision: persisted.revision, expected: { kind: 'absent' }, value: placement,
  });
  expect(serviceSaved).toMatchObject({ ok: true, result: { status: 'applied', placement } });
  if (!serviceSaved.ok) throw new Error(serviceSaved.errorCode);
  ProjectServicePlacementActionOutputSchemasV1['projects.service.placement.set'].parse(serviceSaved.result);
  const beforeReset = await read(workspace);
  expect(beforeReset.preference).toEqual(next);
  const reset = await execute('projects.worker.preferences.reset', {
    workspace, expectedRevision: beforeReset.revision, expected: { kind: 'value', value: beforeReset.preference },
  });
  expect(reset).toMatchObject({ ok: true, result: { status: 'applied', preference: createDefaultWorkspaceWorkerPreferenceV1() } });
  expect(await read(workspace)).toMatchObject({ preference: createDefaultWorkspaceWorkerPreferenceV1() });
  const serviceAfterReset = await execute('projects.service.placement.get', { workspace, serviceName });
  expect(serviceAfterReset).toMatchObject({ ok: true, result: { status: 'ready', placement } });
  if (!serviceAfterReset.ok) throw new Error(serviceAfterReset.errorCode);
  ProjectServicePlacementActionOutputSchemasV1['projects.service.placement.get'].parse(serviceAfterReset.result);
  expect(await read(neighbor)).toEqual(neighborBefore);
}, 0);
