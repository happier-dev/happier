import { describe, expect, it, vi } from 'vitest';

import { createPermissionHandlerSessionStub } from '../../utils/permissionHandler.testkit';
import { createFakeControlPort } from '../tuiControls/fakeControlPort';
import { parseClaudeScreenState } from '../tuiControls/screenState';
import { ClaudeUnifiedDialogChoiceBroker } from '../dialogChoice/claudeUnifiedDialogChoiceBroker';
import { resolveClaudeUnifiedVisibleDialog } from '../tuiControls/dialogRegistry';
import { createClaudeUnifiedResumeChoiceStartupResolver } from './claudeUnifiedResumeChoiceStartupResolver';

const RESUME_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const IDLE = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

const EFFORT_DIALOG_HIGH = [
  'Change effort level?',
  'This conversation is cached for the current effort level.',
  'Switching to high means the full history gets re-read before Claude can continue.',
  '',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const EFFORT_DIALOG_MEDIUM = [
  'Change effort level?',
  'This conversation is cached for the current effort level.',
  'Switching to medium means the full history gets re-read before Claude can continue.',
  '',
  '❯ 1. Yes, switch to medium',
  '  2. No, go back',
].join('\n');

const EFFORT_DIALOG_ULTRACODE = [
  'Change effort level?',
  'This conversation is cached for the current effort level.',
  'Switching to ultracode means the full history gets re-read before Claude can continue.',
  '',
  '❯ 1. Yes, switch to ultracode',
  '  2. No, go back',
].join('\n');

const EFFORT_DIALOG_XHIGH = [
  'Change effort level?',
  'This conversation is cached for the current effort level.',
  'Switching to xhigh means the full history gets re-read before Claude can continue.',
  '',
  '❯ 1. Yes, switch to xhigh',
  '  2. No, go back',
].join('\n');

const SWITCH_MODEL_DIALOG = [
  'Switch model?',
  'Reading from cache may produce different results.',
  '',
  '❯ 1. Yes, switch',
  '  2. No, go back',
].join('\n');

const TRUST_FOLDER_DIALOG = [
  'Do you trust the files in this folder?',
  '❯ 1. Yes, proceed',
  '  2. No, exit',
].join('\n');

const CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION = 'How should Claude resume this session?';

describe('createClaudeUnifiedResumeChoiceStartupResolver', () => {
  it('keeps readiness paused for a non-resume startup dialog owned by the generalized broker', async () => {
    const { session, client } = createPermissionHandlerSessionStub('workspace-trust-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'claude_trust_choice_1' });
    broker.activate();
    const screenState = parseClaudeScreenState(TRUST_FOLDER_DIALOG);
    const dialog = resolveClaudeUnifiedVisibleDialog(screenState);
    expect(dialog?.dialogId).toBe('trust_folder');
    void broker.requestDialogChoice({ dialog: dialog! }).catch(() => undefined);
    await vi.waitFor(() => {
      expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual(['claude_trust_choice_1']);
    });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port: createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG] }),
      wait: async () => undefined,
      settleMs: 1,
    });

    await expect(resolver({
      screenState,
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'waiting_for_user' });

    await broker.dispose();
  });

  it('auto-answers resume-from-summary through terminal control', async () => {
    const { session } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    const port = createFakeControlPort({ captures: [RESUME_DIALOG, IDLE] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'resume_from_summary',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'handled' });

    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual([]);
  });

  it('auto-answers full-session resume through terminal control', async () => {
    const { session } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    const port = createFakeControlPort({ captures: [RESUME_DIALOG, IDLE] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'resume_full_session',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
    });

    await resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    });

    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual([]);
  });

  it('does not repeatedly send an auto-answer after a terminal control failure', async () => {
    const { session } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    const port = createFakeControlPort({
      captures: [RESUME_DIALOG, RESUME_DIALOG, RESUME_DIALOG],
    });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'resume_full_session',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unhandled' });
    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 2,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unhandled' });

    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual([]);
  });

  it('asks the user once and sends the selected answer after the existing user-action RPC resolves', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'claude_resume_choice_1' });
    broker.activate();
    const port = createFakeControlPort({ captures: [RESUME_DIALOG, IDLE] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'waiting_for_user' });
    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 2,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'waiting_for_user' });

    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual(['claude_resume_choice_1']);

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_resume_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Resume from summary' },
    });

    await vi.waitFor(() => {
      expect(port.sentLiteral).toEqual(['1']);
      expect(port.sentKeys).toEqual([]);
    });
  });

  it('submits and marks compaction for the remembered summary choice', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'claude_resume_choice_1' });
    broker.activate();
    const port = createFakeControlPort({ captures: [RESUME_DIALOG, IDLE] });
    const onResumeSummaryCompactionSubmitted = vi.fn();
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
      onResumeSummaryCompactionSubmitted,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'waiting_for_user' });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_resume_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Always resume from summary' },
    });

    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['1']));
    expect(onResumeSummaryCompactionSubmitted).toHaveBeenCalledTimes(1);
  });

  it('keeps startup timeout paused while an answered ask-every-time choice is still being typed', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'claude_resume_choice_1' });
    broker.activate();
    const port = createFakeControlPort({ captures: [RESUME_DIALOG, IDLE] });
    let releaseSettle!: () => void;
    const settleStarted = vi.fn();
    const settlePromise = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => {
        settleStarted();
        await settlePromise;
      },
      settleMs: 1,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'waiting_for_user' });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_resume_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_RESUME_CHOICE_QUESTION]: 'Resume from summary' },
    });

    await vi.waitFor(() => {
      expect(settleStarted).toHaveBeenCalledTimes(1);
    });
    expect(broker.hasPendingChoice()).toBe(false);
    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 2,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'waiting_for_user' });

    releaseSettle();
    await vi.waitFor(() => {
      expect(port.sentLiteral).toEqual(['1']);
      expect(port.sentKeys).toEqual([]);
    });
  });

  it('does not publish a new user action after the user cancels the resume choice', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
      createRequestId: vi.fn()
        .mockReturnValueOnce('claude_resume_choice_1')
        .mockReturnValueOnce('claude_resume_choice_2'),
    });
    broker.activate();
    const port = createFakeControlPort({ captures: [RESUME_DIALOG] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'waiting_for_user' });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_resume_choice_1',
      approved: false,
      reason: 'user_canceled_resume_choice',
    });
    await vi.waitFor(() => {
      expect(broker.hasPendingChoice()).toBe(false);
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 2,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unhandled' });

    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual([]);
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_1).toMatchObject({
      status: 'canceled',
      reason: 'user_canceled_resume_choice',
    });
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_2).toBeUndefined();
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('cancels the pending user action if the dialog disappears before the user answers', async () => {
    const { session, client } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'claude_resume_choice_1' });
    broker.activate();
    const port = createFakeControlPort({ captures: [IDLE] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
    });

    await resolver({
      screenState: parseClaudeScreenState(RESUME_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    });
    let releaseCancellation!: () => void;
    const cancellationApplied = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const noteDialogResolved = vi.spyOn(broker, 'noteDialogResolvedInTerminal')
      .mockImplementation(async (reason) => {
        await cancellationApplied;
        await broker.cancelPendingChoice(reason);
      });
    let resolverSettled = false;
    const resolution = Promise.resolve(resolver({
      screenState: parseClaudeScreenState(IDLE),
      observedAtMs: 2,
      abortSignal: new AbortController().signal,
    })).finally(() => {
      resolverSettled = true;
    });

    await Promise.resolve();
    expect(noteDialogResolved).toHaveBeenCalledWith('resume_dialog_resolved_in_terminal');
    expect(resolverSettled).toBe(false);

    releaseCancellation();
    await expect(resolution).resolves.toEqual({ status: 'handled' });

    expect(port.sentLiteral).toEqual([]);
    expect(client.getAgentStateSnapshot().completedRequests.claude_resume_choice_1).toMatchObject({
      status: 'canceled',
      reason: 'resume_dialog_resolved_in_terminal',
    });
  });

  it('answers an orphan effort-change dialog with switch when its target matches the configured startup effort', async () => {
    const { session } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG_HIGH, IDLE] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
      startupMode: { permissionMode: 'default', reasoningEffort: 'high' },
      isRuntimeControlInFlight: () => false,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(EFFORT_DIALOG_HIGH),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'handled' });

    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual([]);
  });

  it('answers an orphan effort-change dialog with go-back when its target differs from the configured startup effort', async () => {
    const { session } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG_MEDIUM, IDLE] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
      startupMode: { permissionMode: 'default', reasoningEffort: 'high' },
      isRuntimeControlInFlight: () => false,
    });

    await resolver({
      screenState: parseClaudeScreenState(EFFORT_DIALOG_MEDIUM),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    });

    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual([]);
  });

  it.each([
    ['ultracode', EFFORT_DIALOG_ULTRACODE],
    ['xhigh', EFFORT_DIALOG_XHIGH],
  ] as const)(
    'accepts an orphan %s effort target when startup configured Ultracode',
    async (_target, capture) => {
      const { session } = createPermissionHandlerSessionStub('resume-choice-session');
      const broker = new ClaudeUnifiedDialogChoiceBroker(session);
      const port = createFakeControlPort({ captures: [capture, IDLE] });
      const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
        choice: 'ask_every_time',
        broker,
        port,
        wait: async () => undefined,
        settleMs: 1,
        startupMode: { permissionMode: 'default', ultracode: true },
        isRuntimeControlInFlight: () => false,
      });

      await expect(resolver({
        screenState: parseClaudeScreenState(capture),
        observedAtMs: 1,
        abortSignal: new AbortController().signal,
      })).resolves.toEqual({ status: 'handled' });

      expect(port.sentLiteral).toEqual(['1']);
      expect(port.sentKeys).toEqual([]);
      expect(port.sentRaw).toEqual([]);
    },
  );

  it('leaves an effort-change dialog to the runtime-control apply episode while that driver owns it', async () => {
    const { session } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG_HIGH, IDLE] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
      startupMode: { permissionMode: 'default', reasoningEffort: 'high' },
      isRuntimeControlInFlight: () => true,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(EFFORT_DIALOG_HIGH),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unhandled' });

    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('answers an orphan switch-model dialog when the startup mode configured a model', async () => {
    const { session } = createPermissionHandlerSessionStub('resume-choice-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    const port = createFakeControlPort({ captures: [SWITCH_MODEL_DIALOG, IDLE] });
    const resolver = createClaudeUnifiedResumeChoiceStartupResolver({
      choice: 'ask_every_time',
      broker,
      port,
      wait: async () => undefined,
      settleMs: 1,
      startupMode: { permissionMode: 'default', model: 'claude-sonnet-4-6' },
      isRuntimeControlInFlight: () => false,
    });

    await expect(resolver({
      screenState: parseClaudeScreenState(SWITCH_MODEL_DIALOG),
      observedAtMs: 1,
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'handled' });

    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual([]);
  });
});
