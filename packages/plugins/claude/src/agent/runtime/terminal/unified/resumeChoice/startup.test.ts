import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/protocol/agents/claude';

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

const AMBIGUOUS_UNKNOWN_DIALOG = [
  UNKNOWN_DIALOG,
  '',
  'Another prompt',
  '❯ 1. First',
  '  2. Second',
].join('\n');

const TRUST_FOLDER_DIALOG = [
  'Accessing workspace:',
  '/private/tmp/new-project',
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
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

function pendingDecisionUntilAbort<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
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
    expect(port.sentKeys).toEqual([]);
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
    expect(port.sentKeys).toEqual([]);
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
    expect(confirmPort.sentKeys).toEqual([]);

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
    expect(declinePort.sentKeys).toEqual([]);
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
    expect(port.sentKeys).toEqual([]);
  });

  it('aborts a pending ask request when the dialog disappears before the user answers', async () => {
    let signal: AbortSignal | null = null;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      signal = options?.signal ?? null;
      return pendingDecisionUntilAbort<Readonly<{
        decision: 'approved';
        answers: Readonly<Record<string, string>>;
      }>>(options?.signal);
    });
    const port = createFakeControlPort({ captures: [IDLE_COMPOSER] });
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

  it('keeps a pending ask request when a transient no-dialog observation recaptures the same chooser', async () => {
    let signal: AbortSignal | null = null;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      signal = options?.signal ?? null;
      return pendingDecisionUntilAbort<Readonly<{
        decision: 'approved';
        answers: Readonly<Record<string, string>>;
      }>>(options?.signal);
    });
    const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG] });
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
    expect(await handler.handle(parseClaudeScreenState(IDLE_COMPOSER))).toBe('waiting_for_user');
    expect(signal?.aborted).toBe(false);
    expect(handler.hasPendingUserAction()).toBe(true);

    await handler.dispose();
  });

  it('aborts and does not republish an ask request after dispose', async () => {
    let signal: AbortSignal | null = null;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      signal = options?.signal ?? null;
      return pendingDecisionUntilAbort<Readonly<{
        decision: 'approved';
        answers: Readonly<Record<string, string>>;
      }>>(options?.signal);
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
    await handler.dispose();
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
    expect(port.sentKeys).toEqual([]);
  });

  it('sends the remembered summary answer through the same registered terminal option', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'always_resume_from_summary' },
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
    expect(port.sentKeys).toEqual([]);
  });

  it('sends the user-selected answer returned by the current structured-answer shape', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: ['resume_from_summary'] },
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
    expect(port.sentKeys).toEqual([]);
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
    expect(port.sentKeys).toEqual([]);
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
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

  it('publishes pre-hook workspace trust and sends only the user-selected decision', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { claudeUnifiedTerminalTrustFolder: 'trust_once' },
    }));
    const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG))).toBe('waiting_for_user');
    await vi.waitFor(() => {
      expect(port.sentLiteral).toEqual(['1']);
      expect(port.sentKeys).toEqual([]);
    });
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      toolName: 'AskUserQuestion',
      reason: 'claude_unified_terminal_trust_folder',
      input: expect.objectContaining({
        happierDialog: expect.objectContaining({
          kind: 'recognized',
          dialogId: 'trust_folder',
          secondaryAction: 'open_terminal',
        }),
        questions: [expect.objectContaining({
          options: expect.arrayContaining([
            expect.objectContaining({
              choice: 'always_trust_happier_workspaces',
              settingMutation: {
                settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                value: 'always_trust_happier_workspaces',
              },
            }),
            expect.objectContaining({
              choice: 'always_reject_happier_workspaces',
              settingMutation: {
                settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                value: 'always_reject_happier_workspaces',
              },
            }),
          ]),
        })],
      }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('applies an allowlisted remembered trust preference to the exact recaptured prompt', async () => {
    const requestDecision = vi.fn(async () => ({ decision: 'approved' as const }));
    const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      workspaceTrustPolicy: 'always_reject_happier_workspaces',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG))).toBe('handled');
    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual([]);
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('publishes complete generic context/options and answers only the exact recaptured dialog', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { claudeUnifiedTerminalGenericDialog: '2' },
    }));
    const port = createFakeControlPort({ captures: [UNKNOWN_DIALOG, IDLE_COMPOSER] });
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
    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['2']));
    expect(port.sentKeys).toEqual([]);
    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'claude_unified_terminal_generic_dialog',
      input: expect.objectContaining({
        happierDialog: expect.objectContaining({ kind: 'unrecognized', mode: 'generic' }),
        questions: [expect.objectContaining({
          question: 'This session is 18h 2m old and 560.4k tokens.',
          options: [
            expect.objectContaining({ label: 'Delete history' }),
            expect.objectContaining({ label: 'Continue anyway' }),
          ],
        })],
      }),
    }), expect.anything());
  });

  it('publishes an ambiguous prompt as navigation-only fallback with no answer recipe', async () => {
    let signal: AbortSignal | undefined;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      signal = options?.signal;
      return pendingDecisionUntilAbort<Readonly<{ decision: 'approved' }>>(signal);
    });
    const port = createFakeControlPort({ captures: [] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(AMBIGUOUS_UNKNOWN_DIALOG))).toBe('waiting_for_user');
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        happierDialog: {
          kind: 'unrecognized',
          mode: 'notice',
          dialogId: 'unrecognized_confirmation',
          action: 'open_terminal',
        },
        questions: [expect.objectContaining({ options: [] })],
      }),
    }), expect.anything());
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);

    expect(await handler.handle(parseClaudeScreenState(IDLE_COMPOSER))).toBe('unhandled');
    expect(signal?.aborted).toBe(true);
  });

  it('cancels the pending request and republishes when the visible dialog changes (A→B)', async () => {
    const signals: Array<AbortSignal | null> = [];
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      signals.push(options?.signal ?? null);
      return pendingDecisionUntilAbort<Readonly<{
        decision: 'approved';
        answers: Readonly<Record<string, string>>;
      }>>(options?.signal);
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

  it('cancels and republishes when context changes under the same generic dialog id', async () => {
    const signals: AbortSignal[] = [];
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      if (options?.signal) signals.push(options.signal);
      return pendingDecisionUntilAbort<Readonly<{ decision: 'approved' }>>(options?.signal);
    });
    const changed = UNKNOWN_DIALOG.replace('560.4k tokens', '561.0k tokens');
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port: createFakeControlPort({ captures: [] }),
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(UNKNOWN_DIALOG))).toBe('waiting_for_user');
    expect(await handler.handle(parseClaudeScreenState(changed))).toBe('waiting_for_user');
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(requestDecision.mock.calls[0]?.[0]).not.toMatchObject(requestDecision.mock.calls[1]?.[0] as object);
  });

  it('keeps the ask request pending while terminal control is answering', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Resume full session' },
    }));
    let literalStarted: (() => void) | null = null;
    let releaseLiteral: (() => void) | null = null;
    const literalStartedPromise = new Promise<void>((resolve) => {
      literalStarted = resolve;
    });
    const literalBlockedPromise = new Promise<void>((resolve) => {
      releaseLiteral = resolve;
    });
    const port = createFakeControlPort({
      captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER],
      onSendLiteralText: async () => {
        literalStarted?.();
        await literalBlockedPromise;
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
    await literalStartedPromise;

    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual([]);
    expect(handler.hasPendingUserAction()).toBe(true);

    releaseLiteral?.();
    await vi.waitFor(() => {
      expect(handler.hasPendingUserAction()).toBe(false);
    });
  });
});
