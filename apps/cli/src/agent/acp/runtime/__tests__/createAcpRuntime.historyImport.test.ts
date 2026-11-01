import { describe, expect, it } from 'vitest';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createDeferred } from '@/testkit/async/deferred';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createAcpRuntime (history import)', () => {
  it('preserves live provider input and turn output emitted while a native session resumes', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const published: string[] = [];
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({
      sessionId: 'resume-live',
      enqueueSessionTurn: async (mutation) => { mutations.push(mutation); },
    });
    backend.loadSession = async () => {
      backend.emit({ type: 'status', status: 'running' });
      backend.emit({ type: 'user-message', text: 'extension resume input' });
      backend.emit({ type: 'model-output', fullText: 'extension resume answer', fullTextScope: 'segment' });
      backend.emit({ type: 'status', status: 'idle' });
      return { sessionId: 'ses_remote' };
    };
    const runtime = createAcpRuntime({
      provider: 'pi', directory: '/tmp', mcpServers: {}, messageBuffer: new MessageBuffer(),
      permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      session: createBasicSessionClientWithOverrides({
        sessionTurnLifecycle: lifecycle,
        sendAgentMessage: (provider, body) => {
          void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
          published.push(body.type);
        },
        sendUserTextMessageCommitted: async (text) => { published.push(text); },
        sendAgentMessageCommitted: async (_provider, body) => {
          published.push(body.type === 'message' ? body.message : body.type);
        },
      }),
    });
    await runtime.startOrLoad({ resumeId: 'ses_remote' });
    await runtime.flushTurn();
    expect(published).toContain('extension resume input');
    expect(published).toContain('extension resume answer');
    expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
    expect(mutations[0]?.turnId).toBe(mutations[1]?.turnId);
  });

  it('uses the backend replay owner even when history import is disabled', async () => {
    const backend = createFakeAcpRuntimeBackend();
    backend.loadSession = async () => {
      // A raw ACP load emits history through the same stream as live output.
      backend.emit({ type: 'model-output', fullText: 'historical answer', fullTextScope: 'segment' });
      return { sessionId: 'ses_remote' };
    };
    backend.loadSessionWithReplayCapture = async () => ({
      sessionId: 'ses_remote',
      replay: [{ type: 'message', role: 'agent', text: 'historical answer' }],
    });
    const published = new Map<string, string>();
    const runtime = createAcpRuntime({
      provider: 'codex', directory: '/tmp', mcpServers: {}, messageBuffer: new MessageBuffer(),
      permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      session: createBasicSessionClientWithOverrides({
        sendAgentMessageCommitted: async (_provider, body, options) => {
          if (body.type === 'message') published.set(options.localId, body.message);
        },
      }),
    });
    await runtime.startOrLoad({ resumeId: 'ses_remote' });
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', textDelta: 'live answer' });
    backend.emit({ type: 'status', status: 'idle' });
    await runtime.flushTurn();
    expect([...published.values()]).toEqual(['live answer']);
  });

  it('does not prompt to import divergent replay history by default', async () => {
    const backend = createFakeAcpRuntimeBackend();
    backend.loadSessionWithReplayCapture = async (_id: string) => ({
      sessionId: 'ses_remote',
      replay: [
        { type: 'message', role: 'user', text: 'REMOTE: hello' },
        { type: 'message', role: 'agent', text: 'REMOTE: hi' },
      ],
    });

    const prompted = createDeferred<void>();
    const permissionHandler = {
      handleToolCall: async () => {
        prompted.resolve(undefined);
        return { decision: 'denied' as const };
      },
    };

    const base = createSessionClientWithMetadata();
    const session = {
      ...base.session,
      fetchRecentTranscriptTextItemsForAcpImport: async () => [
        { role: 'user' as const, text: 'LOCAL: one' },
        { role: 'agent' as const, text: 'LOCAL: two' },
        { role: 'user' as const, text: 'LOCAL: three' },
      ],
    };

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    const didPrompt = await Promise.race([
      prompted.promise.then(() => true),
      delay(30).then(() => false),
    ]);

    expect(didPrompt).toBe(false);
  });

  it('prompts to import divergent replay history when import is explicitly enabled', async () => {
    const backend = createFakeAcpRuntimeBackend();
    backend.loadSessionWithReplayCapture = async (_id: string) => ({
      sessionId: 'ses_remote',
      replay: [
        { type: 'message', role: 'user', text: 'REMOTE: hello' },
        { type: 'message', role: 'agent', text: 'REMOTE: hi' },
      ],
    });

    const prompted = createDeferred<void>();
    const permissionHandler = {
      handleToolCall: async () => {
        prompted.resolve(undefined);
        return { decision: 'denied' as const };
      },
    };

    const base = createSessionClientWithMetadata();
    const session = {
      ...base.session,
      fetchRecentTranscriptTextItemsForAcpImport: async () => [
        { role: 'user' as const, text: 'LOCAL: one' },
        { role: 'agent' as const, text: 'LOCAL: two' },
        { role: 'user' as const, text: 'LOCAL: three' },
      ],
    };

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote', importHistory: true });

    const didPrompt = await Promise.race([
      prompted.promise.then(() => true),
      delay(30).then(() => false),
    ]);

    expect(didPrompt).toBe(true);
  });
});
