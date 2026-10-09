import { describe, expect, it, vi } from 'vitest';

import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

const scope = { accountId: 'account-1', machineId: 'machine-1' } as const;

describe('action operation canonical execution observer', () => {
  it('returns recorded uncertainty to ordinary Wait while retirement still waits for physical settlement', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'uncertain-wait',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let publish!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]['publishOwnerUpdate'];
    let release!: () => void;
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      publish = context.publishOwnerUpdate;
      context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' }, state: 'running' });
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    } });
    let observed: Awaited<ReturnType<typeof runner.waitForTerminal>> | undefined;
    const waiting = runner.waitForTerminal(scope, 'uncertain-wait').then(value => { observed = value; return value; });
    let retired = false;
    const retirement = runner.retireProjectFiniteOperations().then(() => { retired = true; });
    try {
      publish({ observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(observed).toMatchObject({ state: 'running', observation: { kind: 'stop_unconfirmed' } });
      expect(await runner.waitForTerminal(scope, 'uncertain-wait')).toEqual(observed);
      expect(retired).toBe(false);
      expect(store.get(scope, 'uncertain-wait')).not.toHaveProperty('settledAt');
    } finally {
      release();
      await waiting;
      await retirement;
    }
    expect(store.get(scope, 'uncertain-wait')).toMatchObject({ state: 'cancelled' });
  });
  it('retains the original source Script and actual worker exit on failure without exposing native error details', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'script-failure',
      resolveAction: actionId => ({ actionId, title: 'Run tests', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const attachment = { kind: 'projectCommand', purpose: 'script', serverId: 'worker-home', machineId: 'actual-worker',
      workspaceRefId: 'copied-workspace', cwd: '/copy/packages/web' } as const;
    const observed = { ...attachment, terminalId: 'actual-terminal',
      sourceWorkspace: { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'original-workspace', rootPath: '/source' },
      script: { name: 'test', source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } }, exitCode: 17 } as const;
    let release!: () => void;
    const processExit = new Promise<void>(resolve => { release = resolve; });
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      context.publishOwnerUpdate({ domainRef: attachment });
      context.publishOwnerUpdate({ state: 'running', domainRef: observed });
      await processExit;
      return { ok: false, errorCode: 'project_command_step_failed', error: 'Process failed',
        details: { exitCode: 17, environment: { SECRET: 'private' } } };
    } });
    try {
      expect(store.get(scope, 'script-failure')).toMatchObject({ state: 'running', domainRef: observed });
    } finally { release(); }
    const settled = await runner.waitForTerminal(scope, 'script-failure');
    expect(settled).toMatchObject({ state: 'failed', domainRef: observed,
      error: { errorCode: 'project_command_step_failed', error: 'Process failed' } });
    expect(settled?.error).not.toHaveProperty('details');
    expect(settled).not.toHaveProperty('result');
  });
  it('retains a no-effect setup review on the original invocation and resumes only exact admitted replay', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'review-held',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const details = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup',
      reviewedEffect: { commands: ['reviewed command'] } } as const;
    let executions = 0;
    let resumed = false;
    let release!: () => void;
    await runner.observe({ actionId: 'projects.script.run', scope, requestId: 'original', input: { workspace: 'original' },
      cancellation: 'supported', execute: async context => {
        executions++;
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        await context.operationReview.waitForResume(details);
        resumed = true;
        await new Promise<void>(resolve => { release = resolve; });
        return { ok: true, result: {} };
      },
    });
    expect(await runner.waitForTerminal(scope, 'review-held', undefined, { includeSetupReview: true }))
      .toMatchObject({ state: 'accepted', setupReview: details });
    let settled = false;
    const terminal = runner.waitForTerminal(scope, 'review-held').then(value => { settled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(store.get(scope, 'review-held')).not.toHaveProperty('settledAt');
    const doNotExecute = async () => { throw new Error('Fresh replay is not the original continuation'); };
    expect(await runner.observe({ actionId: 'projects.script.run', scope, requestId: 'original',
      input: { workspace: 'changed' }, execute: doNotExecute })).toMatchObject({ errorCode: 'action_request_input_conflict' });
    expect(resumed).toBe(false);
    await runner.observe({ actionId: 'projects.script.run', scope, requestId: 'original',
      input: { workspace: 'original' }, execute: doNotExecute });
    expect(resumed).toBe(true);
    expect(executions).toBe(1);
    expect(store.get(scope, 'review-held')).not.toHaveProperty('setupReview');
    release();
    expect(await terminal).toMatchObject({ state: 'succeeded' });
  });

  it('cancels the original no-effect setup-review wait without waiting for a new request', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'review-cancel',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
      try {
        await context.operationReview.waitForResume({ kind: 'pendingApproval', code: 'project_setup_effect_changed',
          reviewedEffectDigest: 'setup', reviewedEffect: { commands: [] } });
      } catch { return { ok: false, errorCode: 'cancelled', error: 'cancelled' }; }
      throw new Error('Cancelled review cannot launch');
    } });
    expect(runner.cancel(scope, 'review-cancel')).toEqual({ kind: 'requested' });
    expect(await runner.waitForTerminal(scope, 'review-cancel')).toMatchObject({ state: 'cancelled' });
    expect(store.get(scope, 'review-cancel')).not.toHaveProperty('setupReview');
  });

  it('retains typed setup review failure facts across scoped get and exact request replay without leaking arbitrary details', async () => {
    const store = createActionOperationStore();
    let executions = 0;
    let operationIndex = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `consent-review-${++operationIndex}`,
      resolveAction: actionId => ({ actionId, title: 'Prepare', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const failure = { ok: false, errorCode: 'project_setup_consent_required', error: 'project_setup_consent_required',
      details: { kind: 'pendingApproval', code: 'project_setup_consent_required',
        reviewedEffect: { commands: ['install'] }, reviewedEffectDigest: 'reviewed-effect' } } as const;
    const request = { actionId: 'projects.prepare', scope, requestId: 'prepare-request', execute: async () => {
      executions++;
      return failure;
    } };
    expect(await runner.observe(request)).toEqual(failure);
    expect(store.get(scope, 'consent-review-1')).toMatchObject({ state: 'failed', error: {
      errorCode: failure.errorCode, details: failure.details,
    } });
    expect(store.get({ ...scope, accountId: 'another-requester' }, 'consent-review-1')).toBeNull();
    expect(await runner.observe(request)).toEqual(failure);
    expect(executions).toBe(1);
    const arbitrary = { ...failure, details: { ...failure.details, credential: 'private' } };
    await runner.observe({ ...request, requestId: 'unrecognized-details', execute: async () => arbitrary });
    expect(store.get(scope, 'consent-review-2')?.error).not.toHaveProperty('details');
  });
  it('retires only actual finite invocations and keeps retirement pending through unconfirmed Stop until settlement', async () => {
    const store = createActionOperationStore();
    let nextId = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `retire-${++nextId}`,
      resolveAction: actionId => ({ actionId, title: 'Work', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const releases: (() => void)[] = [];
    const stops: string[] = [];
    const launch = async (actionId: string, accountId: string) => await runner.observe({ actionId,
      scope: { ...scope, accountId }, requestId: `${accountId}-${actionId}`, cancellation: 'supported', execute: async context => {
        const operationId = context.operationAcceptance!.operationId;
        context.onCancellationRequested(() => {
          stops.push(operationId);
          context.publishOwnerUpdate({ observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
        });
        if (actionId === 'projects.compute.exec') context.publishOwnerUpdate({
          domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home', machineId: scope.machineId,
            workspaceRefId: 'workspace', cwd: '/project' }, state: 'running',
        });
        else context.operationAcceptance!.accept({ status: 'accepted' });
        // Only actual process settlement, not cancellation, resolves this boundary.
        await new Promise<void>(resolve => { releases.push(resolve); });
        return context.signal.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
          : { ok: true, result: {} };
      },
    });
    await launch('projects.compute.exec', scope.accountId);
    await launch('projects.compute.exec', 'other-requester');
    await launch('projects.service.relocate', scope.accountId);
    let retired = false;
    const retirement = runner.retireProjectFiniteOperations().then(() => { retired = true; });
    const sameRetirement = runner.retireProjectFiniteOperations();
    expect(runner.retireProjectFiniteOperations()).toBe(sameRetirement);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stops).toEqual(['retire-1', 'retire-2']);
    expect(retired).toBe(false);
    let lateExecutions = 0;
    const lateExecution = async () => { lateExecutions++; return { ok: true as const, result: {} }; };
    expect(await runner.observe({ actionId: 'projects.compute.exec', scope, requestId: 'arrived-after-retirement',
      execute: lateExecution })).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(await runner.observe({ actionId: 'projects.compute.exec', scope,
      requestId: `${scope.accountId}-projects.compute.exec`, execute: lateExecution }))
      .toMatchObject({ ok: true, result: { operation: { operationId: 'retire-1' } } });
    expect(lateExecutions).toBe(0);
    expect(store.get(scope, 'retire-1')).toMatchObject({ state: 'running', observation: { kind: 'stop_unconfirmed' } });
    expect(runner.cancel(scope, 'retire-1')).toEqual({ kind: 'requested' });
    expect(stops).toEqual(['retire-1', 'retire-2', 'retire-1']);
    releases[0]!();
    await runner.waitForTerminal(scope, 'retire-1');
    expect(retired).toBe(false);
    releases[1]!();
    await retirement;
    expect(store.get({ ...scope, accountId: 'other-requester' }, 'retire-2')?.state).toBe('cancelled');
    expect(store.get(scope, 'retire-3')?.state).toBe('running');
    releases[2]!();
    await runner.waitForTerminal(scope, 'retire-3');
    await runner.retireProjectFiniteOperations();
    expect(stops).toEqual(['retire-1', 'retire-2', 'retire-1']);
  });
  it('waits for the actual Project terminal attachment before settlement without replaying or leaking sibling scope', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'mounted-script',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let owner!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0];
    let release!: () => void;
    const attachment = { kind: 'projectCommand', purpose: 'script', serverId: 'home',
      machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } as const;
    let executions = 0;
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      executions++;
      owner = context;
      context.publishOwnerUpdate({ domainRef: attachment });
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: false, errorCode: 'nonzero', error: 'nonzero' };
    } });
    let attached = false;
    const wait = runner.waitForProjectTerminalAttachment(scope, 'mounted-script').then(value => { attached = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(attached).toBe(false);
    expect(await runner.waitForProjectTerminalAttachment({ ...scope, accountId: 'another' }, 'mounted-script')).toBeNull();
    owner.publishOwnerUpdate({ domainRef: { ...attachment, purpose: 'setup', terminalId: 'setup-terminal' }, state: 'running' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(attached).toBe(false);
    owner.publishOwnerUpdate({ domainRef: { ...attachment, terminalId: 'actual-terminal' }, state: 'running' });
    expect(await wait).toMatchObject({ domainRef: { terminalId: 'actual-terminal' } });
    expect(store.get(scope, 'mounted-script')).toMatchObject({ state: 'running' });
    expect(store.get(scope, 'mounted-script')).not.toHaveProperty('settledAt');
    expect(executions).toBe(1);
    release();
    expect(await runner.waitForTerminal(scope, 'mounted-script')).toMatchObject({ state: 'failed' });
  });

  it('ends attachment observation on owner uncertainty and observation abort without stopping accepted work', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'uncertain-attachment',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let owner!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0];
    let release!: () => void;
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      owner = context;
      context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, result: {} };
    } });
    expect(owner.operationAcceptance).toMatchObject({ operationId: 'uncertain-attachment', actionId: 'projects.script.run' });
    const observation = new AbortController();
    const aborted = runner.waitForProjectTerminalAttachment(scope, 'uncertain-attachment', observation.signal);
    observation.abort(new Error('viewer left'));
    await expect(aborted).rejects.toThrow('viewer left');
    expect(owner.signal.aborted).toBe(false);
    const uncertain = runner.waitForProjectTerminalAttachment(scope, 'uncertain-attachment');
    owner.publishOwnerUpdate({ observation: { kind: 'outcome_uncertain', code: 'launch_unknown' } });
    expect(await uncertain).toMatchObject({ state: 'accepted', observation: { code: 'launch_unknown' } });
    release();
    await runner.waitForTerminal(scope, 'uncertain-attachment');
  });
  it('delivers every supported Stop to the retained owner without delivering unsupported or settled requests', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'repeat-stop',
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let stopAttempts = 0;
    let firstAbort = 0;
    let release!: () => void;
    await runner.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'supported',
      execute: async context => {
        context.signal.addEventListener('abort', () => { firstAbort++; });
        const unsubscribe = context.onCancellationRequested(() => { stopAttempts++; });
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        await new Promise<void>(resolve => { release = resolve; });
        unsubscribe();
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    expect(runner.cancel(scope, 'repeat-stop')).toEqual({ kind: 'requested' });
    expect(runner.cancel(scope, 'repeat-stop')).toEqual({ kind: 'requested' });
    expect(stopAttempts).toBe(2);
    expect(firstAbort).toBe(1);
    expect(runner.cancel({ ...scope, accountId: 'another' }, 'repeat-stop')).toEqual({ kind: 'not_found' });
    expect(stopAttempts).toBe(2);
    release();
    await runner.waitForTerminal(scope, 'repeat-stop');
    expect(runner.cancel(scope, 'repeat-stop')).toEqual({ kind: 'already_settled' });
    expect(stopAttempts).toBe(2);
    const unsupported = createActionOperationRunner({ store, generateOperationId: () => 'unsupported-stop',
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    await unsupported.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'unsupported',
      execute: async context => {
        context.onCancellationRequested(() => { stopAttempts++; });
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        return await new Promise(resolve => { release = () => resolve({ ok: true, result: {} }); });
      },
    });
    expect(unsupported.cancel(scope, 'unsupported-stop')).toEqual({ kind: 'unsupported' });
    expect(stopAttempts).toBe(2);
    release();
    await unsupported.waitForTerminal(scope, 'unsupported-stop');
  });
  it('publishes live unconfirmed Stop evidence without settling and clears it only on observed terminal completion', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'unconfirmed',
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let report!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]['publishOwnerUpdate'];
    let release!: () => void;
    await runner.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'supported',
      execute: async ({ publishOwnerUpdate }) => {
        report = publishOwnerUpdate;
        publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' }, state: 'running' });
        await new Promise<void>(resolve => { release = resolve; });
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    const update = { observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } } as const;
    report(update);
    expect(store.get(scope, 'unconfirmed')).toMatchObject({ state: 'running', observation: update.observation });
    expect(store.get(scope, 'unconfirmed')).not.toHaveProperty('settledAt');
    release();
    await expect.poll(() => store.get(scope, 'unconfirmed')?.state).toBe('cancelled');
    expect(await runner.waitForTerminal(scope, 'unconfirmed')).toMatchObject({ state: 'cancelled' });
    expect(store.get(scope, 'unconfirmed')).not.toHaveProperty('observation');
  });
  it('does not retain stoppable execution custody after a synchronous owner throw', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'sync-throw',
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    await runner.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'supported',
      execute: ({ publishOwnerUpdate }) => {
        publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        throw new Error('Synchronous observation lost');
      },
    }).catch(() => undefined);
    expect(store.get(scope, 'sync-throw')).toMatchObject({ state: 'accepted', observation: { kind: 'outcome_uncertain' } });
    expect(runner.cancel(scope, 'sync-throw')).toEqual({ kind: 'unsupported' });
  });
  it('uses the same Stop custody on internal exact access loss without changing other requester work or history', async () => {
    const store = createActionOperationStore();
    let nextId = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `access-${++nextId}`,
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const stopped: string[] = [];
    const completions: (() => void)[] = [];
    const launch = async (targetScope: Readonly<{ accountId: string; machineId: string }>, cancellation: 'supported' | 'unsupported') => await runner.observe({
      actionId: 'projects.compute.exec', scope: targetScope, cancellation,
      execute: async ({ publishOwnerUpdate, signal, operationAcceptance }) => {
        publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home', machineId: targetScope.machineId,
          workspaceRefId: 'workspace', cwd: '/project' } });
        await new Promise<void>(resolve => { completions.push(resolve);
          signal.addEventListener('abort', () => { stopped.push(operationAcceptance!.operationId); }, { once: true }); });
        return signal.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' } : { ok: true, result: {} };
      },
    });
    await launch(scope, 'supported');
    await launch(scope, 'unsupported');
    await launch({ accountId: 'other-account', machineId: scope.machineId }, 'supported');
    await launch({ accountId: scope.accountId, machineId: 'other-machine' }, 'supported');
    store.create({ operationId: 'history', actionId: 'projects.compute.exec', title: 'Done', scope, cancellation: 'supported', inputIdentity: '{}' });
    store.succeed('history', {});
    const history = store.get(scope, 'history');
    const cancellationResults = await runner.cancelForAccessLoss(scope);
    expect(cancellationResults).toHaveLength(2);
    expect(cancellationResults).toEqual(expect.arrayContaining([
      { operationId: 'access-1', result: { kind: 'requested' } },
      { operationId: 'access-2', result: { kind: 'unsupported' } },
    ]));
    expect(stopped).toEqual(['access-1']);
    expect(store.get(scope, 'access-1')?.state).toBe('accepted');
    expect(store.get(scope, 'history')).toEqual(history);
    for (const complete of completions) complete();
    await runner.waitForTerminal(scope, 'access-1');
    expect(store.get(scope, 'access-1')?.state).toBe('cancelled');
  });
  it('rechecks bound current access loss for each original operation before initiating Stop', async () => {
    const store = createActionOperationStore();
    let nextId = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `current-${++nextId}`,
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: { version: 1,
        visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } }) });
    const stopped: string[] = [];
    const completions: (() => void)[] = [];
    for (let index = 0; index < 2; index++) await runner.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'supported',
      execute: async ({ publishOwnerUpdate, signal, operationAcceptance }) => {
        publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home', machineId: scope.machineId,
          workspaceRefId: 'workspace', cwd: '/project' } });
        await new Promise<void>(resolve => { completions.push(resolve);
          signal.addEventListener('abort', () => stopped.push(operationAcceptance!.operationId), { once: true }); });
        return { ok: true, result: {} };
      } });
    let currentChecks = 0;
    const results = await runner.cancelForAccessLoss(scope, async () => ++currentChecks === 1);
    expect(results.map(row => row.result.kind).sort()).toEqual(['admission_not_current', 'requested']);
    expect(stopped).toEqual(results.filter(row => row.result.kind === 'requested').map(row => row.operationId));
    const denied = results.find(row => row.result.kind === 'admission_not_current')!;
    expect(store.get(scope, denied.operationId)).toMatchObject({ state: 'accepted' });
    for (const complete of completions) complete();
    await Promise.all(['current-1', 'current-2'].map(id => runner.waitForTerminal(scope, id)));
  });
  it('keeps accepted finite custody uncertain when its observation throws instead of reporting process exit', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'lost-observation',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let starts = 0;
    const request = { actionId: 'projects.script.run', requestId: 'lost-request', scope,
      execute: async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
        starts++;
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        throw new Error('Completion observation lost');
      },
    };
    await runner.observe(request);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(store.get(scope, 'lost-observation')).toMatchObject({ state: 'accepted', observation: { kind: 'outcome_uncertain' } });
    expect(store.get(scope, 'lost-observation')).not.toHaveProperty('settledAt');
    await runner.observe(request);
    expect(starts).toBe(1);
  });
  it.each(['stop_unconfirmed', 'outcome_uncertain'])('keeps service relocation %s running without replay or false cancellation', async (errorCode) => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'service-move',
      resolveAction: actionId => ({ actionId, title: 'Move service', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
      } }),
    });
    let effects = 0;
    const request = { actionId: 'projects.service.relocate', requestId: 'move-request',
      input: { currentTarget: 'old-instance', destination: 'new-machine' }, scope,
      cancellation: 'supported' as const,
      execute: async () => { effects += 1; return { ok: false as const, errorCode, error: errorCode }; },
    };
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode });
    expect(store.get(scope, 'service-move')).toMatchObject({ state: 'running' });
    expect(store.get(scope, 'service-move')).not.toHaveProperty('settledAt');
    expect(runner.cancel(scope, 'service-move')).toEqual({ kind: 'unsupported' });
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(effects).toBe(1);
  });
  it('returns admitted managed identity while keeping its native execution and replay in the same operation', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({
      store, generateOperationId: () => 'managed-operation',
      resolveAction: actionId => ({ actionId, title: 'Acquire machine', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' },
      } }),
    });
    let release!: () => void;
    const nativeEffect = new Promise<void>(resolve => { release = resolve; });
    const accepted = { managedId: 'managed-machine', operation: { operationId: 'managed-operation' } };
    let starts = 0;
    const request = {
      actionId: 'machines.managed.acquire', requestId: 'managed-request', scope,
      execute: async (context: { operationAcceptance?: { operationId: string; accept(result: unknown): void } }) => {
        starts += 1;
        context.operationAcceptance?.accept(accepted);
        await nativeEffect;
        return { ok: true as const, result: accepted };
      },
    };
    let firstResponse: unknown;
    const first = runner.observe(request).then(result => { firstResponse = result; return result; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(firstResponse).toEqual({ ok: true, result: accepted });
      await expect(runner.observe(request)).resolves.toEqual(firstResponse);
      expect(starts).toBe(1);
      expect(store.get(scope, 'managed-operation')?.state).toBe('running');
    } finally {
      release();
      await first;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(store.get(scope, 'managed-operation')?.state).toBe('succeeded');
  });
  it.each(['outcome_uncertain', 'stop_unconfirmed'])('keeps finite %s evidence unsettled and never replays it', async (errorCode) => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'finite-unknown',
      resolveAction: actionId => ({ actionId, title: 'Run script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const execute = vi.fn(async () => ({ ok: false as const, errorCode, error: errorCode }));
    const request = { actionId: 'projects.compute.exec', requestId: 'unknown-request', scope, execute };
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode });
    expect(store.get(scope, 'finite-unknown')).toMatchObject({ state: 'accepted' });
    expect(store.get(scope, 'finite-unknown')).toMatchObject({ observation: { kind: errorCode, code: errorCode } });
    expect(store.get(scope, 'finite-unknown')).not.toHaveProperty('settledAt');
    await runner.observe(request);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('publishes finite acceptance and output association before observed exit, joining the same request without replay', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'finite-1',
      resolveAction: actionId => ({ actionId, title: 'Run script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
      context.operationAcceptance?.accept({ premature: true });
      context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
      await exit;
      return { ok: false as const, errorCode: 'process_exit_nonzero', error: 'Process failed' };
    });
    const request = { actionId: 'projects.script.run', requestId: 'finite-request', scope, cancellation: 'supported' as const, execute };
    let accepted: unknown;
    const accepting = runner.observe(request).then(value => { accepted = value; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(accepted).toMatchObject({ ok: true, result: { operation: { state: 'accepted',
      domainRef: { kind: 'projectCommand', cwd: '/project' } } } });
    await expect(runner.observe(request)).resolves.toEqual(accepted);
    expect(runner.cancel(scope, 'finite-1')).toEqual({ kind: 'requested' });
    expect(store.get(scope, 'finite-1')?.state).toBe('accepted');
    release();
    await accepting;
    await Promise.resolve();
    expect(store.get(scope, 'finite-1')).toMatchObject({ state: 'failed', domainRef: { kind: 'projectCommand' } });
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: true, result: { operation: { state: 'failed',
      error: { errorCode: 'process_exit_nonzero' }, domainRef: { kind: 'projectCommand' } } } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('publishes every revision while returning the canonical result unchanged exactly once', async () => {
    const published: unknown[] = [];
    const store = createActionOperationStore({ onSnapshot: (snapshot) => published.push(snapshot) });
    const execute = vi.fn(async ({ updateProgress }: { updateProgress: (value: { phase: string; label: string }) => void }) => {
      updateProgress({ phase: 'working', label: 'Working' });
      return { ok: true as const, result: { childSessionId: 'child-1' } };
    });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId,
        title: 'Fork session',
        operation: {
          version: 1,
          visibility: 'activity',
          progress: 'reported',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: () => 'operation-1',
    });

    const result = await runner.observe({
      actionId: 'session.fork',
      requestId: 'request-1',
      scope,
      execute,
    });

    expect(result).toEqual({ ok: true, result: { childSessionId: 'child-1' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(published).toMatchObject([
      { revision: 1, state: 'accepted', requestId: 'request-1' },
      { revision: 2, state: 'running' },
      { revision: 3, state: 'running', progress: { kind: 'phase', phase: 'working' } },
      { revision: 4, state: 'succeeded' },
    ]);
  });

  it('does not observe an Action without a tracked declaration', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({ actionId, title: actionId }),
    });
    const execute = vi.fn(async () => ({ ok: true as const, result: 'historical' }));
    await expect(runner.observe({ actionId: 'memory.search', scope, execute }))
      .resolves.toEqual({ ok: true, result: 'historical' });
    expect(store.list(scope).items).toEqual([]);
  });

  it('returns the terminal result for an exact replay without invoking the Action again', async () => {
    const published: Array<{ operationId: string }> = [];
    const store = createActionOperationStore({ onSnapshot: (snapshot) => published.push(snapshot) });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Spawn',
        operation: {
          version: 1, visibility: 'activity', progress: 'indeterminate',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: vi.fn(() => 'operation-1'),
    });
    const execute = vi.fn(async () => ({ ok: true as const, result: { type: 'success' } }));

    await runner.observe({ actionId: 'session.spawn_new', requestId: 'creation-1', input: { target: 'machine-1' }, scope, execute });
    await expect(runner.observe({
      actionId: 'session.spawn_new', requestId: 'creation-1', input: { target: 'machine-1' }, scope, execute,
    })).resolves.toEqual({ ok: true, result: { type: 'success' } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.list(scope).items).toHaveLength(1);
    expect(new Set(published.map((snapshot) => snapshot.operationId))).toEqual(new Set(['operation-1']));
  });

  it('joins an in-flight exact replay and rejects the same request identity with different input', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Handoff',
        operation: {
          version: 1, visibility: 'activity', progress: 'reported',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: () => 'operation-1',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { ok: true as const, result: { workspace: { kind: 'none' } } };
    });

    const first = runner.observe({
      actionId: 'session.handoff', requestId: 'request-1', input: { targetMachineId: 'machine-2' }, scope, execute,
    });
    const joined = runner.observe({
      actionId: 'session.handoff', requestId: 'request-1', input: { targetMachineId: 'machine-2' }, scope, execute,
    });
    await expect(runner.observe({
      actionId: 'session.handoff', requestId: 'request-1', input: { targetMachineId: 'machine-3' }, scope, execute,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'action_request_input_conflict',
      error: 'action_request_input_conflict',
    });

    expect(execute).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, joined])).resolves.toEqual([
      { ok: true, result: { workspace: { kind: 'none' } } },
      { ok: true, result: { workspace: { kind: 'none' } } },
    ]);
  });

  it('keeps an indeterminate handoff recoverable and re-enters the same operation identity', async () => {
    const store = createActionOperationStore();
    const generateOperationId = vi.fn(() => 'operation-1');
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Handoff',
        operation: {
          version: 1, visibility: 'activity', progress: 'reported',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId,
    });
    let retainedPublicationRequestId: string | null = null;
    let publicationEffectCount = 0;
    const execute = vi.fn(async (context: { actionRequestId?: string }) => {
      const actionRequestId = context.actionRequestId;
      if (!actionRequestId) throw new Error('missing canonical Action request identity');
      if (retainedPublicationRequestId === null) {
        retainedPublicationRequestId = actionRequestId;
        publicationEffectCount += 1;
        return { ok: false as const, errorCode: 'indeterminate', error: 'publication outcome unknown' };
      }
      expect(actionRequestId).toBe(retainedPublicationRequestId);
      return { ok: true as const, result: { workspace: { kind: 'copied', operationId: actionRequestId } } };
    });
    const request = {
      actionId: 'session.handoff',
      requestId: 'request-1',
      input: { targetMachineId: 'machine-2', workspaceAction: { kind: 'copy_once' } },
      scope,
      execute,
    } as const;

    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode: 'indeterminate' });
    expect(store.get(scope, 'operation-1')).toMatchObject({
      operationId: 'operation-1', requestId: 'request-1', state: 'running',
    });

    await expect(runner.observe(request)).resolves.toMatchObject({ ok: true });
    expect(generateOperationId).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(publicationEffectCount).toBe(1);
    expect(execute.mock.calls.map(([context]) => context.actionRequestId)).toEqual(['request-1', 'request-1']);
    expect(store.get(scope, 'operation-1')).toMatchObject({ state: 'succeeded' });
  });

  it('does not fail canonical execution when snapshot publication throws', async () => {
    const store = createActionOperationStore({ onSnapshot: () => { throw new Error('socket unavailable'); } });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Fork',
        operation: {
          version: 1, visibility: 'activity', progress: 'indeterminate',
          presentation: { onStart: 'current' },
        },
      }),
    });
    await expect(runner.observe({
      actionId: 'session.fork', scope,
      execute: async () => ({ ok: true, result: 'historical' }),
    })).resolves.toEqual({ ok: true, result: 'historical' });
  });

  it('preserves the strict handoff terminal result and keeps a later handoff failure visible', async () => {
    const store = createActionOperationStore();
    let operation = 0;
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId,
        title: 'Handoff session',
        operation: {
          version: 1,
          visibility: 'activity',
          progress: 'reported',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: () => `operation-${++operation}`,
    });
    const terminal = {
      ok: true as const,
      result: {
        handoffId: 'handoff-1',
        status: { handoffId: 'handoff-1', status: 'completed' as const, phase: 'finalizing' as const, recoveryActions: [] },
        workspace: { kind: 'relationship' as const, relationshipId: 'relationship-1', created: true },
        warning: { code: 'source_cleanup_failed', message: 'Source cleanup is still pending.' },
      },
    };

    await expect(runner.observe({
      actionId: 'session.handoff', requestId: 'handoff-request-1', scope,
      execute: async () => terminal,
    })).resolves.toEqual(terminal);
    await expect(runner.observe({
      actionId: 'session.handoff', requestId: 'handoff-request-2', scope,
      execute: async () => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }),
    })).resolves.toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });

    expect(store.get(scope, 'operation-1')).toMatchObject({
      requestId: 'handoff-request-1', state: 'succeeded', result: terminal.result,
    });
    expect(store.get(scope, 'operation-2')).toMatchObject({
      requestId: 'handoff-request-2', state: 'failed',
      error: { errorCode: 'target_unavailable', error: 'target_unavailable' },
    });
  });
});
