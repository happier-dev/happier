import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { createServer } from 'node:http';

import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { createActionOperationRpcHandlers, registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import { createActionOperationStore } from './actionOperationStore';
import { createActionOperationRunner } from './actionOperationRunner';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ActionOperationListV1ResponseSchema as PredecessorListSchema,
  ActionOperationGetV1ResponseSchema as PredecessorGetSchema } from './testFixtures/predecessorActionOperationV1';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

describe('action operation observation RPC handlers', () => {
  it('filters V2 Activity by requester and half-open creation time before its cursor without expanding Account scope', async () => {
    let now = 9;
    const store = createActionOperationStore({ now: () => now });
    const scope = { accountId: 'alice', machineId: 'machine', sessionId: 'session' };
    for (const [operationId, createdAt, accountId] of [
      ['before', 9, 'alice'], ['at-from', 10, 'alice'], ['inside', 19, 'alice'], ['at-to', 20, 'alice'], ['foreign', 15, 'bob'],
    ] as const) {
      now = createdAt;
      store.create({ operationId, actionId: 'projects.script.run', title: 'Script', scope: { ...scope, accountId },
        requestId: operationId, cancellation: 'unsupported', inputIdentity: '{}' });
    }
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
    registerActionOperationRpcHandlers(rpc, createActionOperationRpcHandlers({ store,
      runner: createActionOperationRunner({ store, resolveAction: () => null }), machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId }));
    const filtered = { actorAccountId: 'alice', createdAtFromMs: 10, createdAtToMs: 20,
      states: ['accepted'], sessionId: scope.sessionId };
    expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, filtered)).toMatchObject({
      items: [{ operationId: 'inside' }, { operationId: 'at-from' }], nextCursor: null,
    });
    expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, { ...filtered, cursor: 'inside' }))
      .toMatchObject({ items: [{ operationId: 'at-from' }], nextCursor: null });
    expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, { ...filtered, cursor: 'before' }))
      .toMatchObject({ items: [{ operationId: 'inside' }, { operationId: 'at-from' }], nextCursor: null });
    expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, { actorAccountId: 'bob' }))
      .toEqual({ items: [], nextCursor: null });
    const requestIdentity = { actionId: 'projects.script.run', requestId: 'at-from' };
    expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, { requestIdentity, createdAtToMs: 10 }))
      .toEqual({ items: [], nextCursor: null });
    expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, { requestIdentity, createdAtFromMs: 10 }))
      .toMatchObject({ items: [{ operationId: 'at-from' }] });
    expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V1.list, {}))
      .toMatchObject({ items: [{ operationId: 'at-to' }, { operationId: 'inside' }, { operationId: 'at-from' }, { operationId: 'before' }] });
  });

  it('performs zero caller permission reads after cancellation admission', async () => {
    const store = createActionOperationStore();
    const scope = { accountId: 'requester', machineId: 'machine' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'admitted-cancel',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: { version: 1,
        visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } }) });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let signal: AbortSignal | undefined;
    const execution = runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      signal = context.signal;
      context.publishOwnerUpdate({ state: 'running' });
      context.signal.addEventListener('abort', finish, { once: true });
      await gate;
      return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    } });
    await new Promise<void>(resolve => setImmediate(resolve));
    // Account identity is supplied by the credential boundary; the runner and store remain real.
    let admissionComplete = false;
    let postAdmissionPermissionReads = 0;
    const handlers = createActionOperationRpcHandlers({ store, runner, machineId: 'machine',
      resolveAccountId: async () => {
        if (admissionComplete) postAdmissionPermissionReads += 1;
        admissionComplete = true;
        return 'requester';
      } });
    try {
      expect(await handlers.cancel({ operationId: 'admitted-cancel' })).toEqual({ kind: 'requested' });
      expect(signal?.aborted).toBe(true);
      await execution;
      expect(store.get(scope, 'admitted-cancel')?.state).toBe('cancelled');
      expect(postAdmissionPermissionReads).toBe(0);
    } finally {
      finish();
      await execution;
    }
  });
  it.each(['accepted', 'cleanup_refused', 'withdrawn_during_cleanup', 'settled_during_cleanup'] as const)('awaits admitted cancellation cleanup without reauthorization before aborting retained execution (%s)', async disposition => {
    const store = createActionOperationStore();
    const scope = { accountId: 'requester', machineId: 'machine' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'fresh-cancel-operation',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: { version: 1,
        visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } }) });
    let finish!: () => void;
    const executionGate = new Promise<void>(resolve => { finish = resolve; });
    let cleanupStarted!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { cleanupStarted = resolve; });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let originalSignal: AbortSignal | undefined;
    let freshCaller: unknown;
    let abortedWhenCleanupStarted: boolean | undefined;
    let exerciseCleanupRefusal = false;
    const execution = runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      originalSignal = context.signal;
      // Finite commands enter running only when their real handler reports native execution.
      context.publishOwnerUpdate({ state: 'running' });
      context.onCancellationRequested(async (...args: unknown[]) => {
        freshCaller = args[0];
        abortedWhenCleanupStarted = context.signal.aborted;
        cleanupStarted();
        await cleanupGate;
        if (exerciseCleanupRefusal) throw new RpcError('Cancellation cleanup refused', RPC_ERROR_CODES.FORBIDDEN);
      });
      context.signal.addEventListener('abort', finish, { once: true });
      await executionGate;
      return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    } });
    await new Promise<void>(resolve => setImmediate(resolve));
    const keys = tweetnacl.sign.keyPair();
    let current = true;
    // Only Home HTTP is substituted. Transport admission, runner, store and cancellation remain real.
    const network = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: current ? 200 : 403,
      data: current ? { v: 1, ok: true } : { code: 'access_denied' }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } }));
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
        resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
          privateKey: keys.secretKey, daemonToken: 'test-daemon', serverHttpBaseUrl: 'https://home.invalid' }) }) });
    registerActionOperationRpcHandlers(rpc, createActionOperationRpcHandlers({ store, runner, machineId: 'machine',
      resolveAccountId: async () => 'custodian' }));
    const machineAdmission = { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'machine',
      installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const cancel = () => rpc.handleRequest({ method: `machine:${ACTION_OPERATION_RPC_METHODS_V1.cancel}`,
      params: { operationId: 'fresh-cancel-operation' }, machineAdmission });
    try {
      current = false;
      expect(await cancel()).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(freshCaller).toBeUndefined();
      expect(originalSignal?.aborted).toBe(false);
      current = true;
      const cancellation = cancel();
      await cleanupEntered;
      expect(freshCaller).toMatchObject({ machineAdmission, signal: expect.any(AbortSignal),
        verifyMachineAdmissionCurrent: expect.any(Function) });
      expect(abortedWhenCleanupStarted).toBe(false);
      expect(originalSignal?.aborted, 'async cleanup must finish before retained execution is aborted').toBe(false);
      exerciseCleanupRefusal = disposition === 'cleanup_refused';
      if (disposition === 'withdrawn_during_cleanup') current = false;
      if (disposition === 'settled_during_cleanup') { finish(); await execution; }
      releaseCleanup();
      if (disposition === 'accepted' || disposition === 'withdrawn_during_cleanup') {
        expect(await cancellation).toEqual({ kind: 'requested' });
        expect(originalSignal?.aborted).toBe(true);
        await execution;
        expect(store.get(scope, 'fresh-cancel-operation')?.state).toBe('cancelled');
        expect(network).toHaveBeenCalledTimes(2);
      } else if (disposition === 'settled_during_cleanup') {
        expect(await cancellation).toEqual({ kind: 'already_settled' });
        expect(originalSignal?.aborted).toBe(false);
      } else {
        expect(await cancellation).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(originalSignal?.aborted).toBe(false);
        expect(store.get(scope, 'fresh-cancel-operation')?.state).toBe('running');
      }
    } finally {
      releaseCleanup();
      finish();
      await execution;
      network.mockRestore();
    }
  });
  it.each(['machines.managed.acquire', 'machines.managed.delete'] as const)('limits delegated %s discovery and reads to the exact creator resource', async actionId => {
    const store = createActionOperationStore();
    const scope = { accountId: 'requester', machineId: 'controller' };
    for (const [operationId, accountId, managedId] of [
      ['own-operation', 'requester', 'own-resource'], ['neighbor-operation', 'requester', 'neighbor-resource'],
      ['other-requester', 'other', 'own-resource'],
    ] as const) store.create({ operationId, actionId, title: 'Managed operation', scope: { ...scope, accountId },
      cancellation: 'supported', inputIdentity: '{}', domainRef: { kind: 'managedMachine', id: managedId } });
    const handlers = createActionOperationRpcHandlers({ store, runner: createActionOperationRunner({ store, resolveAction: () => null }),
      machineId: 'controller', resolveAccountId: async () => 'custodian' });
    const context = (actionId: 'action.operations.list' | 'action.operations.get', operationId?: string) => ({
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'controller',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: async () => true,
      callerInputAuthorization: { v: 1 as const, token: 'home-issued', binding: { accountId: 'requester',
        custodianAccountId: 'custodian', machineId: 'controller', installationId: 'installation',
        serverIdentityId: 'home', authentication: { kind: 'account' as const, tokenEpoch: 0 }, actionId,
        target: { kind: 'machine' as const, machineId: 'controller' }, requestId: 'read', requestEnvelopeDigest: 'a'.repeat(43),
        managedAdmission: actionId === 'action.operations.get'
          ? { actionId, input: { homeId: 'home', managedId: 'own-resource', operationId: operationId! } }
          : { actionId, input: { homeId: 'home', managedId: 'own-resource' } } } },
    });
    expect(await handlers.listV2({}, context('action.operations.list'))).toMatchObject({ items: [{ operationId: 'own-operation' }] });
    expect((await handlers.listV2({}, context('action.operations.list'))).items).toHaveLength(1);
    expect(await handlers.getV2({ operationId: 'own-operation' }, context('action.operations.get', 'own-operation')))
      .toMatchObject({ kind: 'found', operation: { operationId: 'own-operation' } });
    expect(await handlers.getV2({ operationId: 'neighbor-operation' }, context('action.operations.get', 'neighbor-operation')))
      .toEqual({ kind: 'not_found' });
    expect(await handlers.getV2({ operationId: 'other-requester' }, context('action.operations.get', 'other-requester')))
      .toEqual({ kind: 'not_found' });
    await expect(handlers.getV2({ operationId: 'neighbor-operation' }, context('action.operations.get', 'own-operation')))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
  it('claims one exact Move Start only in its live phase and refuses a requested cancellation before settlement', async () => {
    const scope = { accountId: 'requester', machineId: 'source' };
    const workspace = { serverId: 'home', refId: 'workspace' };
    const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'worker' } };
    const input = ProjectServiceRelocateInputV1Schema.parse({ workspace, sourceMachineId: scope.machineId, serviceName: 'web', requestId: 'move',
      setupReview: { reviewedEffect: { commands: ['setup'] }, reviewedEffectDigest: 'reviewed-setup' },
      currentTarget: { kind: 'managed_service', machineId: 'source', managedServiceId: 'native-old',
        workspaceId: 'workspace', cwd: '/project', declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest', name: 'web' } } },
      destination, selectedTarget: { machineId: 'worker' }, desiredPlacement: { workspace, serviceName: 'web',
        expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } } });
    const store = createActionOperationStore();
    const spec = getActionSpec('projects.service.relocate');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'move-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    let progress!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]['updateProgress'];
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    await runner.observe({ actionId: spec.id, scope, input, requestId: 'root-request', cancellation: 'supported', execute: async context => {
      progress = context.updateProgress;
      progress({ phase: 'stopping', label: 'Stopping service' });
      await completed;
      return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    } });
    const handlers = createActionOperationRpcHandlers({ store, runner, machineId: 'source', resolveAccountId: async () => 'custodian' });
    const context = { machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'source',
      installationId: 'source-installation', role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true };
    const request = { requestId: 'root-request', installationId: 'source-installation', input };
    const refused = { kind: 'refused', reasonCode: 'service_move_not_starting' };
    try {
      expect(await handlers.claimServiceMoveStart(request, context)).toEqual(refused);
      progress({ phase: 'starting', label: 'Starting service' });
      expect(await handlers.claimServiceMoveStart({ ...request, installationId: 'replaced' }, context)).toEqual(refused);
      expect(await handlers.claimServiceMoveStart({ ...request, input: { ...input, selectedTarget: { machineId: 'other' } } }, context)).toEqual(refused);
      const unreviewed = { ...input };
      delete unreviewed.setupReview;
      expect(await handlers.claimServiceMoveStart({ ...request, input: unreviewed }, context)).toEqual(refused);
      expect(await handlers.claimServiceMoveStart({ ...request, input: { ...input,
        setupReview: { ...input.setupReview!, reviewedEffectDigest: 'other-setup' } } }, context)).toEqual(refused);
      expect(await handlers.claimServiceMoveStart(request, { ...context,
        machineAdmission: { ...context.machineAdmission, actorAccountId: 'stranger' } })).toEqual(refused);
      expect(await Promise.all([handlers.claimServiceMoveStart(request, context), handlers.claimServiceMoveStart(request, context)]))
        .toEqual([{ kind: 'claimed' }, { kind: 'refused', reasonCode: 'service_move_start_already_claimed' }]);
      expect(runner.cancel(scope, 'move-operation')).toEqual({ kind: 'requested' });
      expect(store.get(scope, 'move-operation')?.state).toBe('running');
      expect(await handlers.claimServiceMoveStart(request, context)).toEqual(refused);
    } finally { finish(); await runner.waitForTerminal(scope, 'move-operation'); }
    expect(await handlers.claimServiceMoveStart(request, context)).toEqual(refused);
  });
  it('keeps a guest operation read alive past the former Home phase cutoff within its RPC lifetime', async () => {
    const store = createActionOperationStore();
    store.create({ operationId: 'guest-operation', actionId: 'projects.script.run', title: 'Run',
      scope: { accountId: 'requester', machineId: 'guest' }, cancellation: 'unsupported', inputIdentity: '{}' });
    const handlers = createActionOperationRpcHandlers({ store,
      runner: createActionOperationRunner({ store, resolveAction: () => null }),
      machineId: 'guest', resolveAccountId: async () => 'custodian' });
    let requests = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    // Real HTTP is the Home boundary. The second verification is the read's
    // disclosure check; it remains valid after the old 15s phase-local cutoff.
    const home = createServer((_request, response) => {
      const answer = () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ v: 1, ok: true })); };
      if (++requests === 2) {
        const timer = setTimeout(() => { timers.delete(timer); answer(); }, 16_000);
        timers.add(timer);
      } else answer();
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('HTTP Home did not bind');
    const keys = tweetnacl.sign.keyPair();
    const rpc = new RpcHandlerManager({ scopePrefix: 'guest', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'guest', resolveInstallationId: () => 'installation', resolveCustodianAccountId: async () => 'custodian',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
          privateKey: keys.secretKey, daemonToken: 'test-daemon', serverHttpBaseUrl: `http://127.0.0.1:${address.port}` }),
      }),
    });
    registerActionOperationRpcHandlers(rpc, handlers);
    try {
      const result = await rpc.handleRequest({ method: `guest:${ACTION_OPERATION_RPC_METHODS_V2.list}`, params: {},
        timeoutMs: 30_000, machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian',
          machineId: 'guest', installationId: 'installation', role: 'use', encryptionMode: 'plain' } });
      expect(result).toMatchObject({ items: [{ operationId: 'guest-operation', scope: { accountId: 'requester' } }] });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    }
  }, 40_000);
  it('keeps setup terminal output on the exact guest and current operation reader', async () => {
    const store = createActionOperationStore({ now: () => 10 });
    const scope = { accountId: 'account', machineId: 'guest' };
    const domainRef = { kind: 'machineSetup' as const, serverId: 'home', machineId: 'guest',
      preset: { id: 'preset', revision: 3 }, managedId: 'paid', terminalId: 'setup-output', exitCode: 0 };
    store.project({ version: 1, operationId: 'setup', revision: 1, actionId: 'machines.setup.apply',
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
      expect(await handlers.getV2({ operationId: 'held-script', refreshSetupReview: true }))
        .toMatchObject({ kind: 'found', operation: { setupReview: { reviewedEffectDigest: 'current' } } });
      trustedDigest = 'displayed';
      await handlers.getV2({ operationId: 'held-script', refreshSetupReview: true });
      expect(launches).toBe(0);
      trustedDigest = 'current';
      await handlers.getV2({ operationId: 'held-script', refreshSetupReview: true });
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
        const expected = { ...known, ...(error && rich.state === 'failed'
          ? { error: { errorCode: error.errorCode, error: error.error } } : {}) };
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
      readPolicy: async () => ({ status: 'ready', source: 'stored', metadataVersion: 1, policy: { accepting: true, runAtMost: 1 } }),
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
      scope: { accountId, machineId: 'machine' }, requestId: 'same-request', cancellation: 'unsupported', inputIdentity: '{}',
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
      const requestIdentity = { actionId: 'projects.script.run', requestId: 'same-request' };
      expect(await call(ACTION_OPERATION_RPC_METHODS_V2.list, { requestIdentity })).toMatchObject({ items: [
        { operationId: 'bob', scope: { accountId: 'bob' } },
      ] });
      expect(await call(ACTION_OPERATION_RPC_METHODS_V2.list, { requestIdentity, sessionId: 'another-session' }))
        .toEqual({ items: [], nextCursor: null });
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
      expect(await call(ACTION_OPERATION_RPC_METHODS_V2.list, { requestIdentity }))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { network.mockRestore(); }
  });
  it('joins the current managed installation question without settling or cancelling the producer', async () => {
    const store = createActionOperationStore();
    const scope = { accountId: 'requester', machineId: 'controller' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'managed-question',
      resolveAction: actionId => ({ actionId, title: 'Create sandbox', operation: { version: 1,
        visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } }) });
    let publish!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]['publishOwnerUpdate'];
    let release!: () => void;
    await runner.observe({ actionId: 'machines.managed.acquire', scope, execute: async context => {
      publish = context.publishOwnerUpdate;
      context.operationAcceptance?.accept({ managedId: 'exact-resource', operation: { operationId: 'managed-question' } });
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, result: {} };
    } });
    const handlers = createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId });
    const observer = new AbortController();
    const question = { kind: 'auth.approveRemoteProvisioning' as const, message: 'Review enrollment' };
    try {
      const waiting = handlers.getV2({ operationId: 'managed-question', waitForTerminal: true, includeManagedPrompt: true },
        { signal: observer.signal });
      publish({ domainRef: { kind: 'managedMachine', id: 'exact-resource', bootstrapTask: {
        id: 'installer-task', taskKind: 'remote.ssh.bootstrapMachine.v1', prompt: question } }, state: 'running' });
      await expect(waiting).resolves.toMatchObject({ kind: 'found', operation: { state: 'running',
        domainRef: { id: 'exact-resource', bootstrapTask: { prompt: question } } } });
      expect(store.get(scope, 'managed-question')).not.toHaveProperty('settledAt');
      await expect(handlers.getV2({ operationId: 'managed-question', includeManagedPrompt: true })).rejects.toBeDefined();
    } finally { observer.abort(); release(); await runner.waitForTerminal(scope, 'managed-question'); }
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
  it('registers observation, cancellation and the Move Start claim, with no execution ingress', () => {
    const registered = new Map<string, unknown>();
    const handlers = {
      list: vi.fn(), get: vi.fn(), cancel: vi.fn(), listV2: vi.fn(), getV2: vi.fn(), claimServiceMoveStart: vi.fn(),
    };
    registerActionOperationRpcHandlers({
      registerHandler: (method, handler) => registered.set(method, handler),
    }, handlers);
    expect([...registered.keys()]).toEqual([...Object.values(ACTION_OPERATION_RPC_METHODS_V1), ...Object.values(ACTION_OPERATION_RPC_METHODS_V2),
      RPC_METHODS.DAEMON_SERVICE_MOVE_START_CLAIM]);
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
      runner: createActionOperationRunner({ store, resolveAction: () => null }),
      machineId: 'machine-1',
      resolveAccountId: async () => 'account-1',
    });
    await expect(handlers.get({ operationId: 'operation-1' })).resolves.toMatchObject({
      kind: 'found', operation: { operationId: 'operation-1' },
    });
  });
});
