import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('rpcHandlers (session handoff async prepare)', () => {
  it('returns a prepare ack with a durable job id and exposes the final result through result-get', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-job-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const workspaceDeferred = createDeferred<Readonly<{ targetPath: string }>>();
      const importSessionBundle = vi.fn(async () => ({
        remoteSessionId: 'claude_session_target',
        directSource: {
          kind: 'claudeConfig' as const,
          configDir: null,
          projectId: null,
        },
        resume: {
          directory: '/repo-copy',
          agent: 'claude' as const,
          resume: 'claude_session_target',
          transcriptStorage: 'persisted' as const,
          approvedNewDirectoryCreation: true as const,
        },
      }));

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          providerBundle: {
            providerId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importWorkspaceBundle: vi.fn(async () => await workspaceDeferred.promise),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);

      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_async_prepare',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
      });

      const handoffId = started.handoffId;
      const prepareAck = await prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
      });

      expect(prepareAck).toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: expect.any(String),
        },
      });
      expect(prepareAck.remoteSessionId).toBeUndefined();
      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: prepareAck.status.jobId,
        },
      });
      await expect(resultGet!({ handoffId })).resolves.toEqual({
        ok: false,
        errorCode: 'not_found',
      });

      workspaceDeferred.resolve({ targetPath: '/repo-copy' });

      await vi.waitFor(async () => {
        await expect(resultGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: {
            handoffId,
            status: 'ready_for_cutover',
            phase: 'staging_target',
            jobId: prepareAck.status.jobId,
            transportStrategy: 'server_routed_stream',
          },
          remoteSessionId: 'claude_session_target',
          resume: {
            directory: '/repo-copy',
            agent: 'claude',
            resume: 'claude_session_target',
          },
        });
      });
      expect(importSessionBundle).toHaveBeenCalledTimes(1);
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('aborts a pending prepare job before session import when workspace import observes cancellation', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-abort-'));
    const targetRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-abort-target-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueWorkspaceImport = createDeferred<void>();
      const importSessionBundle = vi.fn(async () => ({
        remoteSessionId: 'claude_session_target',
        directSource: {
          kind: 'claudeConfig' as const,
          configDir: null,
          projectId: null,
        },
        resume: {
          directory: '/repo-copy',
          agent: 'claude' as const,
          resume: 'claude_session_target',
          transcriptStorage: 'persisted' as const,
          approvedNewDirectoryCreation: true as const,
        },
      }));
      const importWorkspaceBundle = vi.fn(async (params: Readonly<{
        targetPath: string;
        assertCanContinue?: () => Promise<void>;
      }>) => {
        await continueWorkspaceImport.promise;
        await params.assertCanContinue?.();
        await writeFile(join(params.targetPath, 'new.txt'), 'new\n', 'utf8');
        return { targetPath: params.targetPath };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          providerBundle: {
            providerId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importWorkspaceBundle,
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const abort = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);

      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(abort).toBeDefined();
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_async_prepare_abort',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
      });

      const handoffId = started.handoffId;
      const prepareAck = await prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: targetRoot,
      });

      expect(prepareAck).toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: expect.any(String),
        },
      });

      await expect(abort!({
        handoffId,
        reason: 'user_cancelled',
      })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'aborted',
          jobId: prepareAck.status.jobId,
        },
      });

      continueWorkspaceImport.resolve();

      await vi.waitFor(async () => {
        await expect(statusGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: {
            handoffId,
            status: 'aborted',
            jobId: prepareAck.status.jobId,
          },
        });
      });
      await expect(resultGet!({ handoffId })).resolves.toEqual({
        ok: false,
        errorCode: 'not_found',
      });
      await expect(readFile(join(targetRoot, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(importWorkspaceBundle).toHaveBeenCalledTimes(1);
      expect(importSessionBundle).not.toHaveBeenCalled();
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
