import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE as PROTOCOL_CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
} from '@happier-dev/protocol/agents/claude';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  withPermissionDecisionApplication,
} from '../../../engine.testkit.js';
import { parseClaudeScreenState } from '../screenState.js';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '../constants.js';
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

const HIDDEN_UNKNOWN_DIALOG = [
  'Allow external CLAUDE.md file imports?',
  '',
  '❯ No, disable external imports',
  '  Yes, allow external imports',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

const HIDDEN_UNKNOWN_DIALOG_TARGET_FOCUSED = HIDDEN_UNKNOWN_DIALOG
  .replace('❯ No, disable external imports', '  No, disable external imports')
  .replace('  Yes, allow external imports', '❯ Yes, allow external imports');

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
      requestDecision: withPermissionDecisionApplication(requestDecision),
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
  it('leaves the usage chooser to prompt injection and retires an inherited app question', async () => {
    const requestDecision = vi.fn((_request: unknown, options?: { signal?: AbortSignal }) =>
      pendingDecisionUntilAbort<Readonly<{ decision: 'approved' }>>(options?.signal));
    const usageDialog = ["You've hit your session limit", 'What do you want to do?', '❯ 1. Stop and wait for limit to reset',
      '  2. Switch to extra usage', '  3. Upgrade your plan'].join('\n');
    const port = createFakeControlPort({ captures: [usageDialog] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: createContext(requestDecision),
      sessionId: 'session-1', port, settleMs: 0, wait: async () => undefined });
    try {
      await handler.handle(parseClaudeScreenState(SAFEGUARD_DIALOG));
      expect(handler.hasPendingUserAction()).toBe(true);
      await expect(handler.handle(parseClaudeScreenState(usageDialog))).resolves.toBe('unhandled');
      expect(handler.hasPendingUserAction()).toBe(false);
      expect(requestDecision).toHaveBeenCalledOnce();
      expect(port.sentKeys).toEqual([]);
    } finally { await handler.dispose(); }
  });
  it('does not apply a settled answer that skipped native application acknowledgement', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionPermissions: {
        requestDecision: async () => ({ decision: 'approved',
          answers: { claudeUnifiedTerminalTrustFolder: 'trust_once' } }),
        getMode: () => 'default',
      },
    });
    const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({ ctx, sessionId: 'session-1', port,
      settleMs: 0, wait: async () => undefined,
    });
    try {
      await handler.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG));
      await vi.waitFor(() => expect(handler.hasPendingUserAction()).toBe(false));
      expect(port.sentLiteral).toEqual([]);
      expect(port.sentKeys).toEqual([]);
    } finally {
      await handler.dispose();
    }
  });

  it.each(['dispose', 'replacement'] as const)('refuses a retired native application ACK after %s', async (retirement) => {
    type RequestOptions = Parameters<NonNullable<ReturnType<typeof createContext>['sessions']['current']>['permissions']['requestDecision']>[1];
    const options: RequestOptions[] = [];
    const requestDecision = vi.fn((_request: unknown, requestOptions?: RequestOptions) => {
      options.push(requestOptions);
      return pendingDecisionUntilAbort<Readonly<{ decision: 'approved' }>>(requestOptions?.signal);
    });
    const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: createContext(requestDecision),
      sessionId: 'session-1', port, settleMs: 0, wait: async () => undefined,
    });
    try {
      await handler.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG));
      const retired = options[0];
      expect(retired?.acknowledgeDecisionApplication).toBeTypeOf('function');
      if (retirement === 'dispose') await handler.dispose();
      else await handler.handle(parseClaudeScreenState(HIDDEN_UNKNOWN_DIALOG));
      expect(retired?.signal?.aborted).toBe(true);
      await expect(retired!.acknowledgeDecisionApplication!({ decision: 'approved',
        answers: { claudeUnifiedTerminalTrustFolder: 'trust_once' },
      })).rejects.toThrow('claude_unified_dialog_request_retired');
      expect(port.sentLiteral).toEqual([]);
      expect(port.sentKeys).toEqual([]);
    } finally {
      await handler.dispose();
    }
  });

  it('surfaces native security notes and continues only after the selected user decision', async () => {
    // Own Claude Code 2.1.296 first-run capture on nl1; no composer or selectable rows.
    const securityNotes = [
      ' Security notes:',
      '',
      ' 1. Claude can make mistakes.',
      "    You're responsible for Claude's actions and should always",
      '    review them, especially when running code.',
      '',
      ' 2. Due to prompt injection risks, only use it with code you trust',
      '    Learn more: https://code.claude.com/docs/en/security',
      '',
      ' Press Enter to continue…',
      '',
    ].join('\n');
    type Decision = Readonly<{ decision: 'approved'; answers: Readonly<Record<string, string>> }>;
    let decide: ((decision: Decision) => void) | undefined;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) =>
      new Promise<Decision>((resolve, reject) => {
        decide = resolve;
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
    const port = createFakeControlPort({ captures: [securityNotes, IDLE_COMPOSER] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision), sessionId: 'session-1', port,
      settleMs: 0, wait: async () => undefined,
    });
    try {
      expect(await handler.handle(parseClaudeScreenState(securityNotes))).toBe('waiting_for_user');
      expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'AskUserQuestion', input: expect.objectContaining({
          questions: [expect.objectContaining({
            question: expect.stringContaining('Due to prompt injection risks'),
            options: [expect.objectContaining({ choice: 'continue', label: 'Continue' })],
          })],
        }),
      }), expect.anything());
      expect(port.sentKeys).toEqual([]);
      decide?.({ decision: 'approved', answers: { claudeUnifiedTerminalGenericDialog: 'continue' } });
      await vi.waitFor(() => expect(port.sentKeys).toEqual(['Enter']));
      expect(port.sentLiteral).toEqual([]);
      expect(await handler.handle(parseClaudeScreenState(`${securityNotes}\n${IDLE_COMPOSER}`)))
        .toBe('unhandled');
    } finally {
      await handler.dispose();
    }
  });

  it('surfaces first-run theme selection when the native cursor is on its focused choice', async () => {
    // Claude Code 2.1.296, own isolated tmux launch on nl1 (DF75).
    // The terminal cursor sits on the chooser, which is not an editable composer.
    const theme = [
      " Let's get started.",
      '',
      ' Choose the text style that looks best with your terminal',
      ' To change this later, run /theme',
      '',
      '     Auto (match terminal)',
      ' ❯ ✔ Dark mode',
      '     Light mode',
      '     Dark mode (colorblind-friendly)',
      '     Light mode (colorblind-friendly)',
      '     Dark mode (ANSI colors only)',
      '     Light mode (ANSI colors only)',
      '',
    ].join('\n');
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) =>
      pendingDecisionUntilAbort<Readonly<{ decision: 'approved' }>>(options?.signal));
    const port = createFakeControlPort({ captures: [theme] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision), sessionId: 'session-1', port,
      settleMs: 0, wait: async () => undefined,
    });
    try {
      expect(await handler.handle(parseClaudeScreenState(theme, { cursor: { x: 1, y: 6 } })))
        .toBe('waiting_for_user');
      expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'AskUserQuestion',
        input: expect.objectContaining({ questions: [expect.objectContaining({
          question: expect.stringContaining('Choose the text style'),
          options: expect.arrayContaining([expect.objectContaining({ label: '✔ Dark mode' })]),
        })] }),
      }), expect.anything());
      expect(port.sentLiteral).toEqual([]);
      expect(port.sentKeys).toEqual([]);
    } finally {
      await handler.dispose();
    }
  });

  it('keeps the plugin-owned dialog source equal to the host Protocol discriminant', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE)
      .toBe(PROTOCOL_CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE);
  });

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

  it.each([
    ['composer', { x: 2, y: 8 }, 'unhandled'],
    ['chooser', { x: 2, y: 2 }, 'waiting_for_user'],
  ] as const)('respects the %s cursor with a focused chooser above a separate composer', async (_owner, cursor, expected) => {
    const screen = `${HIDDEN_UNKNOWN_DIALOG}\n\n${IDLE_COMPOSER}`;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) =>
      pendingDecisionUntilAbort<Readonly<{ decision: 'approved' }>>(options?.signal));
    const port = createFakeControlPort({ captures: [screen] });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision), sessionId: 'session-1', port,
      settleMs: 0, wait: async () => undefined,
    });
    try {
      expect(await handler.handle(parseClaudeScreenState(screen, { cursor }))).toBe(expected);
      expect(handler.hasPendingUserAction()).toBe(expected === 'waiting_for_user');
      if (expected === 'unhandled') expect(requestDecision).not.toHaveBeenCalled();
      else expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'AskUserQuestion',
        input: expect.objectContaining({ questions: [expect.objectContaining({
          options: [
            expect.objectContaining({ label: 'No, disable external imports' }),
            expect.objectContaining({ label: 'Yes, allow external imports' }),
          ],
        })] }),
      }), expect.anything());
      expect(port.sentLiteral).toEqual([]);
      expect(port.sentKeys).toEqual([]);
    } finally {
      await handler.dispose();
    }
  });

  it('publishes and applies a future hidden-index generic dialog through verified focus navigation', async () => {
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { claudeUnifiedTerminalGenericDialog: 'option_2' },
    }));
    const port = createFakeControlPort({
      captures: [HIDDEN_UNKNOWN_DIALOG, HIDDEN_UNKNOWN_DIALOG_TARGET_FOCUSED, IDLE_COMPOSER],
    });
    const handler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: createContext(requestDecision),
      sessionId: 'session-1',
      policy: 'ask_every_time',
      port,
      settleMs: 0,
      wait: async () => undefined,
    });

    expect(await handler.handle(parseClaudeScreenState(HIDDEN_UNKNOWN_DIALOG))).toBe('waiting_for_user');
    await vi.waitFor(() => expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']));
    expect(port.sentLiteral).toEqual([]);
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        questions: [expect.objectContaining({
          options: [
            expect.objectContaining({ label: 'No, disable external imports' }),
            expect.objectContaining({ label: 'Yes, allow external imports' }),
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
