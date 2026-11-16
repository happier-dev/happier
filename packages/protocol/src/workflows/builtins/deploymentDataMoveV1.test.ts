import { describe, expect, it } from 'vitest';
import { createDeploymentDataMoveWorkflowV1 } from './deploymentMoveV1.js';
import { validateWorkflowDefinition } from '../workflowValidationV1.js';
import type { WorkflowBlock } from '../workflowV1.js';

function leaves(blocks: readonly WorkflowBlock[]): WorkflowBlock[] {
  return blocks.flatMap(block => [block, ...(block.kind === 'if' ? [...leaves(block.then), ...leaves(block.otherwise)]
    : block.kind === 'loop' ? leaves(block.body) : block.kind === 'parallel' ? block.branches.flatMap(branch => leaves(branch.blocks)) : [])]);
}

describe('data-safe Move authoring', () => {
  it('authors a valid persisted composition with stopped observation before final capture and cutover after restored health', () => {
    const definition = createDeploymentDataMoveWorkflowV1();
    expect(validateWorkflowDefinition(definition)).toMatchObject({ valid: true, issues: [] });
    const actions = leaves(definition.blocks).filter(block => block.kind === 'action').map(block => block.id);
    const order = ['quiesce0', 'stopped0', 'backup', 'verify', 'prepareRestore', 'restore', 'destinationServices',
      'destinationHealth', 'cutover', 'deploy', 'appServices', 'appHealth', 'teardown'];
    let previous = -1;
    for (const id of order) {
      const current = actions.indexOf(id);
      expect(current, `${id} must follow the preceding safety boundary`).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('offers explicit source recovery before cutover and a decision without source restart after cutover', () => {
    const blocks = leaves(createDeploymentDataMoveWorkflowV1().blocks);
    expect(blocks.some(block => block.kind === 'wait' && block.id === 'backupRecovery')).toBe(true);
    const cutoverGuard = blocks.find(block => block.kind === 'if' && block.id === 'cutoverSucceeded');
    expect(cutoverGuard?.kind).toBe('if');
    if (cutoverGuard?.kind !== 'if') throw new Error('missing_cutover_guard');
    expect(leaves(cutoverGuard.otherwise).filter(block => block.kind === 'action')).toEqual([]);
    expect(cutoverGuard.otherwise).toMatchObject([{ kind: 'wait', name: 'Needs decision' }]);
  });
});
