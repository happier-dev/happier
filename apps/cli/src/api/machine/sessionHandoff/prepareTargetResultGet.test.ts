import { describe, expect, it, vi } from 'vitest';

import { SessionHandoffPrepareTargetResultGetResponseSchema } from '@happier-dev/protocol';

import { createSessionHandoffPrepareTargetResultGetActionHandler } from './prepareTargetResultGet';

describe('prepareTargetResultGet typed native-import failures', () => {
  it.each([
    ['target_identity_conflict', 'reconciliation_required'],
    ['agent_version_unsupported', 'failed'],
  ] as const)('returns durable failure %s without continuing native work', async (code, statusCode) => {
    const persistedJob = {
      schemaVersion: 1 as const,
      jobId: `prepare_${code}`,
      handoffId: `handoff_${code}`,
      createdAtMs: 1,
      updatedAtMs: 2,
      failedAtMs: 2,
      lastErrorMessage: 'Safe native import failure',
      status: {
        handoffId: `handoff_${code}`,
        jobId: `prepare_${code}`,
        status: statusCode,
        phase: 'staging_target' as const,
        recoveryActions: [],
        failure: { code },
      },
    };
    const handler = createSessionHandoffPrepareTargetResultGetActionHandler({
      prepareJobStore: {} as never,
      readPersistedPrepareJob: vi.fn(async () => persistedJob),
      isTerminalHandoffStatus: () => true,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
    });

    await expect(handler({ handoffId: persistedJob.handoffId })).resolves.toEqual({
      ok: false,
      errorCode: code,
      error: 'Safe native import failure',
    });
  });

  it.each([
    ['not_found', null, false],
    ['awaiting_recovery', {
      schemaVersion: 1 as const,
      jobId: 'prepare_awaiting_recovery',
      handoffId: 'handoff_awaiting_recovery',
      createdAtMs: 1,
      updatedAtMs: 2,
      lastErrorMessage: 'Prepare-target job is awaiting_recovery',
      status: {
        handoffId: 'handoff_awaiting_recovery',
        jobId: 'prepare_awaiting_recovery',
        status: 'awaiting_recovery' as const,
        phase: 'staging_target' as const,
        recoveryActions: [],
      },
    }, true],
  ] as const)('keeps handler output %s inside the shared result-get schema', async (
    errorCode,
    persistedJob,
    isTerminal,
  ) => {
    const handler = createSessionHandoffPrepareTargetResultGetActionHandler({
      prepareJobStore: {} as never,
      readPersistedPrepareJob: vi.fn(async () => persistedJob),
      isTerminalHandoffStatus: () => isTerminal,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
    });

    const raw = await handler({
      handoffId: persistedJob?.handoffId ?? 'handoff_not_found',
    });

    expect(raw).toMatchObject({ ok: false, errorCode });
    expect(SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(raw).success).toBe(true);
  });

  it('returns the exact deferred source failure code persisted by the start job', async () => {
    const persistedJob = {
      schemaVersion: 1 as const,
      jobId: 'start_handoff_late',
      handoffId: 'handoff_late',
      createdAtMs: 1,
      updatedAtMs: 2,
      failedAtMs: 2,
      lastErrorMessage: 'Failed to stop the active source session before handoff cutover',
      lastErrorCode: 'source_stop_failed',
      status: {
        handoffId: 'handoff_late',
        jobId: 'start_handoff_late',
        status: 'awaiting_recovery' as const,
        phase: 'preparing' as const,
        recoveryActions: ['restart_on_source', 'keep_stopped'] as const,
      },
    };
    const handler = createSessionHandoffPrepareTargetResultGetActionHandler({
      prepareJobStore: {} as never,
      readPersistedPrepareJob: vi.fn(async () => persistedJob),
      isTerminalHandoffStatus: () => true,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
    });

    await expect(handler({ handoffId: 'handoff_late' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'source_stop_failed',
    });
  });
});
