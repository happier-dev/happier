import { describe, expect, it } from 'vitest';
import { createDeepWorkflowDefinition } from './workflowDefinition.testkit.js';

import {
  WORKFLOW_ACTION_IDS_V1,
  WorkflowActionInputSchemasV1,
  WorkflowActionOutputSchemasV1,
  WorkflowInvocationListRequestV1Schema,
  WorkflowInvocationListResultV1Schema,
  WorkflowRunListRequestV1Schema,
  WorkflowActionFailureV1Schema,
  parseWorkflowRunStartActionResultReferenceV1,
  validateWorkflowDefinition,
} from './index.js';

describe('workflow Action contracts', () => {
  it('accepts omitted wait conditions or a nonempty unique set, never a host snapshot sink', () => {
    const schema = WorkflowActionInputSchemasV1['workflow.run.wait'];
    const runId = '11111111-1111-4111-8111-111111111111';
    expect(schema.parse({ runId })).toEqual({ runId });
    expect(schema.parse({ runId, conditions: ['terminal', 'attention', 'paused'] }).conditions)
      .toEqual(['terminal', 'attention', 'paused']);
    for (const conditions of [[], ['terminal', 'terminal'], ['needs_attention']]) {
      expect(schema.safeParse({ runId, conditions }).success).toBe(false);
    }
    expect(schema.safeParse({ runId, onWaitSnapshot: () => {} }).success).toBe(false);
  });
  it('requires the current list metadata map while preserving sparse untitled Runs', () => {
    const schema = WorkflowActionOutputSchemasV1['workflow.run.list'];
    expect(schema.safeParse({ runs: [] }).success).toBe(false);
    expect(schema.safeParse({ runs: [], metadataByRunId: {} }).success).toBe(true);
  });
  it('admits explicit Team selection only as a saved Artifact source grant choice', () => {
    const start = WorkflowActionInputSchemasV1['workflow.run.start'];
    const runId = '0f2cf13d-4ad7-4f4b-b5e0-cc3b7dce7f11';
    const saved = { kind: 'saved', definitionId: 'definition-1', revision: { headerVersion: 1, bodyVersion: 1 } };
    expect(start.safeParse({ runId, source: { ...saved, visibleTeamId: 'team-1' } }).success).toBe(true);
    expect(start.safeParse({ runId, source: saved }).success).toBe(true);
    expect(start.safeParse({ runId, source: { ...saved, visibleTeamId: null } }).success).toBe(false);
    expect(start.safeParse({ runId, source: saved, visibleTeamId: 'team-1' }).success).toBe(false);
    expect(start.safeParse({ runId, source: { kind: 'inline', definition: { blocks: ['Work'] }, visibleTeamId: 'team-1' } }).success).toBe(false);
    expect(start.safeParse({ runId, source: { kind: 'catalog', workflow: 'builtin:review-and-converge', visibleTeamId: 'team-1' } }).success).toBe(false);
  });
  it('requires the displayed row token and keeps plan follow-up exclusive to Use', () => {
    const target = { runId: 'run-1', invocation: { recordId: 'inv-1' }, expectedContentRevision: '2' };
    const use = WorkflowActionInputSchemasV1['workflow.run.invocations.complete_review'];
    expect(use.safeParse({ ...target, mode: 'use_result', value: null, followUp: { kind: 'editing' } }).success).toBe(true);
    expect(use.safeParse({ ...target, mode: 'generate' }).success).toBe(true);
    expect(use.safeParse({ ...target, mode: 'generate', followUp: { kind: 'editing' } }).success).toBe(false);
    expect(use.safeParse({ ...target, expectedContentRevision: '02', mode: 'use_result' }).success).toBe(false);
    expect(use.safeParse({ ...target, mode: 'use_result', expectedRevision: 9 }).success).toBe(false);
    const publish = WorkflowActionInputSchemasV1['workflow.run.invocations.publish_draft'];
    expect(publish.safeParse({ ...target, value: { answer: 7 } }).success).toBe(true);
    expect(publish.safeParse({ ...target, value: 7, by: 'user' }).success).toBe(false);
  });
  it('accepts a filter-bound saved source and the batched summary read', () => {
    expect(WorkflowRunListRequestV1Schema.safeParse({ sourceArtifactId: 'definition-1' }).success).toBe(true);
    const schema = Object.entries(WorkflowActionInputSchemasV1).find(([id]) => id === 'workflow.run.summaries')?.[1];
    expect(schema).toBeDefined();
    expect(schema?.safeParse({ sourceArtifactIds: ['definition-1', 'definition-2'], recent: 3 }).success).toBe(true);
    expect(schema?.safeParse({ sourceArtifactIds: ['definition-1', 'definition-1'], recent: 3 }).success).toBe(false);
    expect(schema?.safeParse({ sourceArtifactIds: ['definition-1'], recent: 0 }).success).toBe(false);
  });
  it('admits typed partial edits with structured currentness and a closed result', () => {
    const input = { definitionId: 'definition-1', expectedRevision: { headerVersion: 2, bodyVersion: 3 },
      ops: [{ kind: 'set_step_prompt', blockId: 'step-1', text: 'Changed' }] };
    expect(WorkflowActionInputSchemasV1['workflow.definition.edit'].parse(input)).toEqual(input);
    expect(WorkflowActionInputSchemasV1['workflow.definition.edit'].safeParse({ ...input, ops: [] }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.definition.edit'].safeParse({ ...input, expectedRevision: 2 }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.definition.edit'].safeParse({ ...input, metadata: { title: 'Unowned' } }).success).toBe(false);
    const definition = validateWorkflowDefinition({ blocks: ['Work'] }, { context: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } }).normalizedDefinition;
    const result = { definition, revision: { headerVersion: 3, bodyVersion: 4 }, changedBlockIds: ['step-1'] };
    expect(WorkflowActionOutputSchemasV1['workflow.definition.edit'].parse(result)).toEqual(result);
    expect(WorkflowActionOutputSchemasV1['workflow.definition.edit'].safeParse({ ...result, metadata: { title: 'Extra' } }).success).toBe(false);
  });
  it('requires the exact Run recovery handle on self-wait failures only', () => {
    expect(WorkflowActionFailureV1Schema.safeParse({
      ok: false,
      errorCode: 'workflow_wait_self_dependency',
      error: 'release the calling turn',
    }).success).toBe(false);
    expect(WorkflowActionFailureV1Schema.parse({
      ok: false,
      errorCode: 'workflow_wait_self_dependency',
      error: 'release the calling turn',
      details: { runId: 'run-1' },
    }).details).toEqual({ runId: 'run-1' });
    expect(WorkflowActionFailureV1Schema.safeParse({
      ok: false,
      errorCode: 'run_not_found',
      error: 'missing',
      details: { runId: 'run-1' },
    }).success).toBe(false);
  });
  it('owns the Run/validation and definition Actions including typed partial edits', () => {
    expect(WORKFLOW_ACTION_IDS_V1).toEqual([
      'workflow.validate',
      'workflow.run.start',
      'workflow.run.list',
      'workflow.run.summaries',
      'workflow.run.get',
      'workflow.run.wait',
      'workflow.run.pause',
      'workflow.run.resume',
      'workflow.run.cancel',
      'workflow.run.invocations.list',
      'workflow.run.invocations.get',
      'workflow.run.invocations.retry',
      'workflow.run.delete',
      'workflow.run.invocations.publish_draft',
      'workflow.run.invocations.complete_review',
      'workflow.definition.list',
      'workflow.definition.get',
      'workflow.definition.create',
      'workflow.definition.update',
      'workflow.definition.edit',
      'workflow.definition.delete',
      'workflow.trigger.list',
      'workflow.trigger.add',
      'workflow.trigger.update',
      'workflow.trigger.remove',
      'session.trigger.list',
      'session.trigger.add',
      'session.trigger.update',
      'session.trigger.remove',
    ]);
  });

  it('initializes the canonical workflow definition schema through the workflow public barrel', () => {
    expect(WORKFLOW_ACTION_IDS_V1).toContain('workflow.validate');
    expect(WorkflowActionInputSchemasV1['workflow.validate'].safeParse({}).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.validate'].safeParse({ definition: undefined }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.validate'].safeParse({
      definition: {
        blocks: ['Summarize the current work'],
      },
    }).success).toBe(true);
    expect(WorkflowActionInputSchemasV1['workflow.validate'].safeParse({
      definition: {
        blocks: ['Summarize the current work'],
        unknownTopLevelField: true,
      },
    }).success).toBe(false);
  });

  it('carries a deeply nested ingress definition to the canonical typed validator stack-safely', () => {
    const agentTarget = {
      kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    };
    let nested: Record<string, unknown> = {
      kind: 'step',
      id: 'leaf',
      document: { text: 'finish', references: [], attachments: [] },
    };
    for (let depth = 1_199; depth >= 0; depth -= 1) {
      nested = {
        kind: 'if',
        id: `gate_${depth}`,
        when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [nested],
        otherwise: [],
      };
    }
    const request = { definition: { defaults: { agentTarget }, blocks: [nested] } };

    let parsed: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.validate']['safeParse']> | undefined;
    expect(() => { parsed = WorkflowActionInputSchemasV1['workflow.validate'].safeParse(request); }).not.toThrow();
    expect(parsed?.success).toBe(true);
    if (!parsed?.success) throw new Error('expected the ingress carrier to parse');
    const validation = validateWorkflowDefinition(parsed.data.definition);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.normalizedDefinition?.blocks).toHaveLength(1);
    let current: unknown = validation.normalizedDefinition?.blocks[0];
    for (let depth = 0; depth < 1_200; depth += 1) {
      expect((current as { kind: string; id: string }).kind).toBe('if');
      expect((current as { id: string }).id).toBe(`gate_${depth}`);
      const thenBlocks = (current as { then: unknown[] }).then;
      expect(thenBlocks).toHaveLength(1);
      current = thenBlocks[0];
    }
    expect((current as { kind: string; id: string }).kind).toBe('step');
    expect((current as { id: string }).id).toBe('leaf');
    expect(WorkflowActionOutputSchemasV1['workflow.validate'].safeParse(validation).success).toBe(true);
  });

  it('represents semantic invalidity with its structurally canonical normalized definition', () => {
    const definition = createDeepWorkflowDefinition();
    const validation = validateWorkflowDefinition({ ...definition, finalOutput: {
      kind: 'result', producer: { blockId: 'missing', scope: { kind: 'current' } }, path: [],
    } });
    expect(validation.valid).toBe(false);
    expect(validation.normalizedDefinition).toBeDefined();
    expect(validation.issues.some((issue) => issue.code === 'missing_reference')).toBe(true);
    expect(WorkflowActionOutputSchemasV1['workflow.validate'].safeParse(validation).success).toBe(true);
  });

  it('selects one exact Run through the list owner without a detail read', () => {
    // Background refresh and transcript initial materialization need one
    // exact Run summary plus its sparse private metadata — never usage,
    // checkpoints, definitions or invocation history. The list owner carries
    // that lean projection when the caller selects the Run by id.
    expect(WorkflowActionInputSchemasV1['workflow.run.list'].safeParse({ runId: 'run-1' }).success).toBe(true);
    expect(WorkflowActionInputSchemasV1['workflow.run.list'].parse({ runId: 'run-1', limit: 1 }).runId).toBe('run-1');
    expect(WorkflowActionInputSchemasV1['workflow.run.list'].safeParse({ runId: '' }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.run.list'].safeParse({ runId: 'r'.repeat(192) }).success).toBe(false);
  });

  it('uses canonical identifiers at public Action boundaries', () => {
    expect(WorkflowActionInputSchemasV1['workflow.validate'].safeParse({
      definition: { blocks: ['Summarize the current work'] },
      inputs: { '$private': 'not an authored input' },
    }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.validate'].safeParse({
      definition: { blocks: ['Summarize the current work'] },
      target: { machineId: 'm'.repeat(192) },
    }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.run.list'].safeParse({
      originSessionId: 's'.repeat(192),
    }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.run.start'].safeParse({
      runId: 'not-a-caller-allocated-uuid',
      source: { kind: 'inline', definition: { blocks: ['Work'] } },
    }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.run.list'].safeParse({
      cursor: 'a'.repeat(1025),
    }).success).toBe(false);
    for (const cursor of ['', 'next page', 'next+page=']) {
      expect(WorkflowActionInputSchemasV1['workflow.run.list'].safeParse({ cursor }).success).toBe(false);
      expect(WorkflowActionInputSchemasV1['workflow.run.invocations.list'].safeParse({
        runId: 'run-1',
        cursor,
      }).success).toBe(false);
      expect(WorkflowActionInputSchemasV1['workflow.definition.list'].safeParse({ cursor }).success).toBe(false);
    }
  });

  it('projects accepted execution context without the admitted authorization', () => {
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      id: 'run-1', origin: { kind: 'direct' }, state: 'succeeded', revision: 1,
      machineId: 'machine-1', workflowCustodyState: 'settled', originDeliveryAckRevision: null,
      availability: {
        pause: false, resumeBoundary: false,
          restoreWorkspace: false, cancel: false, inspectExecution: true,
        disabledReasons: [],
      },
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
    } as const;
    const definition = {
      version: 1, inputs: [],
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
      blocks: [{ kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
    } as const;
    const acceptedContext = {
      startedBy: 'user',
      source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
      metadata: { title: 'Frozen title' },
      executionTarget: { kind: 'session' },
      materializedLeaves: [],
      frozenChildren: {},
      workspaceTarget: { project: { machineId: 'machine-1', directory: '/workspace', checkoutRootPath: '/workspace' } },
      origin: { kind: 'direct' },
    } as const;
    const result = { run, definition, acceptedContext, checkpoint: null };
    expect(WorkflowActionOutputSchemasV1['workflow.run.get'].safeParse({ ...result, definition: createDeepWorkflowDefinition() }).success).toBe(true);
    expect(WorkflowActionOutputSchemasV1['workflow.run.get'].safeParse(result).success).toBe(true);
    const { frozenChildren: _frozenChildren, ...incompleteContext } = acceptedContext;
    expect(WorkflowActionOutputSchemasV1['workflow.run.get'].safeParse({
      ...result, acceptedContext: incompleteContext,
    }).success).toBe(false);
    expect(WorkflowActionOutputSchemasV1['workflow.run.get'].safeParse({
      ...result,
      result: 'done',
    }).success).toBe(false);
    expect(WorkflowActionOutputSchemasV1['workflow.run.get'].safeParse({
      ...result,
      finalOutputInvocationId: 'inv-final',
    }).success).toBe(false);
    expect(WorkflowActionOutputSchemasV1['workflow.run.get'].safeParse({
      ...result,
      result: 'done',
      finalOutputInvocationId: 'inv-final',
    }).success).toBe(true);
    expect(WorkflowActionOutputSchemasV1['workflow.run.get'].safeParse({
      ...result,
      acceptedContext: {
        ...acceptedContext,
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }).success).toBe(false);
  });

  it('keeps public Run summaries title-free while carrying private display metadata beside list rows', () => {
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      id: 'run-1', origin: { kind: 'direct' }, state: 'running', revision: 1,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false,
          restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
    } as const;
    expect(WorkflowActionOutputSchemasV1['workflow.run.list'].parse({
      runs: [run],
      metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Frozen title' } } },
    }).metadataByRunId).toEqual({ 'run-1': { kind: 'available', value: { title: 'Frozen title' } } });
    expect(WorkflowActionOutputSchemasV1['workflow.run.list'].safeParse({ runs: [{ ...run, title: 'leak' }] }).success).toBe(false);
    expect(WorkflowActionOutputSchemasV1['workflow.run.list'].safeParse({
      runs: [run], metadataByRunId: { 'run-1': { kind: 'unavailable' } },
    }).success).toBe(true);
    expect(WorkflowActionOutputSchemasV1['workflow.run.list'].safeParse({
      runs: [run],
      metadataByRunId: {
        'run-1': { kind: 'unavailable' },
        'off-page-run': { kind: 'available', value: { title: 'Not in this page' } },
      },
    }).success).toBe(false);
    expect(WorkflowActionOutputSchemasV1['workflow.run.list'].safeParse({ runs: [run] }).success).toBe(false);
  });

  it('keeps physical retry allocation behind the Workflow owner', () => {
    const retry = {
      runId: 'run-1', expectedRevision: 2,
      invocation: { recordId: 'physical-attempt-2' },
      causalInvocationIds: ['physical-attempt-2'],
      conversation: 'same_conversation', input: { kind: 'original' },
    } as const;
    expect(WorkflowActionInputSchemasV1['workflow.run.invocations.retry'].safeParse(retry).success).toBe(true);
    for (const callerOwnedField of [
      { sequence: '4' },
      { logicalInvocationRecordId: 'logical-1' },
      { workspace: { directory: '/other' } },
      { nextRecordId: 'physical-attempt-3' },
    ]) {
      expect(WorkflowActionInputSchemasV1['workflow.run.invocations.retry'].safeParse({
        ...retry,
        ...callerOwnedField,
      }).success).toBe(false);
    }
  });

  it('projects authorized opened progress without exposing the storage envelope', () => {
    const invocation = {
      index: {
        id: 'invocation-1', runId: 'run-1', sequence: '0', parentRecordId: null,
        memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'completed',
        createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:01.000Z',
      },
      progress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: 'invocation-1',
        result: 'done',
      },
      parentRevision: 1,
    } as const;

    expect(WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].safeParse({ invocation }).success)
      .toBe(true);
    expect(WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].safeParse({
      invocation: { ...invocation, progress: undefined, contentEnvelope: 'private-storage-envelope' },
    }).success).toBe(false);
  });

  it('accepts the V3 handbook start and admission-response examples', () => {
    const start = {
      runId: '0f2cf13d-4ad7-4f4b-b5e0-cc3b7dce7f11',
      source: {
        kind: 'inline',
        definition: {
          version: 1,
          inputs: [],
          defaults: {
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
            conversation: { kind: 'shared_run' },
          },
          blocks: [
            {
              kind: 'step', id: 'a',
              document: { text: 'Analyze', references: [], attachments: [] },
              input: [], result: { kind: 'text' },
            },
            {
              kind: 'step', id: 'b',
              document: { text: 'Implement from the supplied analysis', references: [], attachments: [] },
              execution: { conversation: { kind: 'shared_run' } },
              input: [{
                kind: 'result', producer: { blockId: 'a', scope: { kind: 'current' } }, path: [],
              }],
              result: { kind: 'text' },
            },
          ],
          finalOutput: {
            kind: 'result', producer: { blockId: 'b', scope: { kind: 'current' } }, path: [],
          },
        },
      },
      inputs: {},
      onComplete: { kind: 'originating_session' },
    } as const;
    expect(WorkflowActionInputSchemasV1['workflow.run.start'].safeParse(start).success).toBe(true);

    const response = {
      run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        id: start.runId,
        origin: { kind: 'direct', originSessionId: 'sess-7' },
        state: 'running', revision: 3, machineId: 'machine-1',
        workflowCustodyState: 'pending', originDeliveryAckRevision: 0,
        availability: {
          pause: true, resumeBoundary: false,
            restoreWorkspace: false, cancel: true, inspectExecution: true,
          disabledReasons: [],
        },
        createdAt: '2026-09-08T12:00:00.000Z',
        updatedAt: '2026-09-08T12:00:01.000Z',
      },
      admission: 'created',
    } as const;
    expect(WorkflowActionOutputSchemasV1['workflow.run.start'].safeParse(response).success).toBe(true);
    expect(parseWorkflowRunStartActionResultReferenceV1(response)).toEqual({
      runId: start.runId,
      origin: { kind: 'direct', originSessionId: 'sess-7' },
    });
    expect(parseWorkflowRunStartActionResultReferenceV1({ ok: true, result: response })).toEqual({
      runId: start.runId,
      origin: { kind: 'direct', originSessionId: 'sess-7' },
    });
    expect(parseWorkflowRunStartActionResultReferenceV1({
      ok: false,
      errorCode: 'run_not_found',
      error: 'missing',
    })).toBeNull();
  });

  it('accepts only a strict optional Run-level execution target selector', () => {
    const base = {
      runId: '0f2cf13d-4ad7-4f4b-b5e0-cc3b7dce7f11',
      source: { kind: 'inline', definition: { blocks: ['Work'] } },
    } as const;
    expect(WorkflowActionInputSchemasV1['workflow.run.start'].safeParse(base).success).toBe(true);
    for (const kind of ['session', 'detached_run'] as const) {
      expect(WorkflowActionInputSchemasV1['workflow.run.start'].safeParse({
        ...base,
        executionTarget: { kind },
      }).success).toBe(true);
    }
    expect(WorkflowActionInputSchemasV1['workflow.run.start'].safeParse({
      ...base,
      executionTarget: { kind: 'attached_run' },
    }).success).toBe(false);
    expect(WorkflowActionInputSchemasV1['workflow.run.start'].safeParse({
      ...base,
      executionTarget: { kind: 'session', sessionId: 'forged' },
    }).success).toBe(false);
  });

  it('round-trips lifecycle and attention filters with decimal BigInt counters', () => {
    expect(WorkflowRunListRequestV1Schema.parse({ attention: 'required' }).attention).toBe('required');
    expect(WorkflowRunListRequestV1Schema.safeParse({ attention: 'suggested' }).success).toBe(false);

    const filtered = WorkflowInvocationListRequestV1Schema.parse({
      runId: 'run-1',
      lifecycles: ['waiting_for_approval', 'outcome_uncertain'],
    });
    expect(filtered.lifecycles).toEqual(['waiting_for_approval', 'outcome_uncertain']);
    expect(WorkflowInvocationListRequestV1Schema.safeParse({
      runId: 'run-1',
      lifecycles: ['unknown_lifecycle'],
    }).success).toBe(false);
    expect(WorkflowInvocationListRequestV1Schema.safeParse({
      runId: 'run-1',
      lifecycles: [],
    }).success).toBe(false);

    const page = WorkflowInvocationListResultV1Schema.parse({
      invocations: [{
        id: 'inv-1', runId: 'run-1', sequence: '0', parentRecordId: null,
        memberOrdinal: '12', attempt: '2', contentRevision: '0', lifecycle: 'running',
        createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      }],
      parentRevision: 4,
    });
    expect(page.parentRevision).toBe(4);
    expect(page.invocations[0]).toMatchObject({ sequence: '0', memberOrdinal: '12', attempt: '2' });
    expect(typeof page.invocations[0]?.sequence).toBe('string');
  });
});
