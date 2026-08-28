import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('lets two daemon clients converge on one passive interrupted prepare-target hydration', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-lease-liveness-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-lease-target-'));
    const continueImportSession = createDeferred<void>();

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_lease_1';
      const jobId = 'prepare_lease_1';
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');

      const registeredA = new Map<string, (params: unknown) => Promise<any>>();
      const registeredB = new Map<string, (params: unknown) => Promise<any>>();

      const directPeerTransfer = {
        publishTransfer: () => [],
        requestPayloadFile: async (input: Readonly<{
          transferId: string;
          endpointCandidates: readonly unknown[];
          destinationPath: string;
        }>) => {
          await writeFile(input.destinationPath, JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          }));
          return { destinationPath: input.destinationPath };
        },
        clearPublishedTransfer: () => undefined,
      };

      const importSessionBundleA = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });
      const importSessionBundleB = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registeredA.set(method, handler);
          },
        } as any,
        directPeerTransfer: directPeerTransfer as any,
        importSessionBundle: importSessionBundleA,
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registeredB.set(method, handler);
          },
        } as any,
        directPeerTransfer: directPeerTransfer as any,
        importSessionBundle: importSessionBundleB,
      });

      const prepareA = registeredA.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const prepareB = registeredB.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGetA = registeredA.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(prepareA).toBeDefined();
      expect(prepareB).toBeDefined();
      expect(resultGetA).toBeDefined();

      const preparePayload = {
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: 'session-handoff:handoff_lease_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      } as const;

      const [ackA, ackB] = await Promise.all([
        prepareA!(preparePayload),
        prepareB!(preparePayload),
      ]);

      expect(ackA).toMatchObject({
        handoffId,
        status: { handoffId, jobId, status: 'awaiting_user_resume' },
      });
      expect(ackB).toMatchObject({
        handoffId,
        status: { handoffId, jobId, status: 'awaiting_user_resume' },
      });

      expect(importSessionBundleA).not.toHaveBeenCalled();
      expect(importSessionBundleB).not.toHaveBeenCalled();
      await expect(resultGetA!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'awaiting_user_resume',
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it('does not treat duplicate prepare-target calls as Resume after daemon restart', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-restart-liveness-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-restart-target-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_restart_1';
      const jobId = 'prepare_restart_1';

      // Simulate a daemon crash leaving behind an unexpired lease record for the job runner.
      // Restart liveness must not wait for the TTL; the new daemon should deterministically steal it.
      const leasePath = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
        'lease.json',
      );
      await mkdir(join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
      ), { recursive: true });
      await writeFile(leasePath, JSON.stringify({
        ownerId: 'cli-daemon:999999:stale',
        acquiredAtMs: nowMs - 1000,
        renewedAtMs: nowMs - 1000,
        expiresAtMs: nowMs + 60 * 60 * 1000,
      }));

      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueImportSession = createDeferred<void>();

      const directPeerTransfer = {
        publishTransfer: () => [],
        requestPayloadFile: async (input: Readonly<{
          transferId: string;
          endpointCandidates: readonly unknown[];
          destinationPath: string;
        }>) => {
          // Provide a minimal provider bundle file for the prepare job.
          await writeFile(input.destinationPath, JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          }));
          return { destinationPath: input.destinationPath };
        },
        clearPublishedTransfer: () => undefined,
      };

      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        directPeerTransfer: directPeerTransfer as any,
        importSessionBundle,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      const preparePayload = {
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: 'session-handoff:handoff_restart_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      } as const;

      // Duplicate PREPARE_TARGET is inspection-only for an interrupted target job; it is never Resume.
      const [prepareAck, prepareAck2] = await Promise.all([
        prepare!(preparePayload),
        prepare!(preparePayload),
      ]);

      expect(prepareAck).toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'reconciliation_required',
          phase: 'staging_target',
        },
      });
      expect(prepareAck2).toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'reconciliation_required',
          phase: 'staging_target',
        },
      });
      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'reconciliation_required',
          phase: 'staging_target',
        },
      });

      expect(importSessionBundle).not.toHaveBeenCalled();

      const persisted = await prepareJobStore.read(jobId);
      expect(persisted?.status.status).toBe('reconciliation_required');
      expect(persisted?.lastErrorMessage).toBeUndefined();

      await expect(resultGet!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'reconciliation_required',
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it('keeps result/status polling passive and resumes an interrupted prepare-target job only through the revision-bound action', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-resume-from-result-get-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-resume-from-result-get-target-'));
    const continueImportSession = createDeferred<void>();

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const {
        createSessionHandoffPrepareTargetJobStore,
        recoverSessionHandoffPrepareTargetJobsAfterRestart,
      } = await import(
        '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_result_get_restart_1';
      const jobId = 'prepare_result_get_restart_1';
      const jobPath = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs',
        `${jobId}.json`,
      );

      // Provenance-shaped remote-dev V1 record: a daemon crashed after persisting the
      // Provider-era publication field but before its in-memory prepare runner completed.
      await mkdir(join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs',
      ), { recursive: true });
      await writeFile(jobPath, JSON.stringify({
        schemaVersion: 1,
        jobId,
        handoffId,
        createdAtMs: nowMs - 60_000,
        updatedAtMs: nowMs - 60_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 60_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
        // Persist enough input for the daemon recovery owner to expose explicit Resume.
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
          handoffMetadataV2: {
            providerBundleTransferPublication: {
              transferId: `session-handoff:${handoffId}:provider-bundle`,
              sizeBytes: 123,
              manifestHash: 'hash',
              endpointCandidates: [
                { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
              ],
            },
          },
        },
      }), 'utf8');

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');

      const registered = new Map<string, (params: unknown) => Promise<any>>();

      const directPeerTransfer = {
        publishTransfer: () => [],
        requestPayloadFile: async (input: Readonly<{
          transferId: string;
          endpointCandidates: readonly unknown[];
          destinationPath: string;
        }>) => {
          await writeFile(input.destinationPath, JSON.stringify({
            providerId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          }));
          return { destinationPath: input.destinationPath };
        },
        clearPublishedTransfer: () => undefined,
      };

      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        directPeerTransfer: directPeerTransfer as any,
        importSessionBundle,
      });

      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      const resume = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3);
      expect(resultGet).toBeDefined();
      expect(statusGet).toBeDefined();
      expect(resume).toBeDefined();

      const interruptedBytesBeforePassiveReads = await readFile(jobPath);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(resultGet!({ handoffId })).resolves.toEqual({
          ok: false,
          errorCode: 'not_found',
        });
        await expect(statusGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: { handoffId, jobId, status: 'pending' },
        });
      }
      expect(await readFile(jobPath)).toEqual(interruptedBytesBeforePassiveReads);
      expect(importSessionBundle).not.toHaveBeenCalled();

      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs: nowMs + 1,
      });
      const recoveredBytesBeforePassiveReads = await readFile(jobPath);
      const recoveredRecord = JSON.parse(recoveredBytesBeforePassiveReads.toString('utf8'));
      expect(recoveredRecord).toMatchObject({
        prepareTargetRequest: {
          handoffMetadataV2: {
            agentBundleTransferPublication: {
              transferId: `session-handoff:${handoffId}:provider-bundle`,
            },
          },
        },
      });
      expect(recoveredRecord.prepareTargetRequest.handoffMetadataV2).not.toHaveProperty(
        'providerBundleTransferPublication',
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(resultGet!({ handoffId })).resolves.toMatchObject({
          ok: false,
          errorCode: 'awaiting_user_resume',
        });
        await expect(statusGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          transitionRevision: 0,
          status: { handoffId, jobId, status: 'awaiting_user_resume' },
        });
      }
      expect(await readFile(jobPath)).toEqual(recoveredBytesBeforePassiveReads);
      expect(importSessionBundle).not.toHaveBeenCalled();

      const resumeRequest = {
        handoffId,
        jobId,
        expectedRevision: 0,
        attemptId: 'attempt-result-get-restart-1',
      };
      await expect(resume!(resumeRequest)).resolves.toMatchObject({
        ok: true,
        handoffId,
        jobId,
        transitionRevision: 1,
      });
      await vi.waitFor(() => expect(importSessionBundle).toHaveBeenCalledTimes(1));
      await expect(resume!(resumeRequest)).resolves.toMatchObject({ ok: true });
      expect(importSessionBundle).toHaveBeenCalledTimes(1);
      await expect(resume!({
        ...resumeRequest,
        attemptId: 'conflicting-attempt',
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'attempt_conflict' },
      });
      await expect(resume!({
        ...resumeRequest,
        expectedRevision: 99,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'stale_revision' },
      });
      expect(importSessionBundle).toHaveBeenCalledTimes(1);
      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(statusGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: { handoffId, status: 'ready_for_cutover' },
        });
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it('returns awaiting_recovery instead of pending when a persisted prepare-target job has already been marked stranded after daemon restart', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-stranded-restart-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_stranded_restart_1';
      const jobId = 'prepare_stranded_restart_1';
      const nowMs = Date.now();
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 10_000,
        status: {
          handoffId,
          jobId,
          status: 'awaiting_recovery',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 10_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'daemon_restart_missing_runner',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');
      const registered = new Map<string, (params: unknown) => Promise<any>>();
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      expect(prepare).toBeDefined();

      await expect(prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: 'session-handoff:handoff_stranded_restart_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'awaiting_recovery',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'daemon_restart_missing_runner',
            },
          },
        },
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('does not infer Resume from a duplicate prepare-target call when the persisted semantic request is missing', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-missing-runner-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-missing-runner-target-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_missing_runner_1';
      const jobId = 'prepare_missing_runner_1';
      const leasePath = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
        'lease.json',
      );
      await mkdir(join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
      ), { recursive: true });
      await writeFile(leasePath, JSON.stringify({
        ownerId: `cli-daemon:${process.pid}:current`,
        acquiredAtMs: nowMs - 1000,
        renewedAtMs: nowMs - 1000,
        expiresAtMs: nowMs + 60 * 60 * 1000,
      }));

      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueImportSession = createDeferred<void>();
      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        directPeerTransfer: {
          publishTransfer: () => [],
          requestPayloadFile: async (input: Readonly<{
            transferId: string;
            endpointCandidates: readonly unknown[];
            destinationPath: string;
          }>) => {
            await writeFile(input.destinationPath, JSON.stringify({
              agentId: 'claude',
              remoteSessionId: 'claude_session_source',
              transcriptBase64: 'e30K',
            }));
            return { destinationPath: input.destinationPath };
          },
          clearPublishedTransfer: () => undefined,
        } as any,
        importSessionBundle,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const preparePayload = {
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: 'session-handoff:handoff_missing_runner_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      } as const;

      await expect(prepare!(preparePayload)).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'reconciliation_required',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'daemon_restart_reconciliation_required',
            },
          },
        },
      });
      expect(importSessionBundle).not.toHaveBeenCalled();
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'reconciliation_required',
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it('lets daemon recovery mark a stranded pending prepare-target job reconciliation_required when its semantic request is missing', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-status-recovery-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const {
        createSessionHandoffPrepareTargetJobStore,
        recoverSessionHandoffPrepareTargetJobsAfterRestart,
      } = await import(
        '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_status_recovery_1';
      const jobId = 'prepare_status_recovery_1';
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: Date.now() - 10_000,
        updatedAtMs: Date.now() - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: Date.now() - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });
      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs: Date.now(),
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');
      const registered = new Map<string, (params: unknown) => Promise<any>>();

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'reconciliation_required',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'daemon_restart_reconciliation_required',
            },
          },
        },
      });
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'reconciliation_required',
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('lets daemon recovery mark a stranded in_progress prepare-target job reconciliation_required when its semantic request is missing', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-status-recovery-in-progress-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const {
        createSessionHandoffPrepareTargetJobStore,
        recoverSessionHandoffPrepareTargetJobsAfterRestart,
      } = await import(
        '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_status_recovery_in_progress_1';
      const jobId = 'prepare_status_recovery_in_progress_1';
      const nowMs = Date.now();
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 15_000,
        updatedAtMs: nowMs - 10_000,
        status: {
          handoffId,
          jobId,
          status: 'in_progress',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 10_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });
      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs: Date.now(),
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');
      const registered = new Map<string, (params: unknown) => Promise<any>>();

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'reconciliation_required',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'daemon_restart_reconciliation_required',
            },
          },
        },
      });
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'reconciliation_required',
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('returns a prepare ack with a durable job id and exposes the final result through result-get', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-job-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueImportSession = createDeferred<void>();
      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
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
        };
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
          agentBundle: {
            agentId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);

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
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({ ok: false, errorCode: 'not_found' });

      continueImportSession.resolve();

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

  it('aborts a pending prepare job before session import when cancellation is requested mid-flight', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-abort-'));
    const targetRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-abort-target-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers } = await import('./handlers');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueImportSession = createDeferred<void>();
      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
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
        };
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
          agentBundle: {
            agentId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const abort = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);

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

      continueImportSession.resolve();

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
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({ ok: false, errorCode: 'aborted' });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
