import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';

import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { createActionOperationRpcHandlers, registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import { createActionOperationStore } from './actionOperationStore';
import { createActionOperationRunner } from './actionOperationRunner';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ActionOperationListV1ResponseSchema as PredecessorListSchema,
  ActionOperationGetV1ResponseSchema as PredecessorGetSchema } from './testFixtures/predecessorActionOperationV1';

describe('action operation observation RPC handlers', () => {
  it('keeps setup terminal output on the exact guest and current operation reader', async () => {
    const store = createActionOperationStore({ now: () => 10 });
    const scope = { accountId: 'account', machineId: 'guest' };
    const domainRef = { kind: 'machineEnvironment' as const, serverId: 'home', machineId: 'guest',
      preset: { id: 'preset', revision: 3 }, managedId: 'paid', terminalId: 'setup-output', exitCode: 0 };
    store.project({ version: 1, operationId: 'setup', revision: 1, actionId: 'machines.environment.apply',
      state: 'succeeded', scope, title: 'Set up', createdAt: 1, startedAt: 2, settledAt: 3,
      cancellation: 'supported', domainRef });
    const handlers = createActionOperationRpcHandlers({ store,
      runner: createActionOperationRunner({ store, resolveAction: () => null }), machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId });
    expect(await handlers.getV2({ operationId: 'setup' })).toMatchObject({ kind: 'found', operation: { domainRef } });
    expect(PredecessorGetSchema.parse(await handlers.get({ operationId: 'setup' }))).not.toHaveProperty('operation.domainRef');
    expect(store.get(scope, 'setup')?.domainRef).toEqual(domainRef);
    const stranger = createActionOperationRpcHandlers({ store,
      runner: createActionOperationRunner({ store, resolveAction: () => null }), machineId: scope.machineId,
      resolveAccountId: async () => 'stranger' });
    expect(await stranger.getV2({ operationId: 'setup' })).toEqual({ kind: 'not_found' });
  });
  it('refreshes held setup from its producer and resumes the original operation after remembered consent', async () => {
    const store = createActionOperationStore();
    const scope = { accountId: 'account', machineId: 'machine' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'held-script',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const details = (digest: string) => ({ kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
      reviewedEffectDigest: digest, reviewedEffect: { commands: ['install'] } });
    let currentDigest = 'displayed';
    let trustedDigest: string | undefined;
    let launches = 0;
    let reads = 0;
    await runner.observe({ actionId: 'projects.script.run', scope, requestId: 'original', input: { original: true },
      cancellation: 'supported', execute: async context => {
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        try {
          await context.operationReview.waitForResume(details('displayed'), { review: async () => {
            reads++;
            return trustedDigest === currentDigest ? null : details(currentDigest);
          } });
        } catch { return { ok: false, errorCode: 'cancelled', error: 'cancelled' }; }
        launches++;
        return { ok: true, result: {} };
      },
    });
    const handlers = createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId });
    const outsider = createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
      resolveAccountId: async () => 'another-account' });
    try {
      currentDigest = 'current';
      expect(await outsider.getV2({ operationId: 'held-script' })).toEqual({ kind: 'not_found' });
      expect(reads).toBe(0);
      expect(await handlers.getV2({ operationId: 'held-script' }))
        .toMatchObject({ kind: 'found', operation: { setupReview: { reviewedEffectDigest: 'current' } } });
      trustedDigest = 'displayed';
      await handlers.getV2({ operationId: 'held-script' });
      expect(launches).toBe(0);
      trustedDigest = 'current';
      await handlers.getV2({ operationId: 'held-script' });
      await expect.poll(() => launches).toBe(1);
      expect(await runner.waitForTerminal(scope, 'held-script')).toMatchObject({ state: 'succeeded', requestId: 'original' });
      await handlers.getV2({ operationId: 'held-script' });
      expect(launches).toBe(1);
    } finally {
      runner.cancel(scope, 'held-script');
      await runner.waitForTerminal(scope, 'held-script');
    }
  });
  it('keeps predecessor list/get readers usable while the same owner exposes real managed references through v2', async () => {
    // These provenance-pinned wire times must stay inside the real store's
    // settled-retention window; the clock is the only substituted boundary.
    const store = createActionOperationStore({ now: () => 10 });
    const scope = { accountId: 'account', machineId: 'controller' };
    const ordinary = { version: 1 as const, operationId: 'ordinary', revision: 1, actionId: 'session.fork',
      state: 'succeeded' as const, scope, title: 'Fork', createdAt: 1, startedAt: 2, settledAt: 3,
      cancellation: 'unsupported' as const, domainRef: { kind: 'forkRequest' as const, id: 'fork', strategy: 'native' as const },
      result: { sessionId: 'ordinary-session' } };
    const managed = { ...ordinary, operationId: 'managed-op', actionId: 'machines.managed.acquire', state: 'running' as const,
      requestId: 'original-creation', cancellation: 'supported' as const,
      domainRef: { kind: 'managedMachine' as const, id: 'managed-row', bootstrapTask: {
        id: 'actual-bootstrap', taskKind: 'remote.ssh.bootstrapMachine.v1' as const } },
      progress: { kind: 'phase' as const, phase: 'enrolling', label: 'Enroll guest' } };
    const { settledAt: _settledAt, result: _result, ...activeManaged } = managed;
    store.project(ordinary);
    store.project(activeManaged);
    store.project({ ...activeManaged, operationId: 'bootstrap-op', actionId: 'machines.add.ssh.start',
      domainRef: { kind: 'systemTask', id: 'ordinary-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } });
    const handlers = createActionOperationRpcHandlers({ store,
      runner: createActionOperationRunner({ store, resolveAction: () => null }), machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId });
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
    registerActionOperationRpcHandlers(rpc, handlers);
    const legacy = await rpc.invokeLocal('actionOperation.list.v1', {});
    expect(PredecessorListSchema.safeParse(legacy).success).toBe(true);
    // The incumbent list owner omits settled result bodies; get retains them.
    const { result: _ordinaryResult, ...ordinarySummary } = ordinary;
    expect(legacy).toMatchObject({ items: expect.arrayContaining([ordinarySummary,
      expect.objectContaining({ operationId: 'managed-op', actionId: 'machines.managed.acquire', requestId: 'original-creation',
        progress: activeManaged.progress, cancellation: 'supported' })]) });
    expect(await rpc.invokeLocal('actionOperation.get.v1', { operationId: 'ordinary' }))
      .toMatchObject({ kind: 'found', operation: ordinary });
    const legacyGet = await rpc.invokeLocal('actionOperation.get.v1', { operationId: 'managed-op' });
    expect(PredecessorGetSchema.safeParse(legacyGet).success).toBe(true);
    expect(legacyGet).not.toHaveProperty('operation.domainRef');
    const current = await rpc.invokeLocal('actionOperation.list.v2', {});
    expect(current).toMatchObject({ items: expect.arrayContaining([activeManaged]) });
    expect(await rpc.invokeLocal('actionOperation.get.v2', { operationId: 'managed-op' }))
      .toMatchObject({ kind: 'found', operation: { domainRef: activeManaged.domainRef } });
    // The compatibility seam projects only its response, not retained custody.
    expect(store.get(scope, 'managed-op')?.domainRef).toEqual(activeManaged.domainRef);
  });

  it('projects real Project review, failure and uncertain service observations for the closed predecessor reader without changing v2 custody', async () => {
    const published: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1[] = [];
    const store = createActionOperationStore({ now: () => 10, onSnapshot: snapshot => { published.push(snapshot); } });
    const scope = { accountId: 'account', machineId: 'controller' };
    let nextId = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `project-${++nextId}`,
      resolveAction: actionId => ({ actionId, title: 'Project work', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const details = { kind: 'pendingApproval', code: 'project_setup_consent_required',
      reviewedEffectDigest: 'reviewed-effect', reviewedEffect: { commands: ['install'] } } as const;
    await runner.observe({ actionId: 'projects.script.run', scope, requestId: 'original-review',
      cancellation: 'supported', execute: async context => {
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        try { await context.operationReview.waitForResume(details); }
        catch { return { ok: false, errorCode: 'cancelled', error: 'cancelled' }; }
        return { ok: true, result: {} };
      },
    });
    try {
      // The actual runner publishes and retains the review; no synthetic store
      // projection or internal-domain mock creates the richer observations.
      await runner.waitForTerminal(scope, 'project-1', undefined, { includeSetupReview: true });
      await runner.observe({ actionId: 'projects.prepare', scope, execute: async () => ({
        ok: false, errorCode: details.code, error: 'Setup needs review', details,
      }) });
      await runner.observe({ actionId: 'projects.service.relocate', scope, execute: async context => {
        context.publishOwnerUpdate({ state: 'running', domainRef: { kind: 'projectService', purpose: 'relocation',
          workspace: { serverId: 'home', machineId: scope.machineId, workspaceId: 'workspace', rootPath: '/project' },
          declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest', name: 'web' } },
        } });
        return { ok: false, errorCode: 'outcome_uncertain', error: 'Native outcome is not confirmed' };
      } });
      const held = store.get(scope, 'project-1')!;
      const failed = store.get(scope, 'project-2')!;
      const uncertain = store.get(scope, 'project-3')!;
      expect(held).toMatchObject({ state: 'accepted', setupReview: details, domainRef: { kind: 'projectCommand' } });
      expect(failed).toMatchObject({ state: 'failed', error: { details } });
      expect(uncertain).toMatchObject({ state: 'running', domainRef: { kind: 'projectService' },
        observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } });
      const beforeReads = [...published];
      const handlers = createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
        resolveAccountId: async () => scope.accountId });
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
      registerActionOperationRpcHandlers(rpc, handlers);
      const legacyList = PredecessorListSchema.parse(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V1.list, {}));
      expect(legacyList.items).toHaveLength(3);
      for (const rich of [held, failed, uncertain]) {
        const legacy = PredecessorGetSchema.parse(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V1.get,
          { operationId: rich.operationId }));
        const { domainRef: _domain, setupReview: _review, observation: _observation, error, ...known } = rich;
        const expected = { ...known, ...(error ? { error: { errorCode: error.errorCode, error: error.error } } : {}) };
        expect(legacy).toEqual({ kind: 'found', operation: expected });
        expect(legacyList.items.find(item => item.operationId === rich.operationId)).toEqual(expected);
        expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: rich.operationId }))
          .toEqual({ kind: 'found', operation: rich });
        expect(store.get(scope, rich.operationId)).toBe(rich);
      }
      expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, {}))
        .toEqual({ items: [held, uncertain, failed], nextCursor: null });
      // Reads must not create a revision/ephemeral transition or retire richer
      // owner facts: publication still comes solely from the actual store.
      expect(published).toEqual(beforeReads);
    } finally {
      runner.cancel(scope, 'project-1');
      await runner.waitForTerminal(scope, 'project-1');
    }
  });

  it('reevaluates accepted finite custody only on inspection of the authorized operation', async () => {
    let availableBytes = 0;
    let started = false;
    let release!: () => void;
    const settled = new Promise<void>(resolve => { release = resolve; });
    let accept!: () => void;
    const accepted = new Promise<void>(resolve => { accept = resolve; });
    const admission = createProjectWorkerAdmission({ machineId: 'machine-1',
      admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', source: 'stored', policy: { accepting: true, runAtMost: 1 } }),
      // OS memory is the system boundary; queue and operation observation remain real.
      readMemory: () => ({ totalBytes: 100, availableBytes }),
    });
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const store = createActionOperationStore();
    store.create({ operationId: 'operation-1', actionId: 'projects.script.run', title: 'Script',
      scope, cancellation: 'supported', inputIdentity: '{}',
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: scope.machineId,
        workspaceRefId: 'workspace', cwd: '/project' },
    });
    const pending = admission.execute({ operationId: 'operation-1', workspaceRefId: 'workspace',
      memoryDemand: { bytes: 100, basis: { kind: 'declared' } }, signal: new AbortController().signal,
      accept, run: async () => { started = true; await settled; return { kind: 'process_settled', result: { ok: true, result: {} } }; },
    });
    await accepted;
    await admission.load();
    availableBytes = 100;
    const handlers = createActionOperationRpcHandlers({ store,
      runner: createActionOperationRunner({ store, resolveAction: () => null }),
      machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      onInspection: () => admission.notifyChanged(),
    });
    try {
      await expect(handlers.get({ operationId: 'not-authorized' })).resolves.toEqual({ kind: 'not_found' });
      expect(started).toBe(false);
      await expect(handlers.get({ operationId: 'operation-1' })).resolves.toMatchObject({ kind: 'found' });
      await vi.waitFor(() => expect(started).toBe(true));
    } finally { release(); }
    await expect(pending).resolves.toMatchObject({ ok: true });
  });
  it('keeps operation reads and Stop private to the verified guest actor, not the Machine custodian', async () => {
    const store = createActionOperationStore();
    for (const accountId of ['alice', 'bob', 'carol']) store.create({
      operationId: accountId, actionId: 'projects.script.run', title: accountId,
      scope: { accountId, machineId: 'machine' }, cancellation: 'unsupported', inputIdentity: '{}',
    });
    const runner = createActionOperationRunner({ store, resolveAction: () => null });
    const handlers = createActionOperationRpcHandlers({ store, runner, machineId: 'machine', resolveAccountId: async () => 'alice' });
    const keys = tweetnacl.sign.keyPair();
    let current = true;
    // Only the Home HTTP boundary is replaced; installation signing, Machine admission,
    // transported handler context, operation scope and store filtering are real.
    const network = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: current ? 200 : 403,
      data: current ? { v: 1, ok: true } : { code: 'access_denied' }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } }));
    try {
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
          resolveCustodianAccountId: async () => 'alice', resolveInstallationId: () => 'installation',
          verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
            privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) }),
      });
      registerActionOperationRpcHandlers(rpc, handlers);
      const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
      const call = (method: string, params: unknown) => rpc.handleRequest({ method: `machine:${method}`, params, machineAdmission });
      for (const methods of [ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2]) {
        expect(await call(methods.get, { operationId: 'bob' })).toMatchObject({ kind: 'found', operation: { scope: { accountId: 'bob' } } });
        for (const operationId of ['alice', 'carol']) {
          expect(await call(methods.get, { operationId, waitForTerminal: true })).toEqual({ kind: 'not_found' });
        }
        expect(await call(methods.list, {})).toMatchObject({ items: [
          { operationId: 'bob', scope: { accountId: 'bob' } },
        ] });
      }
      expect(await call(ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId: 'alice' })).toEqual({ kind: 'not_found' });
      let aborted = false;
      const running = createActionOperationRunner({ store, generateOperationId: () => 'bob-running',
        resolveAction: actionId => ({ actionId, title: 'Script', operation: { version: 1,
          visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } }),
      });
      await running.observe({ actionId: 'projects.script.run', scope: { accountId: 'bob', machineId: 'machine' },
        cancellation: 'supported', execute: async context => {
          context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
            machineId: 'machine', workspaceRefId: 'workspace', cwd: '/project' } });
          await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
          return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        } });
      registerActionOperationRpcHandlers(rpc, createActionOperationRpcHandlers({ store, runner: running,
        machineId: 'machine', resolveAccountId: async () => 'alice' }));
      for (const operationId of ['alice', 'carol', 'guessed']) {
        expect(await call(ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId })).toEqual({ kind: 'not_found' });
      }
      expect(await call(ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId: 'bob-running' })).toMatchObject({ kind: 'requested' });
      expect(aborted).toBe(true);
      await running.waitForTerminal({ accountId: 'bob', machineId: 'machine' }, 'bob-running');
      current = false;
      expect(await call(ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId: 'bob-running' })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(await call(ACTION_OPERATION_RPC_METHODS_V1.get, { operationId: 'bob' })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { network.mockRestore(); }
  });
  it('joins terminal observation at get without replay or cancellation when the observer leaves', async () => {
    const store = createActionOperationStore();
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'operation-1',
      resolveAction: actionId => ({ actionId, title: 'Run script', operation: { version: 1,
        visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } }),
    });
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    const invocation = runner.observe({ actionId: 'projects.script.run', scope,
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: scope.machineId,
        workspaceRefId: 'workspace', cwd: '/project' },
      execute: async () => { await exit; return { ok: false, errorCode: 'process_exit_nonzero', error: 'Process failed' }; },
    });
    const handlers = createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId });
    const observer = new AbortController();
    const waiting = handlers.get({ operationId: 'operation-1', waitForTerminal: true }, { signal: observer.signal });
    observer.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(store.get(scope, 'operation-1')?.state).toBe('accepted');
    const joined = handlers.get({ operationId: 'operation-1', waitForTerminal: true });
    release();
    await invocation;
    await expect(joined).resolves.toMatchObject({ kind: 'found', operation: { state: 'failed',
      error: { errorCode: 'process_exit_nonzero' } } });
  });
  it('registers observation and cancellation only, with no execution ingress', () => {
    const registered = new Map<string, unknown>();
    const handlers = {
      list: vi.fn(), get: vi.fn(), cancel: vi.fn(), listV2: vi.fn(), getV2: vi.fn(),
    };
    registerActionOperationRpcHandlers({
      registerHandler: (method, handler) => registered.set(method, handler),
    }, handlers);
    expect([...registered.keys()]).toEqual([...Object.values(ACTION_OPERATION_RPC_METHODS_V1), ...Object.values(ACTION_OPERATION_RPC_METHODS_V2)]);
    expect(registered.has('actionOperation.start.v1')).toBe(false);
    expect(registered.has('actionOperation.wait.v1')).toBe(false);
  });

  it('stamps query scope at the daemon', async () => {
    const store = createActionOperationStore();
    store.create({
      operationId: 'operation-1', actionId: 'session.fork', title: 'Fork',
      scope: { accountId: 'account-1', machineId: 'machine-1' }, cancellation: 'unsupported', inputIdentity: '{}',
    });
    const handlers = createActionOperationRpcHandlers({
      store,
      runner: { cancel: () => ({ kind: 'unsupported' }) },
      machineId: 'machine-1',
      resolveAccountId: async () => 'account-1',
    });
    await expect(handlers.get({ operationId: 'operation-1' })).resolves.toMatchObject({
      kind: 'found', operation: { operationId: 'operation-1' },
    });
  });
});
