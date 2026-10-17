import { describe, expect, it } from 'vitest';

import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createDeferred } from '@/testkit/async/deferred';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import { SessionMutationJournalAdmissionBlockedError } from '@/api/session/mutations/createSessionMutationOutbox';

/**
 * Provider-initiated turns (pi extensions such as AFT background bash inject real user
 * prompts into the provider session; the provider then starts a run without a Happier
 * prompt). These turns must open and close a task lifecycle turn so the session shows
 * as working in Happier clients, mirroring the claude session hook lifecycle.
 */
describe('createAcpRuntime (provider-initiated turns)', () => {
  it.each([
    { output: 'user', beforeStart: false, cancelWhileIdle: false },
    { output: 'user', beforeStart: true, cancelWhileIdle: false },
    { output: 'user', beforeStart: true, cancelWhileIdle: true },
    { output: 'media', beforeStart: false, cancelWhileIdle: false },
  ] as const)('fails visibly when observed $output output cannot enter journal custody (before start: $beforeStart, idle cancel: $cancelWhileIdle)', async ({ output, beforeStart, cancelWhileIdle }) => {
    const backend = createFakeAcpRuntimeBackend();
    const failure = new SessionMutationJournalAdmissionBlockedError(new Error('Journal custody unavailable'));
    const mutations: SessionTurnMutationV1[] = [];
    const published: string[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'refused-custody', enqueueSessionTurn: async (mutation) => { mutations.push(mutation); } });
    const runtime = createAcpRuntime({
      provider: 'pi', directory: '/tmp', messageBuffer: new MessageBuffer(), mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      session: createBasicSessionClientWithOverrides({
        sessionTurnLifecycle: lifecycle,
        sendAgentMessage: (provider, body) => {
          void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
          published.push(body.type);
        },
        sendAgentMessageCommitted: async (_provider, body) => {
          if (output === 'media') throw failure;
          published.push(body.type);
        },
        sendUserTextMessageCommitted: async () => { throw failure; },
      }),
      sessionMedia: { persist: async () => ({ media: [], unavailable: [{
        id: 'failed-custody-media', role: 'output', category: 'generated', mediaKind: 'image',
        code: 'source_not_supported', origin: { source: 'acp-content' },
      }] }) },
    });
    await runtime.startOrLoad({});
    if (cancelWhileIdle) await runtime.cancel();
    if (beforeStart) backend.emit({ type: 'user-message', text: 'provider prompt' });
    backend.emit({ type: 'status', status: 'running' });
    if (output === 'user' && !beforeStart) backend.emit({ type: 'user-message', text: 'provider prompt' });
    if (output === 'user') backend.emit({ type: 'model-output', fullText: 'provider answer', fullTextScope: 'segment' });
    else backend.emit({ type: 'session-media', source: 'acp-content', media: [{
      kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png',
      origin: { source: 'acp-content', providerEventId: 'failed-custody', contentIndex: 0 },
      dedupeKey: 'acp-content:failed-custody:0',
    }] });
    backend.emit({ type: 'status', status: 'idle' });
    await runtime.flushTurn();
    expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'fail']);
    expect(mutations[0]?.turnId).toBe(mutations[1]?.turnId);
    expect(published).not.toContain('task_complete');
    expect(published).toContain('turn_failed');
    expect(lifecycle.hasActiveTurn()).toBe(false);
  });

  it.each([
    { hostFailure: false, providerEnds: true },
    { hostFailure: true, providerEnds: true },
    { hostFailure: false, providerEnds: false },
  ])('separates a provider run before the completed host caller flushes (host failure: $hostFailure, provider ended: $providerEnds)', async ({ hostFailure, providerEnds }) => {
    const response = createDeferred<AcpTurnOutcome>();
    let waitingForResponse = false;
    const backend = createFakeAcpRuntimeBackend({ waitForResponseComplete: () => {
      waitingForResponse = true;
      return response.promise;
    } });
    const mutations: SessionTurnMutationV1[] = [];
    const published: string[] = [];
    const classified: string[] = [];
    const thinking: boolean[] = [];
    const hooks: string[] = [];
    const failure = new Error('Host response rejected');
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'host-handoff', enqueueSessionTurn: async (mutation) => { mutations.push(mutation); } });
    const runtime = createAcpRuntime({
      provider: 'pi', directory: '/tmp', messageBuffer: new MessageBuffer(), mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(), onThinkingChange: (value) => { thinking.push(value); }, ensureBackend: async () => backend,
      session: createBasicSessionClientWithOverrides({
        sessionTurnLifecycle: lifecycle,
        sendAgentMessage: (provider, body) => {
          void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
          published.push(body.type);
        },
        sendAgentMessageCommitted: async (_provider, body) => { published.push(body.type === 'message' ? body.message : body.type); },
        sendUserTextMessageCommitted: async (text) => { published.push(text); },
      }),
      hooks: {
        classifyAssistantTurnFailure: ({ text }) => { classified.push(text); return hostFailure && text === 'host answer' ? failure : null; },
        onBeforeFlushTurn: () => { hooks.push('success'); },
        onTurnFailure: async () => { hooks.push('failure'); },
      },
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    const hostPrompt = runtime.sendPrompt('host prompt');
    await expect.poll(() => waitingForResponse).toBe(true);
    backend.emit({ type: 'model-output', fullText: 'host answer', fullTextScope: 'segment' });
    // These are decoded synchronously before the host prompt continuation gets a turn.
    const terminalIdle = { type: 'status', status: 'idle', turnFinished: true } as const;
    backend.emit(terminalIdle);
    response.resolve({ kind: 'completed', stopReason: 'end_turn' });
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'user-message', text: 'provider prompt' });
    backend.emit({ type: 'model-output', fullText: 'provider answer', fullTextScope: 'segment' });
    if (providerEnds) backend.emit({ type: 'status', status: 'idle' });
    const hostError = await hostPrompt.then(() => null, (error: unknown) => error);
    if (hostError) await runtime.failTurn(hostError);
    await runtime.flushTurn();
    if (!providerEnds) {
      await expect.poll(() => mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete', 'begin']);
      expect(thinking.at(-1)).toBe(true);
      expect(lifecycle.hasActiveTurn()).toBe(true);
      backend.emit({ type: 'status', status: 'idle' });
    }
    await runtime.flushTurn();
    expect(mutations.map((mutation) => mutation.action)).toEqual([
      'begin', hostFailure ? 'fail' : 'complete', 'begin', 'complete',
    ]);
    expect(mutations[0]?.turnId).toBe(mutations[1]?.turnId);
    expect(mutations[2]?.turnId).toBe(mutations[3]?.turnId);
    expect(mutations[0]?.turnId).not.toBe(mutations[2]?.turnId);
    expect(classified).toEqual(['host answer']);
    expect(hooks).toEqual([hostFailure ? 'failure' : 'success']);
    expect(published.indexOf('host answer')).toBeLessThan(published.indexOf(hostFailure ? 'turn_failed' : 'task_complete'));
    expect(published.indexOf('provider prompt')).toBeGreaterThan(published.lastIndexOf('task_started'));
    expect(published.indexOf('provider answer')).toBeGreaterThan(published.lastIndexOf('task_started'));
  });

  it('initiates cancellation before pending transcript settlement and retains trailing provider output', async () => {
    const transcriptCommit = createDeferred();
    const abortAcknowledged = createDeferred();
    const response = createDeferred<AcpTurnOutcome>();
    const published: string[] = [];
    let cancelStarted = false;
    const backend = createFakeAcpRuntimeBackend({ waitForResponseComplete: async () => response.promise, cancel: async () => {
      cancelStarted = true;
      backend.emit({ type: 'model-output', fullText: 'trailing cancel output', fullTextScope: 'segment' });
      response.resolve({ kind: 'completed', stopReason: 'end_turn' });
      await abortAcknowledged.promise;
      backend.emit({ type: 'status', status: 'idle', turnFinished: true });
    } });
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'cancel-session', enqueueSessionTurn: async () => {},
    });
    const runtime = createAcpRuntime({
      provider: 'pi', directory: '/tmp', messageBuffer: new MessageBuffer(),
      mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
      session: createBasicSessionClientWithOverrides({
        sessionTurnLifecycle,
        sendAgentMessage: (provider, body) => {
          void sessionTurnLifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
          published.push(body.type);
        },
        sendAgentMessageCommitted: async (_provider, body) => {
          if (body.type === 'message' && body.message === 'before cancel') await transcriptCommit.promise;
          published.push(body.type === 'message' ? body.message : body.type);
        },
      }),
      onThinkingChange: () => {}, ensureBackend: async () => backend,
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'before cancel', fullTextScope: 'segment' });
    const prompt = runtime.sendPrompt('run');
    const cancellation = runtime.cancel();
    try {
      await expect.poll(() => cancelStarted).toBe(true);
    } finally {
      transcriptCommit.resolve();
      abortAcknowledged.resolve();
    }
    await cancellation;
    await prompt;
    await expect.poll(() => published.includes('trailing cancel output')).toBe(true);
    expect(published).toContain('turn_cancelled');
    expect(published.indexOf('trailing cancel output')).toBeLessThan(published.indexOf('turn_cancelled'));
    expect(published).not.toContain('task_complete');
    expect(sessionTurnLifecycle.hasActiveTurn()).toBe(false);
  });

  it('preserves delayed provider media before publishing a status failure marker', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const persist = createDeferred();
    const published: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const mutations: SessionTurnMutationV1[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'failed-media-session', enqueueSessionTurn: async (mutation) => { mutations.push(mutation); },
    });
    let persistStarted = false;
    const runtime = createAcpRuntime({
      provider: 'pi', directory: '/tmp', messageBuffer: new MessageBuffer(),
      mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
      session: createBasicSessionClientWithOverrides({
        sessionTurnLifecycle,
        sendAgentMessage: (provider, body) => {
          void sessionTurnLifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
          published.push({ body });
        },
        sendAgentMessageCommitted: async (_provider, body, opts) => { published.push({ body, meta: opts.meta }); },
      }),
      sessionMedia: { persist: async () => {
        persistStarted = true;
        await persist.promise;
        return { media: [], unavailable: [{
          id: 'failed-turn-media', role: 'output', category: 'generated', mediaKind: 'image',
          code: 'source_not_supported', origin: { source: 'acp-content' },
        }] };
      } },
      onThinkingChange: () => {}, ensureBackend: async () => backend,
    });
    await runtime.startOrLoad({});
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'session-media', source: 'acp-content', media: [{
      kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png',
      origin: { source: 'acp-content', providerEventId: 'failed-media', contentIndex: 0 },
      dedupeKey: 'acp-content:failed-media:0',
    }] });
    await expect.poll(() => persistStarted).toBe(true);
    backend.emit({ type: 'status', status: 'error', detail: 'Provider failed' });
    await expect.poll(() => mutations.map((mutation) => mutation.action)).toEqual(['begin', 'fail']);
    expect(mutations[0]?.turnId).toBe(mutations[1]?.turnId);
    expect(published.some((row) => row.body.type === 'turn_failed')).toBe(false);
    persist.resolve();
    await expect.poll(() => published.some((row) => row.body.type === 'turn_failed')).toBe(true);
    const mediaIndex = published.findIndex((row) => JSON.stringify(row.meta ?? {}).includes('failed-turn-media'));
    expect(mediaIndex).toBeGreaterThan(-1);
    expect(mediaIndex).toBeLessThan(published.findIndex((row) => row.body.type === 'turn_failed'));
  });

  it('settles a retained transcript retry before publishing the next task start', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const retry = createDeferred();
    const published: string[] = [];
    let allowRetry = false;
    let retryStarted = false;
    const runtime = createAcpRuntime({
      provider: 'pi', directory: '/tmp', messageBuffer: new MessageBuffer(),
      mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
      session: createBasicSessionClientWithOverrides({
        sendAgentMessage: (_provider, body) => { published.push(body.type); },
        sendAgentMessageCommitted: async (_provider, body) => {
          if (body.type === 'message' && body.message === 'retained answer') {
            if (!allowRetry) throw new Error('Transcript transport unavailable');
            retryStarted = true;
            await retry.promise;
          }
          published.push(body.type === 'message' ? body.message : body.type);
        },
      }),
      onThinkingChange: () => {}, ensureBackend: async () => backend,
    });
    await runtime.startOrLoad({});
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'retained answer', fullTextScope: 'segment' });
    backend.emit({ type: 'status', status: 'idle' });
    await expect.poll(() => published.includes('turn_failed')).toBe(true);
    expect(published).not.toContain('task_complete');
    allowRetry = true;
    backend.emit({ type: 'status', status: 'running' });
    await expect.poll(() => retryStarted).toBe(true);
    backend.emit({ type: 'model-output', fullText: 'next answer', fullTextScope: 'segment' });
    backend.emit({ type: 'status', status: 'idle' });
    try {
      expect(published.filter((entry) => entry === 'task_started')).toHaveLength(1);
    } finally {
      retry.resolve();
    }
    await expect.poll(() => published.filter((entry) => entry === 'task_complete').length).toBe(1);
    const secondStart = published.indexOf('task_started', published.indexOf('task_started') + 1);
    expect(published.indexOf('retained answer')).toBeLessThan(secondStart);
    expect(published.indexOf('next answer')).toBeGreaterThan(secondStart);
  });

  it.each(['idle', 'cancel', 'error'] as const)(
    'commits a provider-observed prompt before settling through %s',
    async (terminal) => {
      const backend = createFakeAcpRuntimeBackend();
      const userCommit = createDeferred();
      const published: string[] = [];
      const sessionTurnLifecycle = createSessionTurnLifecycle({
        sessionId: 'provider-user-session', enqueueSessionTurn: async () => {},
      });
      const runtime = createAcpRuntime({
        provider: 'pi', directory: '/tmp', messageBuffer: new MessageBuffer(),
        mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
        session: createBasicSessionClientWithOverrides({
          sessionTurnLifecycle,
          sendAgentMessage: (provider, body) => {
            const observed = sessionTurnLifecycle.observeAcpLifecycleMarker({ provider, body });
            void observed.pendingWrite;
            published.push(body.type);
          },
          sendUserTextMessageCommitted: async () => {
            await userCommit.promise;
            published.push('user');
          },
        }),
        onThinkingChange: () => {}, ensureBackend: async () => backend,
      });
      await runtime.startOrLoad({});
      backend.emit({ type: 'status', status: 'running' });
      backend.emit({ type: 'user-message', text: 'provider prompt' });
      const settlement = terminal === 'cancel' ? runtime.cancel() : undefined;
      if (terminal !== 'cancel') backend.emit(terminal === 'error'
        ? { type: 'status', status: 'error', detail: 'Provider failed' }
        : { type: 'status', status: 'idle' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        expect(sessionTurnLifecycle.hasActiveTurn()).toBe(true);
      } finally {
        userCommit.resolve();
      }
      await settlement;
      await expect.poll(() => sessionTurnLifecycle.hasActiveTurn()).toBe(false);
      const marker = terminal === 'error' ? 'turn_failed' : terminal === 'cancel' ? 'turn_cancelled' : 'task_complete';
      expect(published.indexOf(marker)).toBeGreaterThan(published.indexOf('user'));
    },
  );

  it('preserves a provider turn that starts while a host turn is flushing', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const commit = createDeferred();
    const sent: ACPMessageData[] = [];
    const committedRows = new Map<string, ACPMessageData>();
    const thinking: boolean[] = [];
    let commitStarted = false;
    const runtime = createAcpRuntime({
      provider: 'pi', directory: '/tmp', messageBuffer: new MessageBuffer(),
      mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
      session: createBasicSessionClientWithOverrides({
        sendAgentMessage: (_provider, body) => { sent.push(body); },
        sendAgentMessageCommitted: async (_provider, body, opts) => {
          if (body.type === 'message' && body.message === 'host answer') {
            commitStarted = true;
            await commit.promise;
          }
          sent.push(body);
          committedRows.set(opts.localId, body);
        },
      }),
      onThinkingChange: (value) => { thinking.push(value); },
      ensureBackend: async () => backend,
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'host answer', fullTextScope: 'segment' });
    const hostFlush = runtime.flushTurn();
    await expect.poll(() => commitStarted).toBe(true);
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'provider answer', fullTextScope: 'segment' });
    commit.resolve();
    await hostFlush;
    expect(thinking.at(-1)).toBe(true);
    backend.emit({ type: 'status', status: 'idle' });
    await expect.poll(() => sent.filter((row) => row.type === 'task_complete').length).toBe(2);
    expect(sent.filter((row) => row.type === 'task_started')).toHaveLength(2);
    expect([...committedRows.values()].filter((row) => row.type === 'message').map((row) => row.message)).toEqual(['host answer', 'provider answer']);
    expect(thinking.at(-1)).toBe(false);
  });

  it('settles pending provider media before completing and starting the next turn', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const persist = createDeferred();
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    let persistStarted = false;
    const runtime = createAcpRuntime({
      provider: 'pi', directory: '/tmp', messageBuffer: new MessageBuffer(),
      mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
      session: createBasicSessionClientWithOverrides({
        sendAgentMessage: (_provider, body) => { sent.push({ body }); },
        sendAgentMessageCommitted: async (_provider, body, opts) => { sent.push({ body, meta: opts.meta }); },
      }),
      sessionMedia: { persist: async () => {
        persistStarted = true;
        await persist.promise;
        return { media: [], unavailable: [{
          id: 'media-unavailable', role: 'output', category: 'generated', mediaKind: 'image',
          code: 'source_not_supported', origin: { source: 'acp-content' },
        }] };
      } },
      onThinkingChange: () => {}, ensureBackend: async () => backend,
    });
    await runtime.startOrLoad({});
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'session-media', source: 'acp-content', media: [{
      kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png',
      origin: { source: 'acp-content', providerEventId: 'event-1', contentIndex: 0 },
      dedupeKey: 'acp-content:event-1:0',
    }] });
    await expect.poll(() => persistStarted).toBe(true);
    backend.emit({ type: 'status', status: 'idle' });
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'status', status: 'idle' });
    persist.resolve();
    await expect.poll(() => sent.filter((row) => row.body.type === 'task_complete').length).toBe(2);
    expect(sent.filter((row) => row.meta).map((row) => row.meta)).toEqual([
      expect.objectContaining({ happier: expect.objectContaining({ payload: expect.objectContaining({
        unavailable: [expect.objectContaining({ id: 'media-unavailable' })],
      }) }) }),
    ]);
  });

  it.each(['idle', 'flush', 'cancel', 'error', 'failure'] as const)(
    'settles a second provider turn through %s while the first transcript commit is pending',
    async (terminal) => {
      const backend = createFakeAcpRuntimeBackend();
      const transcriptCommit = createDeferred();
      const sent: ACPMessageData[] = [];
      const mutations: SessionTurnMutationV1[] = [];
      const lifecycleWrites: Promise<void>[] = [];
      const publications: string[] = [];
      const thinking: boolean[] = [];
      const tracker = createTurnAssistantPreviewTracker();
      let commitStarted = false;
      const sessionTurnLifecycle = createSessionTurnLifecycle({
        sessionId: 'provider-session',
        enqueueSessionTurn: async (mutation) => { mutations.push(mutation); },
      });
      const session = createBasicSessionClientWithOverrides({
        sessionTurnLifecycle,
        sendAgentMessage: (provider, body) => {
          const observed = sessionTurnLifecycle.observeAcpLifecycleMarker({ provider, body });
          sent.push(observed.body);
          publications.push(body.type);
          if (observed.pendingWrite) lifecycleWrites.push(observed.pendingWrite);
        },
        sendAgentMessageCommitted: async (_provider, body) => {
          if (body.type === 'message' && body.message === 'answer one') {
            commitStarted = true;
            await transcriptCommit.promise;
          }
          sent.push(body);
          publications.push(body.type === 'message' ? body.message : body.type);
        },
        sendUserTextMessageCommitted: async (text) => { publications.push(text); },
      });
      const runtime = createAcpRuntime({
        provider: 'pi', directory: '/tmp', session, messageBuffer: new MessageBuffer(),
        turnAssistantPreviewTracker: tracker,
        mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: (value) => { thinking.push(value); },
        ensureBackend: async () => backend,
      });
      await runtime.startOrLoad({});
      backend.emit({ type: 'status', status: 'running' });
      backend.emit({ type: 'model-output', fullText: 'answer one', fullTextScope: 'segment' });
      backend.emit({ type: 'status', status: 'idle' });
      await expect.poll(() => commitStarted).toBe(true);

      backend.emit({ type: 'status', status: 'running' });
      expect(thinking.at(-1)).toBe(true);
      backend.emit({ type: 'model-output', fullText: 'answer two', fullTextScope: 'segment' });
      backend.emit({ type: 'tool-call', toolName: 'read', args: {}, callId: 'second-tool' });
      backend.emit({ type: 'tool-result', toolName: 'read', result: 'done', callId: 'second-tool' });
      backend.emit({ type: 'user-message', text: 'provider prompt two' });
      let settlement: Promise<void | Awaited<ReturnType<typeof runtime.flushTurn>>> | undefined;
      if (terminal === 'flush') {
        runtime.beginTurn();
        backend.emit({ type: 'status', status: 'idle' });
        expect(thinking.at(-1)).toBe(true);
        settlement = runtime.flushTurn();
      } else if (terminal === 'cancel') {
        settlement = runtime.cancel();
      } else if (terminal === 'failure') {
        runtime.beginTurn();
        settlement = runtime.failTurn(new Error('Prompt failed')).then(async () => { await runtime.flushTurn(); });
      } else {
        backend.emit(terminal === 'error'
          ? { type: 'status', status: 'error', detail: 'Provider failed' }
          : { type: 'status', status: 'idle' });
      }
      transcriptCommit.resolve();
      await settlement;
      await expect.poll(() => mutations.filter((mutation) => mutation.action !== 'begin').length).toBe(2);
      await Promise.all(lifecycleWrites);

      expect(mutations.map((mutation) => mutation.action)).toEqual([
        'begin', 'complete', 'begin', terminal === 'cancel' ? 'cancel' : terminal === 'error' || terminal === 'failure' ? 'fail' : 'complete',
      ]);
      expect(mutations[0]?.turnId).not.toBe(mutations[2]?.turnId);
      expect(mutations[0]?.turnId).toBe(mutations[1]?.turnId);
      expect(mutations[2]?.turnId).toBe(mutations[3]?.turnId);
      const secondStart = publications.indexOf('task_started', publications.indexOf('task_started') + 1);
      expect(publications.indexOf('answer two')).toBeGreaterThan(secondStart);
      expect(publications.indexOf('tool-call')).toBeGreaterThan(secondStart);
      expect(publications.indexOf('tool-result')).toBeGreaterThan(secondStart);
      expect(publications.indexOf('provider prompt two')).toBeGreaterThan(secondStart);
      expect(sessionTurnLifecycle.hasActiveTurn()).toBe(false);
      expect(runtime.isTurnInFlight()).toBe(false);
      expect(thinking.at(-1)).toBe(false);
      await runtime.flushTurn();
      expect(tracker.getPreview()).toBeNull();
    },
  );

  function findTaskMarker<T extends ACPMessageData['type']>(
    sent: ACPMessageData[],
    type: T,
  ): Extract<ACPMessageData, { type: T }> | undefined {
    return sent.find((message): message is Extract<ACPMessageData, { type: T }> => message.type === type);
  }

  it.each([false, true])('opens a task turn when the provider reports running without a Happier turn in flight (idle cancel: %s)', async (cancelWhileIdle) => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];
    const keepAliveCalls: Array<[boolean, string]> = [];
    const thinkingStates: boolean[] = [];
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'native-running', enqueueSessionTurn: async (mutation) => { mutations.push(mutation); } });

    const session = createBasicSessionClientWithOverrides({
      sessionTurnLifecycle: lifecycle,
      sendAgentMessage: (provider, body) => {
        void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
        sent.push(body);
      },
      keepAlive: (thinking, mode) => {
        keepAliveCalls.push([thinking, mode]);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: (thinking) => {
        thinkingStates.push(thinking);
      },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    if (cancelWhileIdle) await runtime.cancel();

    backend.emit({ type: 'status', status: 'running' });

    const taskStarted = findTaskMarker(sent, 'task_started');
    expect(taskStarted).toBeTruthy();
    expect(taskStarted?.id).toEqual(expect.any(String));
    expect(keepAliveCalls).toContainEqual([true, 'remote']);
    expect(thinkingStates).toContain(true);
    backend.emit({ type: 'status', status: 'idle' });
    await runtime.flushTurn();
    expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
    expect(mutations[0]?.turnId).toBe(mutations[1]?.turnId);
    expect(lifecycle.hasActiveTurn()).toBe(false);
  });

  it('completes the provider-initiated task turn when the provider reports idle', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];
    const keepAliveCalls: Array<[boolean, string]> = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      keepAlive: (thinking, mode) => {
        keepAliveCalls.push([thinking, mode]);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'status', status: 'idle' });

    for (let attempt = 0; attempt < 50 && !findTaskMarker(sent, 'task_complete'); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const taskStarted = findTaskMarker(sent, 'task_started');
    const taskComplete = findTaskMarker(sent, 'task_complete');
    expect(taskStarted).toBeTruthy();
    expect(taskComplete).toBeTruthy();
    expect(taskComplete?.id).toBe(taskStarted?.id);
    expect(keepAliveCalls).toContainEqual([false, 'remote']);
  });

  it('does not open a provider-initiated turn while a Happier turn is in flight', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    await runtime.flushTurn();

    expect(sent.filter((message) => message?.type === 'task_started')).toHaveLength(1);
    expect(findTaskMarker(sent, 'task_complete')).toBeTruthy();
  });

  it('adopts the open provider-initiated turn when a Happier prompt turn begins', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    // Extension triggers a run while the session is idle...
    backend.emit({ type: 'status', status: 'running' });
    // ...and the user steers it with a Happier prompt before it finishes.
    runtime.beginTurn();
    await runtime.flushTurn();

    const providerTurnId = findTaskMarker(sent, 'task_started')?.id;
    expect(providerTurnId).toEqual(expect.any(String));
    expect(sent.filter((message) => message?.type === 'task_started')).toHaveLength(1);
    const taskComplete = findTaskMarker(sent, 'task_complete');
    expect(taskComplete).toBeTruthy();
    expect(taskComplete?.id).toBe(providerTurnId);
  });

  it('cancels an open provider-initiated turn when the session runtime is cancelled', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    await runtime.cancel();

    const providerTurnId = findTaskMarker(sent, 'task_started')?.id;
    const turnCancelled = sent.find(
      (message) => message?.type === 'turn_cancelled' || message?.type === 'turn_aborted',
    );
    expect(turnCancelled).toBeTruthy();
    expect(turnCancelled?.id).toBe(providerTurnId);
  });

  it('marks a provider-initiated turn cancelled, not completed, when idle races the cancel', async () => {
    // Pi's abort acknowledgement waits for provider idle, so the trailing agent_end can
    // arrive while cancel() is still awaiting the backend. The turn must end cancelled.
    const backend = createFakeAcpRuntimeBackend({
      cancel: async () => {
        backend.emit({ type: 'status', status: 'idle' });
      },
    });
    const sent: ACPMessageData[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    await runtime.cancel();

    const providerTurnId = findTaskMarker(sent, 'task_started')?.id;
    expect(sent.some((message) => message?.type === 'task_complete')).toBe(false);
    const turnCancelled = sent.find((message) => message?.type === 'turn_cancelled');
    expect(turnCancelled).toBeTruthy();
    expect(turnCancelled?.id).toBe(providerTurnId);
  });

  it('flushes the final assistant text before completing a provider-initiated turn', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const orderedRows: ACPMessageData[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        orderedRows.push(body);
      },
      sendAgentMessageCommitted: async (_provider, body) => {
        orderedRows.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'final answer', fullTextScope: 'segment' });
    backend.emit({ type: 'status', status: 'idle' });

    // The task_complete marker must land only after the flushed assistant row is durable.
    for (let attempt = 0; attempt < 50 && !orderedRows.some((message) => message?.type === 'task_complete'); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const taskCompleteIndex = orderedRows.findIndex((message) => message?.type === 'task_complete');
    const assistantRowIndex = orderedRows.findIndex(
      (message) => message?.type === 'message' && message?.message === 'final answer',
    );
    expect(assistantRowIndex).toBeGreaterThan(-1);
    expect(taskCompleteIndex).toBeGreaterThan(assistantRowIndex);
  });

  it('never lets the next provider turn open before the previous completion marker', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'answer one', fullTextScope: 'segment' });
    backend.emit({ type: 'status', status: 'idle' });
    // The provider immediately starts its next run while the previous close is still
    // flushing; the new task_started must queue behind the pending task_complete.
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'answer two', fullTextScope: 'segment' });
    backend.emit({ type: 'status', status: 'idle' });

    for (let attempt = 0; attempt < 50 && sent.filter((message) => message?.type === 'task_complete').length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const firstTaskComplete = sent.findIndex((message) => message?.type === 'task_complete');
    const secondTaskStart = sent
      .map((message, index) => ({ message, index }))
      .filter((entry) => entry.message?.type === 'task_started')
      .at(1);
    expect(firstTaskComplete).toBeGreaterThan(-1);
    expect(secondTaskStart?.index).toBeGreaterThan(firstTaskComplete);
  });

  it('commits provider-observed user prompts to the transcript as user rows', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const committedUserMessages: Array<{ text: string; opts: { localId: string; meta?: Record<string, unknown> } }> = [];
    const sent: ACPMessageData[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      sendUserTextMessageCommitted: async (text, opts) => {
        committedUserMessages.push({ text, opts });
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'user-message', text: '<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>' });

    expect(committedUserMessages).toHaveLength(1);
    expect(committedUserMessages[0]!.text).toBe('<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>');
    expect(committedUserMessages[0]!.opts.localId).toEqual(expect.stringMatching(/^provider-user-prompt:/));
    // Identical prompt text observed in two separate events commits two distinct rows:
    // the identity is per-occurrence, not text-derived, so legitimate repeats (e.g. two
    // "continue" injections) do not collapse into one transcript row.
    backend.emit({ type: 'user-message', text: '<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>' });
    await expect.poll(() => committedUserMessages.length).toBe(2);
    expect(committedUserMessages[1]!.opts.localId).not.toBe(committedUserMessages[0]!.opts.localId);
    // Provider-observed user prompts are transcript rows, not ACP-forwarded agent messages.
    expect(sent.some((message) => message.type === 'message' && message.message.includes('BACKGROUND BASH'))).toBe(false);
  });
});
