import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMachineTransferRouteCache } from '@/machines/transfer/transferRouteCache';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { runSessionHandoffPrepareTargetJob } from './prepareTargetRunJob';
import { buildPrepareJobRecord } from './prepareTargetState';

describe('existing native state target acquisition', () => {
  it.each(['ready', 'cancelled', 'missing'] as const)('reuses the ordinary target completion and recovery owner when native state is %s', async (outcome) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-existing-target-'));
    try {
      const handoffId = 'existing'; const jobId = 'prepare_existing';
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const nativePath = join(activeServerDir, 'native-state'); await writeFile(nativePath, 'native bytes');
      const pendingStatus = { handoffId, jobId, status: 'pending' as const, phase: 'staging_target' as const, recoveryActions: [] };
      await prepareJobStore.write(buildPrepareJobRecord({ handoffId, jobId, createdAtMs: 1, status: pendingStatus }));
      const request = { handoffId, sessionId: 'session', sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/target',
        stateTransfer: 'existing' as const, sourceSessionStorageMode: 'persisted' as const, negotiatedTransportStrategy: 'direct_peer' as const, endpointCandidates: [] };
      await runSessionHandoffPrepareTargetJob({ activeServerDir, runtimeConfig: { activeServerDir }, handoffId, jobId, createdAtMs: 1,
        request, pendingStatus, actualTransportStrategy: 'direct_peer', prepareJobStore,
        sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }), prepareTargetJobLeaseOwnerId: 'target-test', prepareTargetJobLeaseTtlMs: 5_000,
        machineTransferChannel: undefined, directPeerTransfer: undefined,
        importSessionBundle: async () => { throw new Error('No-transfer target attempted native import'); },
        resolveExistingSessionState: async () => {
          if (outcome === 'missing') throw Object.assign(new Error('Native state absent'), { code: 'existing_session_state_unavailable' });
          expect(await readFile(nativePath, 'utf8')).toBe('native bytes');
          if (outcome === 'cancelled') await prepareJobStore.update(jobId, (record) => record ? { ...record, cancelRequestedAtMs: 2 } : record);
          return { remoteSessionId: 'native', directSource: { kind: 'claudeConfig' as const, configDir: activeServerDir },
            resume: { agent: 'claude', directory: '/target', resume: 'native', approvedNewDirectoryCreation: true as const, transcriptStorage: 'persisted' as const } };
        },
        getTransferRouteCache: () => createMachineTransferRouteCache({ serverId: 'test' }), invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined,
      });
      const record = await prepareJobStore.read(jobId);
      expect(record?.prepareTargetRequest).toMatchObject({ sessionId: 'session', stateTransfer: 'existing' });
      if (outcome === 'ready') {
        expect(record?.lastErrorMessage).toBeUndefined();
        expect(record?.status).toMatchObject({ status: 'ready_for_cutover', progress: { current: { phaseDetail: 'ready_for_cutover' } } });
        expect(record?.prepareTargetResult?.resume.resume).toBe('native');
      } else {
        expect(record?.prepareTargetResult).toBeUndefined();
        expect(record?.status.status).toBe(outcome === 'cancelled' ? 'aborted' : 'failed');
        if (outcome === 'missing') expect(record?.lastErrorCode).toBe('existing_session_state_unavailable');
      }
      expect(await readFile(nativePath, 'utf8')).toBe('native bytes');
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
});
