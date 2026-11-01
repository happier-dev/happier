import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPermissionHandlerSessionStub } from '../utils/permissionHandler.testkit';
import { ClaudeLocalPermissionBridge } from './localPermissionBridge';
import { routeClaudePermissionHook } from './routeClaudePermissionHook';
import { createClaudeUnifiedHookLifecycleBridge } from '../unifiedTerminal/createClaudeUnifiedHookLifecycleBridge';
import { createClaudeUnifiedInputArbiter } from '../unifiedTerminal/createClaudeUnifiedInputArbiter';
import { createClaudeUnifiedPromptInjector } from '../unifiedTerminal/createClaudeUnifiedPromptInjector';
import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeSessionTranscriptProjector } from '../localControl/createClaudeSessionTranscriptProjector';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { loop, type EnhancedMode } from '../loop';
import {
  CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
  CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
} from '@happier-dev/agents';

describe('ClaudeLocalPermissionBridge', () => {
  const nativePermissionResult = {
    type: 'user', sessionId: 'claude-native-session', isSidechain: false,
    permissionDecision: { decision: 'accept', source: 'user_temporary', grantScope: 'once' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'local-raw-result',
      is_error: true, content: 'Exit code 127\n/bin/bash: line 1: python: command not found' }] },
  };

  function createPermissionTranscriptProjector(
    session: ReturnType<typeof createPermissionHandlerSessionStub>['session'],
    bridge: ClaudeLocalPermissionBridge,
  ) {
    session.sessionId = nativePermissionResult.sessionId;
    Object.defineProperty(session, 'observeClaudePermissionTranscript', {
      value: (value: unknown) => bridge.observeTranscript(value),
    });
    return createClaudeSessionTranscriptProjector({ session, logPrefix: '[permission-transcript-test]' });
  }

  it.each(['PostToolUse', 'accepted transcript', 'denied transcript'] as const)('reconciles plan metadata from the existing observed bridge completion (%s)', async (producer) => {
    const { session, client } = createPermissionHandlerSessionStub('observed-bridge-plan');
    const metadata = {
      sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' },
    };
    client.metadata = metadata;
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();
    const projector = createPermissionTranscriptProjector(session, bridge);
    const tool = { tool_name: 'ExitPlanMode', tool_input: { plan: '# Harmless plan' }, tool_use_id: 'local-raw-result' };
    const hook = bridge.handlePermissionHook({ hook_event_name: 'PermissionRequest', ...tool });
    await vi.advanceTimersByTimeAsync(0);
    if (producer === 'PostToolUse') bridge.handleSessionHook({ hook_event_name: 'PostToolUse', ...tool });
    else projector.observeRaw({ ...nativePermissionResult,
      permissionDecision: { decision: producer === 'accepted transcript' ? 'accept' : 'reject', source: 'user_temporary' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.metadata).toMatchObject(producer === 'denied transcript' ? metadata : {
      sessionModeOverrideV1: { modeId: null }, acpSessionModeOverrideV1: { modeId: null },
    });
    await expect(hook).resolves.toMatchObject({ continue: true });
    bridge.dispose();
  });

  it('retires the app request from a live native approval despite failed execution and rejects stale app denial', async () => {
    const { session, client } = createPermissionHandlerSessionStub('raw-native-approval');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();
    const projector = createPermissionTranscriptProjector(session, bridge);
    const hook = bridge.handlePermissionHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'python -c "print(671)"' }, tool_use_id: 'local-raw-result' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests['local-raw-result']).toBeDefined();

    projector.observeRaw(nativePermissionResult, { historicalReplay: true });
    projector.observeRaw({ ...nativePermissionResult, sessionId: 'different-native-session' });
    projector.observeRaw({ ...nativePermissionResult, isSidechain: true });
    projector.observeRaw({ ...nativePermissionResult, parentToolUseId: 'subagent-parent-tool' });
    projector.observeRaw({ ...nativePermissionResult, message: { content: 'No tool result here' } });
    projector.observeRaw({ ...nativePermissionResult, permissionDecision: undefined });
    projector.observeRaw({ ...nativePermissionResult, message: { content: [{
      type: 'tool_result', tool_use_id: 'other-local-tool', is_error: true,
    }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests['local-raw-result']).toBeDefined();
    expect(client.agentState.completedRequests['local-raw-result']).toBeUndefined();

    projector.observeRaw(nativePermissionResult, { historicalReplay: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests['local-raw-result']).toBeUndefined();
    expect(client.agentState.completedRequests['local-raw-result']).toMatchObject({ status: 'approved', reason: 'Approved in Claude terminal' });
    await expect(hook).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    const completed = client.agentState.completedRequests['local-raw-result'];
    await client.rpcHandlerManager.getHandler('permission')!({ id: 'local-raw-result', approved: false });
    projector.observeRaw(nativePermissionResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests['local-raw-result']).toBeUndefined();
    expect(client.agentState.completedRequests['local-raw-result']).toEqual(completed);
    bridge.dispose();
  });

  it('records a live native denial and releases its held hook without replaying another decision', async () => {
    const { session, client } = createPermissionHandlerSessionStub('raw-native-denial');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();
    const projector = createPermissionTranscriptProjector(session, bridge);
    const hook = bridge.handlePermissionHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'python -c "print(671)"' }, tool_use_id: 'local-raw-result' });
    await vi.advanceTimersByTimeAsync(0);
    projector.observeRaw({ ...nativePermissionResult, toolDenialKind: 'user-rejected',
      permissionDecision: { decision: 'reject', source: 'user_reject' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests['local-raw-result']).toBeUndefined();
    expect(client.agentState.completedRequests['local-raw-result']).toMatchObject({ status: 'denied' });
    await expect(hook).resolves.toMatchObject({ continue: true, hookSpecificOutput: { hookEventName: 'PermissionRequest' } });
    bridge.dispose();
  });

  it('retains the raw native outcome until durable admission succeeds before releasing the held hook', async () => {
    const { session, client } = createPermissionHandlerSessionStub('raw-native-admission');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();
    const projector = createPermissionTranscriptProjector(session, bridge);
    const hook = bridge.handlePermissionHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'python -c "print(671)"' }, tool_use_id: 'local-raw-result' });
    let resumed = false;
    void hook.then(() => { resumed = true; });
    await vi.advanceTimersByTimeAsync(0);
    const admit = client.updateAgentStateRequestSettlement.bind(client);
    let allowAdmission!: () => void;
    client.updateAgentStateRequestSettlement = (updater) => new Promise<void>((resolve, reject) => {
      allowAdmission = () => { void admit(updater).then(resolve, reject); };
    });
    projector.observeRaw(nativePermissionResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed).toBe(false);
    expect(client.agentState.requests['local-raw-result']).toBeDefined();
    expect(allowAdmission).toBeTypeOf('function');
    allowAdmission();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests['local-raw-result']).toBeUndefined();
    expect(client.agentState.completedRequests['local-raw-result']).toMatchObject({ status: 'approved' });
    await expect(hook).resolves.toMatchObject({ continue: true });
    bridge.dispose();
  });

  it('retires the native request through the real loop session producer and shared transcript projector', async () => {
    const { session: stub, client } = createPermissionHandlerSessionStub('raw-native-loop');
    // Session client transport boundary; the real Session owns its keep-alive timer.
    Object.assign(client, { keepAlive: () => {} });
    const abort = new AbortController();
    abort.abort();
    let bridge: ClaudeLocalPermissionBridge | null = null;
    await expect(loop({
      path: '/tmp', onModeChange: () => {}, session: stub.client,
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'default'), hookSettingsPath: '/tmp/hooks.json',
      signal: abort.signal,
      observeClaudePermissionTranscript: (value) => bridge?.observeTranscript(value),
      onSessionReady: async (session) => {
        try {
          session.sessionId = nativePermissionResult.sessionId;
          bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
          bridge.activate();
          const hook = bridge.handlePermissionHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
            tool_input: { command: 'python -c "print(671)"' }, tool_use_id: 'local-raw-result' });
          await vi.advanceTimersByTimeAsync(0);
          const projector = createClaudeSessionTranscriptProjector({ session, logPrefix: '[permission-loop-test]' });
          projector.observeRaw(nativePermissionResult);
          await vi.advanceTimersByTimeAsync(0);
          expect(client.agentState.requests['local-raw-result']).toBeUndefined();
          expect(client.agentState.completedRequests['local-raw-result']).toMatchObject({ status: 'approved' });
          await expect(hook).resolves.toMatchObject({ continue: true });
        } finally {
          bridge?.dispose();
          session.cleanup();
        }
      },
    })).resolves.toBe(0);
  });

  it.each(['disconnect', 'PostToolUse'] as const)('keeps duplicated permission input blocked until %s retires the request', async (completion) => {
    const { session, client } = createPermissionHandlerSessionStub('duplicated-hook-disconnect');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();
    const injectedTexts: string[] = [];
    const injector = createClaudeUnifiedPromptInjector({
      // Native terminal writes are the boundary; lifecycle, arbitration and injection stay real.
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt: async ({ text }) => {
          injectedTexts.push(text);
          return { status: 'injected', at: Date.now(), bytesWritten: text.length };
        },
      },
    });
    const arbiter = createClaudeUnifiedInputArbiter({ quietPeriodMs: 0, injectPrompt: injector.injectPrompt });
    let observeHook: ((data: SessionHookData) => void) | undefined;
    const lifecycle = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        observeHook = callback;
        return () => { observeHook = undefined; };
      },
      arbiter,
      completionQuiescenceMs: 0,
    });
    lifecycle.start({ abortSignal: new AbortController().signal });
    arbiter.observeLifecycle({ type: 'output' });
    const firstTransport = new AbortController();
    const secondTransport = new AbortController();
    const data = {
      hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'pwd' }, tool_use_id: 'duplicated-hook-disconnect',
    };
    session.onClaudeSessionHook = (hook) => { observeHook?.(hook); };
    const handleHook = (signal: AbortSignal) => routeClaudePermissionHook({
      data, options: { signal }, session, bridge,
      settings: { claudeUnifiedTerminalPermissionResponseLocation: 'app_only' },
      unifiedTerminalActive: true,
    });
    const first = handleHook(firstTransport.signal);
    const second = handleHook(secondTransport.signal);

    try {
      await vi.advanceTimersByTimeAsync(0);
      await arbiter.enqueueUiMessage({ message: 'continue after permission', origin: { kind: 'ui_immediate' } });
      await arbiter.drainWhenSafe();
      expect(injectedTexts).toEqual([]);
      if (completion === 'PostToolUse') {
        // Provider completion releases both references even before their transport callbacks finish.
        const completedHook = { ...data, hook_event_name: 'PostToolUse' };
        observeHook?.(completedHook);
        await arbiter.drainWhenSafe();
        expect(injectedTexts).toEqual(['continue after permission']);
        bridge.handleSessionHook(completedHook);
        await expect(first).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
        await expect(second).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
        // Both synthetic completions have now arrived and must leave input unblocked.
        expect(arbiter.snapshot().permissionBlocked).toBe(false);
        expect(client.agentState.completedRequests['duplicated-hook-disconnect']).toMatchObject({ status: 'approved' });
        return;
      }
      firstTransport.abort();
      await vi.advanceTimersByTimeAsync(0);
      await expect(first).resolves.toMatchObject({ continue: true });
      expect(client.agentState.requests['duplicated-hook-disconnect']).toBeDefined();
      expect(client.agentState.completedRequests['duplicated-hook-disconnect']).toBeUndefined();
      await arbiter.drainWhenSafe();
      expect(injectedTexts).toEqual([]);
      expect(arbiter.snapshot().permissionBlocked).toBe(true);

      secondTransport.abort();
      await vi.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toMatchObject({ continue: true });
      expect(client.agentState.requests['duplicated-hook-disconnect']).toBeUndefined();
      expect(client.agentState.completedRequests['duplicated-hook-disconnect']).toMatchObject({ status: 'canceled' });
      await arbiter.drainWhenSafe();
      expect(injectedTexts).toEqual(['continue after permission']);
    } finally {
      firstTransport.abort();
      secondTransport.abort();
      await Promise.allSettled([first, second]);
      bridge.dispose();
      lifecycle.dispose();
      await arbiter.dispose();
    }
  });

  it('disposes a live hook after durable cancellation admission while the acknowledgement transport is offline', async () => {
    const { session, client } = createPermissionHandlerSessionStub('local-dispose-offline');
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    const hook = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {}, tool_use_id: 'dispose-offline',
    });
    let result: unknown;
    void hook.then((value) => { result = value; }, (error) => { result = error; });
    await vi.advanceTimersByTimeAsync(0);
    client.updateAgentState = () => { throw new Error('ack transport offline'); };
    bridge.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toMatchObject({ continue: true });
    expect(client.agentState.completedRequests['dispose-offline']).toMatchObject({ status: 'canceled' });
    expect(client.agentState.requests['dispose-offline']).toBeUndefined();
  });

  it('publishes automatic history through the caught history writer when no pending request exists', async () => {
    const { session, client } = createPermissionHandlerSessionStub('local-auto-history');
    client.updateMetadata((metadata) => ({ ...metadata, permissionMode: 'yolo', permissionModeUpdatedAt: 123 }));
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    client.updateAgentStateRequestSettlement = async () => { throw new Error('no durable storage'); };
    await expect(bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {}, tool_use_id: 'auto-history',
    })).resolves.toMatchObject({ continue: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.completedRequests['auto-history']).toMatchObject({ status: 'approved' });
    bridge.dispose();
  });

  it('retains an observed native PostToolUse completion before releasing its hook and permits admission retry', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-durable-local-admission');
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    const hookData = {
      tool_name: 'Write', tool_input: { file_path: '/workspace/file' }, tool_use_id: 'local-durable',
    };
    const pending = bridge.handlePermissionHook({ hook_event_name: 'PermissionRequest', ...hookData });
    await vi.advanceTimersByTimeAsync(0);
    let admit!: () => void;
    let fail!: (error: Error) => void;
    const original = client.updateAgentStateRequestSettlement.bind(client);
    client.updateAgentStateRequestSettlement = (updater) => new Promise<void>((resolve, reject) => {
      admit = () => { void original(updater).then(resolve, reject); };
      fail = reject;
    });
    let resumed = false;
    void pending.then(() => { resumed = true; });
    bridge.handleSessionHook({ hook_event_name: 'PostToolUse', ...hookData });
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed).toBe(false);
    fail(new Error('storage admission failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed).toBe(false);
    expect(client.agentState.requests['local-durable']).toBeDefined();
    bridge.handleSessionHook({ hook_event_name: 'PostToolUse', ...hookData });
    admit();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ continue: true });
    bridge.dispose();
  });

  it('retains an observed PostToolUse completion arriving while a pre-effect UI acknowledgement is pending', async () => {
    const { session, client } = createPermissionHandlerSessionStub('local-observed-during-ui');
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    const data = { tool_name: 'Write', tool_input: {}, tool_use_id: 'observed-during-ui' };
    const hook = bridge.handlePermissionHook({ hook_event_name: 'PermissionRequest', ...data });
    let outcome = 'pending';
    void hook.then(() => { outcome = 'allowed'; }, () => { outcome = 'canceled'; });
    await vi.advanceTimersByTimeAsync(0);
    let failAcknowledgement!: (error: Error) => void;
    client.updateAgentState = () => new Promise<never>((_resolve, reject) => {
      if (!failAcknowledgement) failAcknowledgement = reject;
      else reject(new Error('UI acknowledgement unavailable'));
    });
    const respond = client.rpcHandlerManager.getHandler('permission')!;
    const response = respond({ id: data.tool_use_id, approved: true });
    await vi.advanceTimersByTimeAsync(0);
    bridge.handleSessionHook({ hook_event_name: 'PostToolUse', ...data });
    failAcknowledgement(new Error('UI acknowledgement unavailable'));
    await expect(response).resolves.toMatchObject({ ok: false, errorCode: 'permission_response_failed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe('allowed');
    expect(client.agentState.completedRequests[data.tool_use_id]).toMatchObject({
      status: 'approved', reason: 'Approved in Claude terminal',
    });
    bridge.dispose();
  });

  it('rejects the disposed local waiter on failed cancellation admission and retains its occurrence for retirement retry', async () => {
    const { session, client } = createPermissionHandlerSessionStub('local-dispose-admission-failure');
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    const hook = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {}, tool_use_id: 'dispose-failed',
    });
    let outcome = 'pending';
    void hook.then(() => { outcome = 'allowed'; }, () => { outcome = 'canceled'; });
    await vi.advanceTimersByTimeAsync(0);
    const admit = client.updateAgentStateRequestSettlement.bind(client);
    client.updateAgentStateRequestSettlement = async () => { throw new Error('journal unavailable'); };
    bridge.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe('canceled');
    expect(client.agentState.requests['dispose-failed']).toBeDefined();
    client.updateAgentStateRequestSettlement = admit;
    bridge.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.completedRequests['dispose-failed']).toMatchObject({ status: 'canceled' });
    expect(client.agentState.requests['dispose-failed']).toBeUndefined();
  });

  it('keeps a failed UI approval retryable before releasing its native hook', async () => {
    const { session, client } = createPermissionHandlerSessionStub('local-approval-retry');
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest', tool_name: 'Write',
      tool_input: { file_path: '/tmp/retry.txt', content: 'hello' }, tool_use_id: 'retry',
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    const write = vi.spyOn(client, 'updateAgentState');
    const updateState = client.updateAgentState.bind(client);
    let failNext = true;
    Object.defineProperty(client, 'updateAgentState', {
      configurable: true,
      value: async (updater: Parameters<typeof client.updateAgentState>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error('state transport unavailable');
        }
        updateState(updater);
      },
    });
    const rpc = client.rpcHandlerManager.getHandler('permission')!;
    try {
      await expect(rpc({ id: 'retry', approved: true })).resolves.toMatchObject({
        ok: false, errorCode: 'permission_response_failed',
      });
      expect(settled).toBe(false);
      expect(client.agentState.requests.retry).toBeDefined();
      await expect(rpc({ id: 'retry', approved: true })).resolves.toEqual({ ok: true });
      await expect(pending).resolves.toMatchObject({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
      expect(client.agentState.requests.retry).toBeUndefined();
    } finally {
      write.mockRestore();
      bridge.dispose();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retires only stale source-owned requests when a replacement bridge activates', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-replacement-cleanup');
    client.updateAgentState((current) => ({
      ...current,
      requests: {
        stale_claude_question: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { questions: [{ question: 'No longer answerable' }] },
          createdAt: 1,
          source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        },
        other_owner_question: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { questions: [{ question: 'Still owned elsewhere' }] },
          createdAt: 2,
          source: 'another_permission_owner',
        },
      },
    }));

    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.agentState.requests.stale_claude_question).toBeUndefined();
    expect(client.agentState.completedRequests.stale_claude_question).toMatchObject({
      status: 'canceled',
      reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
      source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    });
    expect(client.agentState.requests.other_owner_question).toBeDefined();
  });

  it('retires source-only requests added after activation when disposed', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-local-disposal-orphan');
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    await vi.advanceTimersByTimeAsync(0);
    const request = { tool: 'Bash', arguments: {}, createdAt: 1 };
    const claimed = { ...request, source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
      permissionResponseClaimV1: { owner: 'other-runtime' } };
    client.agentState.requests = {
      orphan: { ...request, source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE },
      background: request, claimed,
    };
    bridge.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.completedRequests.orphan).toMatchObject({ status: 'canceled' });
    expect(client.agentState.requests).toEqual({ background: request, claimed });
  });

  it('leaves a source-owned opaque claimed request outstanding through activation and disposal', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-claimed-replacement-cleanup');
    const opaqueClaim = { malformed: ['future', { owner: true }] };
    client.updateAgentState((current) => ({
      ...current,
      requests: {
        claimed_claude_question: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { questions: [{ question: 'Reserved by newer runtime' }] },
          createdAt: 1,
          source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
          permissionResponseClaimV1: opaqueClaim,
        },
      },
    }));

    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();
    await vi.advanceTimersByTimeAsync(0);
    bridge.dispose();
    await vi.advanceTimersByTimeAsync(0);

    const retained = client.agentState.requests.claimed_claude_question as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
    expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
    expect(client.agentState.completedRequests.claimed_claude_question).toBeUndefined();
  });

  it('times out non-interactive requests by default when no UI response arrives', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-default-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session);
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm --version' },
      tool_use_id: 'toolu_default_timeout_1',
    });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PermissionRequest' },
    });
    expect(client.agentState.requests.toolu_default_timeout_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_default_timeout_1).toMatchObject({
      status: 'canceled',
      reason: 'Timed out waiting for permission response',
    });
  });

  it('publishes pending permission requests and resolves allow decisions', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-1');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'hello' },
      tool_use_id: ' toolu_allow_1\n',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests[' toolu_allow_1\n']).toMatchObject({
      tool: 'Write',
      arguments: { file_path: '/tmp/test.txt', content: 'hello' },
    });

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: ' toolu_allow_1\n', approved: true });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests[' toolu_allow_1\n']).toBeUndefined();
    expect(client.agentState.completedRequests[' toolu_allow_1\n']).toMatchObject({
      status: 'approved',
      tool: 'Write',
    });
  });

  it('reconciles native terminal approval when a PostToolUse hook arrives for a pending request', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-native-terminal-approve');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/native-terminal.txt', content: 'hello' },
      tool_use_id: 'toolu_native_terminal_approve_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_native_terminal_approve_1).toBeDefined();

    bridge.handleSessionHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/native-terminal.txt', content: 'hello' },
      tool_use_id: 'toolu_native_terminal_approve_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_native_terminal_approve_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_native_terminal_approve_1).toMatchObject({
      status: 'approved',
      reason: 'Approved in Claude terminal',
      tool: 'Write',
    });
    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });
  });

  it('reconciles native terminal approval for generated permission ids when PostToolUse uses a real tool id', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-generated-id-native-terminal-approve');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();
    const toolInput = { query: 'select event from events limit 1' };

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'mcp__claude_ai_PostHog__exec',
      tool_input: toolInput,
    });

    await vi.advanceTimersByTimeAsync(0);
    const [generatedRequestId] = Object.keys(client.agentState.requests);
    expect(generatedRequestId).toMatch(/^perm_/);

    bridge.handleSessionHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__claude_ai_PostHog__exec',
      tool_input: toolInput,
      tool_use_id: 'toolu_real_post_tool_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests[generatedRequestId]).toBeUndefined();
    expect(client.agentState.completedRequests[generatedRequestId]).toMatchObject({
      status: 'approved',
      reason: 'Approved in Claude terminal',
      tool: 'mcp__claude_ai_PostHog__exec',
    });
    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });
  });

  it('suppresses provider prompts for first-party Happier MCP tools when action approval is required', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-happier-approval-gate');
    (session as any).accountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: [],
            approvalRequiredSurfaces: ['session_agent'],
          },
        },
      },
    };
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    await expect(bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'mcp__happier__session_list',
      tool_input: {},
      tool_use_id: 'toolu_happier_session_list_1',
    })).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });

    expect(client.agentState.requests.toolu_happier_session_list_1).toBeUndefined();
  });

  it('continues to publish custom MCP tool prompts even when a similarly named Happier action requires approval', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-custom-mcp-still-prompts');
    (session as any).accountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: [],
            approvalRequiredSurfaces: ['session_agent'],
          },
        },
      },
    };
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'mcp__custom__session_list',
      tool_input: {},
      tool_use_id: 'toolu_custom_session_list_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_custom_session_list_1).toMatchObject({
      tool: 'mcp__custom__session_list',
    });

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({ id: 'toolu_custom_session_list_1', approved: true });
    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
  });

  it('publishes one request for duplicate hook ids and resolves all duplicate callers after approval', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-duplicate-local-waiters');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/duplicate-local.txt', content: 'first' },
      tool_use_id: 'toolu_duplicate_local_1',
    });
    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/duplicate-local.txt', content: 'first' },
      tool_use_id: 'toolu_duplicate_local_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(client.agentState.requests)).toEqual(['toolu_duplicate_local_1']);

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_duplicate_local_1', approved: true });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    await expect(second).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(client.agentState.requests.toolu_duplicate_local_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_duplicate_local_1).toMatchObject({
      status: 'approved',
      tool: 'Write',
    });
  });

  it('does not let the first duplicate waiter timeout cancel a newer duplicate waiter', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-duplicate-local-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 200 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/duplicate-timeout.txt', content: 'first' },
      tool_use_id: 'toolu_duplicate_timeout_1',
    });
    let firstResolved = false;
    first.then(() => {
      firstResolved = true;
    });

    await vi.advanceTimersByTimeAsync(199);

    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/duplicate-timeout.txt', content: 'first' },
      tool_use_id: 'toolu_duplicate_timeout_1',
    });
    let secondResolved = false;
    second.then(() => {
      secondResolved = true;
    });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(false);
    expect(client.agentState.requests.toolu_duplicate_timeout_1).toBeDefined();
    expect(client.agentState.completedRequests.toolu_duplicate_timeout_1).toBeUndefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({ id: 'toolu_duplicate_timeout_1', approved: true });
    await expect(second).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
  });

  it('ignores permission RPCs for requests without the local bridge source marker', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-local-source-guard');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    client.updateAgentState((current) => ({
      ...current,
      requests: {
        ...current.requests,
        toolu_remote_owned_1: {
          tool: 'Read',
          kind: 'permission',
          arguments: { file_path: '/tmp/remote-owned.txt' },
          createdAt: Date.now(),
        },
      },
    }));

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_remote_owned_1',
      approved: true,
      mode: 'yolo',
      allowedTools: ['Read(/tmp/remote-owned.txt)'],
    });

    expect(client.agentState.requests.toolu_remote_owned_1).toBeDefined();
    expect(client.agentState.completedRequests.toolu_remote_owned_1).toBeUndefined();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/still-requires-local-prompt.txt', content: 'hello' },
      tool_use_id: 'toolu_after_remote_rpc_1',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(client.agentState.requests.toolu_after_remote_rpc_1).toBeDefined();
    bridge.dispose();
    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: { hookEventName: 'PermissionRequest' },
    });
  });

  it('includes updatedPermissions in allow hook responses when supplied by the UI', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-updated-permissions');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do things' },
      tool_use_id: 'toolu_allow_updates_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_allow_updates_1',
      approved: true,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        },
      },
    });

    expect(client.agentState.completedRequests.toolu_allow_updates_1).toMatchObject({
      status: 'approved',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  it('auto-approves non-interactive tools immediately when permissionMode=yolo in metadata', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-yolo-auto-approve');
    client.updateMetadata((m) => ({ ...m, permissionMode: 'yolo', permissionModeUpdatedAt: 123 }));

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const res = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'mcp__happier__change_title',
      tool_input: { title: 'QA Agent Team Setup' },
      tool_use_id: 'toolu_yolo_1',
    });

    expect(res).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_yolo_1).toBeUndefined();
  });

  it('auto-approves session title tools immediately in default mode', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-default-title-auto-approve');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const res = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Set session title',
      tool_input: { title: 'QA Agent Team Setup' },
      tool_use_id: 'toolu_default_title_1',
    });

    expect(res).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_default_title_1).toBeUndefined();
  });

  it('auto-approves recognized first-party Action transport calls in default mode', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-default-execution-run-permission-request');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const result = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'mcp__happier__execution_run_start',
      tool_input: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        instructions: 'Reply exactly QA_CODEX_READY.',
      },
      tool_use_id: 'toolu_execution_run_start_default_1',
    });

    expect(result).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_execution_run_start_default_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_execution_run_start_default_1).toMatchObject({
      status: 'approved',
      tool: 'mcp__happier__execution_run_start',
    });
  });

  it('auto-approves a pending request when metadata permissionMode flips to yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-yolo-auto-approve-pending');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/qa-agent-team-setup.txt', content: 'hello' },
      tool_use_id: 'toolu_yolo_pending_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_yolo_pending_1).toBeDefined();

    client.updateMetadata((m) => ({ ...m, permissionMode: 'yolo', permissionModeUpdatedAt: 456 }));
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.requests.toolu_yolo_pending_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_yolo_pending_1).toMatchObject({ status: 'approved' });
  });

  it('hard-denies new write-like permission hooks immediately when permissionMode=read-only in metadata', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-read-only-immediate-deny');
    client.updateMetadata((m) => ({ ...m, permissionMode: 'read-only', permissionModeUpdatedAt: 123 }));

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const res = await bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'hello' },
      tool_use_id: 'toolu_read_only_1',
    });

    expect(res).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' },
      },
    });
    expect(client.agentState.requests.toolu_read_only_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_read_only_1).toMatchObject({
      status: 'denied',
      tool: 'Write',
      mode: 'read-only',
    });
  });

  it('surfaces non-edit PermissionRequest hooks that Claude Auto leaves unresolved', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-safe-yolo-provider-prompt');
    client.updateMetadata((m) => ({ ...m, permissionMode: 'safe-yolo', permissionModeUpdatedAt: 123 }));

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();
    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'curl https://example.test/install | sh' },
      tool_use_id: 'toolu_auto_unresolved_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests).toHaveProperty('toolu_auto_unresolved_1');
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'toolu_auto_unresolved_1',
      approved: false,
      reason: 'Denied from UI',
    });
    await expect(pending).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' },
      },
    });
  });

  it('hard-denies a pending write-like request when metadata permissionMode flips to read-only', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-read-only-pending-deny');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'hello' },
      tool_use_id: 'toolu_read_only_pending_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_read_only_pending_1).toBeDefined();

    client.updateMetadata((m) => ({ ...m, permissionMode: 'read-only', permissionModeUpdatedAt: 456 }));
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' },
      },
    });
    expect(client.agentState.requests.toolu_read_only_pending_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_read_only_pending_1).toMatchObject({
      status: 'denied',
      tool: 'Write',
      mode: 'read-only',
    });
  });

  it('captures permission_suggestions from hook payloads into agentState requests', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-suggestions');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/file.txt' },
      tool_use_id: 'toolu_suggest_1',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    } as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_suggest_1).toMatchObject({
      tool: 'Read',
      permissionSuggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  it('maps deny decisions from RPC responses to hook deny responses', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-2');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/x' },
      tool_use_id: 'toolu_deny_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({
      id: 'toolu_deny_1',
      approved: false,
      reason: 'Denied from UI',
    });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied from UI' },
      },
      systemMessage: 'Denied from UI',
    });
    expect(client.agentState.completedRequests.toolu_deny_1).toMatchObject({
      status: 'denied',
      reason: 'Denied from UI',
    });
  });

  it('auto-allows new permission hooks after a session allowlist update', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-auto-allow');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const first = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'unset FOO; find .' },
      tool_use_id: 'toolu_allowlist_1',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_allowlist_1).toBeDefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_allowlist_1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });

    const second = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'find src -maxdepth 1' },
      tool_use_id: 'toolu_allowlist_2',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.agentState.requests.toolu_allowlist_2).toBeUndefined();
    await expect(second).resolves.toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
      },
    });
  });

  it('times out to ask and marks the request as canceled', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-3');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 200 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a.txt' },
      tool_use_id: 'toolu_timeout_1',
    });

    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PermissionRequest' },
    });
    expect(client.agentState.requests.toolu_timeout_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_timeout_1).toMatchObject({
      status: 'canceled',
    });
  });

  it('does not time out interactive AskUserQuestion requests even when the bridge has a finite timeout', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-ask-user-question-no-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 200 });
    bridge.activate();

    let resolved = false;
    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            header: 'File write',
            question: 'May I create the file /tmp/qa.txt?',
            multiSelect: false,
            options: [
              { label: 'Yes, go ahead', description: 'Create the file' },
              { label: `No, don't create it`, description: 'Skip file creation' },
            ],
          },
        ],
      },
      tool_use_id: 'toolu_ask_1',
    });
    pending.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(false);
    expect(client.agentState.requests.toolu_ask_1).toMatchObject({
      tool: 'AskUserQuestion',
    });
    // Freeform escape hatch: agent-state copy of the request exposes
    // `freeform: {}` on every question so the mobile UI surfaces its own
    // localized text-input fallback (mirrors Claude's native "Other" in CLI).
    // Happier's bridge synthesizes this because Claude's AskUserQuestion tool
    // schema has no freeform field of its own.
    const publishedArguments = (client.agentState.requests.toolu_ask_1 as any)?.arguments;
    expect(publishedArguments?.questions?.[0]?.freeform).toEqual({});
    expect(client.agentState.completedRequests.toolu_ask_1).toBeUndefined();

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();
    await permissionHandler?.({
      id: 'toolu_ask_1',
      approved: true,
      answers: { 'May I create the file /tmp/qa.txt?': 'Yes, go ahead' },
    });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: {
            questions: [
              {
                header: 'File write',
                question: 'May I create the file /tmp/qa.txt?',
                multiSelect: false,
                options: [
                  { label: 'Yes, go ahead', description: 'Create the file' },
                  { label: `No, don't create it`, description: 'Skip file creation' },
                ],
              },
            ],
            answers: { 'May I create the file /tmp/qa.txt?': 'Yes, go ahead' },
          },
        },
      },
    });
    expect(client.agentState.completedRequests.toolu_ask_1).toMatchObject({
      status: 'approved',
      tool: 'AskUserQuestion',
    });
  });

  it('answers native AskUserQuestion PreToolUse hooks with PreToolUse updatedInput', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-ask-user-question-pre-tool-use');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 200 });
    bridge.activate();

    const toolInput = {
      questions: [
        {
          header: 'Cleanup',
          question: 'Remove the scratch files?',
          multiSelect: false,
          options: [
            { label: 'Remove them now', description: 'Run cleanup' },
            { label: 'Keep for inspection', description: 'Leave files in place' },
          ],
        },
      ],
    };

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: toolInput,
      tool_use_id: 'toolu_ask_pre_1',
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(client.agentState.requests.toolu_ask_pre_1).toMatchObject({
      kind: 'user_action',
      tool: 'AskUserQuestion',
    });

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({
      id: 'toolu_ask_pre_1',
      approved: true,
      answers: { 'Remove the scratch files?': 'Keep for inspection' },
    });

    await expect(pending).resolves.toEqual({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...toolInput,
          answers: { 'Remove the scratch files?': 'Keep for inspection' },
        },
      },
    });
    expect(client.agentState.completedRequests.toolu_ask_pre_1).toMatchObject({
      status: 'approved',
      tool: 'AskUserQuestion',
    });
  });

  it('waits indefinitely when responseTimeoutMs is null', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-infinite-timeout');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: null });
    bridge.activate();

    let resolved = false;
    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm --version' },
      tool_use_id: 'toolu_infinite_1',
    });
    pending.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(resolved).toBe(false);
    expect(client.agentState.requests.toolu_infinite_1).toBeDefined();
  });

  it('generates a request id when tool_use_id is missing', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-4');
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    const pending = bridge.handlePermissionHook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm --version' },
    });

    await vi.advanceTimersByTimeAsync(0);
    const pendingIds = Object.keys(client.agentState.requests);
    expect(pendingIds).toHaveLength(1);

    const [generatedId] = pendingIds;
    expect(typeof generatedId).toBe('string');
    expect(generatedId.length).toBeGreaterThan(0);
    expect(client.agentState.requests[generatedId]).toMatchObject({
      tool: 'Bash',
      arguments: { command: 'npm --version' },
    });

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    await permissionHandler?.({ id: generatedId, approved: true });

    await expect(pending).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(client.agentState.completedRequests[generatedId]).toMatchObject({
      status: 'approved',
      tool: 'Bash',
    });
  });

  it('recovers tool_use_id from transcript_path when missing in the hook payload', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-perm-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    try {
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_transcript_1',
                name: 'Bash',
                input: { command: 'npm --version', description: 'Check npm version (may need permission)' },
              },
            ],
          },
        })}\n`,
        'utf8',
      );

      const { session, client } = createPermissionHandlerSessionStub('session-5');
      const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
      bridge.activate();

      const pending = bridge.handlePermissionHook({
        hook_event_name: 'PermissionRequest',
        transcript_path: transcriptPath,
        tool_name: 'Bash',
        tool_input: { command: 'npm --version', description: 'Check npm version (may need permission)' },
      });

      const waitStarted = Date.now();
      while (Object.keys(client.agentState.requests).length === 0 && Date.now() - waitStarted < 250) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const pendingIds = Object.keys(client.agentState.requests);
      expect(pendingIds).toContain('toolu_transcript_1');
      expect(client.agentState.requests.toolu_transcript_1).toMatchObject({
        tool: 'Bash',
        arguments: { command: 'npm --version' },
      });

      const permissionHandler = client.rpcHandlerManager.getHandler('permission');
      await permissionHandler?.({ id: 'toolu_transcript_1', approved: true });

      await expect(pending).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      });
      expect(client.agentState.completedRequests.toolu_transcript_1).toMatchObject({
        status: 'approved',
        tool: 'Bash',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers tool_use_id from the session transcriptPath when transcript_path is missing in the hook payload', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-perm-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    try {
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_transcript_2',
                name: 'Bash',
                input: { command: 'node --version' },
              },
            ],
          },
        })}\n`,
        'utf8',
      );

      const { session, client } = createPermissionHandlerSessionStub('session-6');
      (session as any).transcriptPath = transcriptPath;

      const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
      bridge.activate();

      const pending = bridge.handlePermissionHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'node --version' },
      });

      const waitStarted = Date.now();
      while (Object.keys(client.agentState.requests).length === 0 && Date.now() - waitStarted < 250) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }

      const pendingIds = Object.keys(client.agentState.requests);
      expect(pendingIds).toContain('toolu_transcript_2');

      const permissionHandler = client.rpcHandlerManager.getHandler('permission');
      await permissionHandler?.({ id: 'toolu_transcript_2', approved: true });

      await expect(pending).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts the metadata watcher when disposed', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-dispose-aborts-watcher');
    const waitSpy = vi.spyOn(client, 'waitForMetadataUpdate');

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    expect(waitSpy).toHaveBeenCalled();
    const signal = waitSpy.mock.calls[0]?.[0];
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    bridge.dispose();

    expect(signal?.aborted).toBe(true);
  });

  it('backs off after metadata watcher failures instead of spinning immediately', async () => {
    const { session, client } = createPermissionHandlerSessionStub('session-metadata-watcher-backoff');
    let calls = 0;
    const waitSpy = vi.spyOn(client, 'waitForMetadataUpdate').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return false;
      }
      return await new Promise<boolean>(() => {});
    });

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 5_000 });
    bridge.activate();

    await Promise.resolve();
    expect(waitSpy).toHaveBeenCalledTimes(1);
    const signal = waitSpy.mock.calls[0]?.[0] as AbortSignal;
    const removeSpy = vi.spyOn(signal, 'removeEventListener');

    await vi.advanceTimersByTimeAsync(25);
    expect(waitSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(waitSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    bridge.dispose();
  });
});
