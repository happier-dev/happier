import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

const credentials = { token: 'token', encryption: null };
const params = { token: credentials.token, credentials, sessionId: 'cli-global', serverId: 'home',
  serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null } as const;
const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
const processEffect = { actionId: 'machines.processes.kill',
  input: { machineId: 'selected', targets: [{ ref: 'process-ref', expect: { level: 'proven' } }], tree: false },
  receipt: { status: 'ended', outcomes: [{ ref: 'process-ref', outcome: 'ended' }] } } as const;
const guardEffect = { actionId: 'machines.guard.idleStop.keepRunning',
  input: { machineId: 'selected', sessionId: 'session' }, receipt: { status: 'kept' } } as const;
const guardUndo = { actionId: 'machines.guard.activity.undo',
  input: { machineId: 'selected', entryId: 'entry' }, receipt: { status: 'restored', entryIds: ['entry'] } } as const;
const adminAccessObservation = { version: 1, observedAt: 20, daemonUid: 1001, daemonUsername: 'happier',
  daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid',
  tailscaledOperator: { authorization: 'denied' } } as const;
const adminAccessEffect = { actionId: 'machines.setup.adminAccess.set',
  input: { machineId: 'selected', expectedMetadataVersion: 1, expectedAdminAccess: { version: 1, mode: 'none' },
    adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field' },
  receipt: { status: 'applied', policy: { version: 1, mode: 'preauthorized' }, metadataVersion: 2,
    effect: { outcome: 'applied', observation: adminAccessObservation } } } as const;
const reads = [
  { actionId: 'machines.setup.adminAccess.inspect', input: { machineId: 'selected' },
    receipt: { observation: adminAccessObservation, checkedAt: 20,
      adminAccess: { version: 1, mode: 'none' }, metadataVersion: 1 } },
  { actionId: 'machines.processes.get', input: { machineId: 'selected', ref: 'process-ref' }, receipt: { row: null } },
  { actionId: 'machines.guard.activity.list', input: { machineId: 'selected', range: 'today' },
    receipt: { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1 } },
] as const;

describe('CLI captured Machine acknowledgement settlement', () => {
  it('allows isolation Preview to wait for person-paced elevation without a transport deadline', async () => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    const preview = { kind: 'ready', policy: { enabled: true }, metadataVersion: 5,
      plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'review' },
      status: { kind: 'applying', phase: 'runtime_replacement' } };
    // Machine RPC is the network boundary. A bounded call expires before the person answers.
    vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async request => request.timeoutMs === null
      ? preview : { error: 'Machine RPC call timeout', errorCode: 'MACHINE_RPC_TIMEOUT' });
    const executor = createActionExecutor(createCliActionDeps(params));
    expect(await executor.execute('machines.agentIsolation.preview',
      { machineId: 'selected', enabled: true, memberProvisioning: 'linuxUsersV1' }, context))
      .toEqual({ ok: true, result: preview });
  });

  it.each([
    { actionId: 'machines.vitals.get', input: { machineId: 'selected', view: 'summary' } },
    { actionId: 'machines.vitals.history.get', input: { machineId: 'selected', range: '1h' } },
  ] as const)('withholds $actionId refusal after the captured credential retires', async action => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    let current = true;
    const rpc = vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async () => {
      current = false;
      return { error: 'private Vitals refusal', errorCode: 'policy_unavailable' };
    });
    const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
    const result = await executor.execute(action.actionId, action.input, context);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
    expect(JSON.stringify(result)).not.toContain('private Vitals refusal');
  });

  it('does not disclose a serialized read refusal after the captured credential retires', async () => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    let current = true;
    vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async () => {
      current = false;
      return { error: 'private refusal', errorCode: 'policy_unavailable' };
    });
    const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
    const result = await executor.execute('machines.processes.get', { machineId: 'selected', ref: 'process-ref' }, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'scope-retired' });
    expect(result).not.toHaveProperty('error', 'private refusal');
  });
  it.each(reads)('keeps typed and legacy serialized refusals out of $actionId success parsing', async action => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    const rpc = vi.spyOn(transport, 'callExactMachineRpc');
    const executor = createActionExecutor(createCliActionDeps(params));
    for (const [reply, errorCode] of [
      [{ error: 'Policy unavailable', errorCode: 'policy_unavailable' }, 'policy_unavailable'],
      [{ error: 'Unknown error' }, 'action_failed'],
    ] as const) {
      rpc.mockResolvedValueOnce(reply);
      expect(await executor.execute(action.actionId, action.input, context))
        .toMatchObject({ ok: false, errorCode, error: reply.error });
    }
  });
  it('retains delayed policy save completion without a subordinate acknowledgement deadline', async () => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    const controller = new AbortController();
    let current = true;
    let acknowledge!: () => void;
    let admitted!: () => void;
    const dispatched = new Promise<void>(resolve => { admitted = resolve; });
    const receipt = { status: 'applied', revision: 2,
      policy: MachineResourcesPolicyV1Schema.parse({ v: 1, processes: { allProcessesVisible: true } }) };
    // The Machine RPC boundary owns its default deadline. A late acknowledged save survives only with effect-owned completion.
    vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async request => {
      admitted();
      await new Promise<void>(resolve => { acknowledge = resolve; });
      if (request.timeoutMs !== null) throw Object.assign(new Error('Machine RPC call timeout'), { code: 'MACHINE_RPC_TIMEOUT' });
      return receipt;
    });
    const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
    const result = executor.execute('machines.resources.policy.set', { machineId: 'selected', expectedRevision: 1,
      patch: { processes: { allProcessesVisible: true } } }, { ...context, signal: controller.signal });
    await dispatched;
    controller.abort();
    current = false;
    acknowledge();
    expect(await result).toEqual({ ok: true, result: receipt });
  });

  for (const retirement of ['cancellation', 'credentials'] as const) {
    it.each([processEffect, guardEffect, guardUndo, adminAccessEffect])(`retains delayed $actionId acknowledgement after ${retirement}`, async action => {
      const transport = await import('@/session/transport/rpc/machineRpc');
      const controller = new AbortController();
      let current = true;
      let acknowledge!: (receipt: unknown) => void;
      let admitted!: () => void;
      const dispatched = new Promise<void>(resolve => { admitted = resolve; });
      // Authenticated daemon transport is the boundary; model a consumed response delivered to its captured invoker.
      const rpc = vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(() => {
        admitted();
        return new Promise(resolve => { acknowledge = resolve; });
      });
      const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
      const result = executor.execute(action.actionId, action.input, { ...context, signal: controller.signal,
        presentUserConfirmation: { actionId: action.actionId } });
      expect(await Promise.race([dispatched.then(() => 'issued'), result])).toBe('issued');
      if (retirement === 'cancellation') controller.abort(); else current = false;
      acknowledge(action.receipt);
      expect(await result).toEqual({ ok: true, result: action.receipt });
      expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: null }));
    });

    it.each(reads)(`withholds delayed $actionId disclosure after ${retirement}`, async action => {
      const transport = await import('@/session/transport/rpc/machineRpc');
      const controller = new AbortController();
      let current = true;
      let acknowledge!: (receipt: unknown) => void;
      let admitted!: () => void;
      const dispatched = new Promise<void>(resolve => { admitted = resolve; });
      vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(() => {
        admitted();
        return new Promise(resolve => { acknowledge = resolve; });
      });
      const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
      const result = executor.execute(action.actionId, action.input, { ...context, signal: controller.signal });
      expect(await Promise.race([dispatched.then(() => 'issued'), result])).toBe('issued');
      if (retirement === 'cancellation') controller.abort(); else current = false;
      acknowledge(action.receipt);
      expect(await result).toMatchObject({ ok: false, errorCode: retirement === 'credentials' ? 'scope-retired' : 'action_failed' });
    });

    it(`retains target-local Activity Undo acknowledgement after ${retirement}`, async () => {
      const controller = new AbortController();
      let current = true;
      let acknowledge!: (receipt: unknown) => void;
      let admitted!: () => void;
      const dispatched = new Promise<void>(resolve => { admitted = resolve; });
      const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current,
        // The target-local daemon restoration port is the boundary, with its original receipt kept intact.
        machineGuardAction: async () => { admitted(); return new Promise(resolve => { acknowledge = resolve; }); } }));
      const result = executor.execute(guardUndo.actionId, guardUndo.input, { ...context, signal: controller.signal });
      await dispatched;
      if (retirement === 'cancellation') controller.abort(); else current = false;
      acknowledge(guardUndo.receipt);
      expect(await result).toEqual({ ok: true, result: guardUndo.receipt });
    });
  }

  it('refuses effects before dispatch when captured credentials are already retired', async () => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    const rpc = vi.spyOn(transport, 'callExactMachineRpc');
    const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => false }));
    expect(await executor.execute(guardEffect.actionId, guardEffect.input, context))
      .toMatchObject({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([adminAccessEffect, { actionId: 'machines.setup.adminAccess.inspect', input: { machineId: 'selected' },
    receipt: { observation: adminAccessObservation, checkedAt: 20,
      adminAccess: { version: 1, mode: 'none' }, metadataVersion: 1 } }] as const)(
    'dispatches administrator Action $actionId to the selected daemon without a client metadata writer', async action => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    const rpc = vi.spyOn(transport, 'callExactMachineRpc').mockResolvedValue(action.receipt);
    const executor = createActionExecutor(createCliActionDeps(params));
    expect(await executor.execute(action.actionId, action.input, {
      ...context, presentUserConfirmation: { actionId: action.actionId }, actionRequestId: 'admin-operation',
    })).toEqual({ ok: true, result: action.receipt });
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'selected',
      method: action.actionId, request: { ...action.input, serverId: 'home' }, requestId: 'admin-operation',
      ...(action.actionId === 'machines.setup.adminAccess.set' ? { timeoutMs: null } : {}) }));
  });
});
