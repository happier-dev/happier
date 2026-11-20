import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createPluginTranscriptFileFollowService } from '@/plugins/runtime/context/transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from '@/plugins/runtime/context/transcripts/fileFollowGrants';
import { createHostTerminalTranscriptFollowService } from '../terminal/transcriptFollow';
import { createHostRuntimeActivityProjection } from './createHostRuntimeActivityProjection';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeUnifiedTerminalTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  createEventsFixture, createPluginContextFixture, createSdkExecFixture, createSessionHooksFixture,
  createTerminalHostFixture,
} from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

const slowRealpath = vi.hoisted(() => ({
  path: null as string | null, wait: null as Promise<void> | null, entered: null as (() => void) | null,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: async (...args: Parameters<typeof actual.realpath>) => {
    // Delay only the genuine OS path lookup; all grant/follow logic and filesystem bytes are real.
    if (String(args[0]) === slowRealpath.path && slowRealpath.wait) {
      const wait = slowRealpath.wait;
      slowRealpath.wait = null;
      slowRealpath.entered?.();
      await wait;
    }
    return await actual.realpath(...args);
  } };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(['fresh', 'source_loss', 'disposed_source_loss'] as const)(
  'admits a fresh terminal prompt before its native transcript can prove the source identity (%s)', async lifecycle => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-terminal-fresh-source-'));
  const sessionId = 'terminal-fresh-source';
  const providerSessionId = 'native-terminal-fresh-source';
  const transcriptPath = join(directory, `${providerSessionId}.jsonl`);
  const lifetime = new AbortController();
  const grants = createTranscriptFileFollowPathGrantRegistry();
  await grants.grant({ pluginId: 'happier.agent.claude', runtimeId: sessionId,
    scope: { kind: 'session', sessionId }, path: transcriptPath, reason: 'providerTranscriptSource',
    evidence: { kind: 'sessionStartTranscriptPath', providerSessionId } });
  const fileFollow = createPluginTranscriptFileFollowService({ pluginId: 'happier.agent.claude',
    runtimeId: sessionId, readSessionId: () => sessionId, fileFollowPathGrants: grants });
  const terminal = createTerminalHostFixture();
  const hooks = createSessionHooksFixture();
  const base = createPluginContextFixture(terminal.service, createEventsFixture().service);
  let metadata = createTestMetadata({ flavor: 'claude', path: directory });
  const metadataSession = { sessionId, updateMetadata: async (update: (current: typeof metadata) => typeof metadata) => {
    metadata = update(metadata);
  } };
  const state = createCliRuntimeSessionStateBridge({ session: metadataSession,
    credentials: { token: 'test-home', encryption: null }, metadataPort: {
      // Home persistence is the system boundary; identity admission below is real.
      update: async (_id, update) => {
        metadata = createTestMetadata(update(metadata));
        return { ok: true, version: 1 };
      },
    } }).engine;
  let sourceAdmissions = 0;
  let failSource!: (error: Error) => void;
  const sourceFailure = new Promise<Error>(resolve => { failSource = resolve; });
  const follow = createHostTerminalTranscriptFollowService({ signal: lifetime.signal,
    loadCommittedLocalIdBaseline: async () => ({ complete: true, localIds: new Set<string>() }),
    // The daemon's external transcript channel is the transport boundary.
    followProviderSession: async (_request, listener) => {
      sourceAdmissions += 1;
      await listener({ kind: 'data', phase: 'initial_replay', items: [], fromCursor: null, nextCursor: 'tail' });
      return { status: 'following', startingCursor: 'tail', failure: sourceFailure,
        subscription: { dispose: async () => {} } };
    }, publish: async () => {},
  });
  let subscription: ReturnType<typeof subscribeSessionRuntimePublicationToMetadata>;
  const ctx = createPluginContextFixture(terminal.service, createEventsFixture().service, {
    sessionHooks: hooks.service,
    transcripts: { ...base.agentRuntime.transcripts, fileFollow,
      followSource: async request => {
        await subscription.waitForProviderSessionIdPublication(request.providerSessionId, lifetime.signal);
        const result = await follow.bindProviderSession({ agentId: 'claude', ...request });
        if (result.status === 'unavailable') throw new Error(result.code);
        return result.binding;
      },
    },
  });
  const operations = createClaudeUnifiedTerminalTurnOperations({ ctx, directory,
    happierSessionId: sessionId, hostPreference: 'zellij', launchEnv: {}, permissionMode: 'default' });
  let latestActivity: unknown;
  const activity = createHostRuntimeActivityProjection({ sessionId, agentRuntimeApplicability: 'supported',
    // Home persistence is the genuine boundary; source loss and Activity reduction stay real.
    enqueueRegisteredSessionStateFieldMutation: async mutation => { latestActivity = mutation.op; } });
  const activityBinding = activity.bindAgentRuntime({ applicability: 'supported' });
  const unsubscribeActivity = operations.subscribeCanonicalAgentSessionEvents(event => {
    void activityBinding.observeEvent(event);
  });
  // Host registration is outside this fixture; the native codec and identity subscriber are real.
  const context = { session: { services: {
    activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
  } } } as unknown as AgentSessionRuntimeContext;
  const native = createClaudeNativeSessionRuntimeFromOperations(operations, { kind: 'create', sessionId, cwd: directory }, context);
  const runtime = createNativeAgentSessionOperations(native, sessionId,
    undefined, undefined, undefined, undefined, undefined, {
      context, cwd: directory, connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
  subscription = subscribeSessionRuntimePublicationToMetadata({ session: metadataSession, sessionState: state,
    runtime, providerSessionMetadataKey: 'claudeSessionId' });
  try {
    await operations.startProviderSession();
    const hook = hooks.service.startServer.mock.calls[0]?.[0].onSessionHook;
    if (!hook) throw new Error('Session hook not registered');
    // Native Claude may report SessionStart before creating its first JSONL row.
    await expect(hook(providerSessionId, { hook_event_name: 'SessionStart', source: 'startup',
      session_id: providerSessionId, transcript_path: transcriptPath })).resolves.toBeUndefined();
    expect(metadata.claudeSessionId).toBeUndefined();
    expect(sourceAdmissions).toBe(0);
    operations.beginProviderTurn('first-terminal-turn');
    await operations.sendProviderTurnPrompt('FIRST_TERMINAL_PROMPT');
    expect(vi.mocked(terminal.service.injectUserPrompt).mock.calls[0]?.[1].text).toBe('FIRST_TERMINAL_PROMPT');
    await appendFile(transcriptPath, JSON.stringify({ type: 'user', uuid: 'first-native-row', sessionId: providerSessionId,
      message: { role: 'user', content: 'FIRST_TERMINAL_PROMPT' } }) + '\n');
    await vi.waitFor(() => expect(metadata.claudeSessionId).toBe(providerSessionId));
    await vi.waitFor(() => expect(sourceAdmissions).toBe(1));
    if (lifecycle !== 'fresh') {
      await vi.waitFor(() => expect(latestActivity).toMatchObject({ kind: 'set', value: { state: 'idle' } }));
      if (lifecycle === 'disposed_source_loss') await operations.disposeProviderSession();
      failSource(Object.assign(new Error('External source unavailable'), { code: 'plugin_external_follow_unavailable' }));
      if (lifecycle === 'source_loss') {
        await vi.waitFor(() => expect(latestActivity).toMatchObject({ kind: 'set', value: { state: 'unknown', activeCount: 0 } }));
        expect(lifetime.signal.aborted).toBe(false);
        expect(terminal.service.dispose).not.toHaveBeenCalled();
      } else {
        await Promise.resolve();
        await activity.reofferCurrentSnapshot();
        expect(latestActivity).toMatchObject({ kind: 'set', value: { state: 'idle' } });
      }
    }
  } finally {
    lifetime.abort();
    unsubscribeActivity();
    activity.dispose();
    subscription();
    await operations.disposeProviderSession();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['ordered', 'delayed_grant', 'delayed_follow', 'historical_before_start',
  'baseline_recovers', 'baseline_unavailable', 'baseline_recovers_after_native_loss'] as const)(
  'settles a fresh Claude host slot after exact SDK input proof (%s)', async order => {
  const delayedGrant = order === 'delayed_grant';
  const delayedFollow = order === 'delayed_follow';
  const failsBaseline = order.startsWith('baseline_');
  let sourceAvailable = !failsBaseline;
  const baselineFailed = deferred(), baselineAdmitted = deferred();
  const directory = await mkdtemp(join(tmpdir(), 'claude-fresh-source-proof-'));
  const sessionId = 'fresh-source-proof';
  const providerSessionId = 'native-source-proof';
  const transcriptPath = join(directory, `${providerSessionId}.jsonl`);
  const lifetime = new AbortController();
  const grants = createTranscriptFileFollowPathGrantRegistry();
  const fileFollow = createPluginTranscriptFileFollowService({
    pluginId: 'happier.agent.claude', runtimeId: 'fresh-source-proof', readSessionId: () => sessionId,
    fileFollowPathGrants: grants,
  });
  let sourceAdmissions = 0;
  const sourceFollow = createHostTerminalTranscriptFollowService({
    signal: lifetime.signal,
    // Home transcript storage and the external source channel are system boundaries.
    loadCommittedLocalIdBaseline: async () => ({ localIds: new Set<string>(), complete: true }),
    followProviderSession: async (_request, listener) => {
      if (!sourceAvailable) return { status: 'unavailable', code: 'plugin_external_sources_reconfiguring' };
      sourceAdmissions += 1;
      await listener({ kind: 'data', phase: 'initial_replay', items: [], fromCursor: null, nextCursor: 'tail' });
      return { status: 'following', startingCursor: 'tail', subscription: { dispose: async () => {} } };
    },
    publish: async () => {},
  });
  const exec = createSdkExecFixture();
  const hooks = createSessionHooksFixture();
  const grantEntered = deferred(), releaseGrant = deferred(), candidateActivated = deferred();
  const hookOrder: string[] = [];
  const nativeHooks = createSessionHooksService({ happyHomeDir: directory,
    hasCapability: capability => capability === 'sessionHooks',
    grantTranscriptFileFollowPath: async request => {
      await grants.grant({ pluginId: 'happier.agent.claude', runtimeId: 'fresh-source-proof',
        scope: { kind: 'session', sessionId }, path: request.transcriptPath, reason: 'providerTranscriptSource',
        evidence: { kind: 'sessionStartTranscriptPath', providerSessionId: request.providerSessionId } });
    },
  });
  const nativeServer: { current: Awaited<ReturnType<typeof nativeHooks.startServer>> | null } = { current: null };
  const base = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service);
  const context = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
    exec: exec.service, sessionHooks: delayedGrant || delayedFollow ? { ...nativeHooks,
      startServer: async request => {
        nativeServer.current = await nativeHooks.startServer({ ...request, onSessionHook: async (id, payload) => {
          hookOrder.push(String(payload.hook_event_name));
          await request.onSessionHook?.(id, payload);
          if (payload.hook_event_name === 'SessionStart') candidateActivated.resolve();
        } });
        return nativeServer.current;
      },
    } : hooks.service,
    transcripts: { ...base.agentRuntime.transcripts,
      fileFollow: { follow: async input => {
        if (delayedFollow) {
          slowRealpath.path = transcriptPath;
          slowRealpath.wait = releaseGrant.promise;
          slowRealpath.entered = grantEntered.resolve;
        }
        return await fileFollow.follow({ ...input, onError: error => {
          input.onError?.(error);
          baselineFailed.resolve();
        } });
      } },
      followSource: async (request: Parameters<NonNullable<typeof base.agentRuntime.transcripts.followSource>>[0]) => {
        const result = await sourceFollow.bindProviderSession({ agentId: 'claude', ...request });
        if (result.status !== 'following') throw new Error(result.code);
        baselineAdmitted.resolve();
        return { dispose: () => result.binding.dispose() };
      },
    },
  });
  let latestState: unknown;
  const projection = createHostRuntimeActivityProjection({
    sessionId, agentRuntimeApplicability: 'supported',
    enqueueRegisteredSessionStateFieldMutation: async mutation => { latestState = mutation.op; },
  });
  const binding = projection.bindAgentRuntime({ applicability: 'supported' });
  const operations = createClaudeAgentSdkTurnOperations({
    ctx: context, directory, launchEnv: {}, permissionMode: 'default', happierSessionId: sessionId,
    enableSessionWorkState: true, enableSessionResumability: true,
  });
  const unsubscribe = operations.subscribeCanonicalAgentSessionEvents(event => { void binding.observeEvent(event); });
  try {
    // Deliberately use composed SDK input rather than the short UI fixture prompt.
    const prompt = 'Host-owned context\nReply exactly QA20D_CLAUDE_READY.';
    await operations.sendProviderTurnPrompt(prompt);
    const submitted = exec.written.find((row): row is { type: 'user'; message: { content: string } } =>
      row !== null && typeof row === 'object' && 'type' in row && row.type === 'user');
    expect(submitted?.message.content).toBe(prompt);
    const onSessionHook = hooks.service.startServer.mock.calls[0]?.[0].onSessionHook;
    if (!submitted) throw new Error('Missing submitted SDK input');
    const writeRoot = async (uuid = 'accepted-input') => await appendFile(transcriptPath, JSON.stringify({ type: 'user', uuid,
      sessionId: providerSessionId, timestamp: new Date().toISOString(),
      message: { role: 'user', content: submitted.message.content } }) + '\n');
    if (delayedGrant || delayedFollow) {
      const server = nativeServer.current;
      if (!server?.sessionHookSecretFile) throw new Error('Missing native hook server');
      const secretFile = server.sessionHookSecretFile;
      const forwarder = await nativeHooks.resolveForwarderAssets();
      const forward = async (event: string, body: unknown) => await new Promise<number | null>((done, reject) => {
        const child = spawn(forwarder.nodeExecutable, [forwarder.sessionForwarderScript,
          String(server.port), event, '--secret-file', secretFile], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('close', done);
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(body));
      });
      if (delayedGrant) {
        slowRealpath.path = transcriptPath;
        slowRealpath.wait = releaseGrant.promise;
        slowRealpath.entered = grantEntered.resolve;
      }
      let sessionStartExited = false;
      const sessionStart = forward('SessionStart', { hook_event_name: 'SessionStart', source: 'startup',
        session_id: providerSessionId, transcript_path: transcriptPath }).then(code => { sessionStartExited = true; return code; });
      await grantEntered.promise;
      try {
        await new Promise(done => setTimeout(done, 650));
        expect(sessionStartExited).toBe(false);
        expect(hookOrder).toEqual(delayedGrant ? [] : ['SessionStart']);
      } finally { releaseGrant.resolve(); }
      // The native parent waits for SessionStart before issuing another hook or writing its root row.
      expect(await sessionStart).toBe(0);
      await candidateActivated.promise;
      expect(await forward('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit',
        session_id: providerSessionId, prompt: submitted.message.content })).toBe(0);
      expect(hookOrder).toEqual(['SessionStart', 'UserPromptSubmit']);
    } else {
      if (!onSessionHook) throw new Error('Missing native hook');
      // Exact same-prompt, same-native-ID history inside the proof window is still replay.
      if (order === 'historical_before_start') await writeRoot('historical-input');
      // The authenticated SessionStart grants this exact pending file before it exists.
      await grants.grant({ pluginId: 'happier.agent.claude', runtimeId: 'fresh-source-proof',
        scope: { kind: 'session', sessionId }, path: transcriptPath, reason: 'providerTranscriptSource',
        evidence: { kind: 'sessionStartTranscriptPath', providerSessionId } });
      await onSessionHook(providerSessionId, { hook_event_name: 'SessionStart', source: 'startup',
        session_id: providerSessionId, transcript_path: transcriptPath });
      await onSessionHook(providerSessionId, { hook_event_name: 'UserPromptSubmit',
        session_id: providerSessionId, prompt: submitted.message.content });
    }
    await projection.reofferCurrentSnapshot();
    expect(latestState).toEqual({ kind: 'set', value: { state: 'unknown', activeCount: 0 } });
    expect(sourceAdmissions).toBe(0);
    await writeRoot();
    if (failsBaseline) {
      await baselineFailed.promise;
      await projection.reofferCurrentSnapshot();
      expect(latestState).toEqual({ kind: 'set', value: { state: 'unknown', activeCount: 0 } });
      if (order === 'baseline_recovers_after_native_loss') await exec.emit({ type: 'system',
        subtype: 'hook_response', hook_event: 'SubagentStop', outcome: 'error', session_id: providerSessionId });
      if (order !== 'baseline_unavailable') {
        sourceAvailable = true;
        // The real file follower reoffers its uncommitted row to the same SDK source binding.
        await baselineAdmitted.promise;
      }
    }
    await exec.emit({ type: 'result', subtype: 'success', is_error: false, result: 'QA20D_CLAUDE_READY',
      session_id: providerSessionId, queued_turn_count: 0, num_turns: 1,
      total_cost_usd: 0, duration_ms: 10, duration_api_ms: 8 });
    await operations.waitForProviderTurnCompletion();
    await projection.reofferCurrentSnapshot();
    expect(sourceAdmissions).toBe(order === 'baseline_unavailable' ? 0 : 1);
    expect(latestState).toEqual({ kind: 'set', value: {
      state: order === 'baseline_unavailable' || order === 'baseline_recovers_after_native_loss' ? 'unknown' : 'idle', activeCount: 0,
    } });
  } finally {
    releaseGrant.resolve();
    slowRealpath.path = null;
    slowRealpath.wait = null;
    slowRealpath.entered = null;
    unsubscribe();
    await operations.disposeProviderSession();
    await nativeServer.current?.dispose();
    await sourceFollow.releaseActiveBindings();
    projection.dispose();
    lifetime.abort();
    await grants.revokeScope({ pluginId: 'happier.agent.claude', runtimeId: 'fresh-source-proof', scope: { kind: 'session', sessionId } });
    await rm(directory, { recursive: true, force: true });
  }
});
