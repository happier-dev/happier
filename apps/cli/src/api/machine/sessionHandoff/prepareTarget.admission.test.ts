import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMachineTransferRouteCache } from '@/machines/transfer/transferRouteCache';
import { importSessionHandoffAgentBundle } from '@/session/handoff/agentBundle/import';
import {
  releaseSessionHandoffPrepareTargetJobLease,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobLease';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';

import { createSessionHandoffPrepareTargetActionHandler } from './prepareTarget';

describe('prepare-target direct-peer admission', () => {
  it('rejects missing endpoints before accepting a job even when a competing runner holds the lease', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-admission-'));
    const handoffId = 'handoff_missing_endpoints';
    const jobId = `prepare_${handoffId}`;
    const ownerId = 'test-competing-handoff-runner';
    const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
    const routeCache = createMachineTransferRouteCache({ serverId: 'test-server' });
    const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
      activeServerDir, jobId, ownerId, nowMs: Date.now(),
    });
    if (!leaseAttempt.acquired) throw new Error('Expected isolated handoff runner lease');

    try {
      const handler = createSessionHandoffPrepareTargetActionHandler({
        prepareJobStore,
        sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }),
        activePrepareJobs: new Map(),
        prepareTargetJobLeaseOwnerId: 'test-target-runner',
        prepareTargetJobLeaseTtlMs: 5_000,
        runtimeConfig: { activeServerDir },
        machineTransferChannel: undefined,
        directPeerTransfer: {
          publishTransfer: () => [],
          clearPublishedTransfer: () => undefined,
          requestPayloadFile: async () => {
            throw new Error('Missing endpoints must not reach the transport boundary');
          },
        },
        importSessionBundle: (bundle, targetPath, sessionStorageMode) =>
          importSessionHandoffAgentBundle({ bundle, targetPath, sessionStorageMode }),
        getTransferRouteCache: () => routeCache,
        invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined,
      });

      await expect(handler.handle({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: `session-handoff:${handoffId}:agent-bundle-file`,
            sizeBytes: 0,
            manifestHash: `sha256:${'0'.repeat(64)}`,
          },
        },
      })).resolves.toEqual({
        ok: false,
        errorCode: 'direct_peer_transfer_unavailable',
        error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
      });
      await expect(prepareJobStore.read(jobId)).resolves.toBeNull();
    } finally {
      await releaseSessionHandoffPrepareTargetJobLease({
        activeServerDir, jobId, ownerId,
      });
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
