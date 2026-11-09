import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RPC_METHODS, RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import { registerExecutionRunRpcHandlers } from './registerExecutionRunRpcHandlers';

describe('detached Run raw ingress Account isolation', () => {
  let directory: string;
  const disposers: Array<() => void | Promise<void>> = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-run-raw-account-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    const run: ExecutionRunState = {
      runId: 'grantee-run', callId: 'grantee-call', sidechainId: 'grantee-sidechain', sessionId: null,
      depth: 0, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
      instructions: 'Private grantee input', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'bounded', ioMode: 'request_response', status: 'cancelled', startedAtMs: 1, finishedAtMs: 2,
      requesterWorkAttributionV1: { serverId: 'home', accountId: 'grantee', machineId: 'machine', installationId: 'installation' },
    };
    await retainExecutionRunState(run);
  });
  afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
    vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
  });
  function requester(accountId: string): RpcHandlerContext {
    return { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'custodian', machineId: 'machine',
        installationId: 'installation', role: accountId === 'custodian' ? 'manage' : 'use', encryptionMode: 'plain' } };
  }

  it('refuses a foreign Use permission response before the real permission owner', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
    const registration = registerMachineRpcHandlers({ rpcHandlerManager: rpc,
      handlers: { spawnSession: async () => ({ type: 'success', sessionId: 'unused' }), stopSession: async () => true, requestShutdown() {} },
      deps: { currentMachineId: 'machine', currentServerId: 'home', workingDirectory: directory },
    });
    disposers.push(() => registration.dispose());
    const owner = requester('grantee');
    // Recover through the real Machine Action entry, not a second manager.
    expect(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: 'grantee-run' }, { rpcContext: owner }))
      .toMatchObject({ run: { runId: 'grantee-run' } });
    const complete = vi.spyOn(ExecutionRunHostBridge.prototype, 'completePermissionRequest');
    const input = { runId: 'grantee-run', requestId: 'exact-request', approved: true };
    expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND, input, { rpcContext: requester('other-use-grantee') }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    expect(complete).not.toHaveBeenCalled();
    // Retained stopped work cannot accept a tool answer, but its owner reaches
    // the real permission lifecycle. Call-through observations never replace it.
    expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND, input, { rpcContext: owner }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: 'stream', method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
      input: { runId: 'grantee-run', message: 'Foreign stream', userTranscript: { mode: 'suppress' } } },
    { kind: 'transcript', method: SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1,
      input: { runId: 'grantee-run', message: 'Foreign transcript', localId: 'foreign-local' } },
  ])('refuses the Machine custodian $kind effect on a grantee Run', async ({ kind, method, input }) => {
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    let manager: ExecutionRunHostBridge | undefined;
    const registration = registerExecutionRunRpcHandlers({ registerHandler(method, handler) {
      handlers.set(method, handler as RpcHandler<unknown, unknown>);
    } }, { sessionId: null, cwd: directory, serverId: 'home', parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
      executionRunProfileCatalog: buildExecutionRunProfileCatalog(), onManagerCreated(created) { manager = created; },
    });
    disposers.push(() => registration.dispose());
    if (!manager) throw new Error('Missing registered Run manager');
    const liveManager = manager;
    disposers.push(() => liveManager.dispose());
    const handler = handlers.get(method);
    if (!handler) throw new Error('Missing registered raw handler');
    await manager.recoverRetainedRuns();
    const before = structuredClone(manager.get('grantee-run'));
    const effect = kind === 'stream' ? vi.spyOn(manager, 'startTurnStream') : vi.spyOn(manager, 'commitUserTranscript');
    expect(await handler(input, requester('custodian'))).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    expect(effect).not.toHaveBeenCalled();
    expect(manager.get('grantee-run')).toEqual(before);
    await handler(input, requester('grantee'));
    expect(effect).toHaveBeenCalledOnce();
  });
});
