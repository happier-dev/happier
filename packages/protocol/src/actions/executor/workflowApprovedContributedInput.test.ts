import { describe, expect, it } from 'vitest';
import { ActionDefinitionV1Schema } from '../actionDefinitionV1.js';
import { freezeWorkflowActionContractV1 } from '../actionCatalog.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { materializeWorkflowAcceptedSnapshotV1 } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { bindWorkflowApprovedOperationSteps, prepareWorkflowApprovedOperationSnapshot } from './workflowRunActions.js';

const actionId = 'happier.deploy.neon/actions/branches-create';
const input = { name: 'Preview 17', database: 'neondb' };
const parent = { actionId: 'machines.setup.apply' as const, input: {
  homeId: 'home', machineId: 'host', targets: [{ homeId: 'home', machineId: 'host', desiredRevision: 0,
    recipePlans: [], sources: [{ kind: 'direct', setup: {} }] }],
} };
const context = { actionRequestId: 'reviewed-parent', approvedActionReplay: { artifactId: 'approval' },
  presentUserApproval: { artifactId: 'approval', actionId: parent.actionId, requestId: 'reviewed-parent',
    inputDigest: computeActionInputApprovalDigestV1(parent.actionId, parent.input), decidingAccountId: 'owner' } };

async function admittedSnapshot(secret = false) {
  const declaration = ActionDefinitionV1Schema.parse({ kindVersion: 1, id: actionId, title: 'Create preview',
    description: null, safety: 'danger', placements: [], slash: null, bindings: null, examples: null,
    surfaces: { cli: true, plugin: true }, inputHints: secret ? { fields: [
      { path: 'name', widget: 'secret', title: 'Private name', visibleWhen: { path: 'database', op: 'eq', value: 'other' } },
    ] } : null,
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, database: { type: 'string' } },
      required: ['name', 'database'], additionalProperties: false }, outputSchema: { type: 'object' } });
  const result = await materializeWorkflowAcceptedSnapshotV1({
    definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'database', actionId,
      input: Object.fromEntries(Object.entries(input).map(([field, value]) => [field, { kind: 'literal', value }])) }] },
    context: { source: { kind: 'inline' }, inputs: {}, machineId: 'host', executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId: 'host', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
      readActionContract: async id => id === actionId ? freezeWorkflowActionContractV1(declaration) : null },
  });
  if (!result.ok) throw new Error(`fixture_materialization_failed:${result.error.code}`);
  return result.snapshot;
}

describe('reviewed Workflow contributed input custody', () => {
  it.each(['qualified', 'envelope'] as const)('retains an admitted target declaration for the %s child', async kind => {
    const snapshot = await admittedSnapshot();
    const step = kind === 'qualified' ? { actionId, input } : { actionId: 'action.invoke', input: {
      action: { pluginId: 'happier.deploy.neon', localId: 'branches-create' }, input,
    } };
    const accepted = await prepareWorkflowApprovedOperationSnapshot({ snapshot, parent, steps: [step], context });
    expect(accepted.approvedOperation?.steps).toEqual([step]);
    expect(bindWorkflowApprovedOperationSteps({ operation: accepted.approvedOperation!, steps: [step],
      materializedLeaves: snapshot.materializedLeaves }).steps).toEqual([step]);
  });

  it('refuses absent declaration custody, schema mismatch and inactive declared secrets', async () => {
    const snapshot = await admittedSnapshot();
    for (const candidate of [
      { snapshot: { ...snapshot, materializedLeaves: [] }, input },
      { snapshot, input: { ...input, unexpected: 'operand' } },
      { snapshot: await admittedSnapshot(true), input },
    ]) {
      await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: candidate.snapshot, parent,
        steps: [{ actionId, input: candidate.input }], context })).rejects.toMatchObject({ code: 'approval_required' });
    }
  });

  it('associates repeated contributed Actions with their exact admitted operands and refuses ambiguous confidential declarations', async () => {
    const publicSnapshot = await admittedSnapshot();
    const privateSnapshot = await admittedSnapshot(true);
    const publicLeaf = publicSnapshot.materializedLeaves[0]!;
    const privateLeaf = privateSnapshot.materializedLeaves[0]!;
    const otherInput = { ...input, name: 'Other target' };
    const snapshot = { ...publicSnapshot, materializedLeaves: [
      { ...publicLeaf, blockId: 'other', actionInput: otherInput }, privateLeaf,
    ] };
    await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot, parent,
      steps: [{ actionId, input }], context })).rejects.toMatchObject({ code: 'approval_required' });
    const publicAccepted = await prepareWorkflowApprovedOperationSnapshot({ snapshot, parent,
      steps: [{ actionId, input: otherInput }], context });
    expect(bindWorkflowApprovedOperationSteps({ operation: publicAccepted.approvedOperation!,
      steps: [{ actionId, input: otherInput }], materializedLeaves: snapshot.materializedLeaves }).steps)
      .toEqual([{ actionId, input: otherInput }]);
    await expect(prepareWorkflowApprovedOperationSnapshot({
      snapshot: { ...snapshot, materializedLeaves: [publicLeaf, privateLeaf] }, parent,
      steps: [{ actionId, input }], context })).rejects.toMatchObject({ code: 'approval_required' });
  });
});
