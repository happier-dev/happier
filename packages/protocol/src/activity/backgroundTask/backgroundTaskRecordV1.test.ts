import { describe, expect, it } from 'vitest';

import { AGENT_ACTIVITY_STATUSES_V1 } from '../../sessionAgentActivity/agentActivityStatusV1.js';
import {
  BACKGROUND_TASK_LABEL_MAX,
  BACKGROUND_TASK_SUMMARY_MAX,
  BackgroundTaskKindV1Schema,
  SessionBackgroundTaskRecordV1Schema,
} from './backgroundTaskRecordV1.js';

function validRecord(): Record<string, unknown> {
  return {
    v: 1,
    taskId: 'task_1',
    kind: 'command',
    status: 'running',
    updatedAt: 1_000,
  };
}

describe('activity/background_task.v1 record', () => {
  it('accepts the minimal attested record and invents nothing', () => {
    const parsed = SessionBackgroundTaskRecordV1Schema.parse(validRecord());

    expect(parsed).toEqual({
      v: 1,
      taskId: 'task_1',
      kind: 'command',
      status: 'running',
      updatedAt: 1_000,
    });
  });

  it('keeps a failure that never reported an exit code a complete record, and carries no exit code at all', () => {
    // §4.9 calls failed-without-a-code a designed state, and it is the ONLY state: no Claude task
    // payload and no SDK tool-output schema carries an exit code, so the field was removed rather
    // than shipped optional-and-unwritable. `.strip()` is what makes that stick — a producer that
    // started sending one would have to land the field here first.
    const parsed = SessionBackgroundTaskRecordV1Schema.parse({
      ...validRecord(),
      status: 'failed',
      endedAt: 2_000,
      exitCode: 137,
    });

    expect(Object.keys(parsed)).not.toContain('exitCode');
    expect((parsed as { exitCode?: number }).exitCode).toBeUndefined();
  });

  it('omits a start it never observed rather than borrowing the end instant (D-8)', () => {
    const terminalOnly = SessionBackgroundTaskRecordV1Schema.parse({
      ...validRecord(),
      status: 'succeeded',
      endedAt: 5_000,
      updatedAt: 5_000,
    });

    expect(Object.keys(terminalOnly)).not.toContain('startedAt');

    const withStart = SessionBackgroundTaskRecordV1Schema.parse({
      ...validRecord(),
      startedAt: 4_000,
      endedAt: 5_000,
    });
    expect((withStart as { startedAt?: number }).startedAt).toBe(4_000);
  });

  it('refuses a label longer than the redaction bound, so an unredacted command cannot be persisted', () => {
    expect(SessionBackgroundTaskRecordV1Schema.safeParse({
      ...validRecord(),
      label: 'x'.repeat(BACKGROUND_TASK_LABEL_MAX),
    }).success).toBe(true);
    expect(SessionBackgroundTaskRecordV1Schema.safeParse({
      ...validRecord(),
      label: 'x'.repeat(BACKGROUND_TASK_LABEL_MAX + 1),
    }).success).toBe(false);
    expect(SessionBackgroundTaskRecordV1Schema.safeParse({
      ...validRecord(),
      summary: 'x'.repeat(BACKGROUND_TASK_SUMMARY_MAX + 1),
    }).success).toBe(false);
  });

  it('drops any field the contract does not attest, so nothing unredacted rides along', () => {
    // The three fields below are exactly the ones an implementer reaches for: the raw command the
    // redaction exists to remove, a `cwd` that appears in no observed Claude payload, and the raw
    // provider task type that `kind` replaces. `.strip()` is the persistence chokepoint.
    const parsed = SessionBackgroundTaskRecordV1Schema.parse({
      ...validRecord(),
      rawCommand: 'curl -H "Authorization: hunter2" https://example.test',
      cwd: '/Users/someone/repo',
      taskType: 'local_bash',
    });

    expect(parsed).not.toHaveProperty('rawCommand');
    expect(parsed).not.toHaveProperty('cwd');
    expect(parsed).not.toHaveProperty('taskType');
  });

  it('speaks the one protocol status vocabulary, never a private background-task enum', () => {
    for (const status of AGENT_ACTIVITY_STATUSES_V1) {
      expect(SessionBackgroundTaskRecordV1Schema.safeParse({ ...validRecord(), status }).success).toBe(true);
    }
    // Raw provider terminal words are not the presentation vocabulary; they map at an adapter.
    for (const providerStatus of ['completed', 'stopped', 'killed']) {
      expect(SessionBackgroundTaskRecordV1Schema.safeParse({ ...validRecord(), status: providerStatus }).success).toBe(false);
    }
  });

  it('stores a classified presentation bucket, never the raw provider task type', () => {
    for (const kind of ['command', 'monitoring', 'unknown']) {
      expect(BackgroundTaskKindV1Schema.safeParse(kind).success).toBe(true);
    }
    for (const rawTaskType of ['local_bash', 'shell', 'monitor_mcp', 'local_workflow']) {
      expect(BackgroundTaskKindV1Schema.safeParse(rawTaskType).success).toBe(false);
    }
  });

  it('requires the identity and freshness a reader cannot do without', () => {
    for (const missing of ['v', 'taskId', 'kind', 'status', 'updatedAt']) {
      const payload = validRecord();
      delete payload[missing];
      expect(SessionBackgroundTaskRecordV1Schema.safeParse(payload).success).toBe(false);
    }
    expect(SessionBackgroundTaskRecordV1Schema.safeParse({ ...validRecord(), taskId: '   ' }).success).toBe(false);
    expect(SessionBackgroundTaskRecordV1Schema.safeParse({ ...validRecord(), v: 2 }).success).toBe(false);
  });
});
