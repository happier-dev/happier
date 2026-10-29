import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { SCM_GIT_ACTION_SPECS } from './scmGitActionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

// Load the real Action graph during collection, outside observable dispatch budgets.
await import('./actionSpecs.js');
const { createActionExecutor } = await import('./actionExecutor.js');
const { isApprovalRequiredByActionsSettings } = await import('./actionApprovalPolicy.js');
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { validateWorkflowDefinition } from '../workflows/workflowValidationV1.js';
import { resolveBuiltinWorkflowDefinitionV1 } from '../workflows/builtins/catalog.js';
import { markSessionListQueryResultV1 } from '../sessions/awareness/action.js';

const reads = [
  'scm.backend.describe', 'scm.status.snapshot', 'scm.worktrees.enrichment',
  'scm.file.read', 'scm.diff.file', 'scm.diff.commit', 'scm.log.list', 'scm.history.entries', 'scm.branch.list',
  'scm.stash.list', 'scm.stash.show', 'scm.pullRequest.list', 'scm.pullRequest.get',
  'scm.pullRequest.openCompose', 'scm.hostingRepository.describePublishTargets', 'scm.hostingRepository.get',
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
  it.each(['scm.status.snapshot', 'scm.remote.pull', 'scm.pullRequest.get'] as const)('routes %s to its admitted Session without borrowing another Machine or default Session', async actionId => {
    type Deps = import('./executor/types.js').ActionExecutorDeps;
    const calls: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'scm.remote.pull': ['cli'] } });
    const executor = createActionExecutor({
      // Session resolution and SCM dispatch are authenticated transport boundaries.
      resolveSessionReference: async () => ({ kind: 'unique', address: { serverId: 'target-home', sessionId: 'bound-session' } }),
      isActionApprovalRequired: (...[id, context, input]: Parameters<NonNullable<Deps['isActionApprovalRequired']>>) =>
        isApprovalRequiredByActionsSettings(id, settings, context, undefined, undefined, input),
      scmActionExecute: async ({ input, context }: Parameters<NonNullable<Deps['scmActionExecute']>>[0]) => {
        calls.push({ input, serverId: context.serverId, sessionId: context.defaultSessionId,
          machineId: context.defaultSessionMachineId, machine: context.externalActionTarget,
          runMachine: context.executionRunTargetMachineId });
        return { ok: false, errorCode: 'fixture_transport', error: 'fixture_transport' };
      },
    } as unknown as Deps);
    const input = { sessionId: { selector: 'self' as const, of: 'bound-reference' }, cwd: '/authored/path',
      ...(actionId === 'scm.remote.pull' ? { remote: 'origin', branch: 'topic' }
        : actionId === 'scm.pullRequest.get' ? { prReference: { url: 'https://github.com/acme/widgets/pull/12' } } : {}) };
    const spec = getActionSpec(actionId);
    expect(await executor.execute(actionId, input, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'original-home',
      defaultSessionId: 'unrelated-session', defaultSessionMachineId: 'unrelated-machine',
      externalActionTarget: { kind: 'machine', machineId: 'unrelated-machine' }, executionRunTargetMachineId: 'unrelated-run-machine',
    })).toMatchObject({ ok: false, errorCode: 'fixture_transport' });
    expect(calls).toEqual([{ input: { ...input, sessionId: 'bound-session' }, serverId: 'target-home',
      sessionId: 'bound-session', machineId: undefined, machine: undefined, runMachine: undefined }]);
    expect(spec.sessionTarget).toEqual({ field: 'sessionId', cardinality: 'one' });
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects a multi-Session pull before SCM effects and preserves an omitted Session operand', async () => {
    type Deps = import('./executor/types.js').ActionExecutorDeps;
    const calls: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'scm.remote.pull': ['cli'] } });
    const executor = createActionExecutor({
      resolveSessionReference: async () => ({ kind: 'unique', address: { serverId: 'home', sessionId: 'manager' } }),
      sessionList: async () => markSessionListQueryResultV1({ sessions: ['child-a', 'child-b'].map(id => ({
        id, manager: { sessionId: 'manager' }, active: false, presence: 'offline', updatedAt: 1,
      })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }),
      isActionApprovalRequired: (...[id, context, input]: Parameters<NonNullable<Deps['isActionApprovalRequired']>>) =>
        isApprovalRequiredByActionsSettings(id, settings, context, undefined, undefined, input),
      scmActionExecute: async ({ input, context }: Parameters<NonNullable<Deps['scmActionExecute']>>[0]) => {
        calls.push({ input, sessionId: context.defaultSessionId, machine: context.externalActionTarget });
        return { ok: false, errorCode: 'fixture_transport', error: 'fixture_transport' };
      },
    } as unknown as Deps);
    const context = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
      serverId: 'home', defaultSessionId: 'original', externalActionTarget: { kind: 'machine' as const, machineId: 'selected-machine' } };
    expect(await executor.execute('scm.remote.pull', { sessionId: { selector: 'workers', of: 'manager' }, remote: 'origin' }, context))
      .toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch', details: { expected: 'one', actualCount: 2 } });
    expect(calls).toEqual([]);
    expect(await executor.execute('scm.remote.pull', { remote: 'origin' }, context)).toMatchObject({ ok: false, errorCode: 'fixture_transport' });
    expect(calls).toEqual([{ input: { remote: 'origin' }, sessionId: 'original', machine: context.externalActionTarget }]);
  });

  it('dispatches blame as a safe machine read through the canonical SCM Action owner', async () => {
    const id = ActionIdSchema.parse('scm.blame.get');
    const spec = getActionSpec(id);
    expect(spec.bindings?.rpcMethod).toBe('scm.blame.file');
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: true });
    for (const surface of ['agent', 'mcp', 'cli', 'ui'] as const) {
      expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface, authority: 'account_automation' } }).required).toBe(false);
    }
    type Deps = import('./executor/types.js').ActionExecutorDeps;
    const input = { cwd: '/repo', path: 'file', expectedHash: '1'.repeat(64) };
    const output = { success: true, ranges: [{ startLine: 1, lineCount: 1, commitIndex: null }], commits: [] };
    const executor = createActionExecutor({
      // The Machine transport is the boundary; shared Action parsing/admission/dispatch stay real.
      scmActionExecute: async (request: Parameters<NonNullable<Deps['scmActionExecute']>>[0]) => {
        expect(request.actionId).toBe(id);
        expect(request.input).toEqual(input);
        return output;
      },
    } as unknown as Deps);
    expect(await executor.execute(id, input, { surface: 'ui', externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
      .toMatchObject({ ok: true, result: output });
  });

  it('keeps the revision read safe without confusing result custody with approval', () => {
    const id = ActionIdSchema.parse('scm.file.read');
    const spec = getActionSpec(id);
    expect(spec.approval.result).toBe('required');
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface, authority: 'account_automation' } }).required).toBe(false);
    }
  });
  it('admits no-Session UI and Voice change selection through the real typed Action and retains policy refusal', async () => {
    type Deps = import('./executor/types.js').ActionExecutorDeps;
    const calls: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'scm.change.include': ['ui', 'voice'] },
    });
    const executor = createActionExecutor({
      // Match the UI host adapter: execute real policy against the admitted settings.
      isActionApprovalRequired: (...[actionId, context, input]: Parameters<NonNullable<Deps['isActionApprovalRequired']>>) => isApprovalRequiredByActionsSettings(
        actionId, context.actionsSettings ?? settings, context, undefined, undefined, input,
      ),
      scmActionExecute: async ({ input, context }: Parameters<NonNullable<Deps['scmActionExecute']>>[0]) => {
        calls.push({ input, target: context.externalActionTarget, sessionId: context.defaultSessionId });
        return { success: true };
      },
    // The fixture supplies only the owning-machine transport boundary.
    } as unknown as Deps);
    for (const surface of ['ui', 'voice'] as const) {
      const receipt = await executor.execute('scm.change.include', { cwd: '/repo', paths: ['file.ts'] }, {
        surface, actionsSettings: settings, externalActionTarget: { kind: 'machine', machineId: 'machine' },
      });
      expect(receipt, JSON.stringify({ surface, receipt })).toMatchObject({ ok: true, result: { success: true } });
    }
    expect(calls).toEqual(Array.from({ length: 2 }, () => ({ input: { cwd: '/repo', paths: ['file.ts'] },
      target: { kind: 'machine', machineId: 'machine' }, sessionId: undefined })));
    const disabledSettings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'scm.change.include': { disabledSurfaces: ['ui'] } },
    });
    expect(await executor.execute('scm.change.include', { cwd: '/repo', paths: ['file.ts'] }, {
      surface: 'ui', actionsSettings: disabledSettings, externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(calls).toHaveLength(2);
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
  it('closes authoritative repository metadata and rejects unsafe public links', () => {
    const spec = getActionSpec(ActionIdSchema.parse('scm.hostingRepository.get'));
    const selector = { provider: { id: 'plugin/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
      repository: { nameWithOwner: 'team/repo' }, protocol: 'https' };
    expect(spec.inputSchema.safeParse({ selector }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ selector, visibility: 'public' }).success).toBe(false);
    const repository = { label: 'team/repo', url: 'https://forge.test/team/repo' };
    expect(spec.outputSchema?.safeParse({ success: true, kind: 'public', repository }).success).toBe(true);
    for (const url of ['http://forge.test/team/repo', 'https://user:secret@forge.test/team/repo', 'https://forge.test/team/repo?token=secret']) {
      expect(spec.outputSchema?.safeParse({ success: true, kind: 'public', repository: { ...repository, url } }).success).toBe(false);
    }
    expect(spec.outputSchema?.safeParse({ success: true, kind: 'private', repository }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ success: false, kind: 'failed', code: 'repository_unavailable', error: 'private diagnostic' }).success).toBe(false);
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
