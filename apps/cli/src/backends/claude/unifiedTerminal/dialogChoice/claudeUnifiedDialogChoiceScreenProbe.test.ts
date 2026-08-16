import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/agents';

import { createPermissionHandlerSessionStub } from '../../utils/permissionHandler.testkit';
import type { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createFakeControlPort } from '../tuiControls/fakeControlPort';
import { resolveClaudeUnifiedVisibleDialog } from '../tuiControls/dialogRegistry';
import { parseClaudeScreenState } from '../tuiControls/screenState';
import {
  CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION,
  ClaudeUnifiedDialogChoiceBroker,
} from './claudeUnifiedDialogChoiceBroker';
import { createClaudeUnifiedDialogChoiceScreenProbe } from './claudeUnifiedDialogChoiceScreenProbe';

const EFFORT_DIALOG = [
  'Change effort level?',
  'Switching to high means the full history gets re-read before Claude can continue.',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const SAFEGUARD_DIALOG = [
  'Session paused',
  'Fable 5\'s safeguards flagged this message.',
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

const UNKNOWN_DIALOG = [
  'Reset conversation cache?',
  '❯ 1. Yes, reset it',
  '  2. No, go back',
].join('\n');

const LSP_RECOMMENDATION_DIALOG = [
  'LSP plugin recommendation',
  '',
  'LSP provides code intelligence like go-to-definition and error checking',
  '',
  'Plugin: swift-lsp',
  'Swift language server (SourceKit-LSP) for code intelligence',
  'Triggered by: .swift files',
  '',
  'Would you like to install this LSP plugin?',
  '❯ 1. Yes, install swift-lsp',
  '  2. No, not now',
  '  3. Never for swift-lsp',
  '  4. Disable all LSP recommendations',
].join('\n');

const RESUME_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const TRUST_FOLDER_DIALOG = [
  'Accessing workspace:',
  '/private/tmp/new-project',
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
].join('\n');

const IDLE = ['──────────────────────────────', '❯ ', '──────────────────────────────'].join('\n');

// Live runner pid 57509 published claude_dialog_choice_639f8db8-a03f-4b66-9af6-06e1b3c02dd6
// at 2026-07-23 14:04:49.874 after seeing an incomplete selection-shaped screen. The stable
// read-only tmux capture had no chooser: completed output followed by this cursor-at-start DIM
// contextual suggestion. Keep one isolated selection-shaped transcript row above the exact idle
// composer to exercise the owner bug: full-pane dialog scanning must not let stale/incomplete
// scrollback override the canonical active-composer evidence.
const IDLE_DIM_SUGGESTION_AFTER_INCOMPLETE_SELECTION_SHAPED_OUTPUT = [
  '❯ 1. completed transcript output, not a chooser',
  '',
  '\x1b[38;2;255;255;255m⏺\x1b[39m QA_SWIFT_DIALOG_TRIGGER_DONE',
  '',
  '\x1b[38;2;153;153;153m✻\x1b[39m \x1b[38;2;153;153;153mChurned for 24s\x1b[39m',
  '',
  '\x1b[38;2;136;136;136m────────────────────────────────────────────────',
  '\x1b[39m❯ \x1b[2mrun it\x1b[0m',
  '\x1b[38;2;136;136;136m────────────────────────────────────────────────',
  '\x1b[39m',
  '  \x1b[38;2;255;193;7m⏵⏵ auto mode on\x1b[38;2;153;153;153m (shift+tab to cycle) · ← for agents\x1b[39m',
].join('\n');

function createHarness(params: Readonly<{
  captures: readonly string[];
  ownsDialog?: (dialogId: string) => boolean;
  resumeStartupActive?: boolean;
  trustPolicy?: 'ask_every_time' | 'always_trust_happier_workspaces' | 'always_reject_happier_workspaces';
}>) {
  const { session, client } = createPermissionHandlerSessionStub('dialog-choice-session');
  Object.assign(session, {
    accountSettings: params.trustPolicy
      ? { claudeUnifiedTerminalWorkspaceTrust: params.trustPolicy }
      : null,
  });
  let requestSequence = 0;
  const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
    createRequestId: () => `claude_dialog_choice_${++requestSequence}`,
    nowMs: () => 123,
  });
  broker.activate();
  const port = createFakeControlPort({ captures: params.captures });
  const probe = createClaudeUnifiedDialogChoiceScreenProbe({
    broker,
    port,
    wait: async () => undefined,
    graceMs: 25,
    settleMs: 1,
    verifyPollIntervalMs: 1,
    verifyPollTimeoutMs: 8,
    isDialogOwned: params.ownsDialog ?? (() => false),
    ...(params.resumeStartupActive === undefined
      ? {}
      : { isResumeStartupActive: () => params.resumeStartupActive === true }),
  });
  return { broker, client, port, probe };
}

describe('createClaudeUnifiedDialogChoiceScreenProbe', () => {
  it('does not publish an action-required episode for an idle DIM suggestion with stale incomplete selection-shaped output', async () => {
    const { client, port, probe } = createHarness({
      captures: [
        IDLE_DIM_SUGGESTION_AFTER_INCOMPLETE_SELECTION_SHAPED_OUTPUT,
        IDLE_DIM_SUGGESTION_AFTER_INCOMPLETE_SELECTION_SHAPED_OUTPUT,
      ],
    });
    const screen = parseClaudeScreenState(
      IDLE_DIM_SUGGESTION_AFTER_INCOMPLETE_SELECTION_SHAPED_OUTPUT,
      { cursor: { x: 2, y: 7 } },
    );

    expect(screen.composerContent).toBe('');
    expect(screen.userDraftPresent).toBe(false);
    expect(screen.unrecognizedConfirmationDialog).toBeNull();
    await expect(probe.evaluateScreenState(screen)).resolves.toEqual({ kind: 'not_visible' });
    expect(client.getAgentStateSnapshot().requests).toEqual({});
    expect(client.getAgentStateSnapshot().completedRequests).toEqual({});
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('clears an inherited dialog request when the restarted runner observes no dialog', async () => {
    const { client, probe } = createHarness({ captures: [IDLE] });
    client.agentState.requests.claude_dialog_choice_inherited = {
      tool: 'AskUserQuestion',
      kind: 'user_action',
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      arguments: {
        happierDialog: {
          kind: 'unrecognized',
          mode: 'notice',
          dialogId: 'unrecognized_confirmation',
          action: 'open_terminal',
        },
        questions: [],
      },
      createdAt: 1,
    };

    await expect(probe.evaluateScreenState(parseClaudeScreenState(IDLE))).resolves.toEqual({ kind: 'not_visible' });
    await vi.waitFor(() => expect(client.agentState.requests.claude_dialog_choice_inherited).toBeUndefined());
    expect(client.agentState.completedRequests.claude_dialog_choice_inherited).toMatchObject({
      status: 'canceled',
      reason: 'claude_dialog_resolved_in_terminal',
    });
  });

  it('leaves a Happier-initiated effort dialog to its slash-controls owner', async () => {
    const { client, port, probe } = createHarness({
      captures: [EFFORT_DIALOG],
      ownsDialog: (dialogId) => dialogId === 'effort_change',
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'owned', dialogId: 'effort_change' });
    expect(client.getAgentStateSnapshot().requests).toEqual({});
    expect(port.sentLiteral).toEqual([]);
  });

  it('clears an inherited broker request when the visible dialog is owned by another control path', async () => {
    const { client, probe } = createHarness({
      captures: [RESUME_DIALOG],
      resumeStartupActive: true,
    });
    client.agentState.requests.claude_dialog_choice_inherited = {
      tool: 'AskUserQuestion',
      kind: 'user_action',
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      arguments: {
        happierDialog: {
          kind: 'unrecognized',
          mode: 'notice',
          dialogId: 'unrecognized_confirmation',
          action: 'open_terminal',
        },
        questions: [],
      },
      createdAt: 1,
    };

    await expect(probe.probe()).resolves.toEqual({ kind: 'owned', dialogId: 'resume_choice' });
    await vi.waitFor(() => expect(client.agentState.requests.claude_dialog_choice_inherited).toBeUndefined());
    expect(client.agentState.completedRequests.claude_dialog_choice_inherited).toMatchObject({
      status: 'canceled',
      reason: 'claude_dialog_owned_by_control_path',
    });
  });

  it('does not cancel the live resume request owned by the startup resolver', async () => {
    const { broker, client, port, probe } = createHarness({
      captures: [RESUME_DIALOG],
      resumeStartupActive: true,
    });
    const dialog = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(RESUME_DIALOG));
    expect(dialog?.dialogId).toBe('resume_choice');
    void broker.requestDialogChoice({ dialog: dialog! }).catch(() => undefined);
    await vi.waitFor(() => {
      expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual(['claude_dialog_choice_1']);
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'owned', dialogId: 'resume_choice' });

    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual(['claude_dialog_choice_1']);
    expect(client.getAgentStateSnapshot().completedRequests.claude_dialog_choice_1).toBeUndefined();
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);

    await broker.dispose();
  });

  it('surfaces a TUI-initiated effort dialog after grace and injects the selected answer', async () => {
    const { client, port, probe } = createHarness({
      captures: [EFFORT_DIALOG, EFFORT_DIALOG, EFFORT_DIALOG, IDLE],
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'effort_change' });
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toMatchObject({
      tool: 'AskUserQuestion',
      kind: 'user_action',
      arguments: expect.objectContaining({
        happierDialog: { kind: 'recognized', dialogId: 'effort_change', secondaryAction: 'open_terminal' },
      }),
    });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: 'confirm' },
    });

    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['1']));
    expect(port.sentKeys).toEqual([]);
    expect(client.getAgentStateSnapshot().completedRequests.claude_dialog_choice_1).toMatchObject({
      status: 'approved',
      dialogId: 'effort_change',
      dialogChoice: 'confirm',
    });
  });

  it('replaces an inherited stale dialog request when the restarted runner observes a new dialog', async () => {
    const { client, probe } = createHarness({
      captures: [EFFORT_DIALOG, EFFORT_DIALOG],
    });
    client.agentState.requests.claude_dialog_choice_inherited = {
      tool: 'AskUserQuestion',
      kind: 'user_action',
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      arguments: {
        happierDialog: {
          kind: 'unrecognized',
          mode: 'notice',
          dialogId: 'unrecognized_confirmation',
          action: 'open_terminal',
        },
        questions: [],
      },
      createdAt: 1,
    };

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'effort_change' });
    await vi.waitFor(() => expect(client.agentState.requests.claude_dialog_choice_inherited).toBeUndefined());
    expect(client.agentState.completedRequests.claude_dialog_choice_inherited).toMatchObject({
      status: 'canceled',
      reason: 'claude_unified_dialog_changed',
    });
    expect(Object.keys(client.agentState.requests)).toEqual(['claude_dialog_choice_1']);
  });

  it('surfaces pre-hook workspace trust and injects only the user-selected decision', async () => {
    const { client, port, probe } = createHarness({
      captures: [TRUST_FOLDER_DIALOG, TRUST_FOLDER_DIALOG, TRUST_FOLDER_DIALOG, IDLE],
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'trust_folder' });
    expect(port.sentLiteral).toEqual([]);
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toMatchObject({
      tool: 'AskUserQuestion',
      kind: 'user_action',
      arguments: expect.objectContaining({
        happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
      }),
    });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: 'trust_once' },
    });

    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['1']));
    expect(port.sentKeys).toEqual([]);
    expect(client.getAgentStateSnapshot().completedRequests.claude_dialog_choice_1).toMatchObject({
      status: 'approved',
      dialogId: 'trust_folder',
      dialogChoice: 'trust_once',
    });
  });

  it.each([
    ['always_trust_happier_workspaces', '1'],
    ['always_reject_happier_workspaces', '2'],
  ] as const)('auto-answers only the exact trust prompt for policy %s', async (trustPolicy, literal) => {
    const { client, port, probe } = createHarness({
      captures: [TRUST_FOLDER_DIALOG, TRUST_FOLDER_DIALOG, TRUST_FOLDER_DIALOG, IDLE],
      trustPolicy,
    });

    await expect(probe.probe()).resolves.toEqual({
      kind: 'automatic_answer_started',
      dialogId: 'trust_folder',
    });
    await vi.waitFor(() => expect(port.sentLiteral).toEqual([literal]));
    expect(port.sentKeys).toEqual([]);
    expect(client.getAgentStateSnapshot().requests).toEqual({});
  });

  it('waits through a delayed terminal redraw after Claude accepts an automatic dialog answer', async () => {
    const { client, port, probe } = createHarness({
      captures: [
        TRUST_FOLDER_DIALOG,
        TRUST_FOLDER_DIALOG,
        TRUST_FOLDER_DIALOG,
        TRUST_FOLDER_DIALOG,
        TRUST_FOLDER_DIALOG,
        TRUST_FOLDER_DIALOG,
        IDLE,
        IDLE,
      ],
      trustPolicy: 'always_trust_happier_workspaces',
    });

    await expect(probe.probe()).resolves.toEqual({
      kind: 'automatic_answer_started',
      dialogId: 'trust_folder',
    });

    await vi.waitFor(() => expect(port.captureCount()).toBeGreaterThanOrEqual(7));
    expect(port.sentLiteral).toEqual(['1']);
    await expect(probe.probe()).resolves.toEqual({ kind: 'not_visible' });
    expect(client.getAgentStateSnapshot().requests).toEqual({});
  });

  it('keeps the safeguard chooser on the generalized broker path', async () => {
    const { client, port, probe } = createHarness({
      captures: [SAFEGUARD_DIALOG, SAFEGUARD_DIALOG, SAFEGUARD_DIALOG, IDLE],
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'safeguard_pause' });
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: 'Edit prompt and retry with Fable 5' },
    });

    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['2']));
    expect(port.sentKeys).toEqual([]);
  });

  it('surfaces and answers a strictly parsed generic numbered dialog', async () => {
    const { broker, client, port, probe } = createHarness({
      captures: [UNKNOWN_DIALOG, UNKNOWN_DIALOG, UNKNOWN_DIALOG, IDLE],
    });
    const requestStore = Reflect.get(broker, 'requestStore') as AgentStateRequestStore;
    const notifyPush = vi.spyOn(requestStore, 'notifyPermissionRequestPushBestEffort');

    await expect(probe.probe()).resolves.toEqual({
      kind: 'request_published',
      dialogId: 'unrecognized_confirmation',
    });
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toMatchObject({
      arguments: expect.objectContaining({
        happierDialog: {
          kind: 'unrecognized',
          dialogId: 'unrecognized_confirmation',
          mode: 'generic',
          signature: expect.any(String),
          secondaryAction: 'open_terminal',
        },
        questions: [expect.objectContaining({
          question: 'Reset conversation cache?',
          options: [
            expect.objectContaining({ choice: '1', label: 'Yes, reset it' }),
            expect.objectContaining({ choice: '2', label: 'No, go back' }),
          ],
        })],
      }),
    });
    expect(notifyPush).not.toHaveBeenCalled();
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: '2' },
    });
    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['2']));
    expect(port.sentKeys).toEqual([]);
  });

  it('surfaces Claude 2.1.217 LSP recommendations through the generic private dialog owner', async () => {
    const { client, port, probe } = createHarness({
      captures: [LSP_RECOMMENDATION_DIALOG, LSP_RECOMMENDATION_DIALOG],
    });

    await expect(probe.probe()).resolves.toEqual({
      kind: 'request_published',
      dialogId: 'unrecognized_confirmation',
    });
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toMatchObject({
      tool: 'AskUserQuestion',
      kind: 'user_action',
      arguments: expect.objectContaining({
        happierDialog: expect.objectContaining({
          kind: 'unrecognized',
          mode: 'generic',
          secondaryAction: 'open_terminal',
        }),
        questions: [expect.objectContaining({
          question: expect.stringContaining('Would you like to install this LSP plugin?'),
          options: [
            expect.objectContaining({ choice: '1', label: 'Yes, install swift-lsp' }),
            expect.objectContaining({ choice: '2', label: 'No, not now' }),
            expect.objectContaining({ choice: '3', label: 'Never for swift-lsp' }),
            expect.objectContaining({ choice: '4', label: 'Disable all LSP recommendations' }),
          ],
        })],
      }),
    });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it.each([
    ['selected option', ['Reset conversation cache?', '❯ 1. Yes, reset it', '  2. Keep cache'].join('\n')],
    ['neighbor option', ['Reset conversation cache?', '❯ 1. Yes, archive it', '  2. No, go back'].join('\n')],
    ['dialog context', ['Delete conversation cache?', '❯ 1. Yes, reset it', '  2. No, go back'].join('\n')],
  ])('types no bytes when the generic %s changes before answer injection', async (_label, changedDialog) => {
    const { client, port, probe } = createHarness({
      captures: [UNKNOWN_DIALOG, UNKNOWN_DIALOG, changedDialog],
    });
    await expect(probe.probe()).resolves.toEqual({
      kind: 'request_published',
      dialogId: 'unrecognized_confirmation',
    });
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: '2' },
    });
    await vi.waitFor(() => expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_2).toBeDefined());
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('never leaves a visible parsed dialog after grace with neither an owner nor a published surface', async () => {
    for (const screen of [EFFORT_DIALOG, SAFEGUARD_DIALOG, UNKNOWN_DIALOG]) {
      const { broker, client, probe } = createHarness({ captures: [screen, screen] });
      const result = await probe.probe();
      expect(result.kind === 'owned' || broker.hasPendingChoice()).toBe(true);
      expect(Object.keys(client.getAgentStateSnapshot().requests)).toHaveLength(1);
      probe.dispose();
      broker.dispose();
    }
  });

  it('defers resume_choice to its dedicated startup resolver instead of double-publishing', async () => {
    // F2: resume_choice has a dedicated publisher (the startup resume resolver / resume-choice
    // broker). The generalized broker must NOT publish it too, or startup double-publishes a single
    // dialog into two needs-attention requests.
    const { broker, client, port, probe } = createHarness({ captures: [RESUME_DIALOG, RESUME_DIALOG] });

    await expect(probe.probe()).resolves.toEqual({ kind: 'owned', dialogId: 'resume_choice' });
    expect(broker.hasPendingChoice()).toBe(false);
    expect(client.getAgentStateSnapshot().requests).toEqual({});
    expect(port.sentLiteral).toEqual([]);
  });

  it('publishes a resume_choice dialog that surfaces AFTER the startup resolver has stood down', async () => {
    // S1-F2: resume_choice ownership is scoped to the startup window. If a resume dialog ever appears
    // post-startup (resolver stood down), the generalized probe must fail OPEN and publish it — never
    // defer forever into a silent hang.
    const { broker, client, probe } = createHarness({
      captures: [RESUME_DIALOG, RESUME_DIALOG],
      resumeStartupActive: false,
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'resume_choice' });
    expect(broker.hasPendingChoice()).toBe(true);
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toMatchObject({
      arguments: expect.objectContaining({
        happierDialog: { kind: 'recognized', dialogId: 'resume_choice', secondaryAction: 'open_terminal' },
      }),
    });
  });

  it('publishes a deferred owner dialog exactly once when control-run ownership has expired', async () => {
    // F3: a queued_by_provider `/effort` control completes before its dialog pops, so ownership has
    // expired by pop time. The owned dialog converts to unowned and must be published exactly once —
    // never left silent, never double-published across repeated observations.
    const { client, probe } = createHarness({
      captures: [EFFORT_DIALOG, EFFORT_DIALOG, EFFORT_DIALOG],
      ownsDialog: () => false,
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'effort_change' });
    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual(['claude_dialog_choice_1']);

    await expect(probe.evaluateScreenState(parseClaudeScreenState(EFFORT_DIALOG))).resolves.toEqual({
      kind: 'already_pending',
      dialogId: 'effort_change',
    });
    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual(['claude_dialog_choice_1']);
  });

  it('fails a freeform answer closed with a typed cancellation instead of an opaque throw', async () => {
    // F4: numbered-choice-only dialogs cannot accept a freeform "Other" answer. It must resolve as a
    // typed cancellation (fail closed), not throw an opaque permission_response_failed error, and must
    // never type stray bytes into the terminal.
    const { client, port, probe } = createHarness({
      captures: [EFFORT_DIALOG, EFFORT_DIALOG, IDLE],
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'effort_change' });

    const result = await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: 'Something else entirely' },
    });

    expect(result).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(client.getAgentStateSnapshot().completedRequests.claude_dialog_choice_1).toMatchObject({
        status: 'canceled',
        reason: 'claude_unified_dialog_choice_unsupported_freeform_answer',
      });
    });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('replaces a pending surface when the visible dialog changes', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-choice-session');
    let requestSequence = 0;
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
      createRequestId: () => `claude_dialog_choice_${++requestSequence}`,
      nowMs: () => 123,
    });
    broker.activate();
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG, SAFEGUARD_DIALOG] });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({
      broker,
      port,
      wait: async () => undefined,
      graceMs: 25,
      settleMs: 1,
      verifyPollIntervalMs: 1,
      verifyPollTimeoutMs: 8,
      isDialogOwned: () => false,
    });

    await expect(probe.evaluateScreenState(parseClaudeScreenState(EFFORT_DIALOG))).resolves.toEqual({
      kind: 'request_published',
      dialogId: 'effort_change',
    });
    await expect(probe.evaluateScreenState(parseClaudeScreenState(SAFEGUARD_DIALOG))).resolves.toEqual({
      kind: 'request_published',
      dialogId: 'safeguard_pause',
    });

    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toBeUndefined();
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_2).toMatchObject({
      arguments: expect.objectContaining({
        happierDialog: { kind: 'recognized', dialogId: 'safeguard_pause', secondaryAction: 'open_terminal' },
      }),
    });
  });
});
