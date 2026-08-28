import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { vi } from 'vitest';

import {
  SessionHandoffStartResponseSchema,
} from '@happier-dev/protocol';

import {
  projectReleasedSessionHandoffResponseForMethod,
  projectSessionHandoffPrepareTargetResponseForPredecessor,
  projectSessionHandoffResponseForPredecessor,
  projectSessionHandoffStartResponseForPredecessor,
  registerSessionHandoffPredecessorCompatibilityHandlers,
} from './predecessorCompatibility';
import { createSessionHandoffPrepareTargetJobStore } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerMachineSessionHandoffRpcHandlers } from './handlers';

const PredecessorStatusSchema = z.object({
  handoffId: z.string(),
  status: z.enum([
    'pending',
    'ready_for_cutover',
    'in_progress',
    'awaiting_recovery',
    'completed',
    'aborted',
    'failed',
  ]),
  phase: z.string(),
  jobId: z.string().optional(),
  recoveryActions: z.array(z.string()),
}).strict();

const PredecessorStartResponseSchema = z.object({
  handoffId: z.string(),
  status: PredecessorStatusSchema,
  endpointCandidates: z.array(z.unknown()),
  targetPath: z.string(),
  handoffMetadataV2: z.object({
    providerBundleTransferPublication: z.object({
      transferId: z.string(),
      sizeBytes: z.number(),
      manifestHash: z.string(),
      endpointCandidates: z.array(z.unknown()).optional(),
    }).strict().optional(),
    workspaceReplicationSourceRootPath: z.string().optional(),
    workspaceReplicationHandoffBackTargetRootPath: z.string().optional(),
    workspaceReplicationManifestTransferPublication: z.object({
      transferId: z.string(),
      endpointCandidates: z.array(z.unknown()).optional(),
    }).strict().optional(),
    workspaceReplicationSourceControllerMetadata: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional(),
}).strict();

const PredecessorPrepareResponseSchema = z.object({
  handoffId: z.string(),
  status: PredecessorStatusSchema,
  remoteSessionId: z.string().optional(),
  directSource: z.unknown().optional(),
  agentRuntimeDescriptorV1: z.object({
    v: z.literal(1),
    providerId: z.string(),
    provider: z.object({
      providerExtra: z.object({
        owner: z.string(),
        schemaId: z.string(),
        v: z.number(),
      }).passthrough().optional(),
    }).passthrough(),
  }).passthrough().optional(),
  resume: z.unknown().optional(),
}).strict();

describe('session handoff predecessor wire compatibility', () => {
  it('projects current-only start and prepare fields onto the exact strict predecessor wire', () => {
    const status = {
      handoffId: 'handoff-1',
      status: 'ready_for_cutover' as const,
      phase: 'staging_target' as const,
      jobId: 'prepare_handoff-1',
      workspaceReplicationJobId: 'workspace-job-1',
      recoveryActions: [],
      failure: undefined,
    };
    const start = projectSessionHandoffStartResponseForPredecessor({
      handoffId: 'handoff-1',
      status,
      endpointCandidates: [],
      targetPath: '/repo',
      workspaceReplicationJobId: 'workspace-job-1',
      handoffMetadataV2: {
        agentBundleTransferPublication: {
          transferId: 'agent-bundle:handoff-1',
          sizeBytes: 10,
          manifestHash: 'sha256:abc',
          currentOnly: true,
        },
        workspaceReplicationSourceRootPath: '/repo',
        currentOnly: true,
      },
    });
    const prepare = projectSessionHandoffPrepareTargetResponseForPredecessor({
      handoffId: 'handoff-1',
      status,
      remoteSessionId: 'remote-1',
      directSource: { kind: 'codexHome', home: 'user' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          agentExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: { backendMode: 'appServer' },
          },
        },
      },
      resume: {
        directory: '/repo',
        agent: 'codex',
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        resume: 'vendor-session-1',
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
      },
      workspaceReplicationJobId: 'workspace-job-1',
    });

    expect(PredecessorStartResponseSchema.parse(start)).toEqual(start);
    expect(PredecessorPrepareResponseSchema.parse(prepare)).toEqual(prepare);
    expect(start).not.toHaveProperty('handoffMetadataV2.agentBundleTransferPublication');
    expect(prepare).not.toHaveProperty('runtimeDescriptorV1');
    expect(prepare).not.toHaveProperty('workspaceReplicationJobId');
    expect(prepare).not.toHaveProperty('resume.agentTarget');
    expect(prepare).toHaveProperty('resume.codexBackendMode', 'appServer');

    const normalizedStart = SessionHandoffStartResponseSchema.parse(start);
    expect(normalizedStart.handoffMetadataV2?.agentBundleTransferPublication?.transferId).toBe(
      'agent-bundle:handoff-1',
    );

    expect(projectReleasedSessionHandoffResponseForMethod(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
      {
        handoffId: 'handoff-1',
        status,
        resume: {
          directory: '/repo',
          agent: 'codex',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
          resume: 'vendor-session-1',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
        },
      },
    )).not.toHaveProperty('resume.agentTarget');
    const currentV3 = {
      handoffId: 'handoff-1',
      status,
      resume: {
        directory: '/repo',
        agent: 'codex',
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        resume: 'vendor-session-1',
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
      },
    };
    expect(projectReleasedSessionHandoffResponseForMethod(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
      currentV3,
    )).toBe(currentV3);
    const currentStatusV3 = {
      handoffId: 'handoff-1',
      status: {
        ...status,
        status: 'awaiting_user_resume',
        recoveryActions: ['resume_on_target'],
      },
    };
    expect(projectReleasedSessionHandoffResponseForMethod(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
      currentStatusV3,
    )).toBe(currentStatusV3);

    expect(PredecessorStatusSchema.parse(
      (projectSessionHandoffResponseForPredecessor('status', {
        handoffId: 'handoff-1',
        status: {
          ...status,
          status: 'awaiting_user_resume',
          workspaceReplicationJobId: 'workspace-job-1',
        },
      }) as { status: unknown }).status,
    )).toMatchObject({
      handoffId: 'handoff-1',
      status: 'awaiting_recovery',
    });
  });

  it('prepares the exact predecessor V2 target through canonical owners while atomic resume is unavailable', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-predecessor-v2-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const registered = new Map<string, (raw: unknown) => Promise<unknown>>();
      const status = {
        handoffId: 'handoff-v2',
        status: 'ready_for_cutover' as const,
        phase: 'staging_target' as const,
        jobId: 'prepare_handoff-v2',
        recoveryActions: [],
      };
      const prepareResult = {
        handoffId: 'handoff-v2',
        status,
        remoteSessionId: 'remote-v2',
        directSource: { kind: 'codexHome' as const, home: 'user' as const },
        runtimeDescriptorV1: {
          v: 1 as const,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        },
        resume: {
          directory: '/repo',
          agent: 'codex' as const,
          resume: 'vendor-v2',
          transcriptStorage: 'persisted' as const,
          approvedNewDirectoryCreation: true as const,
        },
      };
      await store.write({
        jobId: status.jobId,
        handoffId: status.handoffId,
        createdAtMs: 1,
        updatedAtMs: 1,
        status,
        prepareTargetResult: prepareResult,
      });
      const prepareTarget = vi.fn(async () => prepareResult);
      const prepareTargetResultGet = vi.fn(async () => prepareResult);
      const spawnSessionForHandoff = vi.fn(async () => ({
        type: 'success' as const,
        sessionId: 'session-v2',
      }));
      registerSessionHandoffPredecessorCompatibilityHandlers({
        rpcHandlerManager: {
          registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) {
            registered.set(method, handler);
          },
        } as never,
        prepareJobStore: store,
        prepareTarget,
        prepareTargetResultGet,
        commit: vi.fn(),
        abort: vi.fn(),
        spawnSessionForHandoff,
        stopSessionForHandoff: vi.fn(async () => 'stopped' as const),
        now: (() => {
          let value = 10;
          return () => value++;
        })(),
        createOperationId: (kind) => `${kind}-operation`,
      });

      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET)!({}))
        .resolves.toEqual({
          protocolVersion: 2,
          atomicTargetResume: false,
          targetCleanup: false,
        });
      const prepareRequest = {
        handoffId: 'handoff-v2',
        sessionId: 'session-v2',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        endpointCandidates: [],
      };
      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2)!(prepareRequest))
        .resolves.toMatchObject({
          handoffId: 'handoff-v2',
          agentRuntimeDescriptorV1: { providerId: 'codex' },
        });
      expect(prepareTarget).toHaveBeenCalledWith({
        ...prepareRequest,
        sessionId: undefined,
      });
      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2)!({
        handoffId: 'handoff-v2',
        sessionId: 'session-v2',
      })).resolves.toMatchObject({
        handoffId: 'handoff-v2',
        agentRuntimeDescriptorV1: { providerId: 'codex' },
      });

      const resumeRequest = {
        handoffId: 'handoff-v2',
        sessionId: 'session-v2',
        attemptId: 'attempt-v2',
      };
      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2)!(resumeRequest))
        .resolves.toEqual({
          ok: false,
          errorCode: 'unsupported',
        });
      expect(spawnSessionForHandoff).not.toHaveBeenCalled();
      expect(await store.findByHandoffId('handoff-v2')).toMatchObject({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        sessionId: 'session-v2',
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('reports predecessor V2 capabilities false when canonical spawn and cleanup dependencies are absent', async () => {
    const registered = new Map<string, (raw: unknown) => Promise<unknown>>();
    registerSessionHandoffPredecessorCompatibilityHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) {
          registered.set(method, handler);
        },
      } as never,
      prepareJobStore: {} as never,
      prepareTarget: vi.fn(),
      prepareTargetResultGet: vi.fn(),
      commit: vi.fn(),
      abort: vi.fn(),
    });

    await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET)!({}))
      .resolves.toEqual({
        protocolVersion: 2,
        atomicTargetResume: false,
        targetCleanup: false,
      });
  });

  it('fails predecessor atomic resume closed when a matching spawn cannot prove runner ownership', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-predecessor-unowned-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const status = {
        handoffId: 'handoff-unowned',
        status: 'ready_for_cutover' as const,
        phase: 'staging_target' as const,
        jobId: 'prepare_handoff-unowned',
        recoveryActions: [],
      };
      const prepareResult = {
        handoffId: status.handoffId,
        status,
        remoteSessionId: 'remote-unowned',
        directSource: { kind: 'claudeConfig' as const, configDir: null, projectId: null },
        resume: {
          directory: '/repo',
          agent: 'claude' as const,
          resume: 'vendor-unowned',
          transcriptStorage: 'persisted' as const,
          approvedNewDirectoryCreation: true as const,
        },
      };
      await store.write({
        jobId: status.jobId,
        handoffId: status.handoffId,
        createdAtMs: 1,
        updatedAtMs: 1,
        status,
        prepareTargetResult: prepareResult,
      });
      await store.upgradeReadyV1ToPreparedV2({
        jobId: status.jobId,
        sessionId: 'session-unowned',
      });

      const registered = new Map<string, (raw: unknown) => Promise<unknown>>();
      const spawnSessionForHandoff = vi.fn(async () => ({
        type: 'success' as const,
        sessionId: 'session-unowned',
      }));
      const stopSessionForHandoff = vi.fn(async () => 'stopped' as const);
      registerSessionHandoffPredecessorCompatibilityHandlers({
        rpcHandlerManager: {
          registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) {
            registered.set(method, handler);
          },
        } as never,
        prepareJobStore: store,
        prepareTarget: vi.fn(),
        prepareTargetResultGet: vi.fn(),
        commit: vi.fn(),
        abort: vi.fn(),
        spawnSessionForHandoff,
        stopSessionForHandoff,
        now: () => 20,
      });

      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET)!({}))
        .resolves.toEqual({
          protocolVersion: 2,
          atomicTargetResume: false,
          targetCleanup: false,
        });
      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2)!({
        handoffId: status.handoffId,
        sessionId: 'session-unowned',
        attemptId: 'attempt-unowned',
      })).resolves.toEqual({
        ok: false,
        errorCode: 'unsupported',
      });
      expect(spawnSessionForHandoff).not.toHaveBeenCalled();

      await store.transitionPredecessorV2(status.jobId, (current) => ({
        ...current,
        updatedAtMs: 19,
        transitionRevision: current.transitionRevision + 1,
        resume: {
          status: 'attempted',
          attemptId: 'ambiguous-earlier-attempt',
          acceptedAtMs: 19,
        },
      }));
      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2)!({
        handoffId: status.handoffId,
        sessionId: 'session-unowned',
        reason: 'do not stop an ambiguously matching runner',
      })).resolves.toMatchObject({
        status: {
          status: 'awaiting_recovery',
        },
        targetCleanup: {
          status: 'failed',
          reason: 'unreachable',
        },
      });
      expect(stopSessionForHandoff).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('aborts without stopping a target whose predecessor resume was never accepted', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-predecessor-abort-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const status = {
        handoffId: 'handoff-abort',
        status: 'ready_for_cutover' as const,
        phase: 'staging_target' as const,
        jobId: 'prepare_handoff-abort',
        recoveryActions: [],
      };
      const prepareResult = {
        handoffId: status.handoffId,
        status,
        remoteSessionId: 'remote-abort',
        directSource: { kind: 'claudeConfig' as const, configDir: null, projectId: null },
        resume: {
          directory: '/repo',
          agent: 'claude' as const,
          resume: 'vendor-abort',
          transcriptStorage: 'persisted' as const,
          approvedNewDirectoryCreation: true as const,
        },
      };
      await store.write({
        jobId: status.jobId,
        handoffId: status.handoffId,
        createdAtMs: 1,
        updatedAtMs: 1,
        status,
        prepareTargetResult: prepareResult,
      });
      await store.upgradeReadyV1ToPreparedV2({
        jobId: status.jobId,
        sessionId: 'session-abort',
      });
      const registered = new Map<string, (raw: unknown) => Promise<unknown>>();
      const stopSessionForHandoff = vi.fn(async () => 'stopped' as const);
      const abort = vi.fn(async () => ({
        handoffId: status.handoffId,
        status: {
          ...status,
          status: 'aborted' as const,
          recoveryActions: ['restart_on_source', 'keep_stopped'] as const,
        },
      }));
      registerSessionHandoffPredecessorCompatibilityHandlers({
        rpcHandlerManager: {
          registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) {
            registered.set(method, handler);
          },
        } as never,
        prepareJobStore: store,
        prepareTarget: vi.fn(),
        prepareTargetResultGet: vi.fn(),
        commit: vi.fn(),
        abort,
        spawnSessionForHandoff: vi.fn(async () => ({
          type: 'success' as const,
          sessionId: 'session-abort',
        })),
        stopSessionForHandoff,
        now: () => 20,
        createOperationId: () => 'abort-operation',
      });
      const resumeRequest = {
        handoffId: status.handoffId,
        sessionId: 'session-abort',
        attemptId: 'attempt-abort',
      };
      await registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2)!(resumeRequest);
      const abortRequest = {
        handoffId: status.handoffId,
        sessionId: 'session-abort',
        reason: 'source requested abort',
      };
      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2)!(abortRequest))
        .resolves.toMatchObject({
          handoffId: status.handoffId,
          status: { status: 'aborted' },
          targetCleanup: {
            status: 'not_owned',
            reason: 'resume_not_attempted',
          },
        });
      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2)!(abortRequest))
        .resolves.toMatchObject({
          status: { status: 'aborted' },
          targetCleanup: { status: 'not_owned' },
        });
      expect(stopSessionForHandoff).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledTimes(2);
      expect(await store.findByHandoffId(status.handoffId)).toMatchObject({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        sessionId: 'session-abort',
        terminal: { status: 'aborted', operationId: 'abort-operation' },
        targetCleanup: { status: 'not_owned', reason: 'resume_not_attempted' },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('registers the predecessor surface beside the current canonical handoff handlers', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-predecessor-registration-'));
    try {
      const registered = new Map<string, (raw: unknown) => Promise<unknown>>();
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) {
            registered.set(method, handler);
          },
        } as never,
        runtimeConfig: {
          activeServerDir,
          workspaceReplicationBlobPackTargetBytes: 1024,
          workspaceReplicationBlobPackMaxBlobs: 16,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024,
        },
        spawnSessionForHandoff: vi.fn(async () => ({
          type: 'success' as const,
          sessionId: 'session-v2',
        })),
        stopSessionForHandoff: vi.fn(async () => 'already_inactive' as const),
      });

      for (const method of [
        RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2,
      ]) {
        expect(registered.has(method)).toBe(true);
      }
      await expect(registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET)!({}))
        .resolves.toEqual({
          protocolVersion: 2,
          atomicTargetResume: false,
          targetCleanup: false,
        });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
