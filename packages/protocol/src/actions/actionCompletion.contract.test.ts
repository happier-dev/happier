import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  freezeActionCompletionContractV1, prepareActionCompletionV1, resumeActionCompletionV1,
  projectCommandActionCompletionV1,
  type ActionCompletionDeclaration,
} from './actionCompletion.js';

// A declaring Action fixture, not a mock of the completion owner.
const declaration: ActionCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: z.object({ values: z.array(z.string()) }).strict(),
  launched: (output) => {
    const parsed = z.object({ runId: z.string() }).strict().parse(output);
    return { runs: [{ key: 'a', runId: parsed.runId }], failed: [] };
  },
  terminal: (_output, runs) => ({ values: runs.map(({ outcome }) => outcome.kind) }),
};

describe('generic Action completion seam', () => {
  it('projects a live no-effect setup review through the existing FIN consent hold without terminal failure', async () => {
    const operation = { version: 1, operationId: 'finite', revision: 1, actionId: 'projects.script.run', state: 'accepted',
      scope: { accountId: 'account', machineId: 'machine' }, title: 'Script', cancellation: 'supported', createdAt: 1,
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: '/project' } };
    const details = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup',
      reviewedEffect: { commands: [] } };
    const phase = prepareActionCompletionV1(projectCommandActionCompletionV1, { ok: true, result: { operation } }, { serverId: 'home' });
    if (phase.kind !== 'awaiting') throw new Error('Missing qualified acceptance');
    expect(await resumeActionCompletionV1({ actionId: operation.actionId,
      completion: freezeActionCompletionContractV1(projectCommandActionCompletionV1), state: phase.state,
      resolveDeclaration: () => projectCommandActionCompletionV1,
      observeOperation: async () => ({ ...operation, revision: 2, setupReview: details }),
    })).toMatchObject({ kind: 'failed', errorCode: details.code, value: { operation: {
      operationId: operation.operationId, state: 'accepted', setupReview: details,
    } } });
  });
  it('loads real finite Action declarations through the production import cycle', async () => {
    const { PROJECT_ACTION_SPECS_V1 } = await import('./projectActionFamily.js');
    const prepare = PROJECT_ACTION_SPECS_V1.find(spec => spec.id === 'projects.prepare');
    const script = PROJECT_ACTION_SPECS_V1.find(spec => spec.id === 'projects.script.run');
    const compute = PROJECT_ACTION_SPECS_V1.find(spec => spec.id === 'projects.compute.exec');
    expect(prepareActionCompletionV1(prepare?.completion, { ok: true,
      result: { kind: 'notRequired', reviewedEffectDigest: 'reviewed' } }))
      .toMatchObject({ kind: 'completed' });
    expect(script?.completion?.awaits).toBe('action_operations');
    expect(prepare?.operation?.visibility).toBe('activity');
    expect(script?.operation?.visibility).toBe('activity');
    expect(compute?.operation?.visibility).toBe('activity');
  });
  it('settles only strict explicit no-launch results before joining finite acceptance', () => {
    const immediateResultSchema = z.object({ kind: z.literal('notRequired'), reviewedEffectDigest: z.string().min(1) }).strict();
    const immediate = { ...projectCommandActionCompletionV1, immediateResultSchema };
    expect(prepareActionCompletionV1(immediate, { ok: true, result: { kind: 'notRequired', reviewedEffectDigest: 'reviewed' } }))
      .toEqual({ kind: 'completed', value: { kind: 'notRequired', reviewedEffectDigest: 'reviewed' } });
    expect(prepareActionCompletionV1(immediate, { ok: true, result: { kind: 'prepared', reviewedEffectDigest: 'reviewed' } }))
      .toMatchObject({ kind: 'outcome_uncertain' });
  });
  it('qualifies finite custody from the authenticated Home independently of output placement', () => {
    const operation = { version: 1, operationId: 'finite', revision: 1, actionId: 'projects.prepare', state: 'accepted',
      scope: { accountId: 'account', machineId: 'custodian' }, title: 'Prepare', cancellation: 'supported', createdAt: 1,
      domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'output-home', machineId: 'output-machine',
        workspaceRefId: 'workspace', cwd: '/project' } };
    expect(prepareActionCompletionV1(projectCommandActionCompletionV1, { ok: true, result: { operation } })).toMatchObject({ kind: 'outcome_uncertain' });
    expect(prepareActionCompletionV1(projectCommandActionCompletionV1, { ok: true, result: { operation } }, { serverId: 'custody-home' }))
      .toMatchObject({ kind: 'awaiting', state: { awaitedOperations: [{ key: 'command', serverId: 'custody-home',
        machineId: 'custodian', operationId: 'finite' }] } });
  });
  it.each(['account', 'attachment', 'origin'] as const)('does not settle finite completion from transplanted %s custody with the same operation id', async mismatch => {
    const operation = { version: 1, operationId: 'finite', revision: 1, actionId: 'projects.prepare', state: 'accepted',
      scope: { accountId: 'account', machineId: 'custodian' }, title: 'Prepare', cancellation: 'supported', createdAt: 1,
      domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'output-home', machineId: 'output-machine',
        workspaceRefId: 'workspace', cwd: '/project', originRun: { kind: 'workflow_run', serverId: 'home', runId: 'run' } } };
    const phase = prepareActionCompletionV1(projectCommandActionCompletionV1, { ok: true, result: { operation } }, { serverId: 'home' });
    if (phase.kind !== 'awaiting') throw new Error('Missing qualified acceptance');
    expect(await resumeActionCompletionV1({ actionId: operation.actionId,
      completion: freezeActionCompletionContractV1(projectCommandActionCompletionV1), state: phase.state,
      resolveDeclaration: () => projectCommandActionCompletionV1,
      observeRun: async () => { throw new Error('No invented Execution Run'); },
      observeOperation: async () => ({ ...operation, revision: 2, state: 'succeeded', startedAt: 1, settledAt: 2,
        ...(mismatch === 'account' ? { scope: { ...operation.scope, accountId: 'another-account' } }
          : { domainRef: { ...operation.domainRef, ...(mismatch === 'attachment' ? { workspaceRefId: 'another-workspace' }
            : { originRun: { ...operation.domainRef.originRun, runId: 'another-run' } }) } }), result: {} }),
    })).toMatchObject({ kind: 'outcome_uncertain' });
  });
  it('permits a command subdirectory and terminal appearance without changing its accepted Project association', async () => {
    const operation = { version: 1, operationId: 'finite', revision: 1, actionId: 'projects.prepare', state: 'accepted',
      scope: { accountId: 'account', machineId: 'custodian' }, title: 'Prepare', cancellation: 'supported', createdAt: 1,
      domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'output-home', machineId: 'output-machine',
        workspaceRefId: 'workspace', cwd: '/project', originRun: { kind: 'workflow_run', serverId: 'home', runId: 'run' } } };
    const phase = prepareActionCompletionV1(projectCommandActionCompletionV1, { ok: true, result: { operation } }, { serverId: 'home' });
    if (phase.kind !== 'awaiting') throw new Error('Missing qualified acceptance');
    expect(await resumeActionCompletionV1({ actionId: operation.actionId,
      completion: freezeActionCompletionContractV1(projectCommandActionCompletionV1), state: phase.state,
      resolveDeclaration: () => projectCommandActionCompletionV1,
      observeOperation: async () => ({ ...operation, revision: 2, state: 'succeeded', startedAt: 1, settledAt: 2,
        domainRef: { ...operation.domainRef, cwd: '/project/subdir', terminalId: 'terminal' }, result: {} }),
    })).toMatchObject({ kind: 'completed', value: { operation: { domainRef: { cwd: '/project/subdir', terminalId: 'terminal' } } } });
  });
  it('retains qualified finite acceptance and waits for the actual terminal outcome', async () => {
    const operation = { version: 1, operationId: 'operation-a', revision: 1, actionId: 'projects.script.run',
      state: 'accepted', scope: { accountId: 'account', machineId: 'worker' }, title: 'Run script', createdAt: 1,
      cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } };
    const finite = { awaits: 'action_operations' as const,
      terminalOutputSchema: z.object({ operation: z.unknown() }).strict(),
      launched: () => ({ operations: [{ key: 'command', serverId: 'home', machineId: 'worker', operationId: 'operation-a' }] }),
      terminal: (_output: unknown, settled: readonly { operation: unknown }[]) => ({ operation: settled[0]?.operation }),
    };
    const prepared = prepareActionCompletionV1(finite, { ok: true, result: { operation } });
    expect(prepared).toMatchObject({ kind: 'awaiting', state: { awaitedOperations: [{ serverId: 'home',
      machineId: 'worker', operationId: 'operation-a' }] } });
    if (prepared.kind !== 'awaiting') throw new Error('Missing finite acceptance correspondence');
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    const failedOperation = { ...operation, revision: 2, state: 'failed', startedAt: 2, settledAt: 3,
      error: { errorCode: 'process_exit_nonzero', error: 'Process failed' } };
    const completing = resumeActionCompletionV1({ actionId: 'projects.script.run', completion: freezeActionCompletionContractV1(finite),
      state: prepared.state, resolveDeclaration: () => finite,
      observeRun: async () => { throw new Error('Finite command must not create an Execution Run'); },
      observeOperation: async () => { await exit; return failedOperation; },
    });
    let settled = false;
    void completing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await completing).toMatchObject({ kind: 'failed', errorCode: 'process_exit_nonzero', value: { operation: failedOperation } });
    expect(await resumeActionCompletionV1({ actionId: 'projects.script.run', completion: freezeActionCompletionContractV1(finite),
      state: prepared.state, resolveDeclaration: () => finite,
      observeRun: async () => { throw new Error('No Execution Run'); },
      observeOperation: async () => operation,
    })).toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
  });
  it('separates launch persistence from observation and re-resolves only the retained Action id', async () => {
    const prepared = prepareActionCompletionV1(declaration, { ok: true, result: { runId: 'run-a' } });
    expect(prepared.kind).toBe('awaiting');
    if (prepared.kind !== 'awaiting') throw new Error('Missing launch state');
    const ids: string[] = [];
    expect(await resumeActionCompletionV1({
      actionId: 'fixture.action', completion: freezeActionCompletionContractV1(declaration),
      state: JSON.parse(JSON.stringify(prepared.state)),
      resolveDeclaration: (id) => { ids.push(id); return declaration; },
      observeRun: async ({ runId }) => { expect(runId).toBe('run-a'); return { kind: 'cancelled' }; },
    })).toEqual({ kind: 'completed', value: { values: ['cancelled'] } });
    expect(ids).toEqual(['fixture.action']);
  });

  it.each(['missing', 'unparseable', 'changed_correspondence', 'missing_launch_fact'] as const)
  ('fails %s recovery closed before observing anything', async (variant) => {
    let observations = 0;
    expect(await resumeActionCompletionV1({
      actionId: 'fixture.action', completion: freezeActionCompletionContractV1(declaration),
      state: variant === 'missing_launch_fact' ? undefined : {
        output: variant === 'unparseable' ? {} : { runId: 'run-a' },
        awaitedRuns: [{ key: 'a', runId: variant === 'changed_correspondence' ? 'other' : 'run-a' }],
      },
      resolveDeclaration: () => variant === 'missing' ? undefined : declaration,
      observeRun: async () => { observations++; return { kind: 'cancelled' }; },
    })).toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
    expect(observations).toBe(0);
  });

  it('validates against the frozen schema and keeps executable functions out of its JSON snapshot', async () => {
    const frozen = JSON.parse(JSON.stringify(freezeActionCompletionContractV1(declaration)));
    expect(Object.keys(frozen).sort()).toEqual(['awaits', 'terminalOutputSchema']);
    expect(await resumeActionCompletionV1({
      actionId: 'fixture.action', completion: frozen,
      state: { output: { runId: 'run-a' }, awaitedRuns: [{ key: 'a', runId: 'run-a' }] },
      resolveDeclaration: () => ({ ...declaration, terminal: () => ({ invalid: true }) }),
      observeRun: async () => ({ kind: 'cancelled' }),
    })).toEqual({ kind: 'failed', errorCode: 'invalid_action_output' });
    expect(prepareActionCompletionV1(undefined, { ok: true, result: 'immediate' }))
      .toEqual({ kind: 'completed', value: 'immediate' });
    expect(prepareActionCompletionV1(declaration, { ok: false, errorCode: 'denied', error: 'denied' }))
      .toEqual({ kind: 'failed', errorCode: 'denied' });
  });

  it('does not manufacture a terminal value when the observation transport cannot establish an outcome', async () => {
    expect(await resumeActionCompletionV1({
      actionId: 'fixture.action', completion: freezeActionCompletionContractV1(declaration),
      state: { output: { runId: 'run-a' }, awaitedRuns: [{ key: 'a', runId: 'run-a' }] },
      resolveDeclaration: () => declaration,
      observeRun: async () => { throw new Error('machine unavailable'); },
    })).toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
  });

  it('keeps a partially acknowledged review launch uncertain after valid known-run completion', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const review = getActionSpec('review.start').completion;
    if (!review) throw new Error('Review completion declaration missing');
    const prepared = prepareActionCompletionV1(review, { ok: true, result: {
      intent: 'review', sessionId: 'session-a', reviewedFingerprint: 'fingerprint',
      results: [
        { key: 'codex', ok: true, result: { runId: 'review-a' } },
        { key: 'claude', ok: false, errorCode: 'native_response_lost', error: 'native_response_lost' },
      ],
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Known review run did not retain observation custody');
    expect(await resumeActionCompletionV1({
      actionId: 'review.start', completion: freezeActionCompletionContractV1(review),
      state: prepared.state, resolveDeclaration: (actionId) => actionId === 'review.start'
        ? getActionSpec('review.start').completion : undefined,
      observeRun: async () => ({ kind: 'completed', result: {}, reviewedFingerprint: 'fingerprint',
        commentIds: [], materialization: { kind: 'complete' } }),
    })).toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
  });
});
