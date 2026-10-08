import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineSessionHandoffRpcHandlers } from './sessionHandoff/handlers';
import { readSessionHandoffRuntimeConfig } from './sessionHandoff/runtimeConfig';
import { runSessionHandoffPrepareTargetJob } from './sessionHandoff/prepareTargetRunJob';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createMachineTransferRouteCache } from '@/machines/transfer/transferRouteCache';
import { readFile } from 'node:fs/promises';
import { importSessionHandoffAgentBundle } from '@/session/handoff/agentBundle/import';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

describe('same-machine handoff admission', () => {
  it('prepares a home-relative local destination in the actual local home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-local-home-target-'));
    const activeServerDir = join(root, '.happier', 'servers', 'local');
    const handoffId = 'local-home-target';
    const jobId = `prepare_${handoffId}`;
    const targetPath = join(root, 'code', 'my-app');
    const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
    const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
    try {
      vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', join(root, 'claude'));
      runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
      const agentBundle = await sourceExportStore.writeAgentBundleFile({ handoffId,
        agentBundle: { agentId: 'claude', remoteSessionId: 'native-session', transcriptBase64: 'e30K' },
      });
      await sourceExportStore.save({ handoffId, exportedAtMs: 1, sourceMachineId: 'local', targetMachineId: 'local', agentBundle });
      await runSessionHandoffPrepareTargetJob({ activeServerDir, runtimeConfig: { activeServerDir }, jobId, handoffId, createdAtMs: 1,
        request: { handoffId, sourceMachineId: 'local', targetMachineId: 'local', targetPath: '~/code/my-app',
          negotiatedTransportStrategy: 'direct_peer', sourceSessionStorageMode: 'persisted', endpointCandidates: [] },
        actualTransportStrategy: 'direct_peer', pendingStatus: { handoffId, jobId, status: 'pending', phase: 'staging_target', recoveryActions: [] },
        prepareJobStore, sourceExportStore, prepareTargetJobLeaseOwnerId: `local-home-test:${process.pid}`, prepareTargetJobLeaseTtlMs: 5_000,
        machineTransferChannel: undefined, directPeerTransfer: undefined,
        importSessionBundle: (bundle, directory, sessionStorageMode) =>
          importSessionHandoffAgentBundle({ bundle, targetPath: directory, sessionStorageMode }),
        getTransferRouteCache: () => createMachineTransferRouteCache({ serverId: 'local' }),
        invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined,
      });
      const preparedJob = await prepareJobStore.read(jobId);
      expect(preparedJob, preparedJob?.lastErrorMessage).toMatchObject({ status: { status: 'ready_for_cutover' }, prepareTargetResult: { resume: { directory: targetPath, resume: 'native-session' } } });
      const nativeSource = preparedJob?.prepareTargetResult?.directSource;
      if (nativeSource?.kind !== 'claudeConfig' || typeof nativeSource.configDir !== 'string' || typeof nativeSource.projectId !== 'string') {
        throw new Error('Expected prepared Claude native transcript source');
      }
      expect(await readFile(join(nativeSource.configDir, 'projects', nativeSource.projectId, 'native-session.jsonl'), 'utf8')).toBe('{}\n');
    } finally { await runtime?.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([undefined, ' ', 'same-directory'])('rejects local destination %s before source stop', async (destination) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-local-start-'));
    try {
      const sourcePath = join(root, 'code');
      await mkdir(sourcePath);
      const registered = new Map<string, (raw: unknown) => unknown>();
      // The registry, metadata read and process stop are external boundaries; admission stays real.
      const rpcHandlerManager = { registerHandler: (method: string, handler: (raw: unknown) => unknown) => registered.set(method, handler) } as unknown as RpcHandlerManager;
      let stopped = false;
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        runtimeConfig: { ...readSessionHandoffRuntimeConfig(), activeServerDir: join(root, 'server') },
        loadSessionMetadata: async () => ({ machineId: 'local', path: sourcePath }),
        stopSessionForHandoff: async () => { stopped = true; return 'stopped'; },
        directPeerTransfer: { publishTransfer: () => [], clearPublishedTransfer: () => undefined },
        resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true } } } }, capabilities: {} }) }),
      });
      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      if (!start) throw new Error('Missing canonical handoff start');
      await expect(start({ sessionId: 'session', sourceMachineId: 'local', targetMachineId: 'local', targetPath: destination === 'same-directory' ? join(sourcePath, 'child', '..') : destination,
        sessionStorageMode: 'persisted', workspaceAction: { kind: 'none' }, preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer' })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_target_path' });
      expect(stopped).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
