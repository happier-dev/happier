import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedResumeTurnBarrier } from './resumeTurnBarrier.js';

describe('createClaudeUnifiedResumeTurnBarrier', () => {
  afterEach(() => vi.useRealTimers());

  it('begins before provider startup and releases idle only after resume SessionStart plus readiness and quiet', async () => {
    vi.useFakeTimers();
    const begin = vi.fn();
    const cancel = vi.fn();
    const barrier = createClaudeUnifiedResumeTurnBarrier({
      intent: { kind: 'resume_native', providerSessionId: 'resume-1' },
      quietMs: 800,
      begin,
      cancel,
    });

    barrier.beginBeforeProviderRun();
    barrier.observeStartupReady();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();

    barrier.observeProviderSessionStart('resume');
    await vi.advanceTimersByTimeAsync(799);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('retains a confirmed native continuation and deduplicates replayed evidence', async () => {
    vi.useFakeTimers();
    const begin = vi.fn();
    const cancel = vi.fn();
    const barrier = createClaudeUnifiedResumeTurnBarrier({
      intent: { kind: 'resume_native', providerSessionId: 'resume-1' },
      quietMs: 800,
      begin,
      cancel,
    });

    barrier.beginBeforeProviderRun();
    barrier.beginBeforeProviderRun();
    barrier.observeStartupReady();
    barrier.observeProviderSessionStart('resume');
    await vi.advanceTimersByTimeAsync(799);
    expect(barrier.observePromptStart()).toBe(true);
    expect(barrier.observePromptStart()).toBe(false);
    await vi.advanceTimersByTimeAsync(800);

    expect(begin).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('reopens a released idle barrier when the first native resume prompt arrives after the quiet window', async () => {
    vi.useFakeTimers();
    const begin = vi.fn();
    const cancel = vi.fn();
    const barrier = createClaudeUnifiedResumeTurnBarrier({
      intent: { kind: 'resume_native', providerSessionId: 'resume-1' },
      quietMs: 800,
      begin,
      cancel,
    });

    barrier.beginBeforeProviderRun();
    barrier.observeStartupReady();
    barrier.observeProviderSessionStart('resume');
    await vi.advanceTimersByTimeAsync(800);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(barrier.observePromptStart()).toBe(true);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(barrier.observePromptStart()).toBe(false);
  });

  it('releases the provisional barrier while the enclosing runtime rejects a non-resume SessionStart', async () => {
    vi.useFakeTimers();
    const begin = vi.fn();
    const cancel = vi.fn();
    const barrier = createClaudeUnifiedResumeTurnBarrier({
      intent: { kind: 'resume_native', providerSessionId: 'resume-1' },
      quietMs: 800,
      begin,
      cancel,
    });

    barrier.beginBeforeProviderRun();
    barrier.observeStartupReady();
    barrier.observeProviderSessionStart('startup');
    await vi.advanceTimersByTimeAsync(800);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(barrier.observePromptStart()).toBe(false);
  });

  it('forgets delayed resume-prompt provenance after exact terminal evidence', async () => {
    vi.useFakeTimers();
    const begin = vi.fn();
    const cancel = vi.fn();
    const barrier = createClaudeUnifiedResumeTurnBarrier({
      intent: { kind: 'resume_native', providerSessionId: 'resume-1' },
      quietMs: 800,
      begin,
      cancel,
    });

    barrier.beginBeforeProviderRun();
    barrier.observeStartupReady();
    barrier.observeProviderSessionStart('resume');
    barrier.observeTerminal();

    expect(barrier.observePromptStart()).toBe(false);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does nothing for a new session', async () => {
    vi.useFakeTimers();
    const begin = vi.fn();
    const cancel = vi.fn();
    const barrier = createClaudeUnifiedResumeTurnBarrier({
      intent: { kind: 'new_session' },
      quietMs: 800,
      begin,
      cancel,
    });

    barrier.beginBeforeProviderRun();
    barrier.observeProviderSessionStart('resume');
    barrier.observeStartupReady();
    await vi.advanceTimersByTimeAsync(800);

    expect(begin).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
