import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectedServiceTemporaryThrottleRetryScheduler } from './temporaryThrottleRetryScheduler';
import { routeSessionUsageLimitRecoveryWaitResumeCancel } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

function createMemoryStore() {
  const persisted = new Map<string, unknown>();
  return {
    persisted,
    store: {
      read: (sessionId: string) => persisted.get(sessionId) ?? null,
      readAll: () => [...persisted.entries()],
      write: (sessionId: string, intent: unknown) => {
        persisted.set(sessionId, intent);
      },
      remove: (sessionId: string) => {
        persisted.delete(sessionId);
      },
    },
  };
}

describe('ConnectedServiceTemporaryThrottleRetryScheduler', () => {
  it('pushes Run waiting only after persistence while leaving native recovery pending', async () => {
    const memory = createMemoryStore();
    let releaseWrite!: () => void;
    const writeReady = new Promise<void>(resolve => { releaseWrite = resolve; });
    let writing = false;
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => Date.now(),
      store: { ...memory.store, write: async (key, intent) => {
        writing = true;
        await writeReady;
        memory.store.write(key, intent);
      } }, resume: async () => ({ status: 'continued' }) });
    const waiting: SessionUsageLimitRecoveryV1[] = [];
    const controller = new AbortController();
    let completed = false;
    const pending = scheduler.waitForRecovery({ scope: { kind: 'run', runId: 'waiting-progress' },
      serviceId: 'happier.agent.claude/anthropic', profileId: 'profile', groupId: null, issueFingerprint: 'weekly-quota',
      resetAtMs: Date.now() + 86_400_000,
      continuation: { interruptedOriginId: 'turn', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'usage_limit' },
    }, controller.signal, recovery => { waiting.push(recovery); }).then(result => { completed = true; return result; });
    try {
      await vi.waitFor(() => expect(writing).toBe(true));
      expect(waiting).toEqual([]);
      releaseWrite();
      await vi.waitFor(() => expect(scheduler.read('run:waiting-progress')?.status).toBe('waiting'));
      await vi.waitFor(() => expect(waiting).toHaveLength(1));
      expect(waiting[0]).toMatchObject({ v: 1, status: 'waiting', attemptCount: 0,
        nextCheckAtMs: expect.any(Number), selectedAuth: { kind: 'profile', serviceId: 'happier.agent.claude/anthropic', profileId: 'profile' } });
      expect(completed).toBe(false);
      expect(controller.signal.aborted).toBe(false);
      await scheduler.finishRun('waiting-progress');
      await expect(pending).resolves.toEqual({ status: 'cancelled' });
    } finally { releaseWrite(); await scheduler.finishRun('waiting-progress'); scheduler.dispose(); }
  });

  it('does not publish a recovery change when Stop cancels an absent durable intent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'throttle-stop-'));
    const changes: unknown[] = [];
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => 1_000,
      store: createRecoveryIntentFileStore(join(directory, 'intents.json')),
      onStateChange: (_sessionId, intent, previous) => { changes.push({ intent, previous }); },
      resume: async () => ({ status: 'continued' }),
    });
    try {
      await expect(scheduler.cancel({ sessionId: 'never-throttled' })).resolves.toBeNull();
      expect(changes).toEqual([]);
      expect(scheduler.read('never-throttled')).toBeNull();
    } finally {
      scheduler.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits and cancels a Run independently of its parent Session through the same recovery owner', async () => {
    vi.useFakeTimers();
    const { store, persisted } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => Date.now(), store,
      resume: async () => ({ status: 'continued' }) });
    const continuation = { interruptedOriginId: 'turn', resumePromptMode: 'standard' as const, customResumePrompt: null, recoveryKind: 'capacity' as const };
    try {
      await scheduler.enable({ sessionId: 'parent', serviceId: 'service', profileId: 'member', groupId: null, issueFingerprint: 'capacity', continuation });
      const controller = new AbortController();
      const wait = scheduler.waitForRecovery({ scope: { kind: 'run', runId: 'child' }, serviceId: 'service', profileId: 'member', groupId: null,
        issueFingerprint: 'capacity', continuation }, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect([...persisted.values()]).toContainEqual(expect.objectContaining({ scope: { kind: 'run', runId: 'child' }, status: 'waiting' }));
      controller.abort();
      await expect(wait).resolves.toEqual({ status: 'cancelled' });
      expect(scheduler.read('parent')?.status).toBe('waiting');
      const resumed = scheduler.waitForRecovery({ scope: { kind: 'run', runId: 'another-child' }, serviceId: 'service', profileId: 'member', groupId: null,
        issueFingerprint: 'capacity', continuation }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(resumed).resolves.toEqual({ status: 'resumed' });
    } finally { scheduler.dispose(); vi.useRealTimers(); }
  });
  it('publishes a Run continuation only after the shared scheduler settles its awaiting-outcome state', async () => {
    vi.useFakeTimers();
    const memory = createMemoryStore();
    let release!: () => void;
    const publication = new Promise<void>((resolve) => { release = resolve; });
    let publishing = false;
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => Date.now(),
      store: { ...memory.store, write: async (key, intent) => {
        if (intent.status === 'awaiting_outcome') { publishing = true; await publication; }
        memory.store.write(key, intent);
      } }, resume: async () => ({ status: 'continued' }) });
    let settled = false;
    const pending = scheduler.waitForRecovery({ scope: { kind: 'run', runId: 'child' }, serviceId: 'service', profileId: 'member', groupId: null,
      issueFingerprint: 'capacity', continuation: { interruptedOriginId: 'turn', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'capacity' } },
      new AbortController().signal).then((result) => { settled = true; return result; });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(publishing).toBe(true);
      expect(settled).toBe(false);
      release();
      await expect(pending).resolves.toEqual({ status: 'resumed' });
      await scheduler.finishRun('child');
      expect(memory.persisted.size).toBe(0);
    } finally { release(); scheduler.dispose(); vi.useRealTimers(); }
  });
  it('rejects cancellation of a replaced occurrence inside the durable owner transaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capacity-recovery-'));
    const changes: unknown[] = [];
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => 1_000, store: createRecoveryIntentFileStore(join(directory, 'intents.json')), resume: async () => ({ status: 'continued' }),
      onStateChange: (_sessionId, intent) => { changes.push(intent); } });
    try {
      const input = { sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard' as const, customResumePrompt: null, recoveryKind: 'capacity' as const } };
      await scheduler.enable(input);
      const previous = scheduler.read('sess-1')!;
      await scheduler.enable({ ...input, continuation: { ...input.continuation, interruptedOriginId: 'turn-2' } });
      changes.length = 0;
      await expect(scheduler.cancel({ sessionId: 'sess-1', issueFingerprint: previous.issueFingerprint, armedAtMs: previous.armedAtMs })).resolves.toBeNull();
      expect(changes).toEqual([]);
      expect(scheduler.read('sess-1')).toMatchObject({ status: 'waiting', continuation: { interruptedOriginId: 'turn-2' } });
      const current = scheduler.read('sess-1')!;
      await expect(scheduler.cancel({ sessionId: 'sess-1', issueFingerprint: current.issueFingerprint, armedAtMs: current.armedAtMs })).resolves.toMatchObject({ status: 'cancelled' });
      expect(changes).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    } finally {
      scheduler.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('routes Stop retrying to the temporary recovery owner without quota mutation', async () => {
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => 1_000, store: createMemoryStore().store, resume: async () => ({ status: 'continued' }) });
    await scheduler.enable({ sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'capacity' } });
    const intent = scheduler.read('sess-1')!;
    const routeInput: Parameters<typeof routeSessionUsageLimitRecoveryWaitResumeCancel>[0] = {
      token: 'token', sessionId: 'sess-1', rawSession: {
        id: 'sess-1', seq: 1, createdAt: 1_000, updatedAt: 1_000, activeAt: 1_000,
        active: true, machineId: 'machine-1', metadata: '{}', metadataVersion: 1,
        encryptionMode: 'plain', dataEncryptionKey: null,
      },
      metadata: { machineId: 'machine-1' }, currentMachineId: 'machine-1', ctx: null, mode: 'plain',
      stageUsageLimitRecoveryMutation: async () => { throw new Error('Must not mutate quota recovery'); },
      callLiveSessionRpc: async () => { throw new Error('Must not route capacity to live quota recovery'); },
      request: { sessionId: 'sess-1', issueFingerprint: `temporary-throttle:${intent.issueFingerprint}`, armedAtMs: intent.armedAtMs },
      readTemporaryThrottleRecovery: (sessionId: string) => scheduler.read(sessionId),
      cancelTemporaryThrottleRecovery: (input: { sessionId: string }) => scheduler.cancel(input),
    };
    await expect(routeSessionUsageLimitRecoveryWaitResumeCancel({ ...routeInput, request: { ...routeInput.request, armedAtMs: intent.armedAtMs - 1 } })).resolves.toMatchObject({ ok: false });
    expect(scheduler.read('sess-1')?.status).toBe('waiting');
    await expect(routeSessionUsageLimitRecoveryWaitResumeCancel({ ...routeInput, currentMachineId: 'another-machine' })).resolves.toMatchObject({ ok: false });
    expect(scheduler.read('sess-1')?.status).toBe('waiting');
    const result = await routeSessionUsageLimitRecoveryWaitResumeCancel(routeInput);
    expect(result).toMatchObject({ ok: true, status: 'cancelled' });
    expect(scheduler.read('sess-1')?.status).toBe('cancelled');
    scheduler.dispose();
  });
  it('reuses the containing scheduler cadence for consecutive overloads until completed model execution', async () => {
    let nowMs = 1_000;
    const { store } = createMemoryStore();
    const resume = vi.fn(async () => ({ status: 'continued' as const }));
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => nowMs, store, resume });
    const report = (origin: string) => ({
      sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null,
      issueFingerprint: 'temporary-retry:capacity:openai-codex:no-group:primary',
      continuation: { interruptedOriginId: origin, resumePromptMode: 'standard' as const, customResumePrompt: null, recoveryKind: 'capacity' as const },
    });
    for (const [attempt, delay] of Array.from({ length: 9 }, () => 1_000).entries()) {
      await expect(scheduler.enable(report(`turn-${attempt}`))).resolves.toMatchObject({ nextRetryAtMs: nowMs + delay, attemptCount: attempt, maxAttempts: 0 });
      nowMs += delay;
      await scheduler.wake({ sessionId: 'sess-1', reason: 'timer' });
      expect(scheduler.read('sess-1')).toMatchObject({ status: 'awaiting_outcome', nextRetryAtMs: null, attemptCount: attempt + 1 });
      await scheduler.wake({ sessionId: 'sess-1', reason: 'manual' });
      expect(resume).toHaveBeenCalledTimes(attempt + 1);
      for (const event of ['task_started', 'prompt_or_steer', 'turn_cancelled'] as const) {
        await scheduler.recordTurnLifecycle({ sessionId: 'sess-1', event, observedAtMs: nowMs });
      }
      await scheduler.recordTurnLifecycle({ sessionId: 'sess-1', event: 'assistant_message_end', terminalStatus: 'failed', observedAtMs: nowMs });
      expect(scheduler.read('sess-1')?.attemptCount).toBe(attempt + 1);
    }
    await scheduler.recordTurnLifecycle({ sessionId: 'sess-1', event: 'assistant_message_end', terminalStatus: 'completed', observedAtMs: nowMs });
    await expect(scheduler.enable(report('after-success'))).resolves.toMatchObject({ attemptCount: 0, nextRetryAtMs: nowMs + 1_000 });
    await scheduler.cancel({ sessionId: 'sess-1' });
    await scheduler.wake({ sessionId: 'sess-1', reason: 'timer' });
    expect(resume).toHaveBeenCalledTimes(9);
    scheduler.dispose();
  });

  it('preserves both provider Retry-After and reset floors for overloads', async () => {
    for (const [retryAfterMs, resetAtMs, nextRetryAtMs] of [[20_000, 15_000, 21_000], [8_000, 15_000, 15_000]] as const) {
      const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => 1_000, store: createMemoryStore().store, resume: async () => ({ status: 'continued' }) });
      const input = { sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard' as const, customResumePrompt: null, recoveryKind: 'capacity' as const } };
      await expect(scheduler.enable({ ...input, retryAfterMs, resetAtMs })).resolves.toMatchObject({ nextRetryAtMs });
      scheduler.dispose();
    }
  });

  it('does not postpone a duplicate capacity report or lose cancellation during continuation handoff', async () => {
    let nowMs = 1_000;
    let finishResume!: () => void;
    let markResumeStarted!: () => void;
    const resumeStarted = new Promise<void>((resolve) => { markResumeStarted = resolve; });
    const states: Array<string | null> = [];
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs, store: createMemoryStore().store,
      onStateChange: (_sessionId, intent) => { states.push(intent?.status ?? null); },
      resume: async () => {
        markResumeStarted();
        await new Promise<void>((resolve) => { finishResume = resolve; });
        return { status: 'continued' };
      },
    });
    const input = { sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard' as const, customResumePrompt: null, recoveryKind: 'capacity' as const } };
    await scheduler.enable(input);
    nowMs = 2_000;
    await expect(scheduler.enable(input)).resolves.toMatchObject({ nextRetryAtMs: 2_000 });
    await expect(scheduler.enable({ ...input, retryAfterMs: 8_000 })).resolves.toMatchObject({ nextRetryAtMs: 9_000 });
    nowMs = 3_000;
    await expect(scheduler.enable({ ...input, retryAfterMs: 8_000 })).resolves.toMatchObject({ nextRetryAtMs: 9_000 });
    nowMs = 9_000;
    const wake = scheduler.wake({ sessionId: 'sess-1', reason: 'manual' });
    await resumeStarted;
    await scheduler.cancel({ sessionId: 'sess-1' });
    finishResume();
    await wake;
    expect(scheduler.read('sess-1')).toMatchObject({ status: 'cancelled', nextRetryAtMs: null });
    expect(states.at(-1)).toBe('cancelled');
    scheduler.dispose();
  });

  it('backs off handoff transport failures without counting them as model failures', async () => {
    let nowMs = 1_000;
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => nowMs, store: createMemoryStore().store, resume: async () => { throw new Error('transport unavailable'); } });
    const input = { sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard' as const, customResumePrompt: null, recoveryKind: 'capacity' as const } };
    await scheduler.enable(input);
    nowMs = 6_000;
    await scheduler.wake({ sessionId: 'sess-1', reason: 'timer' });
    expect(scheduler.read('sess-1')).toMatchObject({ capacityFailureCount: 1, attemptCount: 1, nextRetryAtMs: 8_000 });
    nowMs = 8_000;
    await scheduler.wake({ sessionId: 'sess-1', reason: 'timer' });
    expect(scheduler.read('sess-1')).toMatchObject({ capacityFailureCount: 1, attemptCount: 2, nextRetryAtMs: 12_000 });
    scheduler.dispose();
  });

  it('manual retry bypasses Happier backoff but honors the provider timing minimum', async () => {
    let nowMs = 1_000;
    const resume = vi.fn(async () => ({ status: 'continued' as const }));
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => nowMs, store: createMemoryStore().store, resume });
    await scheduler.enable({ sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', retryAfterMs: 2_000, resetAtMs: 4_000, continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'capacity' } });
    await scheduler.cancel({ sessionId: 'sess-1' });
    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('sess-1')!.armedAtMs).toBeGreaterThan(1_000);
    expect(resume).not.toHaveBeenCalled();
    nowMs = 4_000;
    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'manual' })).resolves.toEqual({ status: 'resumed' });
    expect(resume).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it('keeps Stop retrying across a new failed origin and resumes only on explicit retry', async () => {
    const resume = vi.fn(async () => ({ status: 'continued' as const }));
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => 1_000, store: createMemoryStore().store, resume });
    const input = { sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard' as const, customResumePrompt: null, recoveryKind: 'capacity' as const } };
    await scheduler.enable(input);
    await scheduler.cancel({ sessionId: 'sess-1' });
    await expect(scheduler.enable({ ...input, continuation: { ...input.continuation, interruptedOriginId: 'turn-2' } })).resolves.toMatchObject({ status: 'cancelled', nextRetryAtMs: null });
    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'timer' })).resolves.toMatchObject({ status: 'inactive' });
    expect(resume).not.toHaveBeenCalled();
    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'manual' })).resolves.toMatchObject({ status: 'resumed' });
    expect(resume).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it('retains the capacity streak when newer user input supersedes a continuation', async () => {
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => 1_000, store: createMemoryStore().store, resume: async () => ({ status: 'superseded', reason: 'newer_user_input' }) });
    const input = { sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard' as const, customResumePrompt: null, recoveryKind: 'capacity' as const } };
    await scheduler.enable(input);
    await scheduler.wake({ sessionId: 'sess-1', reason: 'manual' });
    expect(scheduler.read('sess-1')).toMatchObject({ capacityFailureCount: 1, nextRetryAtMs: null });
    await expect(scheduler.enable(input)).resolves.toMatchObject({ nextRetryAtMs: null });
    await expect(scheduler.enable({ ...input, continuation: { ...input.continuation, interruptedOriginId: 'turn-2' } })).resolves.toMatchObject({ nextRetryAtMs: 2_000 });
    scheduler.dispose();
  });

  it('does not reinterpret a predecessor completed-handoff row as an explicit Stop on a later turn', async () => {
    const { persisted, store } = createMemoryStore();
    // Before this correction, continued handoff settled through markCancelled and
    // persisted this shape, indistinguishable from the old same-occurrence cancel.
    persisted.set('sess-1', {
      v: 1, sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null,
      status: 'cancelled', issueFingerprint: 'overload:origin:turn-1', armedAtMs: 1_000,
      nextRetryAtMs: null, retryAfterMs: null, resetAtMs: null, attemptCount: 1, maxAttempts: 3, lastError: null,
      continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'capacity' },
    });
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => 2_000, store, resume: async () => ({ status: 'continued' }) });
    await expect(scheduler.enable({ sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null, issueFingerprint: 'overload', continuation: { interruptedOriginId: 'turn-2', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'capacity' } })).resolves.toMatchObject({ status: 'waiting', attemptCount: 0, maxAttempts: 0, nextRetryAtMs: 3_000 });
    scheduler.dispose();
  });

  it('explicit retry retires the predecessor capacity attempt ceiling', async () => {
    const { persisted, store } = createMemoryStore();
    persisted.set('sess-1', {
      v: 1, sessionId: 'sess-1', serviceId: 'openai-codex', profileId: 'primary', groupId: null,
      status: 'exhausted', issueFingerprint: 'overload:origin:turn-1', armedAtMs: 1_000,
      nextRetryAtMs: null, retryAfterMs: null, resetAtMs: null, attemptCount: 3, maxAttempts: 3, lastError: 'max_attempts_exhausted',
      continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'capacity' },
    });
    const resume = vi.fn(async () => ({ status: 'continued' as const }));
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => 2_000, store, resume });
    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'manual' })).resolves.toMatchObject({ status: 'resumed' });
    expect(resume).toHaveBeenCalledOnce();
    scheduler.dispose();
  });
  it('returns typed unsupported when no durable store is configured', async () => {
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => 1_000,
      store: null,
      resume: async () => ({ status: 'continued' }),
    });

    await expect(scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 1_000,
      resetAtMs: null,
    })).resolves.toEqual({
      status: 'unsupported',
      nextRetryAtMs: null,
      attemptCount: 0,
      maxAttempts: 0,
    });
    expect(scheduler.read('sess-1')).toBeNull();
  });

  it('schedules a daemon-lifetime retry after both provider timing floors and resumes on timer wake', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const resume = vi.fn(async () => ({ status: 'continued' as const }));
      const { store } = createMemoryStore();
      const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
        nowMs: () => Date.now(),
        store,
        resume,
      });

      await expect(scheduler.enable({
        sessionId: 'sess-1',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
        retryAfterMs: 60_000,
        resetAtMs: 3_000,
      })).resolves.toMatchObject({
        status: 'waiting',
        nextRetryAtMs: 61_000,
        attemptCount: 0,
        maxAttempts: 0,
      });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(scheduler.read('sess-1')).toMatchObject({
        status: 'cancelled',
        nextRetryAtMs: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reschedules when the session resume callback fails', async () => {
    let nowMs = 1_000;
    const resume = vi.fn(async () => {
      throw new Error('respawn failed');
    });
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      resume,
    });

    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: null,
      resetAtMs: null,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('sess-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
      lastError: 'respawn failed',
    });
  });

  it('coalesces repeated reports for the same session without resetting attempts', async () => {
    let nowMs = 1_000;
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume: async (): Promise<{ status: 'continued' }> => {
        throw new Error('still throttled');
      },
    });

    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 1_000,
      resetAtMs: null,
    });

    nowMs = 2_000;
    await scheduler.wake({ sessionId: 'sess-1', reason: 'manual' });
    expect(scheduler.read('sess-1')).toMatchObject({
      attemptCount: 1,
    });

    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 60_000,
      resetAtMs: null,
    });

    expect(scheduler.read('sess-1')).toMatchObject({
      attemptCount: 1,
      maxAttempts: 0,
    });
  });

  it('starts a fresh retry when the reported temporary throttle fingerprint changes', async () => {
    let nowMs = 1_000;
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume: async (): Promise<{ status: 'continued' }> => {
        throw new Error('still throttled');
      },
    });

    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 1_000,
      resetAtMs: null,
    });

    nowMs = 2_000;
    await scheduler.wake({ sessionId: 'sess-1', reason: 'manual' });
    expect(scheduler.read('sess-1')).toMatchObject({
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      attemptCount: 1,
    });

    nowMs = 2_500;
    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'secondary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:secondary',
      retryAfterMs: 500,
      resetAtMs: null,
    });

    expect(scheduler.read('sess-1')).toMatchObject({
      serviceId: 'openai-codex',
      profileId: 'secondary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:secondary',
      attemptCount: 0,
      nextRetryAtMs: 3_000,
    });
  });

  it('hydrates waiting retries from a durable store after daemon restart', async () => {
    let nowMs = 1_000;
    const { persisted, store } = createMemoryStore();

    const first = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume: async () => ({ status: 'continued' }),
    });

    await first.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 1_000,
      resetAtMs: null,
    });

    expect(persisted.get('sess-1')).toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 2_000,
    });

    const resume = vi.fn(async () => ({ status: 'continued' as const }));
    nowMs = 2_000;
    const second = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume,
    });

    expect(second.hydrate()).toHaveLength(1);
    await expect(second.wake({ sessionId: 'sess-1', reason: 'manual' })).resolves.toEqual({ status: 'resumed' });
    expect(resume).toHaveBeenCalledOnce();
    expect(persisted.get('sess-1')).toMatchObject({
      status: 'cancelled',
      nextRetryAtMs: null,
    });
  });

  it('keeps duplicate reports for one interrupted turn deduplicated but rearms a later turn', async () => {
    let nowMs = 1_000;
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume: async () => ({ status: 'continued' }),
    });
    const base = {
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 60_000,
      resetAtMs: null,
    } as const;
    const firstContinuation = {
      interruptedOriginId: 'turn-1',
      resumePromptMode: 'standard' as const,
      customResumePrompt: null,
      recoveryKind: 'temporary_throttle' as const,
    };
    await scheduler.enable({ ...base, continuation: firstContinuation });
    await scheduler.cancel({ sessionId: 'sess-1' });

    await expect(scheduler.enable({ ...base, continuation: firstContinuation })).resolves.toMatchObject({
      status: 'cancelled',
    });

    nowMs = 2_000;
    await expect(scheduler.enable({
      ...base,
      continuation: { ...firstContinuation, interruptedOriginId: 'turn-2' },
    })).resolves.toMatchObject({ status: 'waiting', attemptCount: 0 });
    expect(scheduler.read('sess-1')).toMatchObject({
      continuation: { interruptedOriginId: 'turn-2' },
    });
  });

  it('removes a recovery superseded by newer user input', async () => {
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => 1_000,
      store,
      resume: async () => ({ status: 'superseded', reason: 'newer_user_input' }),
    });
    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 0,
      resetAtMs: null,
      continuation: {
        interruptedOriginId: 'turn-1',
        resumePromptMode: 'standard',
        customResumePrompt: null,
        recoveryKind: 'temporary_throttle',
      },
    });

    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'superseded' });
    expect(scheduler.read('sess-1')).toBeNull();
  });
});
