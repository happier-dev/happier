// Keep the builtin first: daemon/plugin discovery can reach it before the
// Workflow schema graph, so its authored data must not eagerly parse that graph.
import { OPEN_A_PULL_REQUEST_WORKFLOW_V1 as definition } from './openAPullRequest.js';
import { WorkflowDefinitionBaseSchema } from '../workflowV1.js';
import { describe, expect, it } from 'vitest';

describe('Workflow builtin initialization', () => {
  it('loads the pull-request builtin first and retains strict result validation', () => {
    const parsed = WorkflowDefinitionBaseSchema.parse(definition);
    expect(parsed.blocks[0]).toMatchObject({
      kind: 'step', result: { kind: 'json', schema: { type: 'object' } },
    });
    const invalid = structuredClone(definition);
    Object.assign(invalid.blocks[0], { result: { kind: 'json', schema: { type: 'object' }, unexpected: true } });
    expect(WorkflowDefinitionBaseSchema.safeParse(invalid).success).toBe(false);
  });
});
