import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SessionPermissionDecisionRequest, SessionPermissionDecisionResult, SessionPermissionsService } from '@happier-dev/plugin-sdk/sessions';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../../engine.testkit.js';
import { createFakeControlPort } from '../tuiControls/fakeControlPort.js';
import { parseClaudeScreenState } from '../screenState.js';
import { createClaudePermissionHookHandler } from '../../../shared/permissionHookHandler.js';
import { createClaudeUnifiedResumeChoiceStartupHandler } from './startup.js';

const QUESTIONS = [{ question: 'Which probe color?', header: 'Header Color', multiSelect: false,
  options: [{ label: 'Amber', description: 'Warm amber probe color.' }, { label: 'Blue', description: 'Cool blue probe color.' }] }];
const SCREEN = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.304-question-single.txt', import.meta.url), 'utf8');
const BLUE = SCREEN.replace('❯ 1. Amber', '  1. Amber').replace('  2. Blue', '❯ 2. Blue');
const IDLE = '──────────────────\n❯ \n──────────────────';
type DecisionOptions = Parameters<SessionPermissionsService['requestDecision']>[1];

function createHarness(captures: readonly string[], onEnter?: () => Promise<void> | void) {
  const pending: { request: SessionPermissionDecisionRequest; options: DecisionOptions; resolve: (value: SessionPermissionDecisionResult) => void }[] = [];
  const requestDecision = vi.fn<SessionPermissionsService['requestDecision']>((request, options) => new Promise(resolve => {
    pending.push({ request, options, resolve });
    options?.signal?.addEventListener('abort', () => resolve({ decision: 'abort' }), { once: true });
  }));
  const settleObservedDecision = vi.fn<NonNullable<SessionPermissionsService['settleObservedDecision']>>(async (observed) => {
    pending.find(entry => entry.request.requestId === observed.requestId)?.resolve({ decision: observed.decision, answers: observed.answers });
    return true;
  });
  const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
    sessionPermissions: { requestDecision, settleObservedDecision, getMode: () => 'default' },
    toolExecution: { before: async (call: { input: Record<string, unknown> }) => ({ status: 'continue', input: call.input }) },
  });
  const port = createFakeControlPort({ captures, onSendSpecialKey: async (key) => { if (key === 'Enter') await onEnter?.(); } });
  const handler = createClaudeUnifiedResumeChoiceStartupHandler({ ctx, sessionId: 'session-native', port,
    wait: async () => {}, settleMs: 0, verifyPollIntervalMs: 1, verifyPollTimeoutMs: 8,
  });
  const hook = (id: string, location = 'app_and_terminal') => handler.observeSessionHook({
    hook_event_name: 'ClaudeNativePrompt', session_id: 'native', tool_use_id: id,
    tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS }, happierResponseLocation: location,
  });
  return { ctx, handler, hook, pending, requestDecision, settleObservedDecision, port };
}

describe('native occurrences through the generalized Claude dialog owner', () => {

  it.each([
    ['missing', {}, null],
    ['malformed', { command: 671 }, null],
    ['blank', { command: ' \n ' }, null],
    ['prelude', { command: '  unset SYNTHETIC; export PROBE=1;\nprintf "first\\nsecond"\n  ' },
      'unset SYNTHETIC; export PROBE=1;\nprintf "first\\nsecond"'],
  ] as const)('keeps the correlated native Bash command contract for %s input', async (_label, toolInput, command) => {
    const screen = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-permission-clipped-command.txt', import.meta.url), 'utf8');
    const questionIndex = screen.indexOf(' Do you want to proceed?');
    const context = screen.slice(0, questionIndex + ' Do you want to proceed?'.length).trim();
    const explanation = 'Permission rule Bash(cat *) requires confirmation for this command.\n /permissions to update rules\n\n Do you want to proceed?';
    const h = createHarness([screen]);
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'ClaudeNativePrompt', session_id: 'native',
        tool_use_id: 'command-shape', tool_name: 'Bash', tool_input: toolInput, happierResponseLocation: 'app_and_terminal' });
      await h.handler.handle(parseClaudeScreenState(screen));
      expect(h.pending[0]?.request.input).toMatchObject({
        description: command === null ? context : command + '\n\n' + explanation,
      });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });


  it('publishes the complete correlated Bash command with only the native post-command explanation', async () => {
    const command = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-permission-clipped-command.sh.txt', import.meta.url), 'utf8').trim();
    const screen = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-permission-clipped-command.txt', import.meta.url), 'utf8');
    const explanation = 'Permission rule Bash(cat *) requires confirmation for this command.\n /permissions to update rules\n\n Do you want to proceed?';
    const h = createHarness([screen]);
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'PreToolUse', session_id: 'native',
        tool_use_id: 'long-command-1', tool_name: 'Bash', tool_input: { command } });
      await h.handler.observeSessionHook({ hook_event_name: 'ClaudeNativePrompt', session_id: 'native',
        tool_use_id: 'long-command-1', tool_name: 'Bash', tool_input: { command }, happierResponseLocation: 'app_and_terminal' });
      await h.handler.handle(parseClaudeScreenState(screen));
      expect(h.pending[0]?.request.input).toMatchObject({ command, description: command + '\n\n' + explanation });
      expect(h.pending[0]?.request.nativeChoices?.choices).toMatchObject([
        { label: 'Yes', id: 'option_1' }, { label: 'No', id: 'option_2' },
      ]);
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });


  it('publishes native preview choices without an app freeform field', async () => {
    const screen = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-question-preview-single.initial.txt', import.meta.url), 'utf8');
    const input: { questions: readonly unknown[] } = JSON.parse(readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-question-preview-input.json', import.meta.url), 'utf8'));
    const h = createHarness([screen]);
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'ClaudeNativePrompt', session_id: 'native',
        tool_use_id: 'preview-question', tool_name: 'AskUserQuestion', tool_input: input,
        happierResponseLocation: 'app_and_terminal' });
      await h.handler.handle(parseClaudeScreenState(screen));
      expect(h.pending[0]?.request).toMatchObject({ requestId: 'preview-question',
        input: { questions: [expect.objectContaining({ freeform: false })] } });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('publishes full hook-owned questions when the native tabs and question beginning are outside the viewport', async () => {
    const screen = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-question-clipped.txt', import.meta.url), 'utf8').split('\n').slice(1).join('\n');
    const input: { questions: readonly unknown[] } = JSON.parse(readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-question-clipped-input.json', import.meta.url), 'utf8'));
    const h = createHarness([screen]);
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'ClaudeNativePrompt', session_id: 'native',
        tool_use_id: 'clipped-question-1', tool_name: 'AskUserQuestion', tool_input: input,
        happierResponseLocation: 'app_and_terminal' });
      await h.handler.handle(parseClaudeScreenState(screen));
      expect(h.pending[0]?.request).toMatchObject({ requestId: 'clipped-question-1',
        input: { questions: input.questions } });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('waits for paint then publishes the original tool ID without writing terminal bytes', async () => {
    const h = createHarness(['', SCREEN]);
    try {
      await h.hook('question-1');
      expect(await h.handler.handle(parseClaudeScreenState('✻ Thinking…'))).toBe('waiting_for_user');
      expect(h.pending.map(entry => entry.request.requestId)).toEqual(['question-1']);
      expect(h.pending[0]!.request.input).toMatchObject({ questions: [expect.objectContaining({ question: 'Which probe color?' })] });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('publishes the existing terminal notice for a native form that does not match its tool question', async () => {
    const mismatched = SCREEN.replaceAll('Which probe color?', 'A different native question?').replaceAll('Header Color', 'Unrelated Header');
    const h = createHarness([mismatched]);
    try {
      await h.hook('question-1');
      await h.handler.handle(parseClaudeScreenState(mismatched));
      expect(h.pending[0]?.request.input).toMatchObject({ happierDialog: { kind: 'unrecognized', mode: 'notice' } });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('keeps terminal-only native questions outside the app request owner', async () => {
    const h = createHarness([SCREEN]);
    try {
      await h.hook('question-1', 'terminal_only');
      expect(await h.handler.handle(parseClaudeScreenState(SCREEN))).toBe('unhandled');
      expect(h.requestDecision).not.toHaveBeenCalled();
    } finally { await h.handler.dispose(); }
  });

  it.each([true, false])('settles the actual terminal question outcome (approved: %s)', async (approved) => {
    const h = createHarness([SCREEN]);
    try {
      await h.hook('question-1');
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      await h.handler.observeTranscript({ sessionId: 'native', type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'question-1', is_error: !approved }] },
        toolUseResult: approved ? { answers: { 'Which probe color?': 'Blue' } } : {},
      });
      expect(h.settleObservedDecision).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'question-1',
        decision: approved ? 'approved' : 'abort',
        ...(approved ? { answers: { 'Which probe color?': ['Blue'] } } : {}),
      }));
      await vi.waitFor(() => expect(h.handler.hasPendingUserAction()).toBe(false));
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('settles the original published native question after the same exact hook is delivered twice', async () => {
    const h = createHarness([SCREEN]);
    const permissionHook = createClaudePermissionHookHandler(h.ctx, {
      unifiedTerminalActive: true,
      responseLocations: { question: 'app_and_terminal', permission: 'app_and_terminal' },
      resolveToolUseId: h.handler.resolveToolUseId,
      onNativePrompt: h.handler.observeSessionHook,
      onPermissionLifecycle: h.handler.observeSessionHook,
    });
    const data = { hook_event_name: 'PreToolUse', session_id: 'native', tool_use_id: 'question-repeat',
      tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } };
    try {
      await permissionHook(data);
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      expect(h.pending.map(entry => entry.request.requestId)).toEqual(['question-repeat']);
      await permissionHook(data);
      expect(h.requestDecision).toHaveBeenCalledTimes(1);
      expect(h.pending[0]!.options!.signal!.aborted).toBe(false);
      await h.handler.observeTranscript({ sessionId: 'native', type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'question-repeat', is_error: false }] },
        toolUseResult: { answers: { 'Which probe color?': 'Blue' } },
      });
      expect(h.settleObservedDecision).toHaveBeenCalledWith({ requestId: 'question-repeat',
        source: 'claude_unified_terminal_dialog_choice', decision: 'approved',
        answers: { 'Which probe color?': ['Blue'] },
      });
      await vi.waitFor(() => expect(h.handler.hasPendingUserAction()).toBe(false));
      expect(h.handler.hasNativePrompt()).toBe(false);
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('keeps a new native occurrence when the previous app answer finishes', async () => {
    let h!: ReturnType<typeof createHarness>;
    h = createHarness([SCREEN, BLUE, SCREEN], async () => {
      await h.hook('question-2');
      await h.handler.observeSessionHook({ hook_event_name: 'PostToolUse', session_id: 'native', tool_use_id: 'question-1',
        tool_response: { answers: { 'Which probe color?': 'Blue' } },
      });
    });
    try {
      await h.hook('question-1');
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      const result = { decision: 'approved' as const, answers: { 'Which probe color?': ['Blue'] } };
      await h.pending[0]!.options!.acknowledgeDecisionApplication!(result);
      h.pending[0]!.resolve(result);
      await vi.waitFor(() => expect(h.pending.map(entry => entry.request.requestId)).toEqual(['question-1', 'question-2']));
      expect(h.handler.hasNativePrompt()).toBe(true);
      expect(h.pending[1]!.options!.signal!.aborted).toBe(false);
    } finally { await h.handler.dispose(); }
  });

  it('retires an app-applied native permission context while its accepted command is still running', async () => {
    const permission = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.309-permission-no-focused.txt', import.meta.url), 'utf8')
      .replace('   1. Yes', ' ❯ 1. Yes').replace(' ❯ 4. No', '   4. No');
    const h = createHarness([permission, IDLE]);
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'ClaudeNativePrompt', session_id: 'native',
        tool_use_id: 'permission-1', tool_name: 'Bash', tool_input: { command: 'sleep 600' },
      });
      await h.handler.handle(parseClaudeScreenState(permission));
      const result = { decision: 'approved' as const, nativeChoice: {
        requirementId: h.pending[0]!.request.nativeChoices!.requirementId, choiceId: 'option_1',
      } };
      await h.pending[0]!.options!.acknowledgeDecisionApplication!(result);
      h.pending[0]!.resolve(result);
      await vi.waitFor(() => expect(h.handler.hasPendingUserAction()).toBe(false));
      expect(h.handler.hasNativePrompt()).toBe(false);
      expect(h.port.sentKeys).toEqual(['Enter']);
    } finally { await h.handler.dispose(); }
  });

  it.each([['accept', false], ['reject', false], ['accept', true]] as const)('settles an app-prompt native permission from exact %s after Stop=%s', async (decision, stop) => {
    const h = createHarness([IDLE]);
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'PreToolUse', session_id: 'native', tool_use_id: 'app-permission-1',
        tool_name: 'Bash', tool_input: { command: 'missing-command' },
      });
      await h.handler.observeSessionHook({ hook_event_name: 'PermissionRequest', session_id: 'native', tool_use_id: 'app-permission-1',
        tool_name: 'Bash', tool_input: { command: 'missing-command' },
      });
      if (stop) await h.handler.observeSessionHook({ hook_event_name: 'Stop', session_id: 'native' });
      const result = { sessionId: 'native', type: 'user', permissionDecision: { decision },
        message: { content: [{ type: 'tool_result', tool_use_id: 'app-permission-1', is_error: true }] },
      };
      await h.handler.observeTranscript({ ...result, sessionId: 'foreign' });
      await h.handler.observeTranscript({ ...result, isSidechain: true });
      await h.handler.observeTranscript({ ...result, parent_tool_use_id: 'child-tool' });
      await h.handler.observeTranscript({ ...result, parentToolUseId: 'child-tool' });
      await h.handler.observeTranscript({ ...result, permissionDecision: undefined });
      expect(h.settleObservedDecision).not.toHaveBeenCalled();
      await h.handler.observeTranscript(result);
      expect(h.settleObservedDecision).toHaveBeenCalledWith({ requestId: 'app-permission-1',
        source: 'native_tool_approval_once', decision: decision === 'accept' ? 'approved' : 'denied',
      });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('settles the old app permission after Stop while inferring only the next live same-input tool', async () => {
    const h = createHarness([IDLE]);
    const first = new AbortController();
    const next = new AbortController();
    const permissionHook = createClaudePermissionHookHandler(h.ctx, { unifiedTerminalActive: true,
      responseLocations: { question: 'app_only', permission: 'app_only' },
      resolveToolUseId: h.handler.resolveToolUseId, onNativePrompt: h.handler.observeSessionHook,
      onPermissionLifecycle: h.handler.observeSessionHook,
    });
    const data = { session_id: 'native', tool_name: 'Bash', tool_input: { command: 'echo same' } };
    let firstHook: Promise<unknown> | undefined;
    let nextHook: Promise<unknown> | undefined;
    try {
      await h.handler.observeSessionHook({ ...data, hook_event_name: 'PreToolUse', tool_use_id: 'old-permission' });
      firstHook = permissionHook({ ...data, hook_event_name: 'PermissionRequest' }, { signal: first.signal });
      await vi.waitFor(() => expect(h.pending[0]?.request.requestId).toBe('old-permission'));
      await h.handler.observeSessionHook({ hook_event_name: 'Stop', session_id: 'native' });
      await h.handler.observeSessionHook({ ...data, hook_event_name: 'PreToolUse', tool_use_id: 'next-permission' });
      nextHook = permissionHook({ ...data, hook_event_name: 'PermissionRequest' }, { signal: next.signal });
      await vi.waitFor(() => expect(h.pending[1]?.request.requestId).toBe('next-permission'));
      await h.handler.observeTranscript({ sessionId: 'native', type: 'user', permissionDecision: { decision: 'accept' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'old-permission', is_error: true }] },
      });
      expect(h.settleObservedDecision).toHaveBeenCalledWith({ requestId: 'old-permission',
        source: 'native_tool_approval_once', decision: 'approved',
      });
      await expect(firstHook).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
      expect(h.pending[1]!.options!.signal!.aborted).toBe(false);
      expect(h.port.sentKeys).toEqual([]);
    } finally {
      first.abort(); next.abort();
      await Promise.all([firstHook, nextHook]);
      await h.handler.dispose();
    }
  });

  it('retains its own clipped draft and the same pending occurrence after an interrupted answer', async () => {
    const initial = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.316-question-long-freeform.initial.txt', import.meta.url), 'utf8');
    const filled = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.316-question-long-freeform.filled.txt', import.meta.url), 'utf8');
    const input: { questions: { question: string }[] } = JSON.parse(readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.316-question-long-freeform-input.json', import.meta.url), 'utf8'));
    const text = ('This is harmless synthetic freeform text for an isolated diagnostic. The public fixture should preserve the selected status and explain each ordinary display change without changing any real settings. '.repeat(4)).trim();
    const h = createHarness([initial, '']);
    try {
      const hook = { hook_event_name: 'ClaudeNativePrompt', session_id: 'native', tool_use_id: 'clipped-draft',
        tool_name: 'AskUserQuestion', tool_input: input, happierResponseLocation: 'app_and_terminal' };
      await h.handler.observeSessionHook(hook);
      await h.handler.handle(parseClaudeScreenState(initial));
      const pending = h.pending[0]!;
      await expect(pending.options!.acknowledgeDecisionApplication!({ decision: 'approved',
        answers: { [input.questions[0]!.question]: [text] } })).rejects.toThrow();
      await h.handler.observeSessionHook(hook);
      expect(await h.handler.handle(parseClaudeScreenState(filled))).toBe('waiting_for_user');
      expect(pending.options!.signal!.aborted).toBe(false);
      expect(h.pending).toHaveLength(1);
      expect(h.port.sentLiteral).toEqual([text]);
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('keeps sent answers pending, verifies retries without replay, and settles only the observed provider answer', async () => {
    const h = createHarness([SCREEN]);
    try {
      await h.hook('question-unconfirmed');
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      const pending = h.pending[0]!;
      const result = { decision: 'approved' as const, answers: { 'Which probe color?': ['Amber'] } };
      const unconfirmed = { code: 'STRUCTURED_QUESTION_SUBMISSION_UNCONFIRMED', retryable: true };
      await expect(pending.options!.acknowledgeDecisionApplication!(result)).rejects.toMatchObject(unconfirmed);
      await h.hook('question-unconfirmed');
      await expect(pending.options!.acknowledgeDecisionApplication!(result)).rejects.toMatchObject(unconfirmed);
      await expect(pending.options!.acknowledgeDecisionApplication!({ decision: 'approved',
        answers: { 'Which probe color?': ['Blue'] } })).rejects.toMatchObject(unconfirmed);
      expect(h.port.sentKeys).toEqual(['Enter']);
      expect(h.handler.hasPendingUserAction()).toBe(true);
      expect(pending.options!.signal!.aborted).toBe(false);
      await h.handler.observeSessionHook({ hook_event_name: 'PostToolUse', session_id: 'native',
        tool_use_id: 'question-unconfirmed', tool_response: { answers: { 'Which probe color?': 'Amber' } } });
      await vi.waitFor(() => expect(h.handler.hasPendingUserAction()).toBe(false));
      expect(h.settleObservedDecision).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'question-unconfirmed', decision: 'approved', answers: { 'Which probe color?': ['Amber'] },
      }));
      expect(h.port.sentKeys).toEqual(['Enter']);
    } finally { await h.handler.dispose(); }
  });

  it.each([true, false])('checks actual provider answers before app acknowledgement (matching: %s)', async (matching) => {
    let h!: ReturnType<typeof createHarness>;
    h = createHarness([SCREEN, BLUE, IDLE], async () => {
      await h.handler.observeSessionHook({ hook_event_name: 'PostToolUse', session_id: 'native', tool_use_id: 'question-1',
        tool_response: { answers: { 'Which probe color?': matching ? 'Blue' : 'Amber' } },
      });
    });
    try {
      await h.hook('question-1');
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      const result = { decision: 'approved' as const, answers: { 'Which probe color?': ['Blue'] } };
      const application = h.pending[0]!.options!.acknowledgeDecisionApplication!(result);
      if (matching) await expect(application).resolves.toBeUndefined();
      else await expect(application).rejects.toThrow('claude_unified_dialog_terminal_answer_failed');
      expect(h.port.sentKeys).toEqual(['ArrowDown', 'Enter']);
      expect(h.settleObservedDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approved',
        answers: { 'Which probe color?': [matching ? 'Blue' : 'Amber'] },
      }));
    } finally { await h.handler.dispose(); }
  });
});


describe('native Read scopes through the existing dialog owner', () => {
  it.each([2, 3])('publishes exact scopes and applies native one-time choice %s', async (selected) => {
    const initial = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-read-outside.txt', import.meta.url), 'utf8');
    const screen = (focused: number) => initial.replace(/^ [ ❯] (\d+)\./gmu,
      (_, number: string) => ' ' + (focused + 1 === Number(number) ? '❯' : ' ') + ' ' + number + '.')
      .replace(' · Tab to amend', focused === 1 || focused === 2 ? '' : ' · Tab to amend');
    const h = createHarness([...Array.from({ length: selected + 1 }, (_, index) => screen(index)), IDLE]);
    const labels = [
      'Yes, and keep allowing any reads outside the working directories',
      'No, and block reads outside the working directories from now on',
      'No, and ask again next time',
      'Yes, but ask again next time',
    ];
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'PreToolUse', session_id: 'native', tool_use_id: 'read-outside-1',
        tool_name: 'Read', tool_input: { file_path: '/tmp/issue671-native-probe/workspace/outside-read-link-671.txt' } });
      await h.handler.observeSessionHook({ hook_event_name: 'ClaudeNativePrompt', session_id: 'native', tool_use_id: 'read-outside-1',
        tool_name: 'Read', tool_input: { file_path: '/tmp/issue671-native-probe/workspace/outside-read-link-671.txt' },
        happierResponseLocation: 'app_and_terminal' });
      await h.handler.handle(parseClaudeScreenState(initial));
      expect(h.pending[0]?.request.nativeChoices?.choices).toMatchObject(
        labels.map((label, index) => ({ label, id: 'option_' + (index + 1) })),
      );
      const result = { decision: selected === 2 ? 'denied' as const : 'approved' as const, nativeChoice: {
        requirementId: h.pending[0]!.request.nativeChoices!.requirementId, choiceId: 'option_' + (selected + 1),
      } };
      await h.pending[0]!.options!.acknowledgeDecisionApplication!(result);
      h.pending[0]!.resolve(result);
      await vi.waitFor(() => expect(h.handler.hasPendingUserAction()).toBe(false));
      expect(h.port.sentKeys).toEqual([...Array.from({ length: selected }, () => 'ArrowDown'), 'Enter']);
      expect(h.port.sentLiteral).toEqual([]);
      expect(h.handler.hasNativePrompt()).toBe(false);
    } finally { await h.handler.dispose(); }
  });
});
