import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createSessionHandoffPrepareTargetJobStore } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { resolvePrepareTargetResponse } from './prepareTargetResponse';

describe('prepare target completion response', () => {
  it('preserves a settled recovery failure instead of projecting it back to pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-handoff-response-'));
    try {
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir: root });
      const pendingStatus = { handoffId: 'handoff-response', status: 'pending' as const, phase: 'staging_target' as const, recoveryActions: [] };
      const failedStatus = { ...pendingStatus, status: 'awaiting_recovery' as const, recoveryActions: ['restart_on_source' as const] };
      await prepareJobStore.write({ jobId: 'prepare_response', handoffId: pendingStatus.handoffId,
        createdAtMs: Date.now(), updatedAtMs: Date.now(), completedAtMs: Date.now(),
        status: failedStatus, lastErrorMessage: 'Import failed', lastErrorCode: 'native_import_failed' });
      await expect(resolvePrepareTargetResponse({ handoffId: pendingStatus.handoffId,
        jobId: 'prepare_response', pendingStatus, prepareJobStore })).resolves.toMatchObject({ status: failedStatus });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns the admitted pending job without creating a fast-return timer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-handoff-response-wait-'));
    const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir: root });
    const pendingStatus = { handoffId: 'handoff-wait', status: 'pending' as const, phase: 'staging_target' as const, recoveryActions: [] };
    await prepareJobStore.write({ jobId: 'prepare_wait', handoffId: pendingStatus.handoffId,
      createdAtMs: Date.now(), updatedAtMs: Date.now(), status: pendingStatus });
    let response: ReturnType<typeof resolvePrepareTargetResponse> | undefined;
    vi.useFakeTimers();
    try {
      response = resolvePrepareTargetResponse({ handoffId: pendingStatus.handoffId,
        jobId: 'prepare_wait', pendingStatus, prepareJobStore });
      expect(vi.getTimerCount()).toBe(0);
      await expect(response).resolves.toMatchObject({ status: pendingStatus });
    } finally {
      await response?.catch(() => undefined);
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
