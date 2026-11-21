import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationCancelV1ResponseSchema, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ApiClient } from '../../../../apps/cli/src/api/api';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
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
  const opening = await actor.executeReviewed('projects.open', { ...machine.target,
    source: { kind: 'folder', path: directory }, materialization: { kind: 'attach' } });
  if (!opening.ok) throw new Error(`Setup Project open refused (${opening.errorCode})`);
  const opened = OpenProjectResultV1Schema.parse(opening.result);
  if (opened.kind !== 'opened') throw new Error(`Setup Project unavailable (${opened.kind})`);
  const finished = await attachMachineEventTrigger(fixture, actor, machine, 'project-setup-finished', null, { capturePayload: true });
  const failed = await attachMachineEventTrigger(fixture, actor, machine, 'project-setup-failed', null, { capturePayload: true });
  // Machine control may become ready before the daemon publishes encrypted
  // metadata. Wait for the actual executor pin required by operation reads.
  await runWithServerHttpBaseUrl(fixture.actionServerApiUrl, async () => {
    const api = await ApiClient.create(actor.credentials);
    await waitFor(async () => {
      const executor = await api.getMachine(machine.target.machineId);
      return Boolean(executor && (executor.encryptionMode !== 'e2ee' || executor.metadata?.installationPublicKey));
    }, { failFast: true, context: 'Setup executor publishes its operation-read installation key' });
  });
  const observe = async (operationId: string) => {
    const response = await actor.execute('action.operations.get', { ...machine.target, operationId });
    if (!response.ok) throw new Error(`Setup operation read refused (${response.errorCode})`);
    const parsed = ActionOperationGetV1ResponseSchema.parse(response.result);
    if (parsed.kind !== 'found') throw new Error('Accepted setup operation disappeared');
    return parsed.operation;
  };
  const prepare = async () => {
    // The terminal's Inbox approval admits the operation. Its separate native
    // Setup review remains open for the person to decide.
    const response = await actor.executeReviewed('projects.prepare', { workspace: opened.workspace, phase: 'setup' });
    if (!response.ok) throw new Error(`Setup prepare refused (${response.errorCode})`);
    return ProjectCommandActionOutputV1Schema.parse(response.result).operation.operationId;
  };
  const waitForReview = async (operationId: string) => {
    await waitFor(async () => {
      const operation = await observe(operationId);
      if (operation.state === 'succeeded' || operation.state === 'failed' || operation.state === 'cancelled') {
        throw new Error(`Setup settled before consent (${operation.error?.errorCode ?? operation.state})`);
      }
      return Boolean(operation.setupReview);
    }, { context: 'Setup holds for the real person consent before native effects', failFast: true });
    const review = (await observe(operationId)).setupReview;
    if (!review) throw new Error('Setup review disappeared');
    return review;
  };
  const approve = async (operationId: string) => {
    const review = await waitForReview(operationId);
    const response = await actor.executeReviewed('projects.prepare', { workspace: opened.workspace, phase: 'setup',
      heldOperationId: operationId, expectedEffectDigest: review.reviewedEffectDigest, consentScope: 'thisTime' });
    if (!response.ok) throw new Error(`Setup consent refused (${response.errorCode})`);
    expect(ProjectCommandActionOutputV1Schema.parse(response.result).operation.operationId).toBe(operationId);
  };
  const cancel = async (operationId: string) => {
    const response = await actor.executeAsPerson('action.operations.cancel', { ...machine.target, operationId });
    if (!response.ok) throw new Error(`Setup cancel refused (${response.errorCode})`);
    return ActionOperationCancelV1ResponseSchema.parse(response.result);
  };
  const cancelledId = await prepare();
  await waitForReview(cancelledId);
  expect(await finished.readRuns()).toEqual([]);
  expect(await failed.readRuns()).toEqual([]);
  expect(await cancel(cancelledId)).toEqual({ kind: 'requested' });
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
    await waitFor(async () => {
      const runs = await event.readRuns();
      expect(runs.length).toBeLessThanOrEqual(1);
      return runs.length === 1 && typeof runs[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'The Setup Workflow accepts the settled payload' });
    const runs = await event.readRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cause).toMatchObject({ kind: 'trigger', triggerId: event.saved.triggerId,
      triggerKind: 'pluginEvent', evidence: { eventRef: event.selected.event.identity } });
    expect(runs[0]!.cause).not.toHaveProperty('evidence.payload');
    expect(JSON.stringify(runs[0]!.cause)).not.toContain(secret);
    expect(JSON.stringify(runs[0]!.cause)).not.toMatch(/stdout|stderr/);
    const detail = await actor.execute('workflow.run.get', { runId: runs[0]!.id });
    if (!detail.ok) throw new Error(`Setup Workflow Run read refused (${detail.errorCode})`);
    const payload = WorkflowRunGetResultV1Schema.parse(detail.result).acceptedContext.inputs.payload;
    expect(payload).toMatchObject({ operationId, workspace: { workspaceId: opened.workspace.workspaceId,
      serverId: opened.workspace.serverId, rootPath: opened.workspace.rootPath } });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(JSON.stringify(payload)).not.toMatch(/stdout|stderr/);
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
    expect((await cancel(uncertainId)).kind).toMatch(/^(requested|already_settled)$/);
  }
}
