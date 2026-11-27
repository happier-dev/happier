import { describe, expect, it } from 'vitest';
import { composeWorkflowRunWorkerUpdateV1, resolveWorkflowRunFollowEventV1 } from './composeWorkflowRunWorkerUpdateV1.js';
import type { WorkflowFinalResultV1 } from './workflowProgressV1.js';

describe('composeWorkflowRunWorkerUpdateV1', () => {
  const finalResult: WorkflowFinalResultV1 = {
    kind: 'happier.workflow-final-result.v1',
    producerInvocation: { recordId: 'producer-1' },
    result: { kind: 'text', value: 'Review finished' },
  };

  it('composes the current committed result and exact follow-up so the lead does not start it twice', () => {
    expect(composeWorkflowRunWorkerUpdateV1({
      run: { id: 'run-1', state: 'succeeded', attentionRequired: false },
      finalResult,
      finalProducerReview: { decision: { kind: 'use_result', requestedFromContentRevision: '1',
        followUp: { kind: 'run_started', runId: 'run-followup' } } },
    })).toMatchObject({
      workerKind: 'workflow_run', workerId: 'run-1', ownerState: 'succeeded', wake: 'finished',
      result: expect.stringContaining('run-followup'),
      transcriptPointer: { kind: 'workflow_run', runId: 'run-1', invocationRecordId: 'producer-1' },
    });
  });

  it('bounds long JSON results with a pointer without losing the editing follow-up', () => {
    const update = composeWorkflowRunWorkerUpdateV1({
      run: { id: 'run-1', state: 'failed', attentionRequired: false },
      finalResult: { ...finalResult, result: { kind: 'json', value: { report: 'x'.repeat(9000) } } },
      finalProducerReview: { decision: { kind: 'use_result', requestedFromContentRevision: '1',
        followUp: { kind: 'editing' } } },
    });
    expect(update?.result?.length).toBeLessThanOrEqual(8000);
    expect(update).toMatchObject({ truncated: true, canInspect: true,
      result: expect.stringContaining('editing'),
      transcriptPointer: { kind: 'workflow_run', runId: 'run-1', invocationRecordId: 'producer-1' },
    });
  });

  it.each(['interrupted', 'failed'] as const)('publishes the failed leaf cause for a Run in state %s', state => {
    const code = 'connected_service_run_materialization_blocked';
    expect(composeWorkflowRunWorkerUpdateV1({
      run: { id: 'run-1', state, attentionRequired: false },
      failure: { recordId: 'failed-leaf', reason: { code } },
    })).toMatchObject({
      workerKind: 'workflow_run', workerId: 'run-1', ownerState: state, wake: 'needs_you', result: code,
      transcriptPointer: { kind: 'workflow_run', runId: 'run-1', invocationRecordId: 'failed-leaf' },
    });
  });

  it('never composes superseded attention history after a hold resolves', () => {
    expect(composeWorkflowRunWorkerUpdateV1({ run: { id: 'run-1', state: 'running', attentionRequired: false } })).toBeNull();
    expect(composeWorkflowRunWorkerUpdateV1({ run: { id: 'run-1', state: 'running', attentionRequired: true } }))
      .toMatchObject({ wake: 'needs_you', ownerState: 'running' });
  });

  it('preserves terminal outcomes and refuses to call unknown attention progress', () => {
    expect(resolveWorkflowRunFollowEventV1({ state: 'running' })).toBeNull();
    expect(resolveWorkflowRunFollowEventV1({ state: 'succeeded', attentionRequired: true })).toEqual({ kind: 'finished' });
    expect(resolveWorkflowRunFollowEventV1({ state: 'interrupted', attentionRequired: true })).toEqual({ kind: 'failed_or_stopped' });
    expect(resolveWorkflowRunFollowEventV1({ state: 'waiting_for_review' })).toEqual({ kind: 'needs_you', type: 'decision' });
  });
});
