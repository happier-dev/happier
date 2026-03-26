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
  it('uses a durable lease so only one daemon instance restarts a persisted non-terminal prepare-target job (no double-import across processes)', async () => {
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
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
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
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

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
            providerId: 'claude',
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

      const prepareA = registeredA.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const prepareB = registeredB.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGetA = registeredA.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
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
          providerBundleTransferPublication: {
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
        status: { handoffId, jobId, status: 'pending' },
      });
      expect(ackB).toMatchObject({
        handoffId,
        status: { handoffId, jobId, status: 'pending' },
      });

      // Without a durable lease, both daemon instances can start the import concurrently.
      await vi.waitFor(() => {
        expect(importSessionBundleA.mock.calls.length + importSessionBundleB.mock.calls.length).toBe(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(importSessionBundleA.mock.calls.length + importSessionBundleB.mock.calls.length).toBe(1);

      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(resultGetA!({ handoffId })).resolves.toMatchObject({
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

  it('restarts a persisted non-terminal prepare-target job when called again after daemon restart (no hanging pending job with missing runner)', async () => {
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
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
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

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

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

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
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
          providerBundleTransferPublication: {
            transferId: 'session-handoff:handoff_restart_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      } as const;

      // Simulate duplicate PREPARE_TARGET calls after a daemon restart: only one runner should be started.
      const [prepareAck, prepareAck2] = await Promise.all([
        prepare!(preparePayload),
        prepare!(preparePayload),
      ]);

      expect(prepareAck).toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
        },
      });
      expect(prepareAck2).toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
        },
      });
      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
        },
      });

      expect(importSessionBundle).toHaveBeenCalledTimes(1);

      const persisted = await prepareJobStore.read(jobId);
      expect(persisted?.status.status).toBe('pending');
      expect(persisted?.lastErrorMessage).toBeUndefined();

      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(resultGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: {
            handoffId,
            status: 'ready_for_cutover',
            phase: 'staging_target',
          },
          remoteSessionId: 'claude_session_target',
        });
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it('restarts a persisted non-terminal prepare-target job when callers keep polling result-get after daemon restart (no hanging pending job requiring a second PREPARE_TARGET call)', async () => {
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

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_result_get_restart_1';
      const jobId = 'prepare_result_get_restart_1';

      // Simulate a daemon crash: the prepare-target durable record exists, but there is no in-memory runner.
      await prepareJobStore.write({
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
        // Persist enough input to restart the job when only result-get/status polling continues.
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
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

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

      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(resultGet).toBeDefined();
      expect(statusGet).toBeDefined();

      await expect(resultGet!({ handoffId })).resolves.toMatchObject({ ok: false, errorCode: 'not_found' });

      await vi.waitFor(() => {
        expect(importSessionBundle).toHaveBeenCalledTimes(1);
      });

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
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
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

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
      const registered = new Map<string, (params: unknown) => Promise<any>>();
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      expect(prepare).toBeDefined();

      await expect(prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          providerBundleTransferPublication: {
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

  it('restarts a persisted non-terminal prepare-target job when the current daemon lease is present but the runner marker is missing', async () => {
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
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
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

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

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
              providerId: 'claude',
              remoteSessionId: 'claude_session_source',
              transcriptBase64: 'e30K',
            }));
            return { destinationPath: input.destinationPath };
          },
          clearPublishedTransfer: () => undefined,
        } as any,
        importSessionBundle,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
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
          providerBundleTransferPublication: {
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
          status: 'pending',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'resuming_after_restart',
            },
          },
        },
      });
      expect(importSessionBundle).toHaveBeenCalledTimes(1);
      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(resultGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: {
            handoffId,
            status: 'ready_for_cutover',
            phase: 'staging_target',
          },
          remoteSessionId: 'claude_session_target',
        });
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it('marks a stranded pending prepare-target job awaiting_recovery on status_get after daemon restart', async () => {
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

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
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

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
      const registered = new Map<string, (params: unknown) => Promise<any>>();

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
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
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'awaiting_recovery',
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('marks a stranded in_progress prepare-target job awaiting_recovery on status_get after daemon restart', async () => {
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

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
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

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
      const registered = new Map<string, (params: unknown) => Promise<any>>();

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
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
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'awaiting_recovery',
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

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

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
          providerBundle: {
            providerId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
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

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

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
          providerBundle: {
            providerId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
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
