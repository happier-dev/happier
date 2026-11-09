import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { buildDirectPeerTransferEndpointPath } from '@/machines/transfer/directPeerTransport';
import { prepareStartedState } from './prepareStartedState';
import { runSessionHandoffPrepareTargetJob } from './prepareTargetRunJob';
import { createSessionHandoffCommitActionHandler } from './commit';
import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';
import { buildPrepareJobRecord, buildSourceExportOnlyPrepareJobId, buildStartPendingStatus, invalidRequest, readPersistedPrepareJob } from './prepareTargetState';

describe('managed workspace handoff through real source and target owners', () => {
  let runtimeLease: PluginRuntimeRegistryLease | null = null;
  beforeAll(async () => {
    runtimeLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ pluginIds: [] }),
    });
  });
  afterAll(async () => { await runtimeLease?.release(); await pluginReloadController.shutdown(); });
  it('copies A to B to a new A allocation, resolves the returned path, and deletes only local Session allocations', async () => {
    const machineA = await mkdtemp(join(tmpdir(), 'happier-managed-machine-a-'));
    const machineB = await mkdtemp(join(tmpdir(), 'happier-managed-machine-b-'));
    try {
      const ownerA = createManagedSessionDirectories({ activeServerDir: machineA });
      const ownerB = createManagedSessionDirectories({ activeServerDir: machineB });
      const originalA = await ownerA.materializeForFreshSpawn({ sessionCreationTag: 'source' });
      await ownerA.bind({ allocationId: originalA.allocationId, sessionId: 'session' });
      await writeFile(join(originalA.directory, 'notes.txt'), 'from A');

      const transfer = async (sourceRoot: string, targetRoot: string, sourcePath: string, operationId: string) => {
        const handoffId = `handoff_${operationId}`;
        const jobId = `prepare_${operationId}`;
        const sourceStore = createSessionHandoffSourceExportStore({ activeServerDir: sourceRoot });
        // Only the peer network and the native Agent's export/import are substituted.
        // Reopening the real source store proves the receiver needs no process-local snapshot closure.
        const peer: SessionHandoffDirectPeerTransferHandle = {
          publishTransfer: ({ transferId }) => [{ kind: 'http',
            url: `http://127.0.0.1:42001${buildDirectPeerTransferEndpointPath(transferId)}`,
            authorizationToken: 'test-peer-token', expiresAt: Date.now() + 60_000,
          }], clearPublishedTransfer: () => undefined,
          requestPayloadFile: async ({ transferId, destinationPath }) => {
            const persisted = await createSessionHandoffSourceExportStore({ activeServerDir: sourceRoot }).load(handoffId);
            const file = persisted?.agentBundle?.transferId === transferId ? persisted.agentBundle
              : persisted?.workspaceSeed?.files[transferId];
            if (!file) throw new Error('Network source rejected the requested transfer');
            await copyFile(file.filePath, destinationPath);
            return { destinationPath };
          },
        };
        const started = await prepareStartedState({ activeServerDir: sourceRoot,
          callInput: { handoffId, sourceStopState: 'stopped',
            request: { sessionId: 'session', operationId, targetDirectory: { kind: 'managed' },
              sourceMachineId: sourceRoot, targetMachineId: targetRoot, sessionStorageMode: 'persisted',
              preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer',
            }, metadata: { path: sourcePath, sessionDirectoryV1: { v: 1, kind: 'managed' } },
          }, sourceExportStore: sourceStore, directPeerTransfer: peer, buildStartPendingStatus,
          exportSessionBundle: async () => ({ targetPath: sourcePath,
            agentBundle: { agentId: 'claude', remoteSessionId: 'native-source', transcriptBase64: 'e30K' },
          }),
        });
        const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir: targetRoot });
        const targetStore = createSessionHandoffSourceExportStore({ activeServerDir: targetRoot });
        await runSessionHandoffPrepareTargetJob({ activeServerDir: targetRoot, runtimeConfig: { activeServerDir: targetRoot },
          handoffId, jobId, createdAtMs: 1,
          request: { handoffId, operationId, sessionId: 'session', targetDirectory: { kind: 'managed' },
            sourceMachineId: sourceRoot, targetMachineId: targetRoot, negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted', targetPath: '/client/cannot/select/path',
            endpointCandidates: started.endpointCandidates, handoffMetadataV2: started.nextState.handoffMetadataV2,
          }, actualTransportStrategy: 'direct_peer',
          pendingStatus: { handoffId, jobId, status: 'pending', phase: 'staging_target', transportStrategy: 'direct_peer', recoveryActions: [] },
          prepareJobStore, sourceExportStore: targetStore, prepareTargetJobLeaseOwnerId: `cli-daemon:${process.pid}:round-trip`,
          machineTransferChannel: undefined, directPeerTransfer: peer,
          importSessionBundle: async (_bundle, targetPath) => ({ remoteSessionId: 'native-target',
            directSource: { kind: 'claudeConfig', configDir: join(targetRoot, 'native-config') },
            resume: { directory: targetPath, agent: 'claude', agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
              resume: 'native-target', transcriptStorage: 'persisted', approvedNewDirectoryCreation: true },
          }),
        });
        const prepared = await prepareJobStore.read(jobId);
        expect(prepared?.status.status, prepared?.lastErrorMessage).toBe('ready_for_cutover');
        const targetPath = prepared!.prepareTargetResult!.resume.directory;
        expect(targetPath.startsWith(join(targetRoot, 'session-directories'))).toBe(true);
        await createSessionHandoffCommitActionHandler({ activeServerDir: targetRoot, prepareJobStore,
          sourceExportStore: targetStore, directPeerTransfer: peer, readPersistedPrepareJob, buildPrepareJobRecord,
          buildStartPendingStatus, buildSourceExportOnlyPrepareJobId, invalidRequest,
        })({ handoffId, mode: 'target' });
        await sourceStore.releaseTransferFiles(handoffId);
        return targetPath;
      };

      const directoryB = await transfer(machineA, machineB, originalA.directory, 'a_to_b');
      expect(await readFile(join(directoryB, 'notes.txt'), 'utf8')).toBe('from A');
      await writeFile(join(directoryB, 'notes.txt'), 'continued on B');
      const returnedA = await transfer(machineB, machineA, directoryB, 'b_to_a');
      expect(returnedA).not.toBe(originalA.directory);
      expect(await readFile(join(returnedA, 'notes.txt'), 'utf8')).toBe('continued on B');
      expect(await readFile(join(originalA.directory, 'notes.txt'), 'utf8')).toBe('from A');
      expect(await ownerA.resolveForSession({ sessionId: 'session', path: returnedA })).toMatchObject({ ok: true, directory: returnedA });
      await ownerA.removeForSession({ sessionId: 'session', stopSession: async () => ({ status: 'stopped' }) });
      await expect(access(originalA.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(returnedA)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(directoryB, 'notes.txt'), 'utf8')).toBe('continued on B');
      await ownerB.removeForSession({ sessionId: 'session', stopSession: async () => ({ status: 'stopped' }) });
      await expect(access(directoryB)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(machineA, { recursive: true, force: true }); await rm(machineB, { recursive: true, force: true }); }
  });
});
