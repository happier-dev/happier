import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeWaitActionV1 } from './waitAction.js';
import { WaitActionInputV1Schema } from '../specs/wait.js';
import { waitForExecutionRunTerminal } from '../../execution/runs/waitForTerminal.js';
import { createWorkflowAccountRunActionOwner } from './workflowRunActions.js';
import { WorkflowRunSummaryV1Schema } from '../../workflows/workflowProgressV1.js';

function run(status: 'running' | 'failed' | 'succeeded') {
  return { runId: 'run', callId: 'call', sidechainId: 'call', intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
    retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1, status };
}

afterEach(() => vi.useRealTimers());

describe('generic wait observation', () => {
  const target = { kind: 'execution_run', serverId: 'home', machineId: 'machine', runId: 'run' } as const;
  it('returns terminal evidence only after the execution owner completes custody', async () => {
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    const waiting = executeWaitActionV1({ target, condition: { kind: 'terminal' } }, {
      execution: async (_target, options) => waitForExecutionRunTerminal({
        runId: target.runId, timeoutMs: options.timeoutMs, signal: options.signal,
        readRun: async () => ({ ok: true, data: { run: run('failed') } }),
        waitForTerminal: async () => completion,
      }),
    });
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await waiting).toMatchObject({ disposition: 'matched', target, snapshot: { status: 'failed' } });
  });
  it('times out without stopping the admitted work', async () => {
    vi.useFakeTimers();
    let running = true;
    const waiting = executeWaitActionV1({ target, condition: { kind: 'terminal' }, timeout: { durationMs: 1000 } }, {
      execution: async (_target, options) => waitForExecutionRunTerminal({
        runId: target.runId, timeoutMs: options.timeoutMs, signal: options.signal,
        readRun: async () => ({ ok: true, data: { run: run(running ? 'running' : 'succeeded') } }),
        waitForTerminal: (_id, signal) => new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toMatchObject({ disposition: 'observation_timeout' });
    expect(running).toBe(true);
    running = false;
  });
  it('cancels only this observation', async () => {
    const abort = new AbortController();
    const waiting = executeWaitActionV1({ target, condition: { kind: 'terminal' } }, {
      execution: async (_target, options) => waitForExecutionRunTerminal({
        runId: target.runId, timeoutMs: null, signal: options.signal,
        readRun: async () => ({ ok: true, data: { run: run('running') } }),
        waitForTerminal: (_id, signal) => new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      }),
    }, { signal: abort.signal });
    abort.abort();
    expect(await waiting).toMatchObject({ disposition: 'cancelled' });
  });
  it.each(['terminal', 'needs_attention', 'timeout', 'paused'] as const)(
    'consumes FIN %s evidence without another lifecycle decision', async (observation) => {
      const runId = '11111111-1111-4111-8111-111111111111';
      const summary = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account', visibleTeamId: null,
        id: runId, origin: { kind: 'direct' }, state: observation === 'terminal' ? 'succeeded' : observation === 'paused' ? 'paused' : 'running',
        attentionRequired: observation === 'needs_attention', revision: 0, machineId: 'machine', workflowCustodyState: 'pending',
        originDeliveryAckRevision: null, availability: { pause: true, resumeBoundary: false, restoreWorkspace: false,
          cancel: true, inspectExecution: false, disabledReasons: [] }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
      // Only persisted storage is substituted; FIN validates its real wait result.
      const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => 'account',
        storage: { execute: async () => ({ run: summary, observation,
          ...(observation === 'timeout' ? {} : { matchedCondition: observation === 'needs_attention' ? 'attention' : observation }) }) },
        definitions: { get: async () => { throw new Error('wait_requires_no_definition'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: () => null, randomBytes: () => { throw new Error('read_needs_no_randomness'); },
      });
      const result = await executeWaitActionV1({ target: { kind: 'workflow_run', serverId: 'home', runId }, condition: { kind: 'terminal_or_needs_attention' } }, {
        workflow: async () => owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {} }),
      });
      expect(result.disposition).toBe(observation === 'timeout' ? 'observation_timeout' : observation === 'paused' ? 'unsupported_condition' : 'matched');
    },
  );
  it.each(['needs_attention', 'terminal_or_needs_attention'] as const)('consumes the execution owner attention evidence for %s', async (kind) => {
    expect(await executeWaitActionV1({ target, condition: { kind } }, {
      execution: async (_target, options) => waitForExecutionRunTerminal({
        runId: target.runId, timeoutMs: options.timeoutMs, signal: options.signal,
        condition: options.condition.kind === 'needs_attention' ? 'needs_attention' : 'terminal_or_needs_attention',
        readRun: async () => ({ ok: true, data: { run: { ...run('running'),
          attention: { kind: 'permission_required', requestIds: ['permission-1'] } } } }),
        waitForTerminal: async () => { throw new Error('Attention must not await terminal custody'); },
      }),
    })).toMatchObject({ disposition: 'matched', snapshot: { disposition: 'needs_attention', status: 'running' } });
  });
  it.each(['terminal', 'needs_attention', 'terminal_or_needs_attention'] as const)('delegates workflow %s selection to FIN', async (kind) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const summary = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account', visibleTeamId: null,
      id: runId, origin: { kind: 'direct' }, state: 'running', attentionRequired: true,
      revision: 1, machineId: 'machine', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true,
        inspectExecution: false, disabledReasons: [] }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const conditions = kind === 'terminal' ? ['terminal'] as const : kind === 'needs_attention' ? ['attention'] as const : ['terminal', 'attention'] as const;
    const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => 'account',
      storage: { execute: async (request) => {
        expect(request).toMatchObject({ conditions: [...conditions] });
        return kind === 'terminal' ? { run: { ...summary, state: 'succeeded', attentionRequired: false }, observation: 'terminal', matchedCondition: 'terminal' }
          : { run: summary, observation: 'needs_attention', matchedCondition: 'attention' };
      } }, definitions: { get: async () => { throw new Error('wait_requires_no_definition'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: () => null, randomBytes: () => { throw new Error('read_needs_no_randomness'); } });
    const result = await executeWaitActionV1({ target: { kind: 'workflow_run', serverId: 'home', runId }, condition: { kind } }, {
      workflow: async (_target, options) => owner.execute({ actionId: 'workflow.run.wait', input: { runId,
        conditions: options.condition.kind === 'terminal' ? ['terminal'] : options.condition.kind === 'needs_attention' ? ['attention'] : ['terminal', 'attention'] }, context: {} }),
    });
    expect(result).toMatchObject({ disposition: 'matched', snapshot: { observation: kind === 'terminal' ? 'terminal' : 'needs_attention' } });
  });
  it('does not invent plugin conditions before their contribution lands', async () => {
    expect(await executeWaitActionV1({
      target: { kind: 'plugin_source', serverId: 'home', pluginId: 'happier.scm.forge.github', sourceId: 'pr' },
      condition: { kind: 'terminal' },
    }, {})).toMatchObject({ disposition: 'unsupported_condition' });
  });
  it('keeps the absolute observation deadline while plugin dispatch is pending', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = executeWaitActionV1({
      target: { kind: 'plugin_source', serverId: 'home', pluginId: 'acme.checks', sourceId: 'checkpoint' },
      condition: { kind: 'plugin', actionLocalId: 'observe/checks', condition: 'checks_passed' },
      timeout: { durationMs: 50 },
    }, { plugin: (_request, options) => new Promise((resolve) => {
      options.signal?.addEventListener('abort', () => resolve({ disposition: 'cancelled' }), { once: true });
    }) }, { signal: controller.signal });
    const finished = Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve('deadline ignored'), 51))]);
    await vi.advanceTimersByTimeAsync(51);
    const result = await finished;
    controller.abort(); // Release the boundary fixture even under the broken implementation.
    await waiting;
    expect(result).toMatchObject({ disposition: 'observation_timeout' });
  });
  it('rejects unqualified targets and exact-turn requests without a turn identity', () => {
    expect(WaitActionInputV1Schema.safeParse({ target: { kind: 'session', sessionId: 'session' }, condition: { kind: 'idle' } }).success).toBe(false);
    expect(WaitActionInputV1Schema.safeParse({ target: { kind: 'session', serverId: 'home', sessionId: 'session' }, condition: { kind: 'turn_terminal' } }).success).toBe(false);
  });
});
