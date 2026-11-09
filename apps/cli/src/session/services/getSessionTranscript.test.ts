import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ExternalShareableTranscriptSnapshotV1Schema } from '@happier-dev/protocol/sessions/messages/sessionExternalShareableTranscriptV1';

import { createAccountEncryptionCurrentnessFixture, createSessionListResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const credentials = { token: 'token', encryption: null } as const;
const sessionId = 'c1234567890123456789012345';
const transcriptResponse = vi.fn<() => Promise<unknown>>();
let get: MockInstance<typeof axios.get>;

function transcriptRequests() {
  return get.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/messages'));
}

describe('getSessionTranscript', () => {
  beforeEach(() => {
    transcriptResponse.mockReset();
    // HTTP is the only substituted boundary; Account currentness, Session lookup,
    // envelope parsing and both transcript projectors remain real.
    get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain' });
      if (path === '/v2/sessions') return { status: 200, data: createSessionListResponseFixture([session]) };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
      if (path === `/v1/sessions/${sessionId}/messages`) return { status: 200, data: await transcriptResponse() };
      throw new Error(`Unexpected HTTP path: ${path}`);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, null])('preserves a complete large tool result when maxRawPayloadChars is %s', async maxRawPayloadChars => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const raw = { role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
      type: 'tool-result', callId: 'usage-query',
      output: { v: 1, results: [{ evidence: 'usage evidence '.repeat(22_000), last: 'complete' }] },
    } } };
    transcriptResponse.mockResolvedValue({ messages: [{
      id: 'usage-tool-result', seq: 12, createdAt: 12, messageRole: 'agent',
      content: { t: 'plain', v: raw },
    }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });

    const result = await getSessionTranscript({ credentials, idOrPrefix: sessionId,
      messageId: 'usage-tool-result', includeTools: true, includeRaw: true,
      ...(maxRawPayloadChars === undefined ? {} : { maxRawPayloadChars }),
    });

    expect(result).toMatchObject({ ok: true, items: [{ id: 'usage-tool-result', raw }],
      diagnostics: { payloadTruncations: 0 } });
    if (!result.ok) throw new Error(result.errorCode);
    expect(result.items[0]?.rawTruncated).toBeUndefined();
    expect(transcriptRequests()).toHaveLength(1);

    const preview = await getSessionTranscript({ credentials, idOrPrefix: sessionId,
      messageId: 'usage-tool-result', includeTools: true, includeRaw: true, maxRawPayloadChars: 32,
    });
    expect(preview).toMatchObject({ ok: true, items: [{ rawTruncated: true }],
      diagnostics: { payloadTruncations: 1 } });
  });

  it('preserves complete tool results through legacy raw-history and event readers', async () => {
    const { getSessionEvents } = await import('./getSessionEvents');
    const { getSessionHistory, readRawSessionHistoryRows } = await import('./getSessionHistory');
    const raw = { role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
      type: 'tool-result', callId: 'usage-query', output: { evidence: 'usage evidence '.repeat(22_000) },
    } } };
    transcriptResponse.mockResolvedValue({ messages: [{ id: 'usage-tool-result', seq: 12,
      createdAt: 12, messageRole: 'agent', content: { t: 'plain', v: raw },
    }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });

    expect(await getSessionEvents({ credentials, idOrPrefix: sessionId, includeRaw: true }))
      .toMatchObject({ ok: true, items: [{ raw }], diagnostics: { payloadTruncations: 0 } });
    expect(await getSessionHistory({ credentials, idOrPrefix: sessionId, limit: 1,
      format: 'raw', includeMeta: false, includeStructuredPayload: true }))
      .toMatchObject({ ok: true, messages: [{ raw }] });
    expect(await readRawSessionHistoryRows({ token: credentials.token, sessionId, limit: 1,
      mode: 'plain', ctx: null }))
      .toMatchObject([{ raw }]);
  });

  it('measures HTTP work to reopen a known semantic message behind ten history pages', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const wantedId = 'message-3';
    const wantedText = 'selected source '.repeat(400).trim();
    const rows = Array.from({ length: 210 }, (_, index) => ({
      id: `message-${index + 1}`, seq: index + 1, createdAt: index + 1, messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', content: { type: 'text',
        text: index === 2 ? wantedText : `Unrelated message ${index + 1}` } } },
    }));
    let messageRows = 0;
    transcriptResponse.mockImplementation(async () => {
      const url = new URL(String(transcriptRequests().at(-1)?.[0]));
      const messageId = url.searchParams.get('messageId');
      const before = Number(url.searchParams.get('beforeSeq') ?? rows.length + 1);
      const eligible = rows.filter(row => row.seq < before && (messageId === null || row.id === messageId));
      const selected = eligible.slice(-Number(url.searchParams.get('limit') ?? 20));
      messageRows += selected.length;
      const hasMore = messageId === null && eligible.length > selected.length;
      return { messages: selected, hasMore, nextBeforeSeq: hasMore ? selected[0]!.seq : null, nextAfterSeq: null };
    });
    let cursor: string | undefined;
    let selected: Awaited<ReturnType<typeof getSessionTranscript>> | undefined;
    for (;;) {
      const request = { credentials, idOrPrefix: sessionId, messageId: wantedId,
        ...(cursor === undefined ? {} : { cursor }) };
      const result = await getSessionTranscript(request);
      if (!result.ok) throw new Error(result.errorCode);
      if (result.items.some(item => item.id === wantedId)) { selected = result; break; }
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    const counts = { historyMessages: rows.length, http: get.mock.calls.length,
      transcriptHttp: transcriptRequests().length, messageRows };
    console.info('SEMANTIC_EXACT_MESSAGE_HTTP_COST', JSON.stringify(counts));
    expect(selected).toMatchObject({ ok: true, items: expect.arrayContaining([
      expect.objectContaining({ id: wantedId, role: 'user', kind: 'user_message', text: wantedText }),
    ]) });
    expect(counts).toEqual({ historyMessages: 210, http: 3, transcriptHttp: 1, messageRows: 1 });
  });

  it('preserves semantic text truncation and role filtering for an exact message', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const row = { id: 'exact', seq: 3, createdAt: 3, messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'abcdef' } } } };
    transcriptResponse.mockResolvedValue({ messages: [row], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
    expect(await getSessionTranscript({ credentials, idOrPrefix: sessionId, messageId: row.id, maxCharsPerMessage: 3 }))
      .toMatchObject({ ok: true, items: [{ id: row.id, role: 'user', kind: 'user_message', text: 'abc', truncated: true }],
        nextCursor: null, hasMore: false });
    expect(await getSessionTranscript({ credentials, idOrPrefix: sessionId, messageId: row.id, roles: ['assistant'] }))
      .toMatchObject({ ok: true, items: [], nextCursor: null, hasMore: false });
    expect(transcriptRequests()).toHaveLength(2);
  });

  it('settles an absent exact message without opening any history page', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    transcriptResponse.mockResolvedValue({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
    expect(await getSessionTranscript({ credentials, idOrPrefix: sessionId, messageId: 'missing' }))
      .toMatchObject({ ok: true, items: [], hasMore: false, nextCursor: null,
        diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false } });
    expect(transcriptRequests()).toHaveLength(1);
    expect(new URL(String(transcriptRequests()[0]?.[0])).searchParams.get('messageId')).toBe('missing');
  });

  it.each(['wrong_id', 'continuation', 'multiple_rows'] as const)('refuses an exact response with %s before semantic disclosure or paging', async violation => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const row = { id: violation === 'wrong_id' ? 'unselected' : 'exact', seq: 3, createdAt: 3,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'PRIVATE_UNSELECTED' } } } };
    transcriptResponse.mockResolvedValue({ messages: violation === 'multiple_rows' ? [row, row] : [row],
      hasMore: violation === 'continuation', nextBeforeSeq: violation === 'continuation' ? 3 : null, nextAfterSeq: null });
    await expect(getSessionTranscript({ credentials, idOrPrefix: sessionId, messageId: 'exact' }))
      .rejects.toMatchObject({ code: 'session_transcript_stored_content_unavailable' });
    expect(transcriptRequests()).toHaveLength(1);
  });

  it.each([{ cursor: null }, { direction: 'before' as const }, { limit: 1 }, { projection: 'externalShareableV1' as const }])(
    'rejects exact selection combined with incompatible input %j before HTTP', async incompatible => {
      const { getSessionTranscript } = await import('./getSessionTranscript');
      expect(await getSessionTranscript({ credentials, idOrPrefix: sessionId, messageId: 'exact', ...incompatible }))
        .toMatchObject({ ok: false, errorCode: 'invalid_input' });
      expect(get).not.toHaveBeenCalled();
    });

  it('routes the closed external projection through publication rows and exact completed turn anchors', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const admittedUser = {
      id: 'm1', seq: 1, localId: 'local-1', sidechainId: null, messageRole: 'user', createdAt: 1,
      externalShareableActor: 'machine',
      content: { t: 'plain', v: {
        role: 'user', content: { type: 'text', text: 'hello' },
        meta: { happierInputAuthorityV1: {
          v: 1, producer: 'pluginSession',
          caller: { kind: 'plugin', pluginId: 'com.example.channel', contributionLocalId: 'channel' },
          sourceAuthority: {
            mediatorPluginId: 'com.example.channel', sourceRef: 'thread-1', sourceRevisionOrEpoch: '2', remoteApprovalMaxScope: 'off',
          },
          permission: { admittedPermissionCeiling: 'read-only' },
        } },
      } },
    };
    transcriptResponse.mockResolvedValueOnce({
      messages: [
        admittedUser,
        { id: 'm3', seq: 3, localId: 'local-3', sidechainId: null, messageRole: 'agent', createdAt: 3,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'final' } } } },
      ],
      hasMore: false, nextBeforeSeq: null, nextAfterSeq: null, publicationBlocked: false,
      externalShareableSnapshot: {
        turns: [{
          turnId: 'turn-1', status: 'completed', startedAt: 1, updatedAt: 3,
          transcriptAnchors: { userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 3, finalAssistantMessageSeq: 3 },
        }],
      },
    });

    const result = await getSessionTranscript({
      credentials,
      idOrPrefix: sessionId,
      projection: 'externalShareableV1',
      callerPluginId: 'com.example.channel',
      cursor: '0',
    });

    expect(result).toMatchObject({
      ok: true,
      projection: 'externalShareableV1',
      scannedThroughSeq: 3,
      items: [
        { kind: 'userText', seq: 1 },
        { kind: 'assistantText', seq: 3, final: 'completed' },
      ],
    });
    const pageRequest = new URL(String(transcriptRequests()[0]?.[0]));
    expect(Object.fromEntries(pageRequest.searchParams)).toMatchObject({ projection: 'externalShareableV1', afterSeq: '0', limit: '100' });
    expect(get.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/turns'))).toBe(false);
  });

  it('uses same-snapshot referenced user rows for an out-of-page final without a second transcript read', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const admittedUser = {
      id: 'm1', seq: 1, localId: 'local-1', messageRole: 'user', createdAt: 1, updatedAt: 1,
      externalShareableActor: 'machine',
      content: { t: 'plain', v: {
        role: 'user', content: { type: 'text', text: 'hello' },
        meta: { happierInputAuthorityV1: {
          v: 1, producer: 'pluginSession',
          caller: { kind: 'plugin', pluginId: 'com.example.channel', contributionLocalId: 'channel' },
          permission: { admittedPermissionCeiling: 'read-only' },
        } },
      } },
    };
    transcriptResponse.mockResolvedValueOnce({
      messages: [
        { id: 'm101', seq: 101, localId: 'local-101', sidechainId: null, messageRole: 'agent', createdAt: 101,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'draft' } } } },
        { id: 'm102', seq: 102, localId: 'local-102', sidechainId: null, messageRole: 'agent', createdAt: 102,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'final' } } } },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
      publicationBlocked: false,
      externalShareableSnapshot: ExternalShareableTranscriptSnapshotV1Schema.parse({
        turns: [{
          turnId: 'turn-1', status: 'completed', startedAt: 1, updatedAt: 102,
          transcriptAnchors: {
            userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 102, finalAssistantMessageSeq: 102,
          },
        }],
        referencedUserRows: [admittedUser],
      }),
    });

    const result = await getSessionTranscript({
      credentials,
      idOrPrefix: sessionId,
      projection: 'externalShareableV1',
      callerPluginId: 'com.example.channel',
      cursor: '100',
    });

    expect(result).toMatchObject({
      ok: true,
      projection: 'externalShareableV1',
      scannedThroughSeq: 102,
      hasMore: false,
    });
    if (!result.ok) throw new Error('expected external shareable transcript');
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: 'assistantText',
        seq: 102,
        consumedInputs: [expect.objectContaining({ localId: 'local-1' })],
      }),
    ]);
    expect(transcriptRequests()).toHaveLength(1);
  });

  it('holds the cursor at a publication-blocked completed turn until the same snapshot exposes it', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    transcriptResponse.mockResolvedValueOnce({
      messages: [{
        id: 'm7', seq: 7, localId: 'local-7', sidechainId: null, messageRole: 'user', createdAt: 7,
        externalShareableActor: 'machine',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'pending' } } },
      }],
      hasMore: true,
      nextBeforeSeq: null,
      nextAfterSeq: null,
      publicationBlocked: true,
      externalShareableSnapshot: { turns: [], publicationBlockedFromSeq: 7 },
    });

    const result = await getSessionTranscript({
      credentials,
      idOrPrefix: sessionId,
      projection: 'externalShareableV1',
      cursor: '0',
    });

    expect(result).toMatchObject({
      ok: true,
      projection: 'externalShareableV1',
      items: [],
      scannedThroughSeq: 0,
      hasMore: true,
    });
    expect(get.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/turns'))).toBe(false);
  });

  it('holds the cursor at the same-transaction turn-settlement barrier without reconstructing active state', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    transcriptResponse.mockResolvedValueOnce({
      messages: [{
        id: 'm7', seq: 7, localId: 'local-7', sidechainId: null, messageRole: 'user', createdAt: 7,
        externalShareableActor: 'machine',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'pending' } } },
      }],
      hasMore: true,
      nextBeforeSeq: null,
      nextAfterSeq: null,
      publicationBlocked: false,
      externalShareableSnapshot: { turns: [], turnSettlementBlockedFromSeq: 7 },
    });

    const result = await getSessionTranscript({
      credentials,
      idOrPrefix: sessionId,
      projection: 'externalShareableV1',
      cursor: '0',
    });

    expect(result).toMatchObject({
      ok: true,
      projection: 'externalShareableV1',
      items: [],
      scannedThroughSeq: 0,
      hasMore: true,
    });
  });

  it('fails closed when an old server successfully returns rows without the required external snapshot', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    transcriptResponse.mockResolvedValueOnce({
      messages: [{
        id: 'm1', seq: 1, localId: 'local-1', sidechainId: null, messageRole: 'user', createdAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'old server row' } } },
      }],
      hasMore: true,
      nextBeforeSeq: null,
      nextAfterSeq: 1,
      publicationBlocked: false,
    });

    const result = await getSessionTranscript({
      credentials,
      idOrPrefix: sessionId,
      projection: 'externalShareableV1',
      cursor: '0',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'external_shareable_snapshot_unavailable',
      errorMessage: 'external_shareable_snapshot_unavailable',
    });
    expect(transcriptRequests()).toHaveLength(1);
    expect(get.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/turns'))).toBe(false);
  });

  it('stops after the authoritative page returns when cancellation wins before local projection', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const cancellation = new AbortController();
    transcriptResponse.mockImplementationOnce(async () => {
      const readSignal = transcriptRequests().at(-1)?.[1]?.signal;
      expect(readSignal?.aborted).toBe(false);
      cancellation.abort();
      expect(readSignal?.aborted).toBe(true);
      return {
        messages: [],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
        publicationBlocked: false,
        externalShareableSnapshot: { turns: [] },
      };
    });

    await expect(getSessionTranscript({
      credentials,
      idOrPrefix: sessionId,
      projection: 'externalShareableV1',
      signal: cancellation.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(new URL(String(transcriptRequests()[0]?.[0])).searchParams.get('projection')).toBe('externalShareableV1');
  });

  it('does not truncate semantic transcript message text by default', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const longText = 'x'.repeat(5001);
    transcriptResponse.mockResolvedValueOnce({
      messages: [
        {
          id: '1', seq: 1,
          createdAt: 10,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: longText } } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const result = await getSessionTranscript({ credentials, idOrPrefix: sessionId });

    expect(result).toMatchObject({
      ok: true,
      items: [
        { id: '1', role: 'user', kind: 'user_message', text: longText },
      ],
    });
    if (!result.ok) throw new Error('expected transcript result');
    expect(result.items[0]?.truncated).toBeUndefined();
  });

  it('truncates semantic transcript message text when a numeric truncation budget is supplied', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    transcriptResponse.mockResolvedValueOnce({
      messages: [
        {
          id: '1', seq: 1,
          createdAt: 10,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'abcdef' } } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const result = await getSessionTranscript({ credentials, idOrPrefix: sessionId, maxCharsPerMessage: 3 });

    expect(result).toMatchObject({
      ok: true,
      items: [
        { id: '1', role: 'user', kind: 'user_message', text: 'abc', truncated: true },
      ],
    });
  });

  it('does not stored-role prefilter when optional event-like transcript items are requested', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    transcriptResponse.mockResolvedValueOnce({
      messages: [
        {
          id: '3', seq: 3,
          createdAt: 30,
          messageRole: 'event',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'codex',
                data: { type: 'tool-call', callId: 'call-1', name: 'Bash', input: { command: 'pwd' } },
              },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const result = await getSessionTranscript({
      credentials,
      idOrPrefix: sessionId,
      includeTools: true,
    });

    expect(result).toMatchObject({
      ok: true,
      items: [
        {
          id: '3',
          role: 'tool',
          kind: 'tool_call',
          toolName: 'Bash',
        },
      ],
    });
    expect(new URL(String(transcriptRequests()[0]?.[0])).searchParams.has('roles')).toBe(false);
  });

  it('keeps raw transcript page batches large enough for small semantic history requests', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    transcriptResponse.mockResolvedValueOnce({
      messages: [
        {
          id: '1', seq: 1,
          createdAt: 10,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    await getSessionTranscript({
      credentials,
      idOrPrefix: sessionId,
      limit: 5,
      includeRaw: true,
      includeTools: true,
    });

    expect(new URL(String(transcriptRequests()[0]?.[0])).searchParams.get('limit')).toBe('20');
  });
});
