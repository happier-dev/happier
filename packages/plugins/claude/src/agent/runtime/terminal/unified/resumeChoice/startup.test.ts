import { describe, expect, it, vi } from 'vitest';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
} from '../../../engine.testkit.js';
import { parseClaudeScreenState } from '../screenState.js';
import { createFakeControlPort } from '../tuiControls/fakeControlPort.js';
import { createClaudeUnifiedResumeChoiceStartupHandler } from './startup.js';
import { CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION } from './types.js';

const RESUME_CHOICE_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const SAFEGUARD_DIALOG = [
  'Session paused',
  '',
  "Fable 5's safeguards flagged this message.",
  '',
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

const IDLE_COMPOSER = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

const EFFORT_HIGH_DIALOG = [
  'Change effort level?',
  'Switching to high means the full history will be processed with high effort.',
  '',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const EFFORT_LOW_DIALOG = [
  'Change effort level?',
  'Switching to low means the full history will be processed with low effort.',
  '',
  '❯ 1. Yes, switch to low',
  '  2. No, go back',
].join('\n');

const SWITCH_MODEL_DIALOG = [
  'Switch model?',
  '',
  '❯ 1. Yes, switch',
  '  2. No, go back',
].join('\n');

const UNKNOWN_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  '',
  '❯ 1. Delete history',
  '  2. Continue anyway',
].join('\n');

function createContext(requestDecision = vi.fn(async () => ({ decision: 'approved' as const }))) {
  const terminalHost = createTerminalHostFixture();
  const events = createEventsFixture();
  return createPluginContextFixture(terminalHost.service, events.service, {
    sessionPermissions: {
      requestDecision,
      getMode: () => 'default',
    },
  });
}

describe('createClaudeUnifiedResumeChoiceStartupHandler', () => {
  it('answers an orphan effort dialog toward the configured target', async () => {
    const port = createFakeControlPort({ captures: [EFFORT_HIGH_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(),
      sessionId: 'session-1',
      policy: 'resume_full_session',
      port,
      settleMs: 0,
      wait: async () => undefined,
      runtimeConfig: { reasoningEffort: 'high', ultracode: false, model: null },
      isRuntimeControlInFlight: () => false,
    });

    expect(await handler.handle(parseClaudeScreenState(EFFORT_HIGH_DIALOG))).toBe('handled');
    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('declines an orphan effort dialog for a different target', async () => {
    const port = createFakeControlPort({ captures: [EFFORT_LOW_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(),
      sessionId: 'session-1',
      policy: 'resume_full_session',
      port,
      settleMs: 0,
      wait: async () => undefined,
      runtimeConfig: { reasoningEffort: 'high', ultracode: false, model: null },
      isRuntimeControlInFlight: () => false,
    });

    expect(await handler.handle(parseClaudeScreenState(EFFORT_LOW_DIALOG))).toBe('handled');
    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('leaves driver-owned effort dialogs to runtime control while it is in flight', async () => {
    const port = createFakeControlPort({ captures: [EFFORT_HIGH_DIALOG] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(),
      sessionId: 'session-1',
      policy: 'resume_full_session',
      port,
      settleMs: 0,
      wait: async () => undefined,
      runtimeConfig: { reasoningEffort: 'high', ultracode: false, model: null },
      isRuntimeControlInFlight: () => true,
    });

    expect(await handler.handle(parseClaudeScreenState(EFFORT_HIGH_DIALOG))).toBe('unhandled');
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('answers an orphan switch-model dialog only when a model is configured', async () => {
    const confirmPort = createFakeControlPort({ captures: [SWITCH_MODEL_DIALOG, IDLE_COMPOSER] });
    const confirmHandler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(),
      sessionId: 'session-1',
      policy: 'resume_full_session',
      port: confirmPort,
      settleMs: 0,
      wait: async () => undefined,
      runtimeConfig: { reasoningEffort: null, ultracode: false, model: 'claude-opus-4-8' },
      isRuntimeControlInFlight: () => false,
    });

    expect(await confirmHandler.handle(parseClaudeScreenState(SWITCH_MODEL_DIALOG))).toBe('handled');
    expect(confirmPort.sentLiteral).toEqual(['1']);
    expect(confirmPort.sentKeys).toEqual(['Enter']);

    const declinePort = createFakeControlPort({ captures: [SWITCH_MODEL_DIALOG, IDLE_COMPOSER] });
    const declineHandler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(),
      sessionId: 'session-1',
      policy: 'resume_full_session',
      port: declinePort,
      settleMs: 0,
      wait: async () => undefined,
      runtimeConfig: { reasoningEffort: null, ultracode: false, model: null },
      isRuntimeControlInFlight: () => false,
    });

    expect(await declineHandler.handle(parseClaudeScreenState(SWITCH_MODEL_DIALOG))).toBe('handled');
    expect(declinePort.sentLiteral).toEqual(['2']);
    expect(declinePort.sentKeys).toEqual(['Enter']);
  });

  it('does not repeatedly type an auto answer after terminal control fails', async () => {
    const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG, RESUME_CHOICE_DIALOG] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(),
      sessionId: 'session-1',
      policy: 'resume_full_session',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(RESUME_CHOICE_DIALOG))).toBe('unhandled');
    expect(await handler.handle(parseClaudeScreenState(RESUME_CHOICE_DIALOG))).toBe('unhandled');
    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('aborts a pending ask request when the dialog disappears before the user answers', async () => {
    let signal: AbortSignal | null = null;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      signal = options?.signal ?? null;
      return new Promise<Readonly<{ decision: 'approved'; answers: Readonly<Record<string, string>> }>>(() => undefined);
    });
    const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(RESUME_CHOICE_DIALOG))).toBe('waiting_for_user');
    expect(handler.hasPendingUserAction()).toBe(true);
    expect(await handler.handle(parseClaudeScreenState(IDLE_COMPOSER))).toBe('unhandled');
    expect(signal?.aborted).toBe(true);
  });

  it('aborts and does not republish an ask request after dispose', async () => {
    let signal: AbortSignal | null = null;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      signal = options?.signal ?? null;
      return new Promise<Readonly<{ decision: 'approved'; answers: Readonly<Record<string, string>> }>>(() => undefined);
    });
    const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(RESUME_CHOICE_DIALOG))).toBe('waiting_for_user');
    handler.dispose();
    expect(signal?.aborted).toBe(true);
    expect(await handler.handle(parseClaudeScreenState(RESUME_CHOICE_DIALOG))).toBe('unhandled');
    expect(requestDecision).toHaveBeenCalledTimes(1);
  });

  it('sends the user-selected answer returned by AskUserQuestion answers', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Resume from summary' },
    }));
    const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(RESUME_CHOICE_DIALOG))).toBe('waiting_for_user');
    await vi.waitFor(() => {
      expect(port.sentLiteral).toEqual(['1']);
    });
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('publishes a user-action safeguard question and sends the selected option', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { 'How should Claude continue?': 'Edit prompt and retry with Fable 5' },
    }));
    const port = createFakeControlPort({ captures: [SAFEGUARD_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(SAFEGUARD_DIALOG))).toBe('waiting_for_user');
    await vi.waitFor(() => {
      expect(port.sentLiteral).toEqual(['2']);
    });
    expect(port.sentKeys).toEqual(['Enter']);
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      toolName: 'AskUserQuestion',
      input: expect.objectContaining({
        questions: [expect.objectContaining({
          header: 'Claude paused',
          options: [
            expect.objectContaining({ label: 'Switch to Opus 4.8' }),
            expect.objectContaining({ label: 'Edit prompt and retry with Fable 5' }),
          ],
        })],
      }),
      reason: 'claude_unified_terminal_safeguard_choice',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('fail-closed publishes an open-terminal notice for an unrecognized dialog and never types', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { openTerminal: 'open_terminal' },
    }));
    const port = createFakeControlPort({ captures: [UNKNOWN_DIALOG, UNKNOWN_DIALOG] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(UNKNOWN_DIALOG))).toBe('waiting_for_user');
    await vi.waitFor(() => {
      expect(requestDecision).toHaveBeenCalledTimes(1);
    });
    // Exactly-once: the same unknown dialog persisting must not republish or type anything.
    expect(await handler.handle(parseClaudeScreenState(UNKNOWN_DIALOG))).toBe('unhandled');
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'claude_unified_terminal_unrecognized_dialog',
      input: expect.objectContaining({
        happierDialog: { kind: 'unrecognized', dialogId: 'unrecognized_confirmation', notice: 'open_terminal' },
      }),
    }), expect.anything());
  });

  it('cancels the pending request and republishes when the visible dialog changes (A→B)', async () => {
    const signals: Array<AbortSignal | null> = [];
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      signals.push(options?.signal ?? null);
      return new Promise<Readonly<{ decision: 'approved'; answers: Readonly<Record<string, string>> }>>(() => undefined);
    });
    const port = createFakeControlPort({ captures: [SAFEGUARD_DIALOG, RESUME_CHOICE_DIALOG] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(SAFEGUARD_DIALOG))).toBe('waiting_for_user');
    expect(await handler.handle(parseClaudeScreenState(RESUME_CHOICE_DIALOG))).toBe('waiting_for_user');
    expect(requestDecision).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('keeps the ask request pending while terminal control is answering', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Resume full session' },
    }));
    let enterStarted: (() => void) | null = null;
    let releaseEnter: (() => void) | null = null;
    const enterStartedPromise = new Promise<void>((resolve) => {
      enterStarted = resolve;
    });
    const enterBlockedPromise = new Promise<void>((resolve) => {
      releaseEnter = resolve;
    });
    const port = createFakeControlPort({
      captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER],
      onSendSpecialKey: async () => {
        enterStarted?.();
        await enterBlockedPromise;
      },
    });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(RESUME_CHOICE_DIALOG))).toBe('waiting_for_user');
    await enterStartedPromise;

    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual(['Enter']);
    expect(handler.hasPendingUserAction()).toBe(true);

    releaseEnter?.();
    await vi.waitFor(() => {
      expect(handler.hasPendingUserAction()).toBe(false);
    });
  });
});
