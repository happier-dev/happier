import { describe, expect, it } from 'vitest';
import type { WorkflowDefinitionV1, WorkflowStep } from '@happier-dev/protocol';
import { resolveWorkflowInvocationStructure, type WorkflowInvocationBindingRow } from './workflowScopeBinding';

const step = (id: string): WorkflowStep => ({ kind: 'step', id,
  document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' } });
const row = (id: string, parentRecordId: string | null, memberOrdinal: string,
  blockId: string, extra: Partial<WorkflowInvocationBindingRow['progress']> = {}): WorkflowInvocationBindingRow => ({
  index: { id, runId: 'run', parentRecordId, memberOrdinal, sequence: '0', attempt: '0', contentRevision: '0', lifecycle: 'running',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId, scope: [] },
    blockKind: id === 'root' ? 'root' : 'step', attempt: '0', logicalInvocationRecordId: id, ...extra },
});

describe('frozen workflow invocation binding', () => {
  it('selects the exact If body and evaluator from recorded parent/member ancestry', async () => {
    const evaluator = step('judge');
    const work = step('work');
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'loop', id: 'rounds', repetition: { kind: 'evaluate', maxIterations: 3, history: 'none', evaluator: {
        ...evaluator, result: { kind: 'decision', decisions: ['continue', 'stop'] },
      } }, body: [{ kind: 'if', id: 'choice', when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [step('decoy')], otherwise: [work] }] },
    ] };
    const rows = [row('root', null, '0', '$root'), row('loop', 'root', '0', 'rounds', { blockKind: 'loop' }),
      row('body', 'loop', '2', 'rounds', { blockKind: 'loop', frame: { ownerBlockId: 'rounds', source: { kind: 'iteration', index: '2' } } }),
      row('if', 'body', '0', 'choice', { blockKind: 'if', container: { kind: 'if', selected: 'otherwise', nextBlockOrdinal: '0' } }),
      row('work-row', 'if', '0', 'work'), row('judge-row', 'body', '1', 'judge')];
    const reads: string[] = [];
    const readInvocation = async (id: string) => { reads.push(id); return rows.find((value) => value.index.id === id); };
    await expect(resolveWorkflowInvocationStructure({ keyOfInvocation: ({ index }) => index.id, definition, invocation: rows[4]!, readInvocation })).resolves.toMatchObject({ step: work });
    await expect(resolveWorkflowInvocationStructure({ keyOfInvocation: ({ index }) => index.id, definition, invocation: rows[5]!, readInvocation })).resolves.toMatchObject({ step: definition.blocks[0]!.kind === 'loop'
      && definition.blocks[0].repetition.kind === 'evaluate' ? definition.blocks[0].repetition.evaluator : undefined });
    expect(reads).toEqual(['if', 'body', 'loop', 'root', 'body', 'loop', 'root']);
  });

  it('refuses a globally known leaf at the wrong slot or an unavailable parent', async () => {
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [step('first'), step('second')] };
    const root = row('root', null, '0', '$root');
    const readInvocation = async (id: string) => id === 'root' ? root : undefined;
    await expect(resolveWorkflowInvocationStructure({ keyOfInvocation: ({ index }) => index.id, definition, invocation: row('wrong', 'root', '0', 'second'), readInvocation })).resolves.toBeUndefined();
    await expect(resolveWorkflowInvocationStructure({ keyOfInvocation: ({ index }) => index.id, definition, invocation: row('missing', 'gone', '0', 'first'), readInvocation })).resolves.toBeUndefined();
    await expect(resolveWorkflowInvocationStructure({ keyOfInvocation: ({ index }) => index.id, definition, invocation: row('wrong-role', 'root', '0', 'first', { blockKind: 'loop' }), readInvocation })).resolves.toBeUndefined();
  });

  it('reconstructs the inherited parallel-item owner through If and a sequential body without a scope path', async () => {
    const work = step('work');
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'loop', id: 'items',
      repetition: { kind: 'items', items: { kind: 'literal', value: ['a', 'b'] }, execution: 'parallel', failurePolicy: 'fail_stop' },
      body: [{ kind: 'if', id: 'choice', when: { kind: 'exists', value: { kind: 'literal', value: true } }, otherwise: [],
        then: [{ kind: 'loop', id: 'sequential', repetition: { kind: 'count', count: { kind: 'literal', value: 1 } }, body: [work] }] }],
    }] };
    const rows = [row('root', null, '0', '$root'), row('items', 'root', '0', 'items', { blockKind: 'loop' }),
      row('item', 'items', '1', 'items', { blockKind: 'loop', frame: { ownerBlockId: 'items', source: { kind: 'item', index: '1' } } }),
      row('if', 'item', '0', 'choice', { blockKind: 'if', container: { kind: 'if', selected: 'then', nextBlockOrdinal: '0' } }),
      row('loop', 'if', '0', 'sequential', { blockKind: 'loop' }),
      row('body', 'loop', '0', 'sequential', { blockKind: 'loop', frame: { ownerBlockId: 'sequential', source: { kind: 'iteration', index: '0' } } }),
      row('leaf', 'body', '0', 'work')];
    const resolved = await resolveWorkflowInvocationStructure({ definition, invocation: rows[6]!,
      readInvocation: async (id) => rows.find((candidate) => candidate.index.id === id),
      keyOfInvocation: ({ index }) => index.id });
    expect(resolved).toMatchObject({ step: work, inheritedConversationOwnerRecordId: 'item',
      frame: { structuralKey: 'body', loop: { kind: 'count', ownerKey: 'loop' }, parent: { structuralKey: 'if',
        parent: { structuralKey: 'item', loop: { kind: 'items', execution: 'parallel' } } } } });
    const mismatched = rows.map((candidate) => candidate.index.id !== 'body' ? candidate : {
      ...candidate, progress: { ...candidate.progress,
        frame: { ownerBlockId: 'sequential', source: { kind: 'item' as const, index: '0' } } },
    });
    await expect(resolveWorkflowInvocationStructure({ keyOfInvocation: ({ index }) => index.id, definition, invocation: rows[6]!,
      readInvocation: async (id) => mismatched.find((candidate) => candidate.index.id === id) })).resolves.toBeUndefined();
  });
});
