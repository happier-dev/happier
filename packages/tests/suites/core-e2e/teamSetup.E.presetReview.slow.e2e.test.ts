import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedMachinePresetRecipientCensusResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { MachineSetupPlanResultV1Schema, machineSetupApplyTargetFromPlanV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupApplyResultV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupOperationV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';

import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const testDir = run.testDir(`preset-review-${randomUUID()}`);
let fixture: TeamSetupFFixture | undefined;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let account: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
let auth: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>['auth'];
let machineId: string;
let workspaceDir: string;

beforeAll(async () => {
  fixture = await startTeamSetupFFixture({ testDir });
  account = await fixture.createAccount('member');
  auth = account.auth;
  const enrolled = await fixture.enrollDaemon(account);
  machineId = enrolled.target.machineId;
  workspaceDir = enrolled.workspaceDir;
});

// Each test connects after the shared UI device reset has run.
beforeEach(async () => {
  ui = await connectUiActionClient({ serverUrl: fixture!.server.baseUrl, credentials: account.uiCredentials });
  await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
});

afterEach(async () => { await ui?.close(); ui = undefined; });

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => ui?.close(), () => fixture?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Preset review fixture cleanup failed');
});

async function action(id: string, input: unknown, confirmed = false) {
  if (!ui) throw new Error('UI Action client not started');
  return (confirmed ? ui.executeConfirmed : ui.execute)(id as Parameters<typeof ui.execute>[0], input,
    { surface: 'ui', authority: 'present_user', serverId: ui.serverId, actionCaller: { kind: 'host' } });
}

it('TS.E.presetReview publishes setup-only counters and bodyless notices through real E2EE authoring', async () => {
  const accountId = readAccountIdFromToken(auth.token);
  if (!accountId || !fixture || !ui) throw new Error('Expected ready Account');
  const id = randomUUID();
  const homeId = fixture.serverId;
  const marker = join(workspaceDir, 'preset-effects');
  const initialScript = `printf INITIAL >> '${marker.replace(/'/g, "'\\''")}'`;
  const changedScript = `printf CHANGED >> '${marker.replace(/'/g, "'\\''")}'`;
  const owner = { kind: 'account' as const, accountId };
  const response = await fetch(`${fixture.server.baseUrl}/v1/machines/presets/recipient-census`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ homeId, owner }),
  });
  expect(response.status).toBe(200);
  const census = ManagedMachinePresetRecipientCensusResultV1Schema.parse(await response.json());
  if (census.kind !== 'ready') throw new Error(`Expected recipient census: ${JSON.stringify(census)}`);
  const seal = (name: string, body: string, presetId = id) => sealManagedMachinePresetContentV1({ presetId, mode: 'e2ee',
    content: { v: 1, name, setup: { scripts: [{ body, affects: 'none' }] } },
    recipientCensus: census.recipients, randomBytes: length => new Uint8Array(randomBytes(length)) });
  const created = await action('machines.presets.create', { id, homeId, owner, contentEncryptionMode: 'e2ee',
    ...seal('Initial', initialScript) }, true);
  expect(created).toMatchObject({ ok: true, result: { kind: 'saved', preset: { id } } });
  if (!created.ok || !created.result || typeof created.result !== 'object' || !('preset' in created.result)) {
    throw new Error(`Expected saved preset: ${JSON.stringify(created)}`);
  }
  const original = created.result.preset as { revision: number };
  const retainedId = randomUUID();
  const retained = await action('machines.presets.create', { id: retainedId, homeId, owner, contentEncryptionMode: 'e2ee',
    ...seal('Retained', '', retainedId) }, true);
  expect(retained).toMatchObject({ ok: true, result: { kind: 'saved' } });
  if (!retained.ok || !retained.result || typeof retained.result !== 'object' || !('preset' in retained.result))
    throw new Error('Expected retained preset');
  const retainedRevision = (retained.result.preset as { revision: number }).revision;
  const planPreset = async (revision: number) => {
    const planned = await action('machines.setup.plan', { homeId, machineId, mode: 'effects', sources: [
      { kind: 'accountPresetOpaque', presetId: id, presetRevision: revision, contentEncryptionMode: 'e2ee' },
      { kind: 'accountPresetOpaque', presetId: retainedId, presetRevision: retainedRevision, contentEncryptionMode: 'e2ee' },
      { kind: 'direct', setup: {} },
    ] });
    expect(planned).toMatchObject({ ok: true });
    if (!planned.ok) throw new Error('Preset candidate review failed');
    return MachineSetupPlanResultV1Schema.parse(planned.result);
  };
  const apply = async (plan: ReturnType<typeof MachineSetupPlanResultV1Schema.parse>) => {
    const target = { homeId, machineId };
    const applied = await action('machines.setup.apply', { ...target,
      targets: [machineSetupApplyTargetFromPlanV1(target, plan)] }, true);
    expect(applied).toMatchObject({ ok: true });
    if (!applied.ok) throw new Error('Preset Apply failed');
    const receipt = MachineSetupApplyResultV1Schema.parse(applied.result);
    expect(await action('action.operations.get', { serverId: ui!.serverId, machineId,
      operationId: receipt.operationId, waitForTerminal: true })).toMatchObject({ ok: true,
      result: { kind: 'found', operation: { state: 'succeeded' } } });
  };
  await apply(await planPreset(original.revision));
  expect(await readFile(marker, 'utf8')).toBe('INITIAL');
  // The admitted native Apply is the known-good control before the new producer assertion.
  expect(created).toMatchObject({ ok: true, result: { kind: 'saved', preset: { id, setupRevision: 0 } } });
  expect(await action('machines.presets.archive', { homeId, id: retainedId, expectedRevision: retainedRevision }, true))
    .toMatchObject({ ok: true, result: { kind: 'saved' } });
  const renamed = await action('machines.presets.update', { id, homeId, expectedRevision: original.revision,
    patch: seal('Renamed', initialScript) }, true);
  expect(renamed).toMatchObject({ ok: true, result: { kind: 'saved', preset: { setupRevision: 0 } } });
  if (!renamed.ok || !renamed.result || typeof renamed.result !== 'object' || !('preset' in renamed.result)) {
    throw new Error(`Expected renamed preset: ${JSON.stringify(renamed)}`);
  }
  const next = renamed.result.preset as { revision: number };
  const changed = await action('machines.presets.update', { id, homeId, expectedRevision: next.revision,
    patch: seal('Renamed', changedScript) }, true);
  expect(changed).toMatchObject({ ok: true, result: { kind: 'saved', preset: { setupRevision: 1 } } });
  const notice = await action('machines.presets.list', { homeId, projection: 'revisions', includeArchived: true });
  expect(notice).toMatchObject({ ok: true, result: { kind: 'revisions', presets: expect.arrayContaining([{ id,
    homeId, revision: expect.any(Number), setupRevision: 1 }]) } });
  expect(JSON.stringify(notice)).not.toMatch(/"(?:content|recipients|setup|configurationDigest)"/);
  // Publication and declined Review leave the admitted attachment and effects alone.
  expect(await readFile(marker, 'utf8')).toBe('INITIAL');
  const attached = await action('machines.setup.plan', { homeId, machineId, mode: 'check' });
  expect(attached).toMatchObject({ ok: true, result: { sources: [
    { kind: 'accountPresetOpaque', presetId: id, setupRevision: 0 },
    { kind: 'accountPresetOpaque', presetId: retainedId, presetRevision: retainedRevision }, { kind: 'direct' },
  ] } });
  if (!changed.ok || !changed.result || typeof changed.result !== 'object' || !('preset' in changed.result)) {
    throw new Error('Expected updated preset');
  }
  const candidateRevision = (changed.result.preset as { revision: number }).revision;
  const planCandidate = async () => {
    const planned = await action('machines.setup.plan', { homeId, machineId, mode: 'effects',
      candidatePreset: { presetId: id, presetRevision: candidateRevision } });
    expect(planned).toMatchObject({ ok: true });
    if (!planned.ok) throw new Error('Preset candidate review failed');
    return MachineSetupPlanResultV1Schema.parse(planned.result);
  };
  await planCandidate(); // Decline by not applying this candidate.
  expect(await readFile(marker, 'utf8')).toBe('INITIAL');
  await apply(await planCandidate());
  expect(await readFile(marker, 'utf8')).toBe('INITIALCHANGED');
  expect(await action('machines.setup.plan', { homeId, machineId, mode: 'check' })).toMatchObject({ ok: true,
    result: { sources: [{ kind: 'accountPresetOpaque', presetId: id, setupRevision: 1 },
      { kind: 'accountPresetOpaque', presetId: retainedId, presetRevision: retainedRevision }, { kind: 'direct' }] } });
});
