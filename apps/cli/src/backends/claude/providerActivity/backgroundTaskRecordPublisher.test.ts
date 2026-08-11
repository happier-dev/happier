import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';
import type { SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol';

import { CliClientUpgradeRequiredError } from '@/api/clientCompatibility/cliClientCompatibility';
import { createHttpStatusError, createInvalidResponseShapeError } from '@/api/client/httpStatusError';

import { createBackgroundTaskRecordPublisher } from './backgroundTaskRecordPublisher';
import type { ClaudeBackgroundTaskFact } from './claudeBackgroundTaskEvent';

function started(overrides: Partial<Extract<ClaudeBackgroundTaskFact, { type: 'started' }>> = {}) {
  return {
    type: 'started' as const,
    sessionId: 'claude-session-1',
    taskId: 'task_1',
    kind: 'command' as const,
    label: 'grep -rn "thing"',
    toolUseId: 'toolu_1',
    ...overrides,
  };
}

/** Publisher over an in-memory commit sink and a 1s-per-observation clock. */
function createHarness(options: Readonly<{
  isOwnedSessionId?: (sessionId: string) => boolean;
}> = {}) {
  const committed: SessionBackgroundTaskRecordV1[] = [];
  let clock = 1_000;
  const publisher = createBackgroundTaskRecordPublisher({
    commitRecord: async (record) => { committed.push(record); },
    ...(options.isOwnedSessionId ? { isOwnedSessionId: options.isOwnedSessionId } : {}),
    now: () => (clock += 1_000),
  });
  return { publisher, committed };
}

describe('createBackgroundTaskRecordPublisher', () => {
  it('persists a started headless command with an observed start and no invented fields', async () => {
    const { publisher, committed } = createHarness();

    publisher.observe(started());
    await publisher.flush();

    expect(committed).toHaveLength(1);
    expect(committed[0]).toEqual({
      v: 1,
      taskId: 'task_1',
      kind: 'command',
      status: 'running',
      label: 'grep -rn "thing"',
      startedAt: 2_000,
      updatedAt: 2_000,
    });
    // No `cwd`, no output, no exit code, no end time: none of them are attested at a start.
    expect(Object.keys(committed[0]!).sort()).toEqual(
      ['kind', 'label', 'startedAt', 'status', 'taskId', 'updatedAt', 'v'],
    );
  });

  it('redacts a credential out of the PERSISTED record, not merely out of the display', async () => {
    // The deciding security check for R-9. Assertion is on the bytes handed to `commitRecord` —
    // the last thing before sealing and the wire — so a redactor wired only into a renderer fails.
    const { publisher, committed } = createHarness();

    publisher.observe(started({
      label: 'curl -H "Authorization: Bearer sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE" https://example.test --token=ghp_FAKEFAKEFAKEFAKEFAKEFAKE0000',
    }));
    await publisher.flush();

    const label = committed[0]?.label ?? '';
    expect(label).not.toContain('sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE');
    expect(label).not.toContain('ghp_FAKEFAKEFAKEFAKEFAKEFAKE0000');
    expect(label).toContain('[REDACTED]');
    expect(label).toContain('curl');
  });

  it('collapses this machine\'s home directory out of the persisted label', async () => {
    const { publisher, committed } = createHarness();

    publisher.observe(started({ label: `tail -f ${homedir()}/logs/app.log` }));
    await publisher.flush();

    expect(committed[0]?.label).toBe('tail -f ~/logs/app.log');
  });

  it('maps provider terminal words into the one status vocabulary', async () => {
    for (const [terminal, status] of [
      ['completed', 'succeeded'],
      ['failed', 'failed'],
      // A stop is the user's own action: PLAN 4.2 forbids painting it danger.
      ['stopped', 'cancelled'],
    ] as const) {
      const { publisher, committed } = createHarness();
      publisher.observe(started());
      publisher.observe({
        type: 'terminal',
        sessionId: 'claude-session-1',
        taskId: 'task_1',
        status: terminal,
        summary: 'Background command completed',
        endedAt: null,
      });
      await publisher.flush();

      const last = committed.at(-1);
      expect(last?.status).toBe(status);
      expect(last?.summary).toBe('Background command completed');
      // No provider end time on `task_notification`, so the observation instant is used - and the
      // start is the one that was observed, never borrowed from the end (D-8).
      expect(last?.endedAt).toBe(3_000);
      expect(last?.startedAt).toBe(2_000);
    }
  });

  it('never records agent-flavoured or inert work, and never invents a task from a terminal alone', async () => {
    const { publisher, committed } = createHarness();

    publisher.observe(started({ taskId: 'agent_1', kind: 'agent' }));
    publisher.observe(started({ taskId: 'plan_1', kind: 'inert' }));
    publisher.observe({
      type: 'terminal',
      sessionId: 'claude-session-1',
      taskId: 'never-started',
      status: 'completed',
      summary: 'done',
      endedAt: null,
    });
    publisher.observe({
      type: 'progress',
      sessionId: 'claude-session-1',
      taskId: 'never-started',
      detail: 'Reading logs',
    });
    await publisher.flush();

    expect(committed).toEqual([]);
  });

  it('drops a foreign session so another session cannot write into this history', async () => {
    const { publisher, committed } = createHarness({
      isOwnedSessionId: (sessionId) => sessionId === 'claude-session-1',
    });

    publisher.observe(started({ sessionId: 'claude-session-2', taskId: 'foreign' }));
    publisher.observe(started({ taskId: 'own' }));
    await publisher.flush();

    expect(committed.map((record) => record.taskId)).toEqual(['own']);
  });

  it('keeps a late duplicate start from un-terminalling a settled task', async () => {
    // PLAN 4.9.3: a terminal status comes from evidence and nothing walks it back. A replayed or
    // re-delivered `task_started` must not put a finished command back into `running`.
    const { publisher, committed } = createHarness();

    publisher.observe(started());
    publisher.observe({
      type: 'terminal',
      sessionId: 'claude-session-1',
      taskId: 'task_1',
      status: 'completed',
      summary: null,
      endedAt: null,
    });
    publisher.observe(started());
    await publisher.flush();

    expect(committed.at(-1)?.status).toBe('succeeded');
    expect(committed.at(-1)?.startedAt).toBe(2_000);
  });

  it('isolates a failed write to its own task and retries only that one', async () => {
    const failures = new Map<string, number>([['task_flaky', 1]]);
    const attempts: string[] = [];
    const committed: SessionBackgroundTaskRecordV1[] = [];
    let clock = 1_000;
    const publisher = createBackgroundTaskRecordPublisher({
      commitRecord: async (record) => {
        attempts.push(record.taskId);
        const remaining = failures.get(record.taskId) ?? 0;
        if (remaining > 0) {
          failures.set(record.taskId, remaining - 1);
          throw new Error('transient upsert failure');
        }
        committed.push(record);
      },
      debounceMs: 1,
      onError: () => {},
      now: () => (clock += 1_000),
    });

    publisher.observe(started({ taskId: 'task_flaky' }));
    publisher.observe(started({ taskId: 'task_ok' }));
    await publisher.flush();

    // Both land, and the healthy task was written exactly once: a neighbour's failure never
    // re-drives it, so retries cannot amplify into repeated writes across the whole task set.
    expect(committed.map((record) => record.taskId).sort()).toEqual(['task_flaky', 'task_ok']);
    expect(attempts.filter((taskId) => taskId === 'task_ok')).toHaveLength(1);
    expect(attempts.filter((taskId) => taskId === 'task_flaky')).toHaveLength(2);
    publisher.dispose();
  });

  it('drops a permanently rejected record instead of re-queueing it, and still retries a transport failure', async () => {
    // A server released before `activity/background_task.v1` existed rejects the unregistered kind
    // at `registerSessionSystemRecordRoutes` (`safeParse` -> 400), which
    // `sessionSystemRecordsHttp#handleCommonStatus` throws as an `HttpStatusError`. Re-queueing that
    // is a 300 ms PUT loop per task for the session's lifetime: the same bytes are rejected every
    // time. The record is dropped instead - absent row, degraded UI, no storm - while a 5xx or a
    // statusless transport failure is still retried.
    const attempts: string[] = [];
    const committed: SessionBackgroundTaskRecordV1[] = [];
    const errors: Array<{ taskId: string; retryable: boolean }> = [];
    let transientFailuresLeft = 1;
    let clock = 1_000;
    const publisher = createBackgroundTaskRecordPublisher({
      commitRecord: async (record) => {
        attempts.push(record.taskId);
        if (record.taskId === 'task_rejected') {
          throw createHttpStatusError(400, 'Unexpected status from /v2/sessions/s/system-records: 400');
        }
        if (transientFailuresLeft > 0) {
          transientFailuresLeft -= 1;
          throw createHttpStatusError(503, 'Unexpected status from /v2/sessions/s/system-records: 503');
        }
        committed.push(record);
      },
      debounceMs: 1,
      onError: (_error, context) => { errors.push({ ...context }); },
      now: () => (clock += 1_000),
    });

    publisher.observe(started({ taskId: 'task_rejected' }));
    publisher.observe(started({ taskId: 'task_transient' }));
    await publisher.flush();

    expect(attempts.filter((taskId) => taskId === 'task_rejected')).toHaveLength(1);
    expect(attempts.filter((taskId) => taskId === 'task_transient')).toHaveLength(2);
    expect(committed.map((record) => record.taskId)).toEqual(['task_transient']);
    // The failure class is reported, so the wiring's log cannot promise a retry that never comes.
    expect(errors).toContainEqual({ taskId: 'task_rejected', retryable: false });
    expect(errors).toContainEqual({ taskId: 'task_transient', retryable: true });
    publisher.dispose();
  });

  it('drops the two permanent refusals that carry no `response.status`: a 426 upgrade and an unparseable body', async () => {
    // Both shapes come out of the REAL transport (`sessionSystemRecordsHttp`) and neither looks
    // like an `HttpStatusError`. A well-formed 426 is thrown by the compatibility check before any
    // status branch and carries `statusCode` at the top level; a 200 whose body this build cannot
    // parse carries no status at all. Classified as blips, each becomes the same per-task 300 ms
    // PUT loop for the session's lifetime - the storm F3 was supposed to end.
    const attempts: string[] = [];
    const errors: Array<{ taskId: string; retryable: boolean }> = [];
    let clock = 1_000;
    const publisher = createBackgroundTaskRecordPublisher({
      commitRecord: async (record) => {
        attempts.push(record.taskId);
        if (record.taskId === 'task_upgrade') {
          throw new CliClientUpgradeRequiredError({
            error: 'client-upgrade-required',
            requirement: {
              v: 1,
              clientKind: 'session-runner',
              minimumAppVersion: '9.0.0',
              updateUrl: null,
            },
          });
        }
        throw createInvalidResponseShapeError('Unexpected /v2/sessions/s/system-records response shape');
      },
      debounceMs: 1,
      onError: (_error, context) => { errors.push({ ...context }); },
      now: () => (clock += 1_000),
    });

    publisher.observe(started({ taskId: 'task_upgrade' }));
    publisher.observe(started({ taskId: 'task_malformed' }));
    await publisher.flush();
    // Long enough for several debounce intervals: a re-queued task would show a second attempt.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(attempts).toEqual(['task_upgrade', 'task_malformed']);
    expect(errors).toEqual([
      { taskId: 'task_upgrade', retryable: false },
      { taskId: 'task_malformed', retryable: false },
    ]);
    publisher.dispose();
  });

  it('retries a rate-limited write, which is a 4xx that explicitly asks to be retried', async () => {
    const attempts: string[] = [];
    const committed: SessionBackgroundTaskRecordV1[] = [];
    let rateLimitsLeft = 1;
    let clock = 1_000;
    const publisher = createBackgroundTaskRecordPublisher({
      commitRecord: async (record) => {
        attempts.push(record.taskId);
        if (rateLimitsLeft > 0) {
          rateLimitsLeft -= 1;
          throw createHttpStatusError(429, 'Too many requests');
        }
        committed.push(record);
      },
      debounceMs: 1,
      onError: () => {},
      now: () => (clock += 1_000),
    });

    publisher.observe(started({ taskId: 'task_throttled' }));
    await publisher.flush();

    expect(attempts).toEqual(['task_throttled', 'task_throttled']);
    expect(committed.map((record) => record.taskId)).toEqual(['task_throttled']);
    publisher.dispose();
  });

  it('stops writing after dispose', async () => {
    const { publisher, committed } = createHarness();
    publisher.dispose();

    publisher.observe(started());
    await publisher.flush();

    expect(committed).toEqual([]);
  });
});
