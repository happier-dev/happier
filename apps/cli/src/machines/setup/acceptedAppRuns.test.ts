import { describe, expect, it } from 'vitest';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiateResultV1Schema, StoredAppPresetInputV1Schema } from '@happier-dev/protocol';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { WorkflowInvocationDetailV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { readMachineSetupAcceptedAppRuns } from './acceptedAppRuns';

const homeId = 'home', machineId = 'machine', environmentId = 'environment';
const definition = { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` };
const templateRef = { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'version', version: '1' } };
const applied = { kind: 'applied', environmentId, revision: 1, targetLinkId: 'target', definition, savedSecrets: [] };
const receipt = { ok: true, environmentId, revision: 2, deploymentId: 'deployment', deploymentRevision: 2, state: 'succeeded' };

async function fixture(options: Readonly<{
  create?: boolean; deploy?: boolean; result?: unknown; lifecycle?: 'completed' | 'failed' | 'cancelled' | 'outcome_uncertain';
}>) {
  const intent = StoredAppPresetInputV1Schema.parse({ name: 'App', project: { kind: 'existing', projectSourceId: 'project' },
    definition: { from: 'catalogApp', templateRef }, bindings: [] });
  const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: homeId, machineId,
    projectSourceId: 'project', templateRef, bindings: [], target: { kind: 'new', installationId: 'installation' },
    environment: options.create ? { kind: 'create', name: 'App', requestKey: 'create', protection: 'nonProduction',
      purpose: 'standard', deployerMode: 'managers', controllerMachineId: machineId }
      : { kind: 'existing', environmentId, expectedRevision: 1 },
    destination: options.create ? { kind: 'stored' } : definition,
    ...(options.deploy === false ? {} : { deploy: { requestKey: 'deploy' } }) });
  const setup = MachineSetupApplyInputV1Schema.parse({ homeId, machineId, targets: [{ homeId, machineId,
    desiredRevision: 1, recipePlans: [], sources: [{ kind: 'direct', setup: { items: [{ kind: 'app', definition: intent }] } }],
    appChildren: [{ sourceIndex: 0, itemIndex: 0, actionId: 'deployments.templates.instantiate', input }] }] });
  const literalInput = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, { kind: 'literal', value: item }]));
  const accepted = await materializeWorkflowAcceptedSnapshotV1({
    definition: { version: 1, defaults: {}, blocks: [
      { kind: 'action', id: 'setup', actionId: 'machines.setup.apply', input: literalInput(setup) },
      { kind: 'action', id: 'app', actionId: 'deployments.templates.instantiate', input: literalInput(input) },
    ] },
    context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: '/project', checkoutRootPath: '/project' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true, readActionContract: async id =>
      freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) },
  });
  if (!accepted.ok) throw new Error(`Accepted fixture failed: ${accepted.error.code}`);
  const snapshot = accepted.snapshot;
  const storage = createWorkflowRunStorageTestkit({ runId: 'run', machineId, origin: { kind: 'direct' } });
  const run = WorkflowRunGetResultV1Schema.parse({ run: storage.run(), callerAccess: { canEdit: true },
    definition: snapshot.definition, authoredDefinition: snapshot.authoredDefinition, checkpoint: null,
    acceptedContext: { startedBy: 'user', source: snapshot.source, inputs: snapshot.inputs, machineId,
      executionTarget: snapshot.executionTarget, materializedLeaves: snapshot.materializedLeaves,
      frozenChildren: snapshot.frozenChildren, workspaceTarget: snapshot.workspaceTarget, origin: { kind: 'direct' } } });
  const now = '2026-01-01T00:00:00.000Z';
  const index = { runId: 'run', attempt: '0', contentRevision: '1', createdAt: now, updatedAt: now };
  const root = WorkflowInvocationDetailV1Schema.parse({ parentRevision: 1,
    index: { ...index, id: 'root', sequence: '0', parentRecordId: null, memberOrdinal: '0', lifecycle: 'running' },
    progress: { kind: 'happier.workflow-progress.v1', logicalInvocationRecordId: 'root',
      invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0' } });
  const row = WorkflowInvocationDetailV1Schema.parse({ parentRevision: 1,
    index: { ...index, id: 'app-row', sequence: '1', parentRecordId: root.index.id, memberOrdinal: '1',
      lifecycle: options.lifecycle ?? 'completed' },
    progress: { kind: 'happier.workflow-progress.v1', logicalInvocationRecordId: 'app-row',
      invocationPath: { blockId: 'app', scope: [] }, blockKind: 'action', attempt: '0',
      execution: { kind: 'action', localInputId: 'app-input', actionId: 'deployments.templates.instantiate', actionRequestId: 'app-request', input },
      result: options.result ?? DeploymentTemplateInstantiateResultV1Schema.parse({ ...applied, deployment: receipt }) } });
  let current = true;
  // Account Action transport is the boundary. Accepted materialization, binding,
  // invocation ancestry, schemas and completion interpretation remain real.
  const execute: Parameters<typeof readMachineSetupAcceptedAppRuns>[0]['execute'] = async (actionId, request) => {
    if (actionId === 'workflow.run.get') return { ok: true, result: run };
    if (actionId !== 'workflow.run.invocations.list') throw new Error('Unexpected Account operation');
    const selection = request as { invocationId?: string; parentRecordId?: string | null };
    const rows = selection.invocationId ? [root, row].filter(value => value.index.id === selection.invocationId)
      : selection.parentRecordId === null ? [root] : selection.parentRecordId === root.index.id ? [row] : [];
    return { ok: true, result: { invocations: rows.map(value => value.index), invocationDetails: rows, parentRevision: 1 } };
  };
  const reference = { intent, homeId, runId: run.run.id, sourceKey: '$root', blockId: 'app',
    actionId: 'deployments.templates.instantiate' as const };
  const read = () => readMachineSetupAcceptedAppRuns({ homeId, machineId, execute,
    isCurrent: async () => current, apps: [{ intent, reference }] });
  return { read, row, setCurrent: (value: boolean) => { current = value; } };
}

describe('accepted template app outcomes', () => {
  it.each([false, true])('consumes a settled composite deployment for create=%s', async create => {
    const f = await fixture({ create });
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'completed' }, environmentId }]);
  });

  it('does not treat definition-only application as a deployment', async () => {
    const f = await fixture({ create: true, deploy: false, result: DeploymentTemplateInstantiateResultV1Schema.parse(applied) });
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' } }]);
  });

  it('uses normal deployment completion for running-unverified and never completes uncertain ancestry', async () => {
    const f = await fixture({ result: DeploymentTemplateInstantiateResultV1Schema.parse({ ...applied,
      deployment: { ...receipt, state: 'running_unverified' } }) });
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'completed' }, environmentId }]);
    f.row.index.lifecycle = 'outcome_uncertain';
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' } }]);
    f.row.index.lifecycle = 'completed';
    f.row.index.parentRecordId = 'foreign-root';
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' } }]);
  });

  it('retains the authenticated created Environment after a deploy partial without claiming completion', async () => {
    const result = DeploymentTemplateInstantiateResultV1Schema.parse({ ...applied, kind: 'partial', phase: 'deploy',
      errorCode: 'outcome_unknown', deployment: { ok: true, kind: 'pending', environmentId, revision: 2, actionOperationId: 'operation' } });
    const f = await fixture({ create: true, lifecycle: 'failed', result });
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' }, environmentId }]);
  });

  it.each(['failed', 'cancelled'] as const)('preserves %s before template result publication', async lifecycle => {
    const f = await fixture({ lifecycle });
    f.row.progress.result = undefined;
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'failed' } }]);
    f.row.progress.result = DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'partial', phase: 'generation',
      errorCode: 'secret_missing', savedSecrets: [] });
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'failed' } }]);
  });

  it.each([
    { errorCode: 'outcome_unknown' },
    { errorCode: 'deployment_in_progress', deployment: { ...receipt, state: 'queued' } },
  ])('keeps an unresolved deploy partial unknown with its actual Environment: %j', async deployment => {
    const result = DeploymentTemplateInstantiateResultV1Schema.parse({ ...applied, kind: 'partial', phase: 'deploy', ...deployment });
    const f = await fixture({ create: true, lifecycle: 'failed', result });
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' }, environmentId }]);
  });

  it('does not trust an outer/receipt Environment mismatch or different admitted execution', async () => {
    const f = await fixture({ result: { ...applied, deployment: { ...receipt, environmentId: 'foreign' } } });
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' } }]);
    f.row.progress.result = { ...applied, environmentId: 'foreign', deployment: { ...receipt, environmentId: 'foreign' } };
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' }, environmentId }]);
    f.row.progress.result = DeploymentTemplateInstantiateResultV1Schema.parse({ ...applied, deployment: receipt });
    const execution = f.row.progress.execution;
    f.row.progress.execution = { kind: 'action', localInputId: 'app-input', actionId: 'deployments.templates.instantiate', actionRequestId: 'other', input: {} };
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' } }]);
    f.row.progress.execution = execution;
    f.setCurrent(false);
    expect(await f.read()).toMatchObject([{ outcome: { kind: 'unknown' } }]);
  });
});
