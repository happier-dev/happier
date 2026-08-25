import { describe, expect, it, vi } from 'vitest';

import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnLifecycleController } from '@/agent/runtime/session/turn/types';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import type { RawJSONLines } from '../types';
import { bindClaudeUnifiedTerminalSession } from './bindClaudeUnifiedTerminalSession';

function userMessage(text: string, timestamp: string, uuid: string = `user-${text}`): RawJSONLines {
  return {
    type: 'user',
    uuid,
    timestamp,
    message: { content: text },
  } as RawJSONLines;
}

function assistantMessage(text: string, uuid: string = `assistant-${text}`): RawJSONLines {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }] },
  } as RawJSONLines;
}

function createBinding(overrides: Partial<Parameters<typeof bindClaudeUnifiedTerminalSession>[0]> = {}) {
  const observedMessages: RawJSONLines[] = [];
  const consumedMessages: RawJSONLines[] = [];
  const interruptChanges: Array<(() => Promise<void>) | null> = [];
  const readyContexts: unknown[] = [];
  const onPromptTurnStarted = vi.fn();
  const fetchRecentTranscriptTextItemsForAcpImport = vi.fn(async (): Promise<Array<{
    role: 'user' | 'agent';
    text: string;
  }>> => []);
  const sessionTurnLifecycle = {
    beginTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
    touchActiveTurn: vi.fn(async () => undefined),
    completeTurn: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    failTurn: vi.fn(async () => undefined),
  };
  const session = {
    fetchRecentTranscriptTextItemsForAcpImport,
    recordClaudeJsonlMessageConsumed: vi.fn((message: RawJSONLines) => {
      consumedMessages.push(message);
    }),
    getLastObservedMessageSeq: vi.fn(() => 41),
    beginTurnAssistantTextSnapshot: vi.fn(() => 'ready-turn-1'),
    sessionTurnLifecycle,
  };
  const binding = bindClaudeUnifiedTerminalSession({
    session,
    logPrefix: '[test-unified]',
    acceptedPromptEchoWindowMs: 100,
    nowMs: () => 1_000,
    onMessage: (message) => {
      observedMessages.push(message);
    },
    onReady: (context) => {
      readyContexts.push(context);
    },
    onTurnInterruptChanged: (handler) => {
      interruptChanges.push(handler);
    },
    onPromptTurnStarted,
    ...overrides,
  });
  return {
    binding,
    consumedMessages,
    interruptChanges,
    observedMessages,
    readyContexts,
    onPromptTurnStarted,
    session,
    sessionTurnLifecycle,
  };
}

describe('bindClaudeUnifiedTerminalSession', () => {
  it('does not acknowledge a transcript row before the owning publisher settles', async () => {
    let acknowledge!: () => void;
    const publisherAcknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const { binding } = createBinding({
      onMessage: async () => {
        await publisherAcknowledgement;
      },
    });

    let settled = false;
    const observation = Promise.resolve(binding.sessionOptions.onMessage?.(assistantMessage('committed'))).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledge();
    await observation;
    expect(settled).toBe(true);
  });

  it('uses the configured accepted-prompt echo window for injected UI prompts', async () => {
    const { binding, consumedMessages, observedMessages } = createBinding();

    binding.noteNextInjectedPromptShouldSuppressEcho();
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: 'short-lived echo',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'new_turn',
      turnStateAtInjection: 'idle',
    });
    binding.sessionOptions.onMessage?.(userMessage('short-lived echo', new Date(1_200).toISOString()));

    expect(consumedMessages).toHaveLength(0);
    expect(observedMessages).toEqual([expect.objectContaining({ type: 'user' })]);
  });

  it('keeps a durable Pending echo suppressed through a long provider-owned resume compaction', async () => {
    let nowMs = 1_000;
    const { binding, consumedMessages, observedMessages } = createBinding({ nowMs: () => nowMs });

    binding.noteNextInjectedPromptShouldSuppressEcho({ retainUntilObserved: true });
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: 'continue after the provider finishes compacting',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'new_turn',
      turnStateAtInjection: 'idle',
    });
    nowMs = 150_000;
    binding.sessionOptions.onMessage?.(userMessage(
      'continue after the provider finishes compacting',
      new Date(nowMs).toISOString(),
    ));

    expect(observedMessages).toEqual([]);
    expect(consumedMessages).toEqual([expect.objectContaining({ type: 'user' })]);
  });

  it('suppresses a durable Pending echo behind an unmatched accepted control command', async () => {
    let nowMs = 1_000;
    const { binding, consumedMessages, observedMessages } = createBinding({ nowMs: () => nowMs });

    binding.noteNextInjectedPromptShouldSuppressEcho({ retainUntilObserved: true });
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: '/effort high',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'new_turn',
      turnStateAtInjection: 'idle',
    });
    binding.noteNextInjectedPromptShouldSuppressEcho({ retainUntilObserved: true });
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: 'ordinary Pending prompt',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'new_turn',
      turnStateAtInjection: 'idle',
    });

    nowMs = 150_000;
    binding.sessionOptions.onMessage?.(userMessage('ordinary Pending prompt', new Date(nowMs).toISOString()));
    binding.sessionOptions.onMessage?.(userMessage('ordinary Pending prompt', new Date(nowMs + 1).toISOString()));
    binding.sessionOptions.onMessage?.(userMessage('/effort high', new Date(nowMs + 2).toISOString()));

    expect(consumedMessages).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ content: 'ordinary Pending prompt' }) }),
      expect.objectContaining({ message: expect.objectContaining({ content: '/effort high' }) }),
    ]);
    expect(observedMessages).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ content: 'ordinary Pending prompt' }) }),
    ]);
  });

  it('seeds persisted user echoes and does not suppress fresh terminal-origin prompts', async () => {
    const { binding, consumedMessages, observedMessages, session } = createBinding();
    session.fetchRecentTranscriptTextItemsForAcpImport.mockResolvedValueOnce([
      { role: 'user', text: 'repeatable prompt' },
      { role: 'agent', text: 'old answer' },
    ]);

    await binding.seedPersistedPromptEchoes({ nowMs: 2_000 });
    binding.sessionOptions.onMessage?.(userMessage('repeatable prompt', new Date(1_500).toISOString(), 'historical'));
    await binding.sessionOptions.onProviderPromptStarted?.();
    binding.sessionOptions.onMessage?.(userMessage('repeatable prompt', new Date(2_500).toISOString(), 'fresh-terminal'));
    binding.sessionOptions.onMessage?.(assistantMessage('ok'));

    expect(session.fetchRecentTranscriptTextItemsForAcpImport).toHaveBeenCalledWith({ take: 500 });
    expect(consumedMessages).toEqual([expect.objectContaining({ uuid: 'historical' })]);
    expect(observedMessages).toEqual([
      expect.objectContaining({ uuid: 'fresh-terminal' }),
      expect.objectContaining({ type: 'assistant' }),
    ]);
  });

  it('seeds the own-composer registry from persisted user prompts so a respawned runner recognizes predecessor leftovers (C11, incident cmq8y3nlx)', async () => {
    const { binding, session } = createBinding();
    session.fetchRecentTranscriptTextItemsForAcpImport.mockResolvedValueOnce([
      { role: 'user', text: 'please continue and keep waiting for the agents until full completion' },
      { role: 'agent', text: 'still working through the agents' },
    ]);

    expect(binding.ownComposerTexts.matches('please continue and keep waiting for the agents until full completion')).toBe(false);

    await binding.seedPersistedPromptEchoes({ nowMs: 2_000 });

    expect(binding.ownComposerTexts.matches('please continue and keep waiting for the agents until full completion')).toBe(true);
    // Agent texts and unseen texts must NEVER classify as our own composer writes.
    expect(binding.ownComposerTexts.matches('still working through the agents')).toBe(false);
    expect(binding.ownComposerTexts.matches('a genuine fresh user draft')).toBe(false);
  });

  it('opens one canonical turn for accepted prompts and completes it on ready', async () => {
    const { binding, readyContexts, session, sessionTurnLifecycle } = createBinding();

    binding.noteNextInjectedPromptShouldSuppressEcho();
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: 'hello',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'new_turn',
      turnStateAtInjection: 'idle',
    });
    await binding.sessionOptions.onProviderPromptStarted?.();
    await binding.sessionOptions.onReady?.();

    expect(session.beginTurnAssistantTextSnapshot).toHaveBeenCalledWith({ startSeqExclusive: 41 });
    expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
    expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(readyContexts).toEqual([{ turnToken: 'ready-turn-1', startSeqExclusive: 41 }]);
  });

  it('opens one provisional canonical barrier for native resume before provider hooks and releases an idle resume at startup readiness', async () => {
    vi.useFakeTimers();
    const { binding, sessionTurnLifecycle } = createBinding({ providerResumeIdleReleaseDelayMs: 800 });

    try {
      await binding.recordProviderResumeStarted({ kind: 'resume_native', providerSessionId: 'claude-session-resume-1' });
      await binding.recordProviderResumeStarted({ kind: 'resume_native', providerSessionId: 'claude-session-resume-1' });

      expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
      expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
      expect(sessionTurnLifecycle.cancelTurn).not.toHaveBeenCalled();

      binding.recordProviderResumeSessionStarted();
      await binding.recordProviderStartupReady();
      await vi.advanceTimersByTimeAsync(800);

      expect(sessionTurnLifecycle.cancelTurn).toHaveBeenCalledTimes(1);
      expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a confirmed native resume barrier until the exact prompt terminal path settles it', async () => {
    vi.useFakeTimers();
    const { binding, sessionTurnLifecycle } = createBinding({ providerResumeIdleReleaseDelayMs: 800 });

    try {
      await binding.recordProviderResumeStarted({ kind: 'resume_native', providerSessionId: 'claude-session-resume-1' });
      await binding.recordProviderStartupReady();
      await vi.advanceTimersByTimeAsync(799);
      // Generic readiness may precede SessionStart/UserPromptSubmit during native resume. It is
      // not sufficient to clear the barrier by itself.
      expect(sessionTurnLifecycle.cancelTurn).not.toHaveBeenCalled();
      binding.recordProviderResumeSessionStarted();
      await binding.sessionOptions.onProviderPromptStarted?.();
      await vi.advanceTimersByTimeAsync(800);

      expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
      expect(sessionTurnLifecycle.cancelTurn).not.toHaveBeenCalled();
      expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();

      await binding.recordPromptTurnCompleted();
      expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a native resume barrier when the provider transcript accepts the resume-summary compact command', async () => {
    vi.useFakeTimers();
    const { binding, sessionTurnLifecycle } = createBinding({ providerResumeIdleReleaseDelayMs: 800 });

    try {
      await binding.recordProviderResumeStarted({ kind: 'resume_native', providerSessionId: 'claude-session-resume-1' });
      binding.recordProviderResumeSessionStarted();
      await binding.recordProviderStartupReady();

      binding.sessionOptions.onMessage?.(userMessage('/compact', new Date(1_200).toISOString()));
      await vi.advanceTimersByTimeAsync(800);

      expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
      expect(sessionTurnLifecycle.cancelTurn).not.toHaveBeenCalled();
      expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens the native resume turn after an in-flight idle release finishes', async () => {
    vi.useFakeTimers();
    const { binding, session } = createBinding({ providerResumeIdleReleaseDelayMs: 800 });
    const mutations: SessionTurnMutationV1[] = [];
    let releaseCancellation: (() => void) | undefined;
    const realLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-resume-1',
      createId: (() => {
        let id = 0;
        return () => `resume-turn-${++id}`;
      })(),
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
        if (mutation.action === 'cancel') {
          await new Promise<void>((resolve) => {
            releaseCancellation = resolve;
          });
        }
      },
    });
    (session as unknown as { sessionTurnLifecycle: SessionTurnLifecycleController }).sessionTurnLifecycle = realLifecycle;

    try {
      await binding.recordProviderResumeStarted({ kind: 'resume_native', providerSessionId: 'claude-session-resume-1' });
      binding.recordProviderResumeSessionStarted();
      await binding.recordProviderStartupReady();
      await vi.advanceTimersByTimeAsync(800);
      expect(mutations.filter((mutation) => mutation.action === 'cancel')).toHaveLength(1);

      let promptStartSettled = false;
      const promptStart = Promise.resolve(binding.sessionOptions.onProviderPromptStarted?.()).then(() => {
        promptStartSettled = true;
      });
      await Promise.resolve();

      expect(promptStartSettled).toBe(false);
      expect(mutations.filter((mutation) => mutation.action === 'begin')).toHaveLength(1);

      releaseCancellation?.();
      await promptStart;

      expect(mutations.filter((mutation) => mutation.action === 'begin')).toHaveLength(2);
      expect(mutations.filter((mutation) => mutation.action === 'cancel')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('touches the canonical turn on trusted provider and transcript progress without duplicate begin', async () => {
    const { binding, sessionTurnLifecycle } = createBinding();

    await binding.sessionOptions.onProviderPromptStarted?.();
    expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
    expect(sessionTurnLifecycle.touchActiveTurn).toHaveBeenCalledWith({ provider: 'claude' });

    sessionTurnLifecycle.touchActiveTurn.mockClear();
    binding.sessionOptions.onMessage?.(assistantMessage('still working'));

    await vi.waitFor(() => {
      expect(sessionTurnLifecycle.touchActiveTurn).toHaveBeenCalledWith({ provider: 'claude' });
    });
    expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
  });

  it('touches but does not start a new prompt lifecycle for steered prompt injection', async () => {
    const { binding, onPromptTurnStarted, sessionTurnLifecycle } = createBinding();

    await binding.sessionOptions.onProviderPromptStarted?.();
    sessionTurnLifecycle.touchActiveTurn.mockClear();
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: 'steer progress',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'in_flight_steer',
      turnStateAtInjection: 'running',
    });

    expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
    expect(sessionTurnLifecycle.touchActiveTurn).toHaveBeenCalledWith({ provider: 'claude' });
    // A steer belongs to the active turn, so it must not emit the optimistic thinking latch a
    // second time. The hook lifecycle bridge therefore remains a serial true → false stream.
    expect(onPromptTurnStarted).not.toHaveBeenCalled();
  });

  it('suppresses a steered prompt echo that arrives at turn end, beyond the fixed echo window', async () => {
    let nowMs = 1_000;
    const { binding, consumedMessages, observedMessages } = createBinding({ nowMs: () => nowMs });

    binding.noteNextInjectedPromptShouldSuppressEcho();
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: 'steer the long turn',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'in_flight_steer',
      turnStateAtInjection: 'running',
    });

    // The steered turn runs far beyond the 100ms echo window; the JSONL user row
    // for the queued prompt only appears once the turn ends.
    nowMs = 120_000;
    await binding.sessionOptions.onReady?.();
    binding.sessionOptions.onMessage?.(userMessage('steer the long turn', new Date(120_010).toISOString()));

    expect(observedMessages).toEqual([]);
    expect(consumedMessages).toEqual([expect.objectContaining({ type: 'user' })]);
  });

  it('suppresses a steered prompt echo using the canonical prompt identity, not raw bytes', async () => {
    let nowMs = 1_000;
    const { binding, consumedMessages, observedMessages } = createBinding({ nowMs: () => nowMs });

    binding.noteNextInjectedPromptShouldSuppressEcho();
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: [
        '  please review this',
        'and continue   ',
        '',
        '[attachments]',
        '- screenshot.png (screenshot.png, image/png, 262290 bytes)   ',
        '[/attachments]   ',
      ].join('\r\n'),
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'in_flight_steer',
      turnStateAtInjection: 'running',
    });

    nowMs = 120_000;
    await binding.sessionOptions.onReady?.();
    binding.sessionOptions.onMessage?.(userMessage([
      'please review this',
      'and continue',
      '',
      '[attachments]',
      '- screenshot.png (screenshot.png, image/png, 262290 bytes)',
      '[/attachments]',
    ].join('\n'), new Date(120_010).toISOString()));

    expect(observedMessages).toEqual([]);
    expect(consumedMessages).toEqual([expect.objectContaining({ type: 'user' })]);
  });

  it('does not suppress later identical prompts once a steered echo expires after turn end', async () => {
    let nowMs = 1_000;
    const { binding, observedMessages } = createBinding({ nowMs: () => nowMs });

    binding.noteNextInjectedPromptShouldSuppressEcho();
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: 'repeatable steer',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'in_flight_steer',
      turnStateAtInjection: 'running',
    });

    // Turn ends; the pending steer echo gets one echo window (100ms) to match.
    nowMs = 50_000;
    await binding.sessionOptions.onReady?.();
    // No row ever matches it. A later identical terminal-typed prompt must NOT be
    // suppressed by the stale steer entry.
    nowMs = 50_500;
    binding.sessionOptions.onMessage?.(userMessage('repeatable steer', new Date(50_500).toISOString(), 'typed-later'));

    expect(observedMessages).toEqual([expect.objectContaining({ uuid: 'typed-later' })]);
  });

  it('keeps importing steered prompt echoes when import was requested', async () => {
    let nowMs = 1_000;
    const { binding, consumedMessages, observedMessages } = createBinding({ nowMs: () => nowMs });

    binding.noteNextInjectedPromptShouldImportEcho();
    await binding.sessionOptions.onTerminalPromptInjected?.({
      message: 'imported steer',
      mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      acceptedAs: 'in_flight_steer',
      turnStateAtInjection: 'running',
    });

    nowMs = 120_000;
    await binding.sessionOptions.onReady?.();
    binding.sessionOptions.onMessage?.(userMessage('imported steer', new Date(120_010).toISOString()));

    expect(consumedMessages).toEqual([]);
    expect(observedMessages).toEqual([expect.objectContaining({ type: 'user' })]);
  });

  it('fails the canonical turn when the prompt turn terminates with a failure (hook StopFailure leak)', async () => {
    const { binding, sessionTurnLifecycle } = createBinding();

    await binding.sessionOptions.onProviderPromptStarted?.();
    expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);

    await binding.recordPromptTurnFailed();

    expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();

    // Idempotent: a second failure record must not double-fail.
    await binding.recordPromptTurnFailed();
    expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledTimes(1);
  });

  it('recordPromptTurnFailed is a no-op with no open canonical turn', async () => {
    const { binding, sessionTurnLifecycle } = createBinding();

    await binding.recordPromptTurnFailed();

    expect(sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
  });

  it('forwards terminal interrupt handler installation and removal', () => {
    const { binding, interruptChanges } = createBinding();
    const interrupt = vi.fn(async () => undefined);

    binding.sessionOptions.setTurnInterrupt?.(interrupt);
    binding.sessionOptions.setTurnInterrupt?.(null);

    expect(interruptChanges).toEqual([interrupt, null]);
  });
});
