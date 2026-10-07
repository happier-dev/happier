import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { SCM_GIT_ACTION_SPECS } from './scmGitActionSpecs.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { validateWorkflowDefinition } from '../workflows/workflowValidationV1.js';
import { resolveBuiltinWorkflowDefinitionV1 } from '../workflows/builtins/catalog.js';

const reads = [
  'scm.backend.describe', 'scm.status.snapshot', 'scm.worktrees.enrichment',
  'scm.diff.file', 'scm.diff.commit', 'scm.log.list', 'scm.branch.list',
  'scm.stash.list', 'scm.stash.show', 'scm.pullRequest.list', 'scm.pullRequest.get',
  'scm.pullRequest.openCompose', 'scm.hostingRepository.describePublishTargets',
] as const;
const mutations = [
  'scm.change.include', 'scm.change.exclude', 'scm.change.discard',
  'scm.commit.create', 'scm.commit.backout', 'scm.commit.undoLast', 'scm.branch.create', 'scm.branch.checkout',
  'scm.branch.merge', 'scm.branch.rebase', 'scm.branch.operation.continue',
  'scm.branch.operation.skip', 'scm.branch.operation.abort',
  'scm.conflict.acceptSide', 'scm.conflict.markResolved',
  'scm.worktree.create', 'scm.worktree.remove', 'scm.worktree.prune',
  'scm.remote.add', 'scm.remote.setUrl', 'scm.remote.remove', 'scm.remote.fetch',
  'scm.remote.pull', 'scm.remote.push', 'scm.remote.publish',
  'scm.stash.create', 'scm.stash.apply', 'scm.stash.pop', 'scm.stash.drop',
  'scm.pullRequest.openOrReuse', 'scm.pullRequest.checkout', 'scm.pullRequest.prepareWorktree',
  'scm.pullRequest.runStacked',
  'scm.repository.init', 'scm.repository.clone', 'scm.repository.removeIndexLock',
  'scm.hostingRepository.publish',
] as const;

describe('SCM Action parity', () => {
  it('declares every Git read and mutation in the canonical Action ID schema', () => {
    for (const id of [...reads, ...mutations]) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it('projects every Git read and mutation through the same typed machine Action', () => {
    for (const id of [...reads, ...mutations]) {
      const spec = getActionSpec(ActionIdSchema.parse(id));
      expect(spec.bindings?.rpcMethod, id).toBe(id);
      expect(spec.executionPlacement, id).toBe('machine');
      expect(spec.requiredAuthority, id).toBe('account_automation');
      expect(spec.surfaces, id).toMatchObject({ agent: true, mcp: true, cli: true, rpc: true });
      expect(spec.outputSchema, id).toBeDefined();
      expect(spec.safety, id).toBe(reads.includes(id as typeof reads[number]) ? 'safe' : 'danger');
    }
  });

  it('keeps force-with-lease on the same centrally approved danger Action as ordinary push', () => {
    const spec = getActionSpec(ActionIdSchema.parse('scm.remote.push'));
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface, authority: 'account_automation' } }).required).toBe(true);
    }
  });

  it('advertises the PR workflow leaf input with an optional current-branch head', () => {
    const spec = getActionSpec('scm.pullRequest.openOrReuse');
    const input = { cwd: '/repo', base: 'main', title: 'A pull request', body: 'Details' };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    const projected = zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' });
    expect(projected.required).not.toContain('head');
    expect(validateWorkflowDefinition(resolveBuiltinWorkflowDefinitionV1('open-a-pull-request')?.definition).issues).toEqual([]);
  });

  it('uses the canonical path, history-range and remote-policy schemas instead of a separate Action shape', () => {
    const schema = (id: string) => {
      const spec = SCM_GIT_ACTION_SPECS.find((row) => row.id === id);
      if (!spec) throw new Error(`Missing SCM Action ${id}`);
      return spec.inputSchema;
    };
    expect(schema('scm.change.include').safeParse({ paths: ['../outside'] }).success).toBe(false);
    expect(schema('scm.log.list').parse({ range: 'incoming' })).toMatchObject({ range: 'incoming' });
    expect(schema('scm.remote.push').safeParse({ pushMode: 'force_with_lease' }).success).toBe(false);
    expect(schema('scm.commit.undoLast').safeParse({}).success).toBe(false);
    expect(schema('scm.commit.undoLast').safeParse({ expectedHeadOid: 'HEAD' }).success).toBe(false);
    expect(schema('scm.commit.undoLast').parse({ expectedHeadOid: 'a'.repeat(40) })).toMatchObject({ expectedHeadOid: 'a'.repeat(40) });
    expect(schema('scm.remote.push').parse({ remote: 'origin', branch: 'main', pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) })).toMatchObject({ pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) });
  });

  it('keeps source-plugin-owned prepared materialization behind its provenance boundary', () => {
    const spec = getActionSpec('scm.reviewWorkspace.materializePrepared');
    expect(spec.surfaces).toMatchObject({ agent: false, mcp: false, cli: false, api: false });
  });
});
