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
  'scm.diff.file', 'scm.diff.commit', 'scm.log.list', 'scm.history.entries', 'scm.branch.list',
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
  it('admits no-Session UI and Voice change selection through the real typed Action and retains policy refusal', async () => {
    const { createActionExecutor } = await import('./actionExecutor.js');
    type Deps = import('./executor/types.js').ActionExecutorDeps;
    const calls: unknown[] = [];
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      scmActionExecute: async ({ input, context }: Parameters<NonNullable<Deps['scmActionExecute']>>[0]) => {
        calls.push({ input, target: context.externalActionTarget, sessionId: context.defaultSessionId });
        return { success: true };
      },
    // The fixture supplies only the owning-machine transport boundary.
    } as unknown as Deps);
    for (const surface of ['ui', 'voice'] as const) {
      expect(await executor.execute('scm.change.include', { cwd: '/repo', paths: ['file.ts'] }, {
        surface, externalActionTarget: { kind: 'machine', machineId: 'machine' },
      })).toMatchObject({ ok: true, result: { success: true } });
    }
    expect(calls).toEqual(Array.from({ length: 2 }, () => ({ input: { cwd: '/repo', paths: ['file.ts'] },
      target: { kind: 'machine', machineId: 'machine' }, sessionId: undefined })));
    const disabled = createActionExecutor({ isActionEnabled: () => false,
      scmActionExecute: async () => { throw new Error('Disabled Action reached transport'); },
    } as unknown as Deps);
    expect(await disabled.execute('scm.change.include', { cwd: '/repo', paths: ['file.ts'] }, {
      surface: 'ui', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
  });
  it('resolves credential-free addresses through a safe machine read on all surfaces', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const spec = getActionSpec(ActionIdSchema.parse('scm.hostingRepository.resolveAddress'));
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.safety).toBe('safe');
    expect(spec.surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true, cli: true });
    expect(spec.inputSchema.parse({ address: 'forge.test/team/repo' })).toEqual({ address: 'forge.test/team/repo' });
    expect(spec.inputSchema.safeParse({ address: 'forge.test/team/repo', token: 'secret' }).success).toBe(false);
    const selector = { provider: { id: 'plugin/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
      repository: { nameWithOwner: 'team/repo', cloneUrl: 'https://forge.test/team/repo' }, protocol: 'https' };
    expect(spec.outputSchema?.safeParse({ success: true, kind: 'resolved', selector }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ success: true, kind: 'resolved', selector: { ...selector,
      repository: { ...selector.repository, cloneUrl: 'https://user:secret@forge.test/team/repo' } } }).success).toBe(false);
    for (const kind of ['unknown', 'unsupported', 'invalid']) {
      expect(spec.outputSchema?.safeParse({ success: true, kind }).success).toBe(true);
    }
  });
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
    const history = { cwd: '/repo', folder: '', paths: ['', ':(glob)*', '-dash', 'line\nbreak', 'space '] };
    expect(schema('scm.history.entries').parse(history)).toEqual(history);
    expect(schema('scm.history.entries').safeParse({ ...history, unknown: true }).success).toBe(false);
    const { zodSchemaToJsonSchemaObject } = await import('./actionInputJsonSchema.js');
    expect(zodSchemaToJsonSchemaObject(schema('scm.history.entries'))).toMatchObject({
      type: 'object', additionalProperties: false, required: ['cwd', 'folder', 'paths'],
    });
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
