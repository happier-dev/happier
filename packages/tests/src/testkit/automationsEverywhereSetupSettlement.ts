import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { createProjectSetupSuccessStore } from '../../../../apps/cli/src/workspaces/projectSetup/projectSetupSuccess';
import type { TeamSetupFFixture } from './teamSetupF';
import { attachMachineEventTrigger } from './automationsEverywhereGuardStop';
import { waitFor } from './timing';

type Account = Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
type Machine = Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;

/** Ordinary consent and native process settlement, never a synthetic host fact. */
export async function assertSetupSettlement(fixture: TeamSetupFFixture, actor: Account, machine: Machine) {
  const directory = join(machine.workspaceDir, 'f6-setup');
  await mkdir(join(directory, '.happier'), { recursive: true });
  const secret = 'F6_PRIVATE_SETUP_OUTPUT_NEVER_IN_EVENT_CAUSE';
  const manifestPath = join(directory, '.happier/project.json');
  const writeSetup = async (command: string) => writeFile(manifestPath, JSON.stringify({ version: 1,
    workspace: { setup: [{ kind: 'command', command }] } }));
  await writeSetup(`printf '${secret}'; printf finished > setup-result`);
  const opening = await actor.execute('projects.open', { ...machine.target,
    source: { kind: 'folder', path: directory }, materialization: { kind: 'attach' } },
  { presentUserConfirmation: { actionId: 'projects.open' } });
  if (!opening.ok) throw new Error(`Setup Project open refused (${opening.errorCode})`);
  const opened = OpenProjectResultV1Schema.parse(opening.result);
  if (opened.kind !== 'opened') throw new Error(`Setup Project unavailable (${opened.kind})`);
  const finished = await attachMachineEventTrigger(fixture, actor, machine, 'project-setup-finished');
  const failed = await attachMachineEventTrigger(fixture, actor, machine, 'project-setup-failed');
  const observe = async (operationId: string) => {
    const response = await actor.execute('action.operations.get', { ...machine.target, operationId });
    if (!response.ok) throw new Error(`Setup operation read refused (${response.errorCode})`);
    const parsed = ActionOperationGetV1ResponseSchema.parse(response.result);
    if (parsed.kind !== 'found') throw new Error('Accepted setup operation disappeared');
    return parsed.operation;
  };
  const prepare = async () => {
    const response = await actor.execute('projects.prepare', { workspace: opened.workspace, phase: 'setup' },
      { presentUserConfirmation: { actionId: 'projects.prepare' } });
    if (!response.ok) throw new Error(`Setup prepare refused (${response.errorCode})`);
    return ProjectCommandActionOutputV1Schema.parse(response.result).operation.operationId;
  };
  const waitForReview = async (operationId: string) => {
    await waitFor(async () => Boolean((await observe(operationId)).setupReview),
      { context: 'Setup holds for the real person consent before native effects' });
    const review = (await observe(operationId)).setupReview;
    if (!review) throw new Error('Setup review disappeared');
    return review;
  };
  const approve = async (operationId: string) => {
    const review = await waitForReview(operationId);
    const response = await actor.executeAsPerson('projects.prepare', { workspace: opened.workspace, phase: 'setup',
      heldOperationId: operationId, expectedEffectDigest: review.reviewedEffectDigest, consentScope: 'thisTime' },
    { presentUserConfirmation: { actionId: 'projects.prepare' } });
    expect(response).toMatchObject({ ok: true });
  };
  const cancelledId = await prepare();
  await waitForReview(cancelledId);
  expect(await finished.readRuns()).toEqual([]);
  expect(await failed.readRuns()).toEqual([]);
  expect(await actor.execute('action.operations.cancel', { ...machine.target, operationId: cancelledId }))
    .toMatchObject({ ok: true });
  await waitFor(async () => (await observe(cancelledId)).state === 'cancelled',
    { context: 'Rejected setup settles without running the command' });
  expect(await finished.readRuns()).toEqual([]);
  expect(await failed.readRuns()).toEqual([]);

  const successId = await prepare();
  await approve(successId);
  await waitFor(async () => (await observe(successId)).state === 'succeeded',
    { context: 'Accepted setup actually settles successfully' });
  expect(await readFile(join(directory, 'setup-result'), 'utf8')).toBe('finished');
  await waitFor(async () => (await finished.readRuns()).length === 1,
    { context: 'One setup success produces one ordinary Workflow Run' });
  expect(await failed.readRuns()).toEqual([]);

  await writeSetup(`printf '${secret}' >&2; exit 7`);
  const failedId = await prepare();
  await approve(failedId);
  await waitFor(async () => (await observe(failedId)).state === 'failed',
    { context: 'Accepted setup failure is a settled native failure' });
  await waitFor(async () => (await failed.readRuns()).length === 1,
    { context: 'One setup failure produces one ordinary Workflow Run' });
  expect(await finished.readRuns()).toHaveLength(1);
  for (const [event, operationId] of [[finished, successId], [failed, failedId]] as const) {
    const runs = await event.readRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cause).toMatchObject({ kind: 'trigger', triggerId: event.saved.triggerId,
      triggerKind: 'pluginEvent', evidence: { eventRef: event.selected.event.identity,
        payload: { operationId, workspace: { workspaceId: opened.workspace.workspaceId,
          serverId: opened.workspace.serverId, rootPath: opened.workspace.rootPath } } } });
    expect(JSON.stringify(runs[0]!.cause)).not.toContain(secret);
    expect(JSON.stringify(runs[0]!.cause)).not.toMatch(/stdout|stderr/);
  }

  // A real filesystem checkpoint fault after a confirmed native effect is an
  // uncertain setup, rather than a failed process or a fabricated host fact.
  const checkpoint = createProjectSetupSuccessStore({ homeDir: machine.homeDir }).pathFor({
    serverId: opened.workspace.serverId, machineId: machine.target.machineId,
    workspaceRefId: opened.workspace.workspaceId,
  });
  const quotedCheckpoint = `'${checkpoint.replaceAll("'", "'\\''")}'`;
  await writeSetup(`rm -f ${quotedCheckpoint} && mkdir ${quotedCheckpoint} && printf confirmed > uncertain-effect`);
  const uncertainId = await prepare();
  await approve(uncertainId);
  try {
    await waitFor(async () => (await observe(uncertainId)).observation?.code === 'project_setup_success_unavailable',
      { context: 'Confirmed setup effect exposes its unavailable checkpoint as uncertainty' });
    expect(await readFile(join(directory, 'uncertain-effect'), 'utf8')).toBe('confirmed');
    expect(await finished.readRuns()).toHaveLength(1);
    expect(await failed.readRuns()).toHaveLength(1);
  } finally {
    await rmdir(checkpoint);
    expect(await actor.execute('action.operations.cancel', { ...machine.target, operationId: uncertainId }))
      .toMatchObject({ ok: true });
  }
}
