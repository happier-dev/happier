import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol';
import { createCodexAppServerRuntime, waitForCodexAppServerRuntimeTurnCompletion } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime';
import { createCodexNativeAppServerSessionRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import type { DisposableCodexAppServerClient } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';
import { db } from '../../../../../../server/sources/storage/db';
import { createLightSqliteHarness } from '../../../../../../server/sources/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '../../../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionMessage } from '../../../../../../server/sources/app/session/sessionWriteService';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { createRuntimeTranscriptProjector, type RuntimeTranscriptProjectionSession } from './projectRuntimeTranscriptEvent';
import { createSessionTurnLifecycle } from '../turn/lifecycle';
import { createNativeAgentSessionOperations } from '../../registry/engineRegistry/nativeAgentSession';

it.each([0, 1])('revises a terminal missing-result snapshot without reopening its turn (late clock delta %i)', async lateClockDelta => {
  const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-late-codex-tool-',
    env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
  let disposeRuntime: (() => Promise<void>) | undefined;
  let restoreClock: (() => void) | undefined;
  try {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
    const committedFence = new Date(1000);
    const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), active: true,
      lastActiveAt: committedFence, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })),
      ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 })),
    } });
    await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'fixture' } });
    const authentication = createPresentUserSessionAccessAuthentication();
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    restoreClock = () => clock.mockRestore();
    const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
    let turnNumber = 0;
    // The native JSON-RPC process is the only substituted runtime boundary.
    const client: DisposableCodexAppServerClient = {
      launchFeatures: { realtimeConversationAdvertised: false },
      onNativeEvent: () => () => undefined,
      request: async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turnId: `turn-${++turnNumber}` };
        if (method === 'account/read') return { account: null };
        if (method === 'account/rateLimits/read') return { rateLimits: null };
        throw new Error(`Unexpected native request: ${method}`);
      },
      notify: async () => undefined,
      registerRequestHandler: () => () => undefined,
      registerNotificationHandler: (method, handler) => { handlers.set(method, handler); return () => handlers.delete(method); },
      onExit: () => () => undefined,
      dispose: async () => undefined,
    };
    const runtime = createCodexAppServerRuntime({ happierSessionId: session.id, directory: '/tmp',
      host: { baseProcessEnv: {}, logger: { debug: vi.fn(), warn: vi.fn() }, createClient: async () => client } });
    const native = createCodexNativeAppServerSessionRuntime(runtime, session.id);
    const host = createNativeAgentSessionOperations(native, session.id,
      undefined, undefined, undefined, undefined, undefined, {
        context: {} as AgentSessionRuntimeContext, cwd: '/tmp', connectedAccounts: [],
        capabilities: { open: ['create'], delivery: ['newTurn', 'steer'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
      });
    disposeRuntime = () => host.resetOrDisposeRuntime('runtime_recovery');
    const events: AgentSessionRuntimeEvent[] = [];
    const writes: Array<{ localId: string; createdAt?: number; updatedAt?: number }> = [];
    const project = createRuntimeTranscriptProjector();
    const transcriptSession: RuntimeTranscriptProjectionSession = { sessionId: session.id,
      enqueueAgentMessageCommitted: async (provider, body, opts) => {
        writes.push({ localId: opts.localId, createdAt: opts.createdAt, updatedAt: opts.updatedAt });
        const result = await createSessionMessage({ authentication, inputAdmission: 'transcriptOnly',
          actorUserId: account.id, sessionId: session.id, localId: opts.localId, messageRole: 'agent',
          content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider, body, meta: opts.meta }) },
          publisherAuthority: { accountId: account.id, machineId: machine.id, sessionId: session.id, committedFence },
          trustedSourceTimestamps: { createdAt: opts.createdAt ?? Date.now(), updatedAt: opts.updatedAt ?? Date.now() },
          trustedTranscriptObservationProvenance: opts.provenance,
        });
        expect(result).toMatchObject({ ok: true });
        return { persisted: result.ok, delivered: result.ok };
      },
    };
    let projection = Promise.resolve();
    const lifecycle = createSessionTurnLifecycle({ session: { sessionId: session.id } });
    host.subscribeRuntimeEvents(event => {
      events.push(event);
      projection = projection.then(async () => { await project({ session: transcriptSession, provider: 'codex', event }); });
      lifecycle.observeRuntimeEvent(event);
    });
    const notify = async (method: string, params: unknown) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Missing native handler: ${method}`);
      await handler(params);
      await projection;
    };
    await host.sendTurnPrompt('Read the worker status', { localId: 'input-1', turnId: 'host-turn-1' });
    const callId = 'exec-5ec2aa46-7f05-4440-8b2d-675433e4ced9';
    await notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { id: callId,
      type: 'mcpToolCall', server: 'happier', tool: 'action_execute', arguments: { actionId: 'session.status.get', input: {} } } });
    await notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed' } });
    await waitForCodexAppServerRuntimeTurnCompletion(runtime);
    await projection;
    expect(runtime.isTurnInFlight()).toBe(false);
    expect(lifecycle.hasActiveTurn()).toBe(false);
    const synthetic = await db.sessionMessage.findMany({ where: { sessionId: session.id }, orderBy: { seq: 'asc' } });
    expect(synthetic).toHaveLength(2);
    expect(synthetic[1]?.content).toMatchObject({ v: { content: { data: { type: 'tool-result', isError: true } } } });

    await host.sendTurnPrompt('An independent next turn', { localId: 'input-2', turnId: 'host-turn-2' });
    now += lateClockDelta;
    const late = { threadId: 'thread-1', turnId: 'turn-1', item: { id: callId, type: 'mcpToolCall',
      server: 'happier', tool: 'action_execute', arguments: {}, result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false } } };
    await notify('item/completed', { ...late, threadId: 'foreign-thread' });
    await notify('item/completed', { ...late, item: { ...late.item, id: 'unknown-call' } });
    await notify('item/completed', late);
    await notify('item/completed', late);
    const rows = await db.sessionMessage.findMany({ where: { sessionId: session.id }, orderBy: { seq: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.id).toBe(synthetic[1]?.id);
    expect(rows[1]?.content).toMatchObject({ v: { content: { data: { type: 'tool-result', output: late.item.result } } } });
    expect(rows[1]?.rowRevision).toBe(1n);
    const resultEvents = events.filter(event => event.kind === 'tool-result');
    expect(resultEvents).toEqual([expect.objectContaining({ turnId: 'host-turn-1', toolCallId: callId, output: late.item.result })]);
    expect(events.filter(event => event.kind === 'turn-start')).toHaveLength(2);
    expect(events.filter(event => event.kind === 'turn-complete')).toHaveLength(1);
    expect(runtime.isTurnInFlight()).toBe(true);
    expect(lifecycle.hasActiveTurn()).toBe(true);
    const resultWrites = writes.filter(write => write.localId === writes[1]?.localId);
    expect(resultWrites).toHaveLength(2);
    expect(resultWrites[1]?.createdAt).toBe(resultWrites[0]?.createdAt);
    expect(resultWrites[1]?.updatedAt).toBeGreaterThanOrEqual(resultWrites[0]?.updatedAt ?? 0);
    await notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-2', turn: { id: 'turn-2', status: 'completed' } });
    await waitForCodexAppServerRuntimeTurnCompletion(runtime);
    await projection;
    expect(lifecycle.hasActiveTurn()).toBe(false);
  } finally {
    await disposeRuntime?.();
    restoreClock?.();
    await harness.close();
  }
}, 180_000);
