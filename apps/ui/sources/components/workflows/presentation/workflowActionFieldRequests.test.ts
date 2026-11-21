import { describe, expect, it } from 'vitest';

import { readWorkflowActionFieldRequests } from './workflowActionFieldRequests';
import { findWorkflowActionSpec } from './workflowActionCatalog';
import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';

function reviewStep(
  input: WorkflowActionLeafV1['input'],
): WorkflowActionLeafV1 {
  return {
    kind: 'action',
    id: 'review',
    actionId: 'review.start',
    input,
  } as WorkflowActionLeafV1;
}

function requestedPaths(
  input: WorkflowActionLeafV1['input'],
): readonly string[] {
  const spec = findWorkflowActionSpec('review.start', undefined, {
    authored: true,
  });
  expect(spec).not.toBeNull();
  return readWorkflowActionFieldRequests({ blocks: [reviewStep(input)] }, [
    spec!,
  ]).requests.map(({ field }) => field.path);
}

describe('readWorkflowActionFieldRequests', () => {
  it('does not ask a repository Review step which changes to review', () => {
    expect(
      requestedPaths({ scope: { kind: 'literal', value: 'repository' } }),
    ).not.toContain('changeType');
  });

  it('asks a changes Review step which changes to review', () => {
    expect(requestedPaths({})).toContain('changeType');
    expect(
      requestedPaths({ scope: { kind: 'literal', value: 'changes' } }),
    ).toContain('changeType');
  });
});
