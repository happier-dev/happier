import { describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createOpenCodeServerClient } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeServerClient';
import { createOpenCodeServerTransport } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/transport';
import { createOpenCodeServerRuntime } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/runtime';
import { createOpenCodeSessionRuntime } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/sessionRuntime';
import { createContextFixture, managedServiceHandle } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly.managedServices.testkit';
import { openCodeTranscriptIdentityCodec } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/transcript/committedIdentities';
import { createBoundTranscriptIdentityReconciler } from './reconcileSourceIdentities';
import { fetchCommittedTranscriptIdentitySnapshot } from '@/api/session/transcriptQueries';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodeBase64, encrypt } from '@/api/encryption';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { publishRuntimeSessionEvent } from './publishRuntimeSessionEvent';

describe('native cold history reconciliation at the admitted Session scope', () => {
  it.each(['plain', 'e2ee', 'opaque-spaces', 'legacy-incomplete', 'failed-read', 'malformed-native'] as const)('reconciles exact predecessor identities on cold resume (%s)', async (kind) => {
    const nativeSessionId = kind === 'opaque-spaces' ? ' ses:old ' : 'ses:old';
    const encryptionKey = new Uint8Array(32).fill(7);
    let unavailable = kind === 'failed-read';
    let malformedNative = kind === 'malformed-native';
    let baselineReads = 0;
    // These are the exact correlation fields written by the 0.2 send/import owners,
    // including opaque colons; status rows without correlation are not conversation rows.
    const committed = [
      { id: 'h_user', seq: 4, localId: 'ui-local', createdAt: 1, updatedAt: 1, messageRole: 'user', sidechainId: null,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ui prompt' } } } },
      { id: 'h_assistant', seq: 3, localId: 'agent-local', createdAt: 2, updatedAt: 2, messageRole: 'agent', sidechainId: null,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', provider: 'opencode', data: { type: 'message', message: 'ui answer' } },
          meta: { opencodeMessageId: 'msg:ui:assistant', opencodeRemoteSessionId: nativeSessionId } } } },
      ...['user', 'assistant'].map((role, index) => ({ id: `h_imported_${role}`, seq: 2 - index,
        localId: role === 'user' ? `opencode:import:history:${nativeSessionId}:msg:imported:${role}`
          : `opencode:import:v2:${JSON.stringify(['history', nativeSessionId, null, `msg:imported:${role}`])}`, createdAt: 11 + index, updatedAt: 11 + index,
        messageRole: role === 'user' ? 'user' : 'agent', sidechainId: null,
        content: { t: 'plain', v: role === 'user'
          ? { role: 'user', content: { type: 'text', text: 'imported prompt' }, meta: { remoteSessionId: nativeSessionId } }
          : { role: 'agent', content: { type: 'acp', provider: 'opencode', data: { type: 'message', message: 'imported answer' } }, meta: { remoteSessionId: nativeSessionId } } },
      })),
      { id: 'h_status', seq: 0, localId: 'status', createdAt: 1, updatedAt: 1, messageRole: 'agent', sidechainId: null,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', provider: 'opencode', data: { type: 'event', data: { type: 'message', message: 'informational' } } } } } },
    ];
    const sourceId = (group: string, role: string): string => kind === 'opaque-spaces' && group === 'missing'
      ? ` msg:${group}:${role} ` : `msg:${group}:${role}`;
    const messages = ['ui', 'imported', 'missing'].flatMap((group, index) => [
      { id: sourceId(group, 'user'), type: 'user', sessionID: nativeSessionId, text: `${group} prompt`, time: { created: index * 10 + 1 } },
      { id: sourceId(group, 'assistant'), type: 'assistant', sessionID: nativeSessionId, parentID: sourceId(group, 'user'),
        content: [{ id: `part:${group}`, type: 'text', text: `${group} answer` }], time: { created: index * 10 + 2, completed: index * 10 + 3 }, finish: 'stop' },
    ]);
    const stream: { current: ServerResponse | null } = { current: null };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      if (path === '/v1/sessions/happy_old/messages') {
        baselineReads += 1;
        if (unavailable) { response.writeHead(503); response.end('private baseline transport failure'); return; }
        const beforeSeq = Number(url.searchParams.get('beforeSeq') ?? Infinity);
        const eligible = committed.filter((row) => row.seq < beforeSeq);
        const page = eligible.slice(0, 2).map((row) => ({ ...row, content: kind === 'e2ee'
          ? { t: 'encrypted', c: encodeBase64(encrypt(encryptionKey, 'dataKey', row.content.v)) } : row.content }));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ messages: page, hasMore: eligible.length > page.length,
          nextBeforeSeq: page.at(-1)?.seq ?? null, nextAfterSeq: page[0]?.seq ?? null }));
        return;
      }
      if (path === '/api/event') {
        stream.current = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"type":"server.connected","data":{}}\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: path.endsWith('/message') ? malformedNative ? {} : messages : path.endsWith('/active') ? {} : [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fixture = createContextFixture({ managedServerBaseUrl: baseUrl });
    const metadata = { ...createTestMetadata({ flavor: 'opencode' }),
      ...(kind === 'legacy-incomplete' ? {} : { opencodeUserMessageIdMapV1: { v: 1, byLocalId: { 'ui-local': 'msg:ui:user' } } }),
    };
    const notifications: unknown[] = [];
    // Starts after scope admission. The actual bound owner, ordinary paged reader,
    // encryption/semantic decoder, provider codec and public event projection are real.
    const reconcileSourceIdentities = createBoundTranscriptIdentityReconciler({
      agentId: 'opencode', sessionId: 'happy_old', signal: fixture.abort.signal,
      assertCurrent: () => fixture.abort.signal.throwIfAborted(), readProviderSessionId: () => nativeSessionId,
      readCodec: () => openCodeTranscriptIdentityCodec,
      session: { sessionId: 'happy_old', getMetadataSnapshot: () => metadata,
        fetchCommittedTranscriptIdentitySnapshot: (options) => runWithServerHttpBaseUrl(baseUrl, () => fetchCommittedTranscriptIdentitySnapshot({
          token: 'test-token', sessionId: 'happy_old', ...(kind === 'e2ee'
            ? { encryptionMode: 'e2ee', encryptionKey, encryptionVariant: 'dataKey' } as const : { encryptionMode: 'plain' } as const),
          ...(options?.signal ? { signal: options.signal } : {}),
        })),
      },
    });
    const ctx = { ...fixture, sessions: { ...fixture.sessions, current: { ...fixture.sessions.current,
      transcripts: { reconcileSourceIdentities,
        publishSessionEvent: (event: Parameters<typeof publishRuntimeSessionEvent>[0]['event']) => publishRuntimeSessionEvent({
          agentId: 'opencode', event, session: { sessionId: 'happy_old', enqueueAgentMessageCommitted: async (_provider, body) => {
            // The durable commit transport acknowledgement is the external boundary.
            notifications.push(body); return { persisted: true, delivered: true };
          } },
        }),
      },
    } } };
    const client = createOpenCodeServerClient({ directory: '/repo', dialect: 'v2', transport: createOpenCodeServerTransport({ managedService: managedServiceHandle({ baseUrl, request: async (request) => {
      const response = await fetch(`${baseUrl}${request.pathAndQuery}`, { method: request.method,
        ...(request.body ? { body: Buffer.from(request.body) } : {}), signal: request.signal });
      return { ok: response.ok, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: response.body };
    } }) }) });
    const operations = createOpenCodeServerRuntime({ ctx, directory: '/repo', happierSessionId: 'happy_old', client, dialect: 'v2',
      mcpRegistration: Promise.resolve({ requiredHappier: { status: 'ready' }, registeredServers: [] }),
      mcpProjection: { registrations: [], requiredHappierServerName: null, requiredHappierConfigurationPresent: false } });
    const runtime = createOpenCodeSessionRuntime({ operations,
      request: { kind: 'resume', sessionId: 'happy_old', cwd: '/repo', providerSessionId: nativeSessionId },
      disposeOperations: async () => { await operations.resetOrDisposeRuntime(); },
      runtimeCapabilities: {
        sessionCapabilities: {
          sessionListing: 'supported',
          sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
          sessionRollback: { conversation: 'unsupported' },
          usageLimitRecovery: { checkNow: 'unsupported' },
          compaction: { manual: 'supported' },
        },
        tools: { delivery: 'native_mcp', support: 'supported' },
      } });
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    try {
      await operations.openSession({ kind: 'resume', providerSessionId: nativeSessionId });
      if (kind === 'malformed-native') {
        await expect.poll(() => vi.mocked(fixture.logger.warn).mock.calls.length > 0).toBe(true);
        expect(events.filter((event) => event.kind === 'transcript-message-committed')).toEqual([]);
        malformedNative = false;
        stream.current?.write(`data: ${JSON.stringify({ type: 'session.execution.succeeded', location: { directory: '/repo' }, data: { sessionID: nativeSessionId } })}\n\n`);
      }
      if (kind === 'failed-read') {
        await expect.poll(() => vi.mocked(fixture.logger.warn).mock.calls).toContainEqual(['opencode_history_reconciliation_incomplete', { phase: 'baseline_read' }]);
        expect(events.filter((event) => event.kind === 'transcript-message-committed')).toEqual([]);
        unavailable = false;
        stream.current?.write(`data: ${JSON.stringify({ type: 'session.execution.succeeded', location: { directory: '/repo' }, data: { sessionID: nativeSessionId } })}\n\n`);
      }
      if (kind === 'legacy-incomplete') {
        await expect.poll(() => notifications).toHaveLength(1);
        expect(events.filter((event) => event.kind === 'transcript-message-committed')).toEqual([]);
        messages.push({ id: 'future-user', type: 'user', sessionID: nativeSessionId, text: 'future prompt', time: { created: 101 } });
        messages.push({ id: 'future-assistant', type: 'assistant', sessionID: nativeSessionId, parentID: 'future-user',
          content: [{ id: 'future-part', type: 'text', text: 'future answer' }], time: { created: 102, completed: 103 }, finish: 'stop' });
        stream.current?.write(`data: ${JSON.stringify({ type: 'session.execution.succeeded', location: { directory: '/repo' }, data: { sessionID: nativeSessionId } })}\n\n`);
        await expect.poll(() => events.filter((event) => event.kind === 'transcript-message-committed')).toEqual([
          expect.objectContaining({ role: 'user', text: 'future prompt' }),
          expect.objectContaining({ role: 'assistant', text: 'future answer' }),
        ]);
        return;
      }
      await expect.poll(() => events.filter((event) => event.kind === 'transcript-message-committed')).toEqual([
        expect.objectContaining({ role: 'user', text: 'missing prompt', messageId: `opencode:${encodeURIComponent(nativeSessionId)}:${encodeURIComponent(sourceId('missing', 'user'))}` }),
        expect.objectContaining({ role: 'assistant', text: 'missing answer', messageId: `opencode:${encodeURIComponent(nativeSessionId)}:${encodeURIComponent(sourceId('missing', 'assistant'))}` }),
      ]);
      stream.current?.write(`data: ${JSON.stringify({ type: 'session.execution.succeeded', location: { directory: '/repo' }, data: { sessionID: nativeSessionId } })}\n\n`);
      expect(events.filter((event) => event.kind === 'transcript-message-committed')).toHaveLength(2);
      expect(baselineReads).toBeGreaterThan(1);
    } finally {
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('exact identity scope and predecessor correlation', () => {
  it('does not trust ambiguous legacy local IDs without the exact native SID witness', () => {
    const fact = { sourceMessageId: 'c', role: 'user' as const, localId: 'opencode:a%3Ab:c' };
    const reconcile = (meta: Readonly<Record<string, unknown>>) => openCodeTranscriptIdentityCodec.reconcile({
      providerSessionId: 'a:b', facts: [fact], metadata: {},
      baseline: { complete: true, rows: [{ localId: 'opencode:import:history:a:b:c', role: 'user', meta }] },
    });
    expect(reconcile({ remoteSessionId: 'a' })).toEqual({ committedSourceMessageIds: [], hostAuthoredUserMessageIds: [],
      coverage: { complete: true, unmappedUsers: 0, unmappedAgents: 0 } });
    expect(reconcile({})).toMatchObject({ committedSourceMessageIds: [], coverage: { complete: false, unmappedUsers: 1 } });
    expect(reconcile({ remoteSessionId: 'a:b' })).toMatchObject({ committedSourceMessageIds: ['c'], coverage: { complete: true } });
  });

  it('rejects a held baseline when the admitted native Session changes, and rejects absent codec authority', async () => {
    let release: (() => void) | null = null;
    const server = createServer((_request, response) => {
      release = () => { response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })); };
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let nativeSessionId = 'old';
    const signal = new AbortController().signal;
    const params = { agentId: 'opencode', sessionId: 'h', signal, assertCurrent: () => signal.throwIfAborted(),
      readProviderSessionId: () => nativeSessionId, readCodec: () => openCodeTranscriptIdentityCodec,
      session: { sessionId: 'h', getMetadataSnapshot: () => createTestMetadata(),
        fetchCommittedTranscriptIdentitySnapshot: () => runWithServerHttpBaseUrl(baseUrl, () => fetchCommittedTranscriptIdentitySnapshot({ token: 'test-token', sessionId: 'h', encryptionMode: 'plain', signal })),
      } };
    try {
      const pending = createBoundTranscriptIdentityReconciler(params)({ providerSessionId: 'old', facts: [] });
      const outcome = expect(pending).rejects.toMatchObject({ code: 'native_agent_transcript_session_scope_mismatch' });
      await expect.poll(() => release !== null).toBe(true);
      nativeSessionId = 'new';
      const finish = (): void => { release?.(); };
      finish();
      await outcome;
      await expect(createBoundTranscriptIdentityReconciler({ ...params, readCodec: () => null })({ providerSessionId: 'new', facts: [] })).rejects.toMatchObject({ code: 'native_agent_transcript_identity_unsupported' });
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
