import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTrackedSessionHandoffCoordinator } from './createTrackedSessionHandoffCoordinator';

describe('createTrackedSessionHandoffCoordinator', () => {
  it('routes the accepted handoff through the existing source and target daemon primitives', async () => {
    const calls: Array<{ machineId: string; method: string; request: unknown }> = [];
    let resultGets = 0;
    const callMachine = vi.fn(async (input: { machineId: string; method: string; request: unknown }) => {
      calls.push(input);
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET) {
        return { ok: false, errorCode: 'not_found', error: 'pending' };
      }
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET) {
        resultGets += 1;
        if (resultGets === 1) return { ok: false, errorCode: 'not_found', error: 'pending' };
        return {
          handoffId: 'handoff-1',
          status: {
            handoffId: 'handoff-1', sessionId: 'session-1', sourceMachineId: 'source-1',
            targetMachineId: 'target-1', status: 'ready_for_cutover', phase: 'staging_target',
            transportStrategy: 'server_routed_stream', recoveryActions: [],
          },
          remoteSessionId: 'remote-1',
          directSource: { kind: 'claudeConfig', configDir: null, projectId: null },
          resume: {
            directory: '/target/workspace', agent: 'claude', resume: 'remote-1',
            transcriptStorage: 'persisted', approvedNewDirectoryCreation: true,
          },
        };
      }
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET) {
        return {
          handoffId: 'handoff-1',
          transitionRevision: 3,
          status: {
            handoffId: 'handoff-1', status: 'in_progress', phase: 'staging_target',
            transportStrategy: 'server_routed_stream', recoveryActions: [],
          },
        };
      }
      if (input.method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        return { type: 'success', spawnNonce: 'handoff:handoff-1', sessionIdStatus: 'pending' };
      }
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT) {
        return {
          handoffId: 'handoff-1',
          status: {
            handoffId: 'handoff-1', sessionId: 'session-1', sourceMachineId: 'source-1',
            targetMachineId: 'target-1', status: 'completed', phase: 'finalizing',
            transportStrategy: 'server_routed_stream', recoveryActions: [],
          },
        };
      }
      return { ok: true };
    });
    const coordinate = createTrackedSessionHandoffCoordinator({
      readCredentials: async () => ({ token: 'token' } as never),
      resolveSource: async () => ({ ok: true, sourceMachineId: 'source-1', sessionStorageMode: 'persisted' }),
      callMachine,
      awaitTargetCustody: async () => ({ type: 'success', sessionId: 'session-1' }),
      wait: async () => undefined,
    });

    const result = await coordinate({
      actionInput: { sessionId: 'session-1', targetMachineId: 'target-1' },
      start: async () => ({
        ok: true,
        result: {
          handoffId: 'handoff-1', targetPath: '/source/workspace', endpointCandidates: [],
          status: {
            handoffId: 'handoff-1', sessionId: 'session-1', sourceMachineId: 'source-1',
            targetMachineId: 'target-1', status: 'in_progress', phase: 'preparing',
            transportStrategy: 'server_routed_stream', recoveryActions: [],
          },
        },
      }),
      signal: new AbortController().signal,
      publishOwnerUpdate: vi.fn(),
    });

    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(calls.map(({ machineId, method }) => [machineId, method])).toEqual([
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET],
      ['target-1', RPC_METHODS.SPAWN_HAPPY_SESSION],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT],
      ['source-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT],
    ]);
    expect((calls[4]!.request as { sessionId?: string }).sessionId).toBe('session-1');
  });
});
