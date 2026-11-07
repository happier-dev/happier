import { describe, expect, it } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { WorkflowAcceptedSnapshotV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createWorkflowActionAdmissionReader } from './workflowActionAdmission';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

describe('retained Workflow root approval replay', () => {
  it('opens only the exact retained root and active invocation without admitting the principal again', async () => {
    const accountId = 'owner';
    const runId = '52bd37c4-99c6-41cf-90a5-3a1be2b1e031';
    const invocationId = 'exact-child';
    const requestId = `${runId}/${invocationId}/0`;
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'retained-root', binding: {
      serverIdentityId: 'identity', accountId, principalId: accountId, credentialId: 'accepted-pat',
      grant: API_TOKEN_FULL_GRANT_V1, custodianAccountId: accountId, machineId: 'host', installationId: 'installation',
      actionId: 'workflow.run.start', requestId: 'original-start', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'host' },
    } });
    const definition = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'teardown', actionId: 'deployments.teardown', input: {} },
    ] };
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ startedBy: 'user', authoredDefinition: definition, definition,
      materializedLeaves: [{ sourceKey: '$root', blockId: 'teardown', kind: 'action', selection: {},
        authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' }, actionId: 'deployments.teardown',
        actionInput: {}, actionContract: { inputSchema: { type: 'object' }, outputSchema: {} } }],
      frozenChildren: {}, workDepth: 0, metadata: null, inputs: {}, machineId: 'host', executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId: 'host', directory: '/repo', checkoutRootPath: '/repo' } },
      source: { kind: 'inline' }, origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default',
        principal: { kind: 'api', accountId, principalId: accountId, credentialId: 'accepted-pat' },
        externalActionExecutionAuthorization: root } });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    // Opaque server storage is the boundary; the reader and envelope owners stay real.
    const storage = createWorkflowRunStorageTestkit({ runId, accountId, machineId: 'host',
      state: 'running', origin: { kind: 'direct' }, acceptedEnvelope });
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId, sequence: '1',
        parentRecordId: 'root', memberOrdinal: '0', attempt: '0' }, progress: { kind: 'happier.workflow-progress.v1',
        blockKind: 'action', invocationPath: { blockId: 'teardown', scope: [] }, attempt: '0',
        logicalInvocationRecordId: invocationId, execution: { kind: 'action', actionId: 'deployments.teardown',
          actionRequestId: requestId, localInputId: 'local', input: {} } } }));
    await storage.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, expectedRevision: storage.run().revision,
      checkpointEnvelope: '{}', invocations: [{ id: invocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', contentEnvelope }] });
    await storage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0',
      expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'waiting_for_approval', contentEnvelope });
    await storage.execute({ operation: 'transition', runId, expectedRevision: storage.run().revision,
      state: 'paused', checkpointEnvelope: '{}' });
    const context: ActionExecutorContext = { actionRequestId: requestId, executionRunWorkflowRunId: runId,
      actionCaller: { kind: 'workflowRun', runId, authorization: accepted.authorization },
      externalActionExecutionAuthorization: root };
    const readAdmission = createWorkflowActionAdmissionReader({ storage,
      resolveEncryption: async () => ({ witness: { mode: 'plain' } }) });
    const beforeReplay = storage.operations().length;
    const admission = await readAdmission({ runId, context, phase: 'approval_replay' });
    expect(admission).not.toBeNull();
    expect((await admission?.readActionInvocation('approval_replay'))?.progress.execution)
      .toMatchObject({ kind: 'action', actionRequestId: requestId });
    expect(storage.operations().slice(beforeReplay)).toEqual(['get', 'invocations.get']);
    expect(await readAdmission({ runId, phase: 'approval_replay', context: { ...context,
      externalActionExecutionAuthorization: { ...root, token: 'another-person-root',
        binding: { ...root.binding, accountId: 'another-person' } } } })).toBeNull();
    expect(await readAdmission({ runId, phase: 'approval_replay', context: { ...context,
      externalActionExecutionAuthorization: undefined } })).toBeNull();
    storage.requestControl('cancel_requested');
    expect(await (await readAdmission({ runId, context, phase: 'approval_replay' }))
      ?.readActionInvocation('approval_replay')).toBeUndefined();
    storage.requestControl('cancelled');
    expect(await readAdmission({ runId, context, phase: 'approval_replay' })).toBeNull();
  });
});
