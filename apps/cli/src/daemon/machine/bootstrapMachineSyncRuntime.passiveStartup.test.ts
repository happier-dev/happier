import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';
import { UsageLimitRecoveryScheduler, type UsageLimitRecoveryIntent } from '../connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';

describe('bootstrapMachineSyncRuntime passive startup', () => {
  it.each([500, 2_000])('re-arms persisted usage-limit deadline %s without synchronous recovery', async deadline => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let stored: UsageLimitRecoveryIntent = { v: 1, status: 'waiting', issueFingerprint: 'original-failure', armedAtMs: 100,
      resetAtMs: deadline, nextCheckAtMs: deadline, attemptCount: 0, maxAttempts: 3, lastProbeError: null,
      resumePromptMode: 'standard', selectedAuth: { kind: 'native' } };
    const recover = vi.fn(async () => ({ status: 'superseded' as const }));
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: Date.now, recover,
      store: { read: () => stored, readAll: () => [['session', stored]], write: (_key, value) => { stored = value; } } });
    try {
      scheduler.hydratePassive();
      expect(vi.getTimerCount()).toBe(0);
      scheduler.hydrate();
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(Math.max(0, deadline - 1_000));
      expect(recover).toHaveBeenCalledOnce();
    } finally { scheduler.dispose(); vi.useRealTimers(); }
  });

  it('keeps the speech-transcription peer media consumer wired into the relay terminator', async () => {
    const source = await readFile(new URL('./bootstrapMachineSyncRuntime.ts', import.meta.url), 'utf8');
    expect(source).toContain('voiceBinaryAppendConsumer');
  });
});
