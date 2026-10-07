import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { createSessionHandoffPrepareTargetJobStore } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import { runSessionHandoffPrepareTargetJob } from './prepareTargetRunJob';
import { createWorkspaceSyncSeedExport } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { createMachineTransferRouteCache } from '@/machines/transfer/transferRouteCache';

describe('runSessionHandoffPrepareTargetJob typed native-import failures', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
  });
  afterAll(async () => { await runtime?.dispose(); });
  it('materializes the managed source files before native import without WorkspaceRefs', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-managed-seed-target-'));
    const sourcePath = await mkdtemp(join(tmpdir(), 'happier-managed-seed-source-'));
    const handoffId = 'handoff_managed_seed';
    const jobId = 'prepare_managed_seed';
    await writeFile(join(sourcePath, 'notes.txt'), 'source workspace');
    const transferId = `session-handoff:${handoffId}:workspace-seed`;
    const seed = await createWorkspaceSyncSeedExport({ operationId: transferId, activeServerDir, sourcePath,
      workspaceTransfer: { includeIgnoredMode: 'include_selected', ignoredIncludeGlobs: [], includeAllIgnored: true },
    });
    const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
    const agentBundle = await sourceExportStore.writeAgentBundleFile({ handoffId,
      agentBundle: { agentId: 'claude', remoteSessionId: 'remote_source', transcriptBase64: 'e30K' },
    });
    await sourceExportStore.save({ handoffId, exportedAtMs: 1, agentBundle });
    let observedFiles: string | null = null;
    let importedPath = '';
    try {
      await runSessionHandoffPrepareTargetJob({ activeServerDir, runtimeConfig: { activeServerDir }, jobId, handoffId, createdAtMs: 1,
        request: { handoffId, operationId: 'operation_managed_seed', sessionId: 'session_managed_seed', targetDirectory: { kind: 'managed' },
          sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/untrusted/client/path', negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted', endpointCandidates: [], handoffMetadataV2: { workspaceSeedTransferPublication: {
            transferId, sizeBytes: seed.payloadSource.sizeBytes!, manifestHash: seed.payloadSource.manifestHash!, endpointCandidates: [],
          } },
        }, actualTransportStrategy: 'direct_peer', pendingStatus: { handoffId, jobId, status: 'pending', phase: 'staging_target', transportStrategy: 'direct_peer', recoveryActions: [] },
        prepareJobStore: createSessionHandoffPrepareTargetJobStore({ activeServerDir }), sourceExportStore,
        prepareTargetJobLeaseOwnerId: `seed-test:${process.pid}`, prepareTargetJobLeaseTtlMs: 5_000, machineTransferChannel: undefined,
        directPeerTransfer: { publishTransfer: () => [], clearPublishedTransfer: () => undefined,
          requestPayloadFile: async (request) => {
            const payload = request.transferId === transferId ? seed.payloadSource : await seed.onDemandScope.resolvePayloadSourceOnOpen({ transferId: request.transferId, requestBody: undefined });
            if (payload.kind === 'buffer') await writeFile(request.destinationPath, payload.payload);
            else await copyFile(payload.filePath, request.destinationPath);
            return { destinationPath: request.destinationPath };
          },
        },
        importSessionBundle: async (_bundle, targetPath) => {
          importedPath = targetPath;
          observedFiles = await readFile(join(targetPath, 'notes.txt'), 'utf8').catch(() => null);
          throw Object.assign(new Error('Observed native import boundary'), { code: 'agent_version_unsupported' });
        }, getTransferRouteCache: () => createMachineTransferRouteCache({ serverId: 'target-server' }), invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined,
      });
      expect(observedFiles).toBe('source workspace');
      expect(importedPath.startsWith(join(activeServerDir, 'session-directories') + '/')).toBe(true);
      expect(importedPath).not.toBe('/untrusted/client/path');
      await expect(access(importedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(activeServerDir, { recursive: true, force: true }); await rm(sourcePath, { recursive: true, force: true }); }
  });
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
        runtimeConfig: {
          activeServerDir,
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
          prepareReceivedAgentBundleFilePath: vi.fn(async () => join(
            activeServerDir,
            'unused-received-agent-bundle.bin',
          )),
        } as never,
        prepareTargetJobLeaseOwnerId: `cli-daemon:${process.pid}:typed-import-failure`,
        prepareTargetJobLeaseTtlMs: 5_000,
        machineTransferChannel: undefined,
        directPeerTransfer: undefined,
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
        runtimeConfig: {
          activeServerDir,
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
          prepareReceivedAgentBundleFilePath: vi.fn(async () => join(
            activeServerDir,
            'unused-received-agent-bundle.bin',
          )),
        } as never,
        prepareTargetJobLeaseOwnerId: `cli-daemon:${process.pid}:crash-convergence`,
        prepareTargetJobLeaseTtlMs: 5_000,
        machineTransferChannel: undefined,
        directPeerTransfer: undefined,
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
