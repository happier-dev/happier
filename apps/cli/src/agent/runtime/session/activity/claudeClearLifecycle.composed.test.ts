import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { createPluginTranscriptFileFollowService } from '@/plugins/runtime/context/transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from '@/plugins/runtime/context/transcripts/fileFollowGrants';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';
import { createHostTerminalTranscriptFollowService } from '../terminal/transcriptFollow';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createClaudeUnifiedTerminalTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

it.each([false, true])('settles real clear hooks and publishes B without an OS exit (B file exists: %s)', async materialized => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-clear-lifecycle-'));
  const sessionId = 'clear-lifecycle';
  const lifetime = new AbortController();
  const grants = createTranscriptFileFollowPathGrantRegistry();
  const fileFollow = createPluginTranscriptFileFollowService({ pluginId: 'happier.agent.claude',
    runtimeId: sessionId, readSessionId: () => sessionId, fileFollowPathGrants: grants });
  const hooks = createSessionHooksService({ happyHomeDir: directory, hasCapability: capability => capability === 'sessionHooks',
    grantTranscriptFileFollowPath: async request => {
      await grants.grant({ pluginId: 'happier.agent.claude', runtimeId: sessionId,
        scope: { kind: 'session', sessionId }, path: request.transcriptPath, reason: 'providerTranscriptSource',
        evidence: { kind: 'sessionStartTranscriptPath', providerSessionId: request.providerSessionId } });
    } });
  const terminal = createTerminalHostFixture();
  const base = createPluginContextFixture(terminal.service, createEventsFixture().service);
  let metadata = createTestMetadata({ flavor: 'claude', path: directory });
  const metadataSession = { sessionId, updateMetadata: async (update: (value: typeof metadata) => typeof metadata) => {
    metadata = update(metadata);
  } };
  // Home persistence and daemon transcript transport are the external boundaries.
  const state = createCliRuntimeSessionStateBridge({ session: metadataSession,
    credentials: { token: 'test-home', encryption: null }, metadataPort: {
      update: async (_id, update) => { metadata = createTestMetadata(update(metadata)); return { ok: true, version: 1 }; },
    } }).engine;
  const admitted: string[] = [];
  const follow = createHostTerminalTranscriptFollowService({ signal: lifetime.signal,
    loadCommittedLocalIdBaseline: async () => ({ complete: true, localIds: new Set<string>() }),
    followProviderSession: async (request, listener) => {
      admitted.push(request.providerSessionId);
      // Hold an unintended second A transport admission: B must not depend on
      // reopening the source that its own rekey just retired.
      if (request.providerSessionId === 'native-a' && admitted.length > 1) {
        await new Promise<void>(resolve => {
          request.signal.addEventListener('abort', () => resolve(), { once: true });
          if (request.signal.aborted) resolve();
        });
      }
      await listener({ kind: 'data', phase: 'initial_replay', items: [], fromCursor: null, nextCursor: 'tail' });
      return { status: 'following', startingCursor: 'tail', subscription: { dispose: async () => {
        // Native JSONL can still contain a buffered A row when the daemon source
        // detaches. The real file follower must not reopen that retired source.
        await appendFile(join(directory, `${request.providerSessionId}.jsonl`),
          JSON.stringify({ type: 'assistant', uuid: `${request.providerSessionId}-buffered-answer`, sessionId: request.providerSessionId,
            message: { role: 'assistant', content: [{ type: 'text', text: 'A' }], stop_reason: 'end_turn' } }) + '\n');
      } } };
    }, publish: async () => {},
  });
  let subscription: ReturnType<typeof subscribeSessionRuntimePublicationToMetadata>;
  let server: Awaited<ReturnType<typeof hooks.startServer>> | undefined;
  const hookEvents: string[] = [];
  const hookErrors: unknown[] = [];
  const ctx = createPluginContextFixture(terminal.service, createEventsFixture().service, {
    sessionHooks: { ...hooks, startServer: async request => {
      server = await hooks.startServer({ ...request, onSessionHook: async (id, payload) => {
        hookEvents.push(String(payload.hook_event_name));
        try { await request.onSessionHook?.(id, payload); } catch (error) { hookErrors.push(error); throw error; }
      } });
      return server;
    } },
    transcripts: { ...base.agentRuntime.transcripts, fileFollow, followSource: async request => {
      await subscription.waitForProviderSessionIdPublication(request.providerSessionId, lifetime.signal);
      const result = await follow.bindProviderSession({ agentId: 'claude', ...request });
      if (result.status === 'unavailable') throw new Error(result.code);
      return result.binding;
    } },
  });
  const operations = createClaudeUnifiedTerminalTurnOperations({ ctx, directory, happierSessionId: sessionId,
    hostPreference: 'zellij', launchEnv: {}, permissionMode: 'default' });
  const context = { session: { services: {
    activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
  } } } as unknown as AgentSessionRuntimeContext;
  const native = createClaudeNativeSessionRuntimeFromOperations(operations, { kind: 'create', sessionId, cwd: directory }, context);
  const runtime = createNativeAgentSessionOperations(native, sessionId,
    undefined, undefined, undefined, undefined, undefined, {
      context, cwd: directory, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
  subscription = subscribeSessionRuntimePublicationToMetadata({ session: metadataSession, sessionState: state,
    runtime, providerSessionMetadataKey: 'claudeSessionId' });
  const unsubscribeEvents = runtime.subscribeRuntimeEvents?.(subscription.observeRuntimeEvent);
  const children = new Set<ReturnType<typeof spawn>>();
  try {
    await operations.startProviderSession();
    if (!server?.sessionHookSecretFile) throw new Error('Authenticated hooks not started');
    const endpoint = server;
    const secretFile = server.sessionHookSecretFile;
    const forwarder = await hooks.resolveForwarderAssets();
    const forward = async (event: string, id: string, extra: Record<string, unknown> = {}) => await new Promise<number | null>((resolve, reject) => {
      const child = spawn(forwarder.nodeExecutable, [forwarder.sessionForwarderScript, String(endpoint.port), event,
        '--secret-file', secretFile], { stdio: ['pipe', 'ignore', 'ignore'] });
      children.add(child);
      child.once('error', reject);
      child.once('close', code => { children.delete(child); resolve(code); });
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ hook_event_name: event, session_id: id,
        transcript_path: join(directory, `${id}.jsonl`), ...extra }));
    });
    const row = async (id: string, uuid: string, text: string) => await appendFile(join(directory, `${id}.jsonl`),
      JSON.stringify({ type: 'user', uuid, sessionId: id, message: { role: 'user', content: text } }) + '\n');
    await row('native-a', 'a-prompt', 'A');
    expect(await forward('SessionStart', 'native-a', { source: 'startup' })).toBe(0);
    expect(hookEvents).toEqual(['SessionStart']);
    expect(hookErrors).toEqual([]);
    await vi.waitFor(() => expect(metadata.claudeSessionId).toBe('native-a'));
    await vi.waitFor(() => expect(admitted).toEqual(['native-a']));
    expect(await forward('SessionEnd', 'native-a', { reason: 'clear' })).toBe(0);
    if (materialized) await row('native-b', 'b-clear', '<command-name>/clear</command-name>');
    let settled = false;
    const startB = forward('SessionStart', 'native-b', { source: 'clear' }).then(code => { settled = true; return code; });
    await vi.waitFor(() => expect({ settled, providerId: metadata.claudeSessionId }).toEqual({
      settled: true, providerId: materialized ? 'native-b' : 'native-a',
    }));
    expect(await startB).toBe(0);
    if (materialized) await vi.waitFor(() => expect(metadata.claudeSessionId).toBe('native-b'));
    expect(await forward('UserPromptSubmit', 'native-b', { prompt: 'B' })).toBe(0);
    await row('native-b', 'b-prompt', 'B');
    await vi.waitFor(() => expect(metadata.claudeSessionId).toBe('native-b'));
    await vi.waitFor(() => expect(admitted).toEqual(['native-a', 'native-b']));
    expect(hookEvents).toEqual(['SessionStart', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    expect(hookErrors).toEqual([]);
    expect(terminal.service.dispose).not.toHaveBeenCalled();
    expect(runtime.readSessionIdentity().sessionId).toBe('native-b');
    await operations.disposeProviderSession();
    expect(admitted).toEqual(['native-a', 'native-b']);
  } finally {
    lifetime.abort();
    for (const child of children) child.kill();
    subscription();
    unsubscribeEvents?.();
    await operations.disposeProviderSession();
    await server?.dispose();
    await follow.releaseActiveBindings();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
