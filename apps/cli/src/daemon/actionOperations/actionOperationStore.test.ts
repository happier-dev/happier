import { describe, expect, it } from 'vitest';

import { createActionOperationStore } from './actionOperationStore';

const ACCOUNT_SCOPE = { accountId: 'account-1', machineId: 'machine-1' } as const;

describe('action operation store', () => {
  it('measures finite elapsed work from the first observed spawn across later setup and Script processes', () => {
    let now = 100;
    const store = createActionOperationStore({ now: () => now });
    store.create({ operationId: 'finite-duration', actionId: 'projects.script.run', title: 'Run tests', scope: ACCOUNT_SCOPE,
      cancellation: 'supported', inputIdentity: '{}' });
    expect(store.get(ACCOUNT_SCOPE, 'finite-duration')).not.toHaveProperty('startedAt');
    now = 120;
    store.markRunning('finite-duration');
    now = 160;
    store.markRunning('finite-duration');
    now = 200;
    store.fail('finite-duration', { errorCode: 'project_command_step_failed', error: 'Process failed' });
    expect(store.get(ACCOUNT_SCOPE, 'finite-duration')).toMatchObject({ state: 'failed', createdAt: 100, startedAt: 120, settledAt: 200 });
  });
  it.each(['managed.intent.waiting-idle', 'managed.intent.waiting-deadline'])(
    'excludes only an owner-confirmed passive managed wait (%s) and restores material custody before native submission', phase => {
    const store = createActionOperationStore();
    for (const [operationId, actionId] of [['stop', 'machines.managed.power.set'],
      ['delete', 'machines.managed.delete'], ['other', 'machines.managed.acquire']] as const) {
      store.create({ operationId, actionId, title: 'Managed work', scope: ACCOUNT_SCOPE,
        cancellation: 'unsupported', inputIdentity: '{}' });
      store.markRunning(operationId);
      store.updateProgress(operationId, { kind: 'phase', phase, label: 'Waiting for trigger' });
    }
    expect(store.readLiveWork().items).toEqual([expect.objectContaining({ ownerRef: 'other', state: 'active' })]);
    expect(store.get(ACCOUNT_SCOPE, 'stop')).toMatchObject({ state: 'running' });
    store.updateProgress('stop', { kind: 'phase', phase: 'managed.intent.native-effect', label: 'Applying stop' });
    store.updateObservation('delete', { kind: 'outcome_uncertain', code: 'native_outcome_uncertain' });
    expect(store.readLiveWork().items).toEqual([
      expect.objectContaining({ category: 'finite', ownerRef: 'stop', state: 'active' }),
      expect.objectContaining({ ownerRef: 'delete', state: 'unknown' }),
      expect.objectContaining({ ownerRef: 'other', state: 'active' }),
    ]);
  });
  it('projects accepted finite, setup and handoff custody until real settlement, with the actual terminal association', () => {
    const store = createActionOperationStore();
    const accepted = (operationId: string, actionId: string) => store.create({ operationId, actionId,
      title: 'Work', scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    accepted('finite', 'projects.script.run');
    accepted('prepare', 'projects.prepare');
    accepted('handoff', 'session.handoff');
    store.updateDomainRef('finite', { kind: 'projectCommand', purpose: 'script', serverId: 'home',
      machineId: 'machine-1', workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal' });
    expect(store.readLiveWork()).toMatchObject({ coverage: 'complete', items: [
      { category: 'finite', ownerRef: 'finite', state: 'active', associatedTerminal: 'terminal', attribution: { kind: 'unknown' } },
      { category: 'setup', ownerRef: 'prepare', state: 'active' },
      { category: 'handoff', ownerRef: 'handoff', state: 'active' },
    ] });
    store.markRunning('finite');
    store.updateObservation('finite', { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' });
    expect(store.readLiveWork().items[0]).toMatchObject({ state: 'unknown', associatedTerminal: 'terminal' });
    store.cancel('finite');
    store.succeed('prepare', {});
    store.fail('handoff', { errorCode: 'rejected', error: 'Rejected' });
    expect(store.readLiveWork().items.every(item => item.state === 'settled')).toBe(true);
  });

  it('notifies activity readers when new custody arrives and unsubscription does not discard work', () => {
    const store = createActionOperationStore();
    const observations: unknown[] = [];
    const unsubscribe = store.subscribe(() => observations.push(store.readLiveWork()));
    store.create({ operationId: 'copy', actionId: 'daemon.filesystem.upload', title: 'Copy', scope: ACCOUNT_SCOPE,
      cancellation: 'unsupported', inputIdentity: '{}' });
    expect(observations).toContainEqual(expect.objectContaining({ items: [expect.objectContaining({
      category: 'transfer', ownerRef: 'copy', state: 'active',
    })] }));
    unsubscribe();
    store.markRunning('copy');
    expect(observations).toHaveLength(1);
    expect(store.readLiveWork().items[0]).toMatchObject({ state: 'active' });
  });
  it('retains unconfirmed live evidence without allowing it to outlive observed process settlement', () => {
    const store = createActionOperationStore();
    store.create({ operationId: 'finite', actionId: 'projects.prepare', title: 'Prepare',
      scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    store.updateObservation('finite', { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' });
    expect(store.get(ACCOUNT_SCOPE, 'finite')).toMatchObject({ state: 'accepted',
      observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
    store.cancel('finite');
    expect(store.get(ACCOUNT_SCOPE, 'finite')).toMatchObject({ state: 'cancelled' });
    expect(store.get(ACCOUNT_SCOPE, 'finite')).not.toHaveProperty('observation');
  });
  it('keeps revisions monotonic, terminalizes once, and scopes get/list', () => {
    let now = 1_000;
    const store = createActionOperationStore({ now: () => now });
    const accepted = store.create({
      operationId: 'operation-1',
      actionId: 'session.fork',
      scope: { ...ACCOUNT_SCOPE, sessionId: 'session-1' },
      title: 'Fork session',
      cancellation: 'unsupported',
      inputIdentity: '{}',
    });

    expect(accepted).toMatchObject({ state: 'accepted', revision: 1, createdAt: 1_000 });
    expect(store.get(ACCOUNT_SCOPE, 'operation-1')).toEqual(accepted);
    expect(store.get({ accountId: 'account-2', machineId: 'machine-1' }, 'operation-1')).toBeNull();
    expect(store.list({ ...ACCOUNT_SCOPE, sessionId: 'session-2' }).items).toEqual([]);

    now = 1_100;
    const running = store.markRunning('operation-1');
    expect(running).toMatchObject({ state: 'running', revision: 2, startedAt: 1_100 });

    now = 1_200;
    const succeeded = store.succeed('operation-1', { childSessionId: 'session-2' });
    expect(succeeded).toMatchObject({ state: 'succeeded', revision: 3, settledAt: 1_200 });
    now = 1_300;
    expect(store.fail('operation-1', { errorCode: 'late', error: 'late' })).toEqual(succeeded);
    expect(store.markRunning('operation-1')).toEqual(succeeded);

    expect(store.list(ACCOUNT_SCOPE).items[0]).not.toHaveProperty('result');
    expect(store.get(ACCOUNT_SCOPE, 'operation-1')).toEqual(succeeded);
  });

  it('has no polling observation API', () => {
    expect(createActionOperationStore()).not.toHaveProperty('wait');
  });

  it('retains active rows and only the newest 50 settled rows within 24 hours', () => {
    let now = 100_000_000;
    const store = createActionOperationStore({ now: () => now });

    store.create({
      operationId: 'active-old',
      actionId: 'session.fork',
      scope: ACCOUNT_SCOPE,
      title: 'Active',
      cancellation: 'unsupported',
      inputIdentity: '{}',
    });

    for (let index = 0; index < 52; index += 1) {
      const operationId = `settled-${index}`;
      store.create({
        operationId,
        actionId: 'session.fork',
        scope: ACCOUNT_SCOPE,
        title: `Settled ${index}`,
        cancellation: 'unsupported',
        inputIdentity: '{}',
      });
      store.markRunning(operationId);
      now += 1;
      store.succeed(operationId, { index });
    }

    const bounded = store.list(ACCOUNT_SCOPE).items;
    expect(bounded).toHaveLength(51);
    expect(bounded[0]).toMatchObject({ operationId: 'active-old', state: 'accepted' });
    expect(bounded.some((item) => item.operationId === 'settled-0')).toBe(false);
    expect(bounded.some((item) => item.operationId === 'settled-1')).toBe(false);

    now += 24 * 60 * 60 * 1_000 + 1;
    expect(store.list(ACCOUNT_SCOPE).items).toEqual([
      expect.objectContaining({ operationId: 'active-old', state: 'accepted' }),
    ]);
  });
});
