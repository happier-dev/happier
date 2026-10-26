import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_RPC_HANDLER_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { FakePermissionClient } from '../../utils/permissionHandler.testkit';
import { Session } from '../../session';
import type { EnhancedMode } from '../../loop';
import { parseClaudeScreenState } from '../tuiControls/screenState';
import { getClaudeUnifiedDialogIdentity } from '../tuiControls/dialogRegistry';
import { ClaudeUnifiedDialogChoiceBroker } from './claudeUnifiedDialogChoiceBroker';
import { createClaudeUnifiedDialogChoiceScreenProbe } from './claudeUnifiedDialogChoiceScreenProbe';
import { createFakeControlPort } from '../tuiControls/fakeControlPort';
import { ClaudeLocalPermissionBridge } from '../../localPermissions/localPermissionBridge';
import { routeClaudePermissionHook } from '../../localPermissions/routeClaudePermissionHook';
import { createClaudeSessionTranscriptProjector } from '../../localControl/createClaudeSessionTranscriptProjector';
import { createClaudeUnifiedHookLifecycleBridge } from '../createClaudeUnifiedHookLifecycleBridge';
import { createClaudeUnifiedInputArbiter } from '../createClaudeUnifiedInputArbiter';

const QUESTIONS = [{ question: 'Which probe color?', header: 'Header Color', multiSelect: false,
  options: [{ label: 'Amber', description: 'Warm amber probe color.' }, { label: 'Blue', description: 'Cool blue probe color.' }],
}];
const SCREEN = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.304-question-single.txt', import.meta.url), 'utf8');

const sessions = new Set<Session>();
afterEach(() => {
  for (const session of sessions) session.cleanup();
  sessions.clear();
});

function createHarness() {
  const client = new FakePermissionClient('native-prompt');
  const session = new Session({
    // The canonical transport fake implements the client methods exercised by these flows.
    client: client as unknown as SessionClientPort,
    path: '/tmp', logPath: '/tmp/native-prompt-test.log', sessionId: null,
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'), onModeChange: () => {},
    hookSettingsPath: '/tmp/native-prompt-hooks.json',
  });
  sessions.add(session);
  let sequence = 0;
  const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => `native-${++sequence}` });
  broker.activate();
  session.addClaudeSessionHookCallback((data) => broker.observeSessionHook(data));
  const observe = (id: string, location = 'app_and_terminal') => session.onClaudeSessionHook({
    hook_event_name: 'ClaudeNativePrompt', session_id: 'claude-native-session',
    tool_use_id: id, tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS },
    happierResponseLocation: location,
  });
  return { session, broker, client, observe };
}

describe('native prompts through the existing terminal dialog owner', () => {
  it('publishes the full correlated Bash command with the native explanation instead of a clipped command tail', async () => {
    const { session, broker, client } = createHarness();
    const command = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-permission-clipped-command.sh.txt', import.meta.url), 'utf8').trim();
    const tool = { session_id: 'claude-native-session', tool_name: 'Bash', tool_input: { command } };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse', tool_use_id: 'toolu-long-command' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt' });
    const explanation = 'Permission rule Bash(cat *) requires confirmation for this command.\n /permissions to update rules\n\n Do you want to proceed?';
    const screen = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-permission-clipped-command.txt', import.meta.url), 'utf8');
    const dialog = broker.resolveVisibleDialog(parseClaudeScreenState(screen));
    expect(dialog).toMatchObject({ kind: 'native', dialogId: 'tool_permission', question: `${command}\n\n${explanation}` });
    if (!dialog) throw new Error('expected current native permission');
    const pending = broker.requestDialogChoice({ dialog });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['native-1']).toMatchObject({ arguments: { questions: [{
      question: `${command}\n\n${explanation}`,
      options: [{ label: 'Yes', choice: 'option_1' }, { label: 'No', choice: 'option_2' }],
    }] } }));
    await broker.dispose();
  });

  it('publishes the full hook-owned questions while their native tab header is above the viewport', async () => {
    const { session, broker, client } = createHarness();
    const screen = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-question-clipped.txt', import.meta.url), 'utf8');
    const input = JSON.parse(readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-question-clipped-input.json', import.meta.url), 'utf8'));
    session.onClaudeSessionHook({ hook_event_name: 'ClaudeNativePrompt', session_id: 'claude-native-session',
      tool_use_id: 'toolu-clipped-question', tool_name: 'AskUserQuestion', tool_input: input,
    });
    const dialog = broker.resolveVisibleDialog(parseClaudeScreenState(screen));
    expect(dialog).toMatchObject({ kind: 'native', dialogId: 'ask_user_question' });
    if (!dialog) throw new Error('expected current native question');
    const pending = broker.requestDialogChoice({ dialog });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['toolu-clipped-question']).toMatchObject({ arguments: { questions: input.questions } }));
    await broker.dispose();
  });

  it('releases native input after repeated ingress observes one tool prompt resolved in the terminal', async () => {
    const { session, broker, client } = createHarness();
    const injected: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      injectPrompt: async (batch) => {
        injected.push(batch.message);
        return { status: 'injected', at: Date.now(), bytesWritten: batch.message.length };
      },
    });
    const lifecycle = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        session.addClaudeSessionHookCallback(callback);
        return () => session.removeClaudeSessionHookCallback(callback);
      },
      arbiter, completionQuiescenceMs: 0,
    });
    lifecycle.start({ abortSignal: new AbortController().signal });
    arbiter.observeLifecycle({ type: 'output' });
    const ingress = () => routeClaudePermissionHook({
      data: { hook_event_name: 'PreToolUse', session_id: 'claude-native-session',
        tool_use_id: 'native-repeat', tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } },
      session, bridge: null, settings: {}, unifiedTerminalActive: true,
    });
    try {
      await ingress();
      const dialog = broker.resolveVisibleDialog(parseClaudeScreenState(SCREEN));
      if (!dialog) throw new Error('expected native question');
      const pending = broker.requestDialogChoice({ dialog });
      void pending.catch(() => {});
      await vi.waitFor(() => expect(client.agentState.requests['native-repeat']).toBeDefined());
      await ingress();
      await arbiter.enqueueUiMessage({ message: 'continue after native answer', origin: { kind: 'ui_immediate' } });
      await arbiter.drainWhenSafe();
      expect(injected).toEqual([]);

      await broker.observeTranscript({ sessionId: 'claude-native-session', type: 'user',
        toolUseResult: { answers: { 'Which probe color?': 'Blue' } },
        message: { content: [{ type: 'tool_result', tool_use_id: 'native-repeat' }] },
      });
      await arbiter.drainWhenSafe();
      expect(injected).toEqual(['continue after native answer']);
      expect(client.agentState.requests['native-repeat']).toBeUndefined();
      expect(client.agentState.completedRequests['native-repeat']).toMatchObject({ status: 'approved' });
      await expect(pending).rejects.toThrow();
    } finally {
      await broker.dispose();
      lifecycle.dispose();
      await arbiter.dispose();
    }
  });

  it.each(['current primary', 'headless sidechain', 'legacy no live hook', 'legacy sidechain history'] as const)('correlates repeated provider requests without claiming a historical or another agent identity (%s)', async (source) => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-live-permission-id-'));
    const { session, broker, client } = createHarness();
    session.sessionId = 'claude-native-session';
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();
    const toolName = source === 'headless sidechain' ? 'Write' : 'ExitPlanMode';
    const toolInput = source === 'headless sidechain'
      ? { file_path: '/tmp/native-sidechain-probe.txt', content: 'fixture text' }
      : { plan: '# Same harmless resumed plan', planFilePath: '/tmp/plan.md' };
    session.transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(session.transcriptPath, [
      { type: 'assistant', sessionId: session.sessionId, message: { content: [{ type: 'tool_use', id: 'old-plan-id', name: toolName, input: toolInput }] } },
      { type: 'user', sessionId: session.sessionId, permissionDecision: { decision: 'accept' }, message: { content: [{ type: 'tool_result', tool_use_id: 'old-plan-id' }] } },
      { type: 'user', sessionId: session.sessionId, message: { content: 'Ask for the same plan again after resume.' } },
      ...(source === 'headless sidechain' ? [{ type: 'assistant', sessionId: session.sessionId,
        message: { content: [{ type: 'tool_use', id: 'current-plan-id', name: toolName, input: toolInput }] } }] : []),
      ...(source === 'legacy sidechain history' ? [{ type: 'assistant', sessionId: session.sessionId, isSidechain: true,
        message: { content: [{ type: 'tool_use', id: 'child-plan-id', name: toolName, input: toolInput }] } }] : []),
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    try {
      // The real native producer emits this exact ID before PermissionRequest; its current
      // assistant tool_use row has not reached the transcript file yet.
      if (source === 'current primary' || source === 'headless sidechain') session.onClaudeSessionHook({ hook_event_name: 'PreToolUse', session_id: session.sessionId,
        tool_name: toolName, tool_input: toolInput, tool_use_id: 'current-plan-id' });
      const hook = routeClaudePermissionHook({ data: { hook_event_name: 'PermissionRequest', session_id: session.sessionId,
        tool_name: toolName, tool_input: toolInput, ...(source === 'headless sidechain' ? { agent_id: 'headless-agent' } : {}) }, session,
        settings: { claudeUnifiedTerminalPermissionResponseLocation: 'app_only' }, unifiedTerminalActive: true, bridge,
      });
      void hook.catch(() => {});
      await vi.waitFor(() => expect(Object.keys(client.agentState.requests).length).toBe(1));
      const requestIds = Object.keys(client.agentState.requests);
      if (source !== 'current primary') {
        expect(requestIds).not.toContain('current-plan-id');
        expect(requestIds).not.toContain('old-plan-id');
        expect(requestIds).not.toContain('child-plan-id');
        expect(requestIds[0]).toMatch(/^perm_/u);
        if (source === 'headless sidechain') {
          bridge.handleSessionHook({ hook_event_name: 'PostToolUse', session_id: session.sessionId,
            tool_name: toolName, tool_input: toolInput, tool_use_id: 'current-plan-id' });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(client.agentState.requests[requestIds[0]!]).toBeDefined();
          expect(client.agentState.completedRequests[requestIds[0]!]).toBeUndefined();
          bridge.handleSessionHook({ hook_event_name: 'PostToolUse', session_id: session.sessionId,
            agent_id: 'headless-agent', tool_name: toolName, tool_input: toolInput, tool_use_id: 'actual-child-tool-id' });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(client.agentState.requests[requestIds[0]!]).toBeUndefined();
          expect(client.agentState.completedRequests[requestIds[0]!]).toMatchObject({ status: 'approved' });
        }
        return;
      }
      expect(requestIds).toEqual(['current-plan-id']);
      Object.defineProperty(session, 'observeClaudePermissionTranscript', { value: (value: unknown) => bridge.observeTranscript(value) });
      const projector = createClaudeSessionTranscriptProjector({ session, logPrefix: '[live-permission-id]' });
      projector.observeRaw({ type: 'user', sessionId: session.sessionId,
        permissionDecision: { decision: 'accept', source: 'user_temporary', grantScope: 'session' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'current-plan-id' }] },
      });
      await vi.waitFor(() => expect(client.agentState.requests['current-plan-id']).toBeUndefined());
      expect(client.agentState.completedRequests['current-plan-id']).toMatchObject({ status: 'approved' });
      expect(client.agentState.completedRequests['old-plan-id']).toBeUndefined();
      await expect(hook).resolves.toMatchObject({ continue: true });
    } finally {
      bridge.dispose();
      await broker.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['Write', 'ExitPlanMode'] as const)('keeps the app-only %s native form with its original bridge request', async (toolName) => {
    const { session, broker, client } = createHarness();
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();
    const toolInput = toolName === 'Write'
      ? { file_path: 'native-write-probe.txt', content: 'native write probe' }
      : { plan: '# Harmless plan' };
    const screen = toolName === 'Write' ? [
      '──────────────────', ' Create file', ' native-write-probe.txt', '  1 native write probe',
      ' Do you want to create native-write-probe.txt?', ' ❯ 1. Yes',
      '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session',
      '      (shift+tab)', '   3. No', '', ' Esc to cancel · Tab to amend',
    ].join('\n') : readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.304-plan-exit.txt', import.meta.url), 'utf8');
    const hook = routeClaudePermissionHook({
      data: { hook_event_name: 'PermissionRequest', session_id: 'claude-native-session',
        tool_use_id: 'original-bridge-request', tool_name: toolName, tool_input: toolInput },
      session, settings: { claudeUnifiedTerminalPermissionResponseLocation: 'app_only' },
      unifiedTerminalActive: true, bridge,
    });
    void hook.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['original-bridge-request']).toBeDefined());
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({ broker,
      port: createFakeControlPort({ captures: [screen, screen] }), wait: async () => {}, graceMs: 0, settleMs: 1,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 5, isDialogOwned: () => false,
    });
    const result = await probe.probe();
    expect(Object.keys(client.agentState.requests)).toEqual(['original-bridge-request']);
    expect(result).toEqual({ kind: 'not_visible' });
    expect(client.agentState.requests['original-bridge-request']).toMatchObject({ tool: toolName, source: 'claude_local_permission_bridge' });
    probe.dispose();
    await broker.dispose();
    bridge.dispose();
    await hook;
  });

  const planMetadata = {
    sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' },
    acpSessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' },
  };

  it.each(['PostToolUse', 'transcript'] as const)('clears plan mode aliases after observed terminal plan acceptance (%s)', async (producer) => {
    const { session, broker, client } = createHarness();
    client.metadata = { ...planMetadata };
    const tool = { session_id: 'claude-native-session', tool_name: 'ExitPlanMode', tool_input: { plan: '# Harmless plan' }, tool_use_id: 'toolu-plan-accepted' };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt' });
    if (producer === 'PostToolUse') {
      session.onClaudeSessionHook({ ...tool, hook_event_name: 'PostToolUse', tool_response: { plan: '# Harmless plan' } });
    } else {
      await broker.observeTranscript({ sessionId: tool.session_id, type: 'user',
        permissionDecision: { decision: 'accept', source: 'user_temporary', grantScope: 'session' },
        message: { content: [{ type: 'tool_result', tool_use_id: tool.tool_use_id, content: 'User has approved your plan.' }] },
      });
    }
    expect(client.metadata).toMatchObject({ sessionModeOverrideV1: { modeId: null }, acpSessionModeOverrideV1: { modeId: null } });
    await broker.dispose();
  });

  it.each(['PostToolUseFailure', 'feedback', 'sidechain', 'other-session', 'no-decision', 'other-tool'] as const)('keeps plan mode without a successful matching approval (%s)', async (producer) => {
    const { session, broker, client } = createHarness();
    client.metadata = { ...planMetadata };
    const tool = { session_id: 'claude-native-session', tool_name: producer === 'other-tool' ? 'Bash' : 'ExitPlanMode', tool_input: { plan: '# Harmless plan' }, tool_use_id: 'toolu-plan-not-accepted' };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt' });
    if (producer === 'PostToolUseFailure') {
      session.onClaudeSessionHook({ ...tool, hook_event_name: 'PostToolUseFailure' });
    } else {
      await broker.observeTranscript({ sessionId: producer === 'other-session' ? 'different-session' : tool.session_id,
        ...(producer === 'sidechain' ? { parent_tool_use_id: 'subagent-parent-tool' } : {}), type: 'user',
        ...(producer === 'no-decision' ? {} : { permissionDecision: { decision: producer === 'feedback' ? 'reject' : 'accept', source: 'user_reject' } }),
        ...(producer === 'feedback' ? { toolDenialKind: 'user-rejected', userFeedback: 'Please revise.' } : {}),
        message: { content: [{ type: 'tool_result', tool_use_id: tool.tool_use_id, is_error: producer === 'feedback' }] },
      });
    }
    expect(client.metadata).toEqual(planMetadata);
    await broker.dispose();
  });

  it.each(['PostToolUse', 'transcript'] as const)('clears plan mode from the exact provider result arriving after app acknowledgment (%s)', async (producer) => {
    const { session, broker, client } = createHarness();
    client.metadata = { ...planMetadata };
    const tool = { session_id: 'claude-native-session', tool_name: 'ExitPlanMode', tool_input: { plan: '# Harmless plan' }, tool_use_id: 'toolu-plan-app-accepted' };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt' });
    const initial = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.304-plan-exit.txt', import.meta.url), 'utf8');
    const port = createFakeControlPort({ captures: [initial, initial, initial, '──────────────────\n❯ \n──────────────────'] });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({ broker, port, wait: async () => {}, graceMs: 0, settleMs: 1,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 5, isDialogOwned: () => false,
    });
    await expect(probe.probe()).resolves.toMatchObject({ kind: 'request_published', dialogId: 'tool_permission' });
    await vi.waitFor(() => expect(client.agentState.requests['native-1']).toBeDefined());
    await expect(client.rpcHandlerManager.getHandler('permission')!({ id: 'native-1', approved: true,
      structuredAnswersV1: { claudeNativePermission: ['option_1'] },
    })).resolves.toEqual({ ok: true });
    expect(broker.hasNativePrompt()).toBe(false);
    expect(client.metadata).toEqual(planMetadata);
    if (producer === 'PostToolUse') {
      session.onClaudeSessionHook({ ...tool, hook_event_name: 'PostToolUse', tool_response: { plan: '# Harmless plan' } });
    } else {
      await broker.observeTranscript({ sessionId: tool.session_id, type: 'user',
        permissionDecision: { decision: 'accept', source: 'user_temporary', grantScope: 'session' },
        message: { content: [{ type: 'tool_result', tool_use_id: tool.tool_use_id, content: 'User has approved your plan.' }] },
      });
    }
    expect(client.metadata).toMatchObject({ sessionModeOverrideV1: { modeId: null }, acpSessionModeOverrideV1: { modeId: null } });
    probe.dispose();
    await broker.dispose();
  });

  it('records native permission acceptance even when the approved tool execution fails', async () => {
    const { session, broker, client } = createHarness();
    const tool = { session_id: 'claude-native-session', tool_name: 'Bash', tool_input: { command: 'ruby -e "puts 671"' } };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse', tool_use_id: 'toolu-failed-execution' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt', happierResponseLocation: 'app_and_terminal' });
    const screen = ['Bash command', 'ruby -e "puts 671"', 'Do you want to proceed?',
      '❯ 1. Yes', '  2. No', 'Esc to cancel · Tab to amend'].join('\n');
    const dialog = broker.resolveVisibleDialog(parseClaudeScreenState(screen));
    if (!dialog) throw new Error('expected native permission');
    const pending = broker.requestDialogChoice({ dialog });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['native-1']).toBeDefined());
    await broker.observeTranscript({ sessionId: 'claude-native-session', type: 'user',
      permissionDecision: { decision: 'accept', source: 'user_temporary', grantScope: 'once' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-failed-execution', is_error: true, content: 'Exit code 127' }] },
    });
    await expect(pending).rejects.toThrow();
    expect(client.agentState.completedRequests['native-1']).toMatchObject({ status: 'approved', decision: 'allow' });
    await broker.dispose();
  });

  it('applies the exact native permission scope through the shared dialog control path', async () => {
    const { session, broker, client } = createHarness();
    const tool = { session_id: 'claude-native-session', tool_name: 'Bash', tool_input: { command: 'python3 -c "print(671)"' } };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse', tool_use_id: 'toolu-permission' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt', happierResponseLocation: 'app_and_terminal',
      permission_suggestions: [{ rules: [{ ruleContent: 'python3 -c "print(671)"' }] }],
    });
    const screen = [
      '──────────────────', ' Bash command', ' │ python3 -c "print(671)"',
      ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don’t ask again for: python3 *', '   3. No',
      '', ' Esc to cancel · Tab to amend',
    ].join('\n');
    const selected = screen.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes,', ' ❯ 2. Yes,');
    const idle = '──────────────────\n❯ \n──────────────────';
    const port = createFakeControlPort({ captures: [screen, screen, screen, selected, idle] });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({
      broker, port, wait: async () => {}, graceMs: 0, settleMs: 1,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 5, isDialogOwned: () => false,
    });
    await expect(probe.probe()).resolves.toMatchObject({ kind: 'request_published', dialogId: 'tool_permission' });
    await vi.waitFor(() => expect(client.agentState.requests['native-1']).toBeDefined());
    expect(client.agentState.requests['native-1']).toMatchObject({ arguments: { questions: [{
      options: [expect.anything(), expect.objectContaining({ label: 'Yes, and don’t ask again for: python3 *' }), expect.anything()],
    }] } });
    await expect(client.rpcHandlerManager.getHandler('permission')!({
      id: 'native-1', approved: true, structuredAnswersV1: { claudeNativePermission: ['option_2'] },
    })).resolves.toEqual({ ok: true });
    expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
    expect(port.sentLiteral).toEqual([]);
    probe.dispose();
    await broker.dispose();
  });

  it('publishes read-outside-directory scopes and applies the selected one-time approval through the existing permission path', async () => {
    const { session, broker, client } = createHarness();
    const tool = { session_id: 'claude-native-session', tool_name: 'Read', tool_input: { file_path: '/tmp/outside-read-probe.txt' } };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse', tool_use_id: 'toolu-read-outside' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt', happierResponseLocation: 'app_and_terminal' });
    const labels = [
      'Yes, and keep allowing any reads outside the working directories',
      'No, and block reads outside the working directories from now on',
      'No, and ask again next time',
      'Yes, but ask again next time',
    ];
    const initial = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.310-read-outside.txt', import.meta.url), 'utf8');
    const screen = (focused: number) => initial.replace(/^ [ ❯] (\d+)\./gmu,
      (_, number: string) => ` ${focused + 1 === Number(number) ? '❯' : ' '} ${number}.`);
    const idle = '──────────────────\n❯ \n──────────────────';
    const port = createFakeControlPort({ captures: [screen(0), screen(0), screen(0), screen(1), screen(2), screen(3), idle] });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({
      broker, port, wait: async () => {}, graceMs: 0, settleMs: 1,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 5, isDialogOwned: () => false,
    });
    await expect(probe.probe()).resolves.toMatchObject({ kind: 'request_published', dialogId: 'tool_permission' });
    await vi.waitFor(() => expect(client.agentState.requests['native-1']).toBeDefined());
    expect(client.agentState.requests['native-1']).toMatchObject({ arguments: { questions: [{
      options: labels.map((label, index) => ({ label, choice: `option_${index + 1}` })),
    }] } });
    await expect(client.rpcHandlerManager.getHandler('permission')!({
      id: 'native-1', approved: true, structuredAnswersV1: { claudeNativePermission: ['option_4'] },
    })).resolves.toEqual({ ok: true });
    expect(port.sentKeys).toEqual(['ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter']);
    expect(port.sentLiteral).toEqual([]);
    expect(client.agentState.requests['native-1']).toBeUndefined();
    expect(client.agentState.completedRequests['native-1']).toMatchObject({ dialogChoice: 'option_4' });
    probe.dispose();
    await broker.dispose();
  });

  it('retires an observed native permission when the app state acknowledgment fails after execution', async () => {
    const { session, broker, client } = createHarness();
    const tool = { session_id: 'claude-native-session', tool_name: 'Bash', tool_input: { command: 'python3 -c "print(671)"' } };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse', tool_use_id: 'toolu-ack-failure' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt', happierResponseLocation: 'app_and_terminal' });
    const screen = ['Bash command', 'python3 -c "print(671)"', 'Do you want to proceed?',
      '❯ 1. Yes', '  2. No', 'Esc to cancel · Tab to amend'].join('\n');
    const port = createFakeControlPort({ captures: [screen, screen, screen, '──────────────────\n❯ \n──────────────────'],
      onSendSpecialKey: (key) => {
        if (key === 'Enter') session.onClaudeSessionHook({ ...tool, hook_event_name: 'PostToolUse', tool_use_id: 'toolu-ack-failure' });
      },
    });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({ broker, port, wait: async () => {}, graceMs: 0, settleMs: 1,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 5, isDialogOwned: () => false,
    });
    await probe.probe();
    await vi.waitFor(() => expect(client.agentState.requests['native-1']).toBeDefined());
    // Persistence transport rejects the app acknowledgment; provider observation must still retire it.
    vi.spyOn(client, 'updateAgentState').mockRejectedValueOnce(new Error('state_ack_failed'));
    await expect(client.rpcHandlerManager.getHandler('permission')!({ id: 'native-1', approved: true,
      structuredAnswersV1: { claudeNativePermission: ['option_1'] },
    })).resolves.toMatchObject({ ok: false, errorCode: 'permission_response_failed' });
    expect(client.agentState.requests['native-1']).toBeUndefined();
    expect(client.agentState.completedRequests['native-1']).toMatchObject({ status: 'approved', decision: 'allow' });
    probe.dispose();
    await broker.dispose();
  });

  it('routes plan change feedback through the same native permission choice and preserves its text', async () => {
    const { session, broker, client } = createHarness();
    const tool = { session_id: 'claude-native-session', tool_name: 'ExitPlanMode', tool_input: { plan: '# Harmless probe plan' } };
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'PreToolUse', tool_use_id: 'toolu-plan' });
    session.onClaudeSessionHook({ ...tool, hook_event_name: 'ClaudeNativePrompt', happierResponseLocation: 'app_and_terminal' });
    const filled = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.304-plan-feedback.txt', import.meta.url), 'utf8');
    const feedback = 'Keep this harmless probe; do not execute the plan.';
    const focused = filled.replace(feedback, 'Tell Claude what to change');
    const initial = focused.replace('❯ 3.', '  3.').replace(/^     1\./mu, '   ❯ 1.');
    const second = focused.replace('❯ 3.', '  3.').replace(/^     2\./mu, '   ❯ 2.');
    const port = createFakeControlPort({ captures: [initial, initial, initial, second, focused, filled,
      '──────────────────\n❯ \n──────────────────'],
    });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({ broker, port, wait: async () => {}, graceMs: 0, settleMs: 1,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 5, isDialogOwned: () => false,
    });
    await expect(probe.probe()).resolves.toMatchObject({ kind: 'request_published', dialogId: 'tool_permission' });
    await vi.waitFor(() => expect(client.agentState.requests['native-1']).toBeDefined());
    expect(client.agentState.requests['native-1']).toMatchObject({ arguments: { questions: [{
      freeform: {}, options: [expect.anything(), expect.anything()],
    }] } });
    await expect(client.rpcHandlerManager.getHandler('permission')!({ id: 'native-1', approved: true,
      structuredAnswersV1: { claudeNativePermission: [feedback] },
    })).resolves.toEqual({ ok: true });
    expect(port.sentKeys).toEqual(['ArrowDown', 'ArrowDown', 'Enter']);
    expect(port.sentRaw).toEqual([`\u001b[200~${feedback}\u001b[201~`]);
    probe.dispose();
    await broker.dispose();
  });

  it('applies an app answer to the exact native form and verifies the producer result before acknowledgment', async () => {
    const { session, broker, client, observe } = createHarness();
    observe('toolu-native-1');
    const blueFocused = SCREEN.replace('❯ 1. Amber', '  1. Amber').replace('  2. Blue', '❯ 2. Blue');
    const port = createFakeControlPort({
      captures: [SCREEN, SCREEN, SCREEN, blueFocused, '──────────────────\n❯ \n──────────────────'],
      onSendSpecialKey: (key) => {
        if (key !== 'Enter') return;
        expect(client.agentState.requests['toolu-native-1']).toBeDefined();
        session.onClaudeSessionHook({
          hook_event_name: 'PostToolUse', session_id: 'claude-native-session',
          tool_use_id: 'toolu-native-1', tool_name: 'AskUserQuestion',
          tool_response: { questions: QUESTIONS, answers: { 'Which probe color?': 'Blue' } },
        });
      },
    });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({
      broker, port, wait: async () => {}, graceMs: 0, settleMs: 1,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 5, isDialogOwned: () => false,
    });
    await expect(probe.probe()).resolves.toMatchObject({ kind: 'request_published', dialogId: 'ask_user_question' });
    await vi.waitFor(() => expect(client.agentState.requests['toolu-native-1']).toBeDefined());
    const request = client.agentState.requests['toolu-native-1'];
    const occurrenceId = request && typeof request === 'object' && 'occurrenceId' in request ? request.occurrenceId : null;
    if (typeof occurrenceId !== 'string') throw new Error('expected published occurrence identity');
    expect(occurrenceId).not.toBe('toolu-native-1');
    const respond = client.rpcHandlerManager.getHandler(SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_TO_OCCURRENCE_V1)!;
    await expect(respond({ id: 'toolu-native-1', occurrenceId: 'toolu-native-1', approved: true,
      structuredAnswersV1: { 'Which probe color?': ['Blue'] },
    })).rejects.toMatchObject({ publicErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER });
    expect(port.sentKeys).toEqual([]);
    await expect(respond({
      id: 'toolu-native-1', occurrenceId, approved: true, structuredAnswersV1: { 'Which probe color?': ['Blue'] },
    })).resolves.toEqual({ ok: true });
    expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
    expect(client.agentState.requests['toolu-native-1']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu-native-1']).toMatchObject({
      status: 'approved', structuredAnswersV1: { 'Which probe color?': ['Blue'] },
    });
    probe.dispose();
    await broker.dispose();
  });

  it.each([false, true])('records the actual native answer without a stale waiter (next occurrence: %s)', async (nextOccurrence) => {
    const { session, broker, client, observe } = createHarness();
    observe('toolu-native-1');
    const port = createFakeControlPort({
      captures: [SCREEN, SCREEN, SCREEN],
      onSendSpecialKey: (key) => {
        if (key !== 'Enter') return;
        session.onClaudeSessionHook({
          hook_event_name: 'PostToolUse', session_id: 'claude-native-session',
          tool_use_id: 'toolu-native-1', tool_name: 'AskUserQuestion',
          tool_response: { answers: { 'Which probe color?': 'Blue' } },
        });
        if (nextOccurrence) observe('toolu-native-2');
      },
    });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({
      broker, port, wait: async () => {}, graceMs: 0, settleMs: 1,
      verifyPollIntervalMs: 1, verifyPollTimeoutMs: 5, isDialogOwned: () => false,
    });
    await probe.probe();
    await vi.waitFor(() => expect(client.agentState.requests['toolu-native-1']).toBeDefined());
    await expect(client.rpcHandlerManager.getHandler('permission')!({
      id: 'toolu-native-1', approved: true, structuredAnswersV1: { 'Which probe color?': ['Amber'] },
    })).resolves.toMatchObject({ ok: false, errorCode: 'permission_response_failed' });
    expect(client.agentState.requests['toolu-native-1']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu-native-1']).toMatchObject({
      status: 'approved', answers: { 'Which probe color?': 'Blue' },
    });
    if (nextOccurrence) expect(broker.resolveVisibleDialog(parseClaudeScreenState(SCREEN))).toMatchObject({ occurrenceId: 'toolu-native-2' });
    probe.dispose();
    await broker.dispose();
  });

  it('publishes the full structured question and retires a terminal cancellation by exact tool result', async () => {
    const { session, broker, client, observe } = createHarness();
    observe('toolu-native-1');
    const dialog = broker.resolveVisibleDialog(parseClaudeScreenState(SCREEN));
    expect(dialog?.kind).toBe('native');
    if (!dialog) throw new Error('expected native question');
    const pending = broker.requestDialogChoice({ dialog });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['toolu-native-1']).toBeDefined());
    expect(client.agentState.requests['toolu-native-1']).toMatchObject({ arguments: { questions: QUESTIONS } });

    await broker.observeTranscript({ sessionId: 'another-session', type: 'user', message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu-native-1', is_error: true }],
    } });
    expect(client.agentState.requests['toolu-native-1']).toBeDefined();
    await broker.observeTranscript({ sessionId: 'claude-native-session', type: 'user', message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu-native-1', is_error: true }],
    } });
    await expect(pending).rejects.toThrow();
    expect(client.agentState.requests['toolu-native-1']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu-native-1']).toMatchObject({ status: 'canceled' });
    await expect(client.rpcHandlerManager.getHandler('permission')!({
      id: 'toolu-native-1', approved: true, answers: { 'Which probe color?': 'Blue' },
    })).rejects.toMatchObject({ publicErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER });
    await broker.dispose();
  });

  it('records a successful terminal answer without leaving an actionable app waiter', async () => {
    const { session, broker, client, observe } = createHarness();
    observe('toolu-native-local');
    const dialog = broker.resolveVisibleDialog(parseClaudeScreenState(SCREEN));
    if (!dialog) throw new Error('expected native question');
    const pending = broker.requestDialogChoice({ dialog });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['toolu-native-local']).toBeDefined());
    await broker.observeTranscript({ sessionId: 'claude-native-session', type: 'user',
      toolUseResult: { answers: { 'Which probe color?': 'Blue' } },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-native-local' }] },
    });
    await expect(pending).rejects.toThrow();
    expect(client.agentState.requests['toolu-native-local']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu-native-local']).toMatchObject({
      status: 'approved', decision: 'allow', answers: { 'Which probe color?': 'Blue' },
    });
    await expect(client.rpcHandlerManager.getHandler('permission')!({
      id: 'toolu-native-local', approved: true, answers: { 'Which probe color?': 'Amber' },
    })).rejects.toMatchObject({ publicErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER });
    await broker.dispose();
  });

  it('distinguishes identical repeated questions while allowing tabs to remain one request', () => {
    const { session, broker, observe } = createHarness();
    observe('toolu-native-1');
    const first = broker.resolveVisibleDialog(parseClaudeScreenState(SCREEN));
    expect(first?.kind).toBe('native');
    if (!first) throw new Error('expected native question');
    observe('toolu-native-2');
    const next = broker.resolveVisibleDialog(parseClaudeScreenState(SCREEN));
    if (!next) throw new Error('expected repeated native question');
    expect(getClaudeUnifiedDialogIdentity(next)).not.toEqual(getClaudeUnifiedDialogIdentity(first));
  });

  it('recognizes terminal-only questions without exposing a competing generic app dialog', () => {
    const { session, broker, observe } = createHarness();
    observe('toolu-native-local', 'terminal_only');
    const dialog = broker.resolveVisibleDialog(parseClaudeScreenState(SCREEN));
    expect(dialog?.kind).toBe('native');
    if (!dialog) throw new Error('expected native question');
    expect(broker.shouldPublishDialog(dialog)).toBe(false);
  });
});
