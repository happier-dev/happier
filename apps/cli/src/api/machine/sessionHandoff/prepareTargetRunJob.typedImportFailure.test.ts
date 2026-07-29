import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createSessionHandoffPrepareTargetJobStore } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { runSessionHandoffPrepareTargetJob } from './prepareTargetRunJob';

describe('runSessionHandoffPrepareTargetJob typed native-import failures', () => {
  it.each([
    ['target_identity_conflict', 'reconciliation_required'],
    ['agent_version_unsupported', 'failed'],
  ] as const)('durably maps %s to %s', async (code, statusCode) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-import-failure-owner-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-import-failure-target-'));
    const bundlePath = join(activeServerDir, 'agent-bundle.json');
    const handoffId = `handoff_${code}`;
    const jobId = `prepare_${code}`;
    const request = {
      handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream' as const,
      sourceSessionStorageMode: 'persisted' as const,
      targetPath,
      endpointCandidates: [],
    };
    const pendingStatus = {
      handoffId,
      jobId,
      status: 'pending' as const,
      phase: 'staging_target' as const,
      transportStrategy: 'server_routed_stream' as const,
      recoveryActions: [],
    };

    try {
      await writeFile(bundlePath, JSON.stringify({
        agentId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      }), 'utf8');
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const importSessionBundle = vi.fn(async () => {
        throw Object.assign(new Error('leaf detail must not become durable'), { code });
      });

      await runSessionHandoffPrepareTargetJob({
        activeServerDir,
        homeDir: targetPath,
        runtimeConfig: {
          activeServerDir,
          workspaceReplicationBlobPackTargetBytes: 1024,
          workspaceReplicationBlobPackMaxBlobs: 10,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024,
        },
        jobId,
        handoffId,
        createdAtMs: 1,
        request,
        actualTransportStrategy: 'server_routed_stream',
        pendingStatus,
        prepareTargetRequest: request,
        prepareJobStore,
        sourceExportStore: {
          load: vi.fn(async () => ({
            agentBundle: { filePath: bundlePath },
          })),
        } as never,
        prepareTargetJobLeaseOwnerId: `cli-daemon:${process.pid}:typed-import-failure`,
        prepareTargetJobLeaseTtlMs: 5_000,
        machineTransferChannel: undefined,
        directPeerTransfer: undefined,
        workspaceReplicationAdapter: {
          prepareTargetWorkspace: vi.fn(async () => ({
            currentTargetManifest: { entries: [] },
            sourceOffer: null,
            importedWorkspace: { targetPath },
          })),
        } as never,
        workspaceReplicationTransfers: {} as never,
        importSessionBundle,
        getTransferRouteCache: () => ({} as never),
        invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined,
      });

      expect(importSessionBundle).toHaveBeenCalledTimes(1);
      await expect(prepareJobStore.read(jobId)).resolves.toMatchObject({
        failedAtMs: expect.any(Number),
        lastErrorMessage: code === 'target_identity_conflict'
          ? 'The native handoff target conflicts with the exported session identity'
          : 'The installed Agent version cannot safely import this handoff',
        status: {
          status: statusCode,
          recoveryActions: [],
          failure: { code },
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('converges after a crash following native import without observation or Resume duplicating the target mutation', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-import-crash-convergence-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-import-crash-target-'));
    const bundlePath = join(activeServerDir, 'agent-bundle.json');
    const handoffId = 'handoff_crash_after_native_import';
    const jobId = 'prepare_crash_after_native_import';
    const request = {
      handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream' as const,
      sourceSessionStorageMode: 'persisted' as const,
      targetPath,
      endpointCandidates: [],
    };
    const pendingStatus = {
      handoffId,
      jobId,
      status: 'pending' as const,
      phase: 'staging_target' as const,
      transportStrategy: 'server_routed_stream' as const,
      recoveryActions: [],
    };

    try {
      await writeFile(bundlePath, JSON.stringify({
        agentId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      }), 'utf8');
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      // The first daemon already completed the leaf-owned native mutation, then crashed before
      // persisting ready_for_cutover. The replacement daemon may only observe until explicit Resume.
      let nativeTargetExists = true;
      let nativeMutationCount = 1;
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 2,
        status: pendingStatus,
        prepareTargetRequest: request,
      });

      await expect(prepareJobStore.hydrateInterrupted(jobId, 3)).resolves.toMatchObject({
        transitionRevision: 0,
        prepareRecovery: { status: 'awaiting_user_resume' },
        status: { status: 'awaiting_user_resume' },
      });
      await expect(prepareJobStore.read(jobId)).resolves.toMatchObject({
        status: { status: 'awaiting_user_resume' },
      });
      await expect(prepareJobStore.read(jobId)).resolves.toMatchObject({
        status: { status: 'awaiting_user_resume' },
      });
      expect(nativeMutationCount).toBe(1);

      const accepted = await prepareJobStore.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-crash-after-import',
        nowMs: 4,
      });
      expect(accepted).toMatchObject({
        ok: true,
        disposition: 'accepted',
        record: {
          transitionRevision: 1,
          prepareRecovery: {
            status: 'attempted',
            attemptId: 'attempt-crash-after-import',
          },
        },
      });

      const importSessionBundle = vi.fn(async () => {
        if (!nativeTargetExists) {
          nativeTargetExists = true;
          nativeMutationCount += 1;
        }
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

      await runSessionHandoffPrepareTargetJob({
        activeServerDir,
        homeDir: targetPath,
        runtimeConfig: {
          activeServerDir,
          workspaceReplicationBlobPackTargetBytes: 1024,
          workspaceReplicationBlobPackMaxBlobs: 10,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024,
        },
        jobId,
        handoffId,
        createdAtMs: 1,
        request,
        actualTransportStrategy: 'server_routed_stream',
        pendingStatus,
        prepareTargetRequest: request,
        prepareJobStore,
        sourceExportStore: {
          load: vi.fn(async () => ({
            agentBundle: { filePath: bundlePath },
          })),
        } as never,
        prepareTargetJobLeaseOwnerId: `cli-daemon:${process.pid}:crash-convergence`,
        prepareTargetJobLeaseTtlMs: 5_000,
        machineTransferChannel: undefined,
        directPeerTransfer: undefined,
        workspaceReplicationAdapter: {
          prepareTargetWorkspace: vi.fn(async () => ({
            currentTargetManifest: { entries: [] },
            sourceOffer: null,
            importedWorkspace: { targetPath },
          })),
        } as never,
        workspaceReplicationTransfers: {} as never,
        importSessionBundle,
        getTransferRouteCache: () => ({} as never),
        invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined,
      });

      expect(importSessionBundle).toHaveBeenCalledTimes(1);
      expect(nativeMutationCount).toBe(1);
      await expect(prepareJobStore.read(jobId)).resolves.toMatchObject({
        completedAtMs: expect.any(Number),
        prepareRecovery: {
          status: 'attempted',
          attemptId: 'attempt-crash-after-import',
        },
        status: { status: 'ready_for_cutover' },
        prepareTargetResult: {
          remoteSessionId: 'claude_session_target',
          status: { status: 'ready_for_cutover' },
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
