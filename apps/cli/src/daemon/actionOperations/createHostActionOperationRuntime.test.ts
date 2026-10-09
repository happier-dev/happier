import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess } from '@/terminal/pty/provider';
import { executeProjectFiniteProcess } from '@/workspaces/projectSetup/projectSetupExecution';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';

import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';

describe('finite host operation custody', () => {
  it('keeps ordinary pending Session creation unconfirmed and re-enters its same request with resume-only admission', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'actual-spawn-operation' });
    const nativeModes: Array<boolean | undefined> = [];
    // The native Session creation/nonce transport is the system boundary. The
    // actual Action executor, admission, operation identity and store stay real.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      sessionSpawnNew: async (input): Promise<import('@happier-dev/protocol').SessionSpawnNewResultV1> => {
      nativeModes.push(input.resumeActionRequest);
      return input.resumeActionRequest ? { type: 'success', disposition: 'rejoined', sessionId: 'actual-session',
        executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' } } : { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
    } });
    const input = { executionTarget: { serverId: 'home', machineId: 'guest' }, directory: { kind: 'managed' as const },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } };
    const invoke = () => runtime.observeExecution({ actionId: 'session.spawn_new', input, actionRequestId: 'original-creation',
      execute: context => executor.execute('session.spawn_new', input, { ...context, surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
    expect(await invoke()).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'unknown' } });
    const pendingOperation = await runtime.handlers.getV2({ operationId: 'actual-spawn-operation' });
    expect(pendingOperation, JSON.stringify(pendingOperation)).toMatchObject({ kind: 'found', operation: {
      state: 'running', requestId: 'original-creation', domainRef: { kind: 'spawnAttempt', id: 'original-creation' },
      observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' },
    } });
    expect(await invoke()).toMatchObject({ ok: true, result: { type: 'success', disposition: 'rejoined', sessionId: 'actual-session' } });
    expect(nativeModes).toEqual([undefined, true]);
    expect(await runtime.handlers.getV2({ operationId: 'actual-spawn-operation' })).toMatchObject({ kind: 'found', operation: {
      state: 'succeeded', result: { type: 'success', sessionId: 'actual-session' },
    } });
    expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'actual-spawn-operation'))
      .not.toHaveProperty('observation');
  });
  it.each(['machines.managed.acquire', 'machines.managed.bootstrap.retry'] as const)('keeps %s linked to its managed row and cancels the containing admitted lifetime', async actionId => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
      generateOperationId: () => 'managed-start' });
    let release!: () => void;
    const boundary = new Promise<void>(resolve => { release = resolve; });
    let aborted = false;
    await runtime.observeExecution({ actionId, input: { managedId: 'managed' }, actionRequestId: 'request',
      execute: async ({ signal, operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed' } });
        operationAcceptance?.accept({ managedId: 'managed', operation: { operationId: 'managed-start' } });
        operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed',
          bootstrapTask: { id: 'actual-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } } });
        // Native completion is the system boundary. The actual runner/store
        // remains alive after acceptance and owns the public Stop signal.
        signal.addEventListener('abort', () => { aborted = true; release(); }, { once: true });
        await boundary;
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    try {
      expect(await runtime.handlers.getV2({ operationId: 'managed-start' })).toMatchObject({ kind: 'found', operation: {
        domainRef: { kind: 'managedMachine', id: 'managed', bootstrapTask: { id: 'actual-task' } }, cancellation: 'supported',
      } });
      expect(await runtime.handlers.cancel({ operationId: 'managed-start' })).toEqual({ kind: 'requested' });
      expect(aborted).toBe(true);
      expect(await runtime.handlers.getV2({ operationId: 'managed-start', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled', domainRef: { kind: 'managedMachine', id: 'managed' } } });
    } finally { release(); }
  });
  it.each(['machines.managed.power.set', 'machines.managed.delete'] as const)('cancels the actual accepted %s idle observer through its containing Action signal', async actionId => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
      generateOperationId: () => 'managed-idle' });
    let release!: () => void;
    let aborted = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    await runtime.observeExecution({ actionId, input: { when: 'after-idle' }, actionRequestId: 'intent',
      execute: async ({ signal, operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ progress: { kind: 'phase', phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' } });
        operationAcceptance?.accept({ kind: 'accepted', managedId: 'managed', intentRevision: 1,
          operation: { operationId: 'managed-idle' } });
        signal.addEventListener('abort', () => { aborted = true; release(); }, { once: true });
        await waiting;
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    try {
      expect(await runtime.handlers.cancel({ operationId: 'managed-idle' })).toEqual({ kind: 'requested' });
      expect(aborted).toBe(true);
      expect(await runtime.handlers.get({ operationId: 'managed-idle', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally { release(); }
  });
  it('reports legacy requester attribution incomplete without cancelling the unknown process', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'guest',
      custodyBinding: { serverId: 'home', installationId: 'installation' } });
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    let aborted = false;
    await runtime.observeExecution({ actionId: 'projects.script.run', input: {}, execute: async ({ signal, operationOwnerUpdate }) => {
      operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await exit; return { ok: true, result: null };
    } });
    try {
      expect(await runtime.cleanupRequesterMachineOperations({ serverId: 'home', machineId: 'worker',
        requesterAccountId: 'guest', installationId: 'installation', verifyCurrentMachineAdmission: async () => true }))
        .toEqual({ kind: 'incomplete' });
      expect(aborted).toBe(false);
    } finally { release(); }
  });
  it('cancels the exact requester FIFO before waiting for physical completion and preserves other requesters', async () => {
    const runtime = createHostActionOperationRuntime({ serverId: 'home', machineId: 'worker', resolveAccountId: async () => 'custodian',
      custodyBinding: { serverId: 'home', installationId: 'installation' }, generateOperationId: (() => {
        let next = 0; return () => `operation-${++next}`;
      })() });
    const admission = (actorAccountId: string) => ({ signal: new AbortController().signal,
      machineAdmission: { actorAccountId, custodianAccountId: 'custodian', machineId: 'worker', installationId: 'installation',
        role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true });
    const finite = createProjectWorkerAdmission({ machineId: 'worker', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 },
        source: 'default', metadataVersion: 1 }) });
    let release!: () => void;
    const processExit = new Promise<void>(resolve => { release = resolve; });
    let stopped = false;
    const started: string[] = [];
    const run = (requester: string, requestId: string) => runtime.observeExecution({ actionId: 'projects.script.run',
      input: {}, actionRequestId: requestId, rpcContext: admission(requester),
      execute: context => finite.execute({ operationId: context.operationAcceptance!.operationId,
        requesterAccountId: requester, workspaceRefId: 'workspace', signal: context.signal,
        accept: handle => {
          context.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
            machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
          context.operationAcceptance!.accept(handle);
        },
        run: async reservation => {
          started.push(requestId);
          reservation.phase('running');
          context.operationOwnerUpdate.update({ state: 'running' });
          reservation.signal.addEventListener('abort', () => { stopped = true; }, { once: true });
          // Only OS completion is substituted: runner, FIFO and custody stay real.
          await processExit;
          return { kind: 'process_settled', result: reservation.signal.aborted
            ? { ok: false, errorCode: 'cancelled', error: 'cancelled' } : { ok: true, result: null } };
        },
      }) });
    await run('guest', 'resident');
    await run('guest', 'queued');
    await run('other', 'other-requester');
    await vi.waitFor(() => expect(started).toEqual(['resident']));
    expect(await finite.load()).toMatchObject({ kind: 'known', running: 1, queued: 2 });
    const subject = { serverId: 'home', machineId: 'worker', requesterAccountId: 'guest', installationId: 'installation',
      verifyCurrentMachineAdmission: async () => true };
    expect(await runtime.cleanupRequesterMachineOperations({ ...subject, serverId: 'other-home' })).toEqual({ kind: 'incomplete' });
    expect(await runtime.cleanupRequesterMachineOperations({ ...subject, installationId: 'old-installation' })).toEqual({ kind: 'incomplete' });
    expect(await runtime.cleanupRequesterMachineOperations({ ...subject, verifyCurrentMachineAdmission: async () => false })).toEqual({ kind: 'incomplete' });
    expect(stopped).toBe(false);
    let settled = false;
    const cleanup = runtime.cleanupRequesterMachineOperations({ serverId: 'home', machineId: 'worker',
      requesterAccountId: 'guest', installationId: 'installation', verifyCurrentMachineAdmission: async () => true })
      .then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(stopped).toBe(true));
    await vi.waitFor(() => expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'operation-2')?.state)
      .toBe('cancelled'));
    expect(settled).toBe(false);
    expect(started).toEqual(['resident']);
    expect(await finite.load()).toMatchObject({ kind: 'known', running: 1, queued: 1 });
    expect(runtime.store.get({ accountId: 'other', machineId: 'worker' }, 'operation-3')?.state).toBe('accepted');
    release();
    expect(await cleanup).toEqual({ kind: 'settled' });
    expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'operation-1')?.state).toBe('cancelled');
    await vi.waitFor(() => expect(runtime.store.get({ accountId: 'other', machineId: 'worker' }, 'operation-3')?.state)
      .toBe('succeeded'));
    expect(started).toEqual(['resident', 'other-requester']);
    expect(finite.dependencies()).toEqual([]);
  });
  it('attributes the canonical Action RPC observation to the verified requester, not the custodian', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'custodian',
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      generateOperationId: () => 'transported-operation' });
    const keys = tweetnacl.sign.keyPair();
    // Only the signed Home HTTP verifier is substituted; dispatch and the
    // actual CLI executor retain their ordinary unavailable-target behavior.
    const network = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: 200,
      data: { v: 1, ok: true }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } }));
    try {
      const rpc = new RpcHandlerManager({ scopePrefix: 'worker', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'worker',
          resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
          verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
            privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) }),
      });
      const spec = getActionSpec('projects.script.run');
      registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionSpecs: [spec],
        actionExecutor: createActionExecutor(createCliActionDeps({ token: '', sessionId: '' })),
        observeExecution: runtime.observeExecution });
      await rpc.handleRequest({ method: `worker:${spec.bindings!.rpcMethod}`, params: {
        workspace: { serverId: 'home', machineId: 'worker', workspaceId: 'workspace', rootPath: '/project' },
        selection: { kind: 'named', name: 'build' },
      }, machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: 'worker',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' } });
      expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'transported-operation'))
        .toMatchObject({ scope: { accountId: 'guest', machineId: 'worker' } });
      expect(runtime.store.get({ accountId: 'custodian', machineId: 'worker' }, 'transported-operation')).toBeNull();
    } finally { network.mockRestore(); }
  });
  it('owns a transported operation by its verified actor and withholds a held reply after access loss', async () => {
    expect(getActionSpec('projects.script.run').operation).toBeDefined();
    let activeAccountId = 'custodian';
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => activeAccountId,
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      generateOperationId: () => 'guest-operation' });
    const keys = tweetnacl.sign.keyPair();
    let current = true;
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    // The HTTP access verifier and process-exit notification are genuine boundaries.
    const network = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: current ? 200 : 403,
      data: current ? { v: 1, ok: true } : { code: 'access_denied' }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } }));
    try {
      const rpc = new RpcHandlerManager({ scopePrefix: 'worker', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'worker',
          resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
          verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
            privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) }),
      });
      registerActionOperationRpcHandlers(rpc, runtime.handlers);
      rpc.registerHandler('execute-project', async (input: unknown, context?: RpcHandlerContext) => runtime.observeExecution({
        actionId: 'projects.script.run', input, rpcContext: context, execute: async operation => {
          operation.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
            machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
          await exit;
          return { ok: true, result: { privateResult: 'guest-only' } };
        },
      }));
      const machineAdmission = { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: 'worker',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
      const call = (method: string, params: unknown) => rpc.handleRequest({ method: `worker:${method}`, params, machineAdmission });
      expect(await call('execute-project', { accountId: 'custodian' })).toMatchObject({ ok: true, result: {
        operation: { scope: { accountId: 'guest', machineId: 'worker' }, state: 'accepted' },
      } });
      expect(runtime.store.get({ accountId: 'custodian', machineId: 'worker' }, 'guest-operation')).toBeNull();
      expect((await runtime.activity.read()).items).toContainEqual(expect.objectContaining({ ownerRef: 'guest-operation',
        attribution: { serverId: 'home', accountId: 'guest', machineId: 'worker', installationId: 'installation' },
      }));
      const waiting = call(ACTION_OPERATION_RPC_METHODS_V1.get, { operationId: 'guest-operation', waitForTerminal: true });
      // Let the admitted long observation reach its real retained invocation before revocation.
      await vi.waitFor(() => expect(rpc.getActiveHandlerExecutions()).toContainEqual(expect.objectContaining({
        method: ACTION_OPERATION_RPC_METHODS_V1.get,
      })));
      await new Promise<void>(resolve => setImmediate(resolve));
      activeAccountId = 'different-account';
      current = false;
      release();
      expect(await waiting).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'guest-operation')).toMatchObject({ state: 'succeeded' });
      expect(runtime.store.readRequesterWorkAttribution('guest-operation')).toEqual({ serverId: 'home', accountId: 'guest',
        machineId: 'worker', installationId: 'installation' });
      expect(runtime.store.get({ accountId: 'different-account', machineId: 'worker' }, 'guest-operation')).toBeNull();
    } finally { release(); network.mockRestore(); }
  });
  it('retries the same unconfirmed live process Stop and settles only after its observed exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-repeated-stop-'));
    const exits = new Set<(exit: PtyExitEvent) => void>();
    const process: PtyProcess = { pid: 12345, ownedProcessGroupId: 12345, write() {}, resize() {}, kill() {},
      onData: () => ({ dispose() {} }),
      onExit: listener => { exits.add(listener); return { dispose: () => exits.delete(listener) }; } };
    let attempts = 0;
    const terminals = createTerminalPtySessionManager({ ptyProvider: { spawn: () => process }, env: {}, platform: 'linux',
      probeProcessGroup: () => 'absent',
      stopProcessTree: async () => { attempts++; if (attempts === 1) throw new Error('OS tree Stop unconfirmed'); },
      config: { maxSessions: 10, idleTimeoutMs: 60000, bufferMaxBytes: 100000, bufferMaxEvents: 1000,
        bufferRetentionMs: 600000, urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 } });
    try {
      const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'account',
        generateOperationId: () => 'repeat-stop' });
      await runtime.observeExecution({ actionId: 'projects.compute.exec', input: {}, execute: async operation => {
        const launch = await authorizeResolvedProjectExecLaunchForHost({ launch: { command: '/managed/process', args: [], cwd: root, env: {} },
          signal: operation.signal, assertCurrent: () => undefined,
          projectLaunch: { status: 'ready', reviewedEffectDigest: 'reviewed', environment: {
            selection: { kind: 'host' }, root, platform: 'linux', io: { resolveTool: async () => null,
              run: async () => { throw new Error('Host environment never evaluates a native tool'); } } } } });
        try { return (await executeProjectFiniteProcess({ workspace: { id: 'workspace', serverId: 'home', machineId: 'worker',
          rootPath: root, createdAtMs: 1 }, purpose: 'exec', requesterAccountId: 'account', operation, terminalSessions: terminals, launch })).result; }
        finally { launch.release(); }
      } });
      expect(await runtime.handlers.cancel({ operationId: 'repeat-stop' })).toEqual({ kind: 'requested' });
      await expect.poll(() => runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')?.observation)
        .toMatchObject({ kind: 'stop_unconfirmed' });
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).toMatchObject({ state: 'running' });
      expect(await runtime.handlers.cancel({ operationId: 'repeat-stop' })).toEqual({ kind: 'requested' });
      await expect.poll(() => attempts).toBe(2);
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).not.toHaveProperty('settledAt');
      for (const exit of exits) exit({ exitCode: 0, signal: 0 });
      expect(await runtime.handlers.get({ operationId: 'repeat-stop', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).not.toHaveProperty('observation');
    } finally { terminals.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it('keeps a managed bootstrap task discoverable after acceptance while its native task remains running', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
      generateOperationId: () => 'managed' });
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    await expect(runtime.observeExecution({ actionId: 'machines.managed.acquire', input: {}, actionRequestId: 'request',
      execute: async ({ operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'systemTask', id: 'task', taskKind: 'remote.ssh.bootstrapMachine.v1' } });
        operationAcceptance?.accept({ managedId: 'machine', operation: { operationId: 'managed' } });
        await pending;
        return { ok: true, result: { managedId: 'machine', operation: { operationId: 'managed' } } };
      },
    })).resolves.toMatchObject({ ok: true, result: { managedId: 'machine' } });
    const acceptedOperation = await runtime.handlers.getV2({ operationId: 'managed' });
    expect(acceptedOperation, JSON.stringify(acceptedOperation)).toMatchObject({ kind: 'found', operation: {
      state: 'running', scope: { accountId: 'account', machineId: 'controller' },
      domainRef: { kind: 'systemTask', id: 'task', taskKind: 'remote.ssh.bootstrapMachine.v1' },
    } });
    settle();
    expect(await runtime.handlers.get({ operationId: 'managed', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
  });
  it('routes relocation cancellation to its supported owner without settling an unknown native start', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'source', resolveAccountId: async () => 'account',
      generateOperationId: () => 'move', supportsCoreCancellation: actionId => actionId === 'projects.service.relocate' });
    const request = runtime.observeExecution({ actionId: 'projects.service.relocate', input: { requestId: 'move-1' },
      execute: async ({ signal, operationAcceptance }) => {
        operationAcceptance?.accept({ status: 'accepted', operationId: 'move' });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { ok: false, errorCode: 'outcome_uncertain', error: 'native start is unknown' };
      },
    });
    await expect(request).resolves.toMatchObject({ ok: true });
    expect(await runtime.handlers.cancel({ operationId: 'move' })).toEqual({ kind: 'requested' });
    expect(await runtime.handlers.get({ operationId: 'move', waitForTerminal: true }))
      .toMatchObject({ kind: 'found', operation: { state: 'running', cancellation: 'supported' } });
  });
  it('offers Stop for a finite producer and settles only its observed cancelled process', async () => {
    expect(getActionSpec('projects.script.run').operation).toBeDefined();
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'account',
      generateOperationId: () => 'finite' });
    let processCancelled = false;
    const reply = await runtime.observeExecution({ actionId: 'projects.script.run', input: {}, actionRequestId: 'request',
      execute: async ({ operationOwnerUpdate, signal }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => { processCancelled = true; resolve(); }, { once: true }));
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    expect(reply).toMatchObject({ ok: true, result: { operation: { state: 'accepted', cancellation: 'supported' } } });
    expect(processCancelled).toBe(false);
    expect(await runtime.handlers.cancel({ operationId: 'finite' })).toEqual({ kind: 'requested' });
    const cancelledOperation = await runtime.handlers.getV2({ operationId: 'finite', waitForTerminal: true });
    expect(cancelledOperation, JSON.stringify(cancelledOperation))
      .toMatchObject({ kind: 'found', operation: { state: 'cancelled', domainRef: { kind: 'projectCommand' } } });
  });
});
