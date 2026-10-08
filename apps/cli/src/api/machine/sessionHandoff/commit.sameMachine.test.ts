import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffCommitActionHandler } from './commit';
import { createSessionHandoffAbortActionHandler } from './abort';
import { buildPrepareJobRecord, buildSourceExportOnlyPrepareJobId, buildStartPendingStatus, invalidRequest, readPersistedPrepareJob } from './prepareTargetState';

describe('same-machine handoff terminal ownership', () => {
  it.each([true, false])('cleans up source state without stopping a local successor (same machine: %s)', async (sameMachine) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-local-commit-'));
    try {
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
      const handoffId = 'local-move';
      await sourceExportStore.save({ handoffId, sessionId: 'session', sourceMachineId: 'source', targetMachineId: sameMachine ? 'source' : 'target', exportedAtMs: 1 });
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId: 'prepare_local-move', handoffId, createdAtMs: 1,
        status: { handoffId, status: 'ready_for_cutover', phase: 'staging_target', recoveryActions: [] },
      }));
      let running = true;
      let stops = 0;
      const deps = { activeServerDir, prepareJobStore, sourceExportStore, directPeerTransfer: undefined,
        readPersistedPrepareJob, buildPrepareJobRecord, buildStartPendingStatus, buildSourceExportOnlyPrepareJobId,
        invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined, invalidRequest,
        stopSessionForHandoff: async () => { stops++; running = false; return 'stopped' as const; },
      };
      const commit = createSessionHandoffCommitActionHandler(deps);
      if (sameMachine) {
        await expect(commit({ handoffId, mode: 'source_cleanup' })).resolves.toMatchObject({ ok: false, errorCode: 'not_ready' });
        expect(running).toBe(true);
      }
      await expect(commit({ handoffId, mode: 'target' })).resolves.toMatchObject({ status: { status: 'completed' } });
      for (let retry = 0; retry < 2; retry++) {
        await expect(commit({ handoffId, mode: 'source_cleanup' })).resolves.toMatchObject({ status: { status: 'completed' } });
      }
      expect(running).toBe(sameMachine);
      expect(stops).toBe(sameMachine ? 0 : 2);
      const job = await prepareJobStore.findByHandoffId(handoffId);
      expect(job?.status.status).toBe('completed');
      if (sameMachine) {
        await expect(createSessionHandoffAbortActionHandler(deps)({ handoffId, reason: 'late cancellation' })).resolves.toMatchObject({ status: { status: 'completed' } });
        expect((await prepareJobStore.findByHandoffId(handoffId))?.status.status).toBe('completed');
        expect(running).toBe(true);
      }
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
});
