import { describe, expect, it } from 'vitest';
import { createActionExecutor, createScmCapabilities } from '@happier-dev/protocol';

import { createCliActionDeps } from './createCliActionDeps';

describe('exact-machine SCM Action targeting', () => {
  it('admits machine saved inventory without a fabricated directory and refuses a Session-wide inventory', async () => {
    const calls: unknown[] = [];
    const inventory = { success: true, results: [], count: 0, bytes: 0,
      sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request) => { calls.push({ method, request }); return inventory; } },
    }));
    expect(await executor.execute('scm.diffSummary.result.list', {}, { surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toEqual({ ok: true, result: inventory });
    expect(calls).toEqual([{ method: 'scm.diffSummary.result.list', request: {} }]);
    expect(await executor.execute('scm.diffSummary.result.list', {}, { surface: 'rpc', authority: 'account_automation',
      defaultSessionId: 'session', externalActionTarget: { kind: 'session', sessionId: 'session' },
    })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    expect(calls).toHaveLength(1);
  });
  it('uses the admitted machine transport and exact directory without requiring a Session', async () => {
    const calls: Array<Readonly<{ method: string; request: unknown; signal?: AbortSignal }>> = [];
    const signal = new AbortController().signal;
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token',
      sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: {
        machineId: 'selected-machine',
        // The injected boundary is the authenticated exact-daemon transport.
        invoke: async (method, request, options) => {
          calls.push({ method, request, signal: options?.signal });
          return { success: false, errorCode: 'NOT_REPOSITORY', error: 'Not a repository' };
        },
      },
    }));

    await expect(executor.execute('scm.pullRequest.list', { cwd: '/chosen/worktree' }, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'selected-machine' }, signal,
    })).resolves.toEqual({ ok: true, result: { success: false, errorCode: 'NOT_REPOSITORY', error: 'Not a repository' } });
    expect(calls).toEqual([{ method: 'scm.pullRequest.list', request: { cwd: '/chosen/worktree', outcomeVersion: 1 }, signal }]);
  });

  it('does not reuse an admitted transport for a different machine or infer a directory', async () => {
    let invoked = false;
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: {
        machineId: 'admitted-machine',
        invoke: async () => { invoked = true; return { success: true }; },
      },
    }));
    await expect(executor.execute('scm.pullRequest.list', { cwd: '/chosen/worktree' }, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'different-machine' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    await expect(executor.execute('scm.pullRequest.list', {}, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'admitted-machine' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(invoked).toBe(false);
  });

  it('capability-negotiates advanced mutation options at the exact selected target before dispatch', async () => {
    const cases = [
      { id: 'scm.commit.undoLast', input: { cwd: '/repo', expectedHeadOid: 'a'.repeat(40) }, bits: { writeCommitUndoLast: true }, capability: 'writeCommitUndoLast' },
      { id: 'scm.remote.push', input: { cwd: '/repo', dirtyPolicy: 'autostash' }, bits: { writeRemotePolicies: true }, capability: 'writeRemotePolicies' },
      { id: 'scm.remote.push', input: { cwd: '/repo', remote: 'origin', branch: 'main', pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) }, bits: { writeRemoteForceWithLease: true }, capability: 'writeRemoteForceWithLease' },
      { id: 'scm.commit.create', input: { cwd: '/repo', message: 'Amend', mode: 'amend' }, bits: { writeCommitAmend: true }, capability: 'writeCommitAmend' },
      { id: 'scm.commit.create', input: { cwd: '/repo', message: 'Sign off', signOff: true }, bits: { writeCommitSignOff: true }, capability: 'writeCommitSignOff' },
    ] as const;
    for (const item of cases) {
      for (const capabilities of [undefined, createScmCapabilities(), createScmCapabilities(item.bits)]) {
        const methods: string[] = [];
        const executor = createActionExecutor(createCliActionDeps({ token: 'admitted-token', sessionId: '', mode: 'plain', ctx: null,
          machineActionDirectTargetTransport: { machineId: 'target', invoke: async (method) => {
            methods.push(method);
            return method === 'scm.backend.describe' ? { success: true, ...(capabilities ? { capabilities } : {}) } : { success: true };
          } },
        }));
        const result = await executor.execute(item.id, item.input, {
          surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'target' },
          actionsSettings: { v: 1, actions: {}, approvalWaivedSurfaces: { [item.id]: ['rpc'] } },
        });
        const supported = capabilities?.[item.capability] === true;
        expect(result).toMatchObject({ ok: true, result: supported ? { success: true } : { success: false, errorCode: 'FEATURE_UNSUPPORTED', outcome: { kind: 'failed' } } });
        expect(methods).toEqual(supported ? ['scm.backend.describe', item.id] : ['scm.backend.describe']);
      }
    }
  });
});
