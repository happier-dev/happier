import { describe, expect, it, vi } from 'vitest';

import { createSessionHandoffPrepareTargetResumeActionHandler } from './prepareTargetResume';

describe('prepare-target interrupted Resume action', () => {
  it('rejects stale, conflicting, and malformed requests before continuation effects', async () => {
    const continuePrepare = vi.fn(async () => undefined);
    const acceptPrepareTargetResume = vi.fn(async (input: Readonly<{ attemptId: string }>) => {
      if (input.attemptId === 'io-failure') {
        throw new Error('durable store unavailable');
      }
      if (input.attemptId === 'stale') {
        return { ok: false, errorCode: 'stale_revision' } as const;
      }
      return { ok: false, errorCode: 'attempt_conflict' } as const;
    });
    const handler = createSessionHandoffPrepareTargetResumeActionHandler({
      prepareJobStore: { acceptPrepareTargetResume } as never,
      resumePersistedPrepareTarget: continuePrepare,
      nowMs: () => 100,
    });

    await expect(handler({
      handoffId: 'handoff-1',
      jobId: 'prepare_handoff-1',
      expectedRevision: 0,
      attemptId: 'stale',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_revision' },
    });
    await expect(handler({
      handoffId: 'handoff-1',
      jobId: 'prepare_handoff-1',
      expectedRevision: 0,
      attemptId: 'other',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'attempt_conflict' },
    });
    await expect(handler({
      handoffId: 'handoff-1',
      jobId: 'prepare_handoff-1',
      expectedRevision: 0,
      attemptId: 'io-failure',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
    await expect(handler({
      handoffId: 'handoff-1',
      jobId: 'prepare_handoff-1',
      expectedRevision: 0,
      attemptId: 'stale',
      sessionId: 'forbidden-client-authority',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(continuePrepare).not.toHaveBeenCalled();
  });

  it('acknowledges the durable attempt transition before starting one in-daemon continuation', async () => {
    let accepted = false;
    let finishContinuation!: () => void;
    const continuationFinished = new Promise<void>((resolve) => {
      finishContinuation = resolve;
    });
    const record = {
      schemaVersion: 2,
      recordKind: 'legacy_target',
      jobId: 'prepare_handoff-1',
      handoffId: 'handoff-1',
      transitionRevision: 8,
      prepareRecovery: {
        status: 'attempted',
        attemptId: 'attempt-1',
        acceptedAtMs: 100,
        acceptedRevision: 7,
      },
      status: {
        handoffId: 'handoff-1',
        jobId: 'prepare_handoff-1',
        status: 'pending',
        phase: 'staging_target',
        recoveryActions: [],
      },
    } as const;
    const continuePrepare = vi.fn(async () => {
      expect(accepted).toBe(true);
      await continuationFinished;
    });
    const handler = createSessionHandoffPrepareTargetResumeActionHandler({
      prepareJobStore: {
        acceptPrepareTargetResume: vi.fn(async () => {
          accepted = true;
          return { ok: true, disposition: 'accepted', record } as never;
        }),
      } as never,
      resumePersistedPrepareTarget: continuePrepare as never,
      nowMs: () => 100,
    });
    const request = {
      handoffId: 'handoff-1',
      jobId: 'prepare_handoff-1',
      expectedRevision: 7,
      attemptId: 'attempt-1',
    };

    await expect(handler(request)).resolves.toEqual({
      ok: true,
      handoffId: 'handoff-1',
      jobId: 'prepare_handoff-1',
      transitionRevision: 8,
      status: record.status,
    });
    await expect(handler(request)).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(continuePrepare).toHaveBeenCalledTimes(1));
    finishContinuation();
  });

  it('rejoins the same accepted attempt after a daemon crash between acknowledgement and continuation', async () => {
    const record = {
      schemaVersion: 2,
      recordKind: 'legacy_target',
      jobId: 'prepare_handoff-crash',
      handoffId: 'handoff-crash',
      transitionRevision: 4,
      prepareRecovery: {
        status: 'attempted',
        attemptId: 'attempt-crash',
        acceptedAtMs: 100,
        acceptedRevision: 3,
      },
      status: {
        handoffId: 'handoff-crash',
        jobId: 'prepare_handoff-crash',
        status: 'pending',
        phase: 'staging_target',
        recoveryActions: [],
      },
    } as const;
    const continuePrepare = vi.fn(async () => undefined);
    const handlerAfterRestart = createSessionHandoffPrepareTargetResumeActionHandler({
      prepareJobStore: {
        acceptPrepareTargetResume: vi.fn(async () => ({
          ok: true,
          disposition: 'replay',
          record,
        }) as never),
      } as never,
      resumePersistedPrepareTarget: continuePrepare as never,
      nowMs: () => 200,
    });

    await expect(handlerAfterRestart({
      handoffId: 'handoff-crash',
      jobId: 'prepare_handoff-crash',
      expectedRevision: 3,
      attemptId: 'attempt-crash',
    })).resolves.toMatchObject({
      ok: true,
      transitionRevision: 4,
    });
    await vi.waitFor(() => expect(continuePrepare).toHaveBeenCalledTimes(1));
  });
});
