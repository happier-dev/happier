import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchEncryptedTranscriptMessagesPage, fetchSessionTurnsProjection, resolveSessionTransportContext } = vi.hoisted(() => ({
  fetchEncryptedTranscriptMessagesPage: vi.fn(),
  fetchSessionTurnsProjection: vi.fn(),
  resolveSessionTransportContext: vi.fn(),
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
  fetchEncryptedTranscriptMessagesPage,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionTurnsProjection,
}));

vi.mock('./resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

const credentials = { token: 'token', encryption: null } as const;

describe('getSessionTranscript', () => {
  beforeEach(() => {
    fetchEncryptedTranscriptMessagesPage.mockReset();
    fetchSessionTurnsProjection.mockReset();
    resolveSessionTransportContext.mockReset();
  });

  it('routes the closed external projection through publication rows and exact completed turn anchors', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true, sessionId: 'sess-1', rawSession: { id: 'sess-1' }, mode: 'plain', ctx: null,
    });
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
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
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
      idOrPrefix: 'sess-1',
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
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.objectContaining({
      projection: 'externalShareableV1',
      afterSeq: 0,
      limit: 100,
    }));
    expect(fetchSessionTurnsProjection).not.toHaveBeenCalled();
  });

  it('uses same-snapshot referenced user rows for an out-of-page final without a second transcript read', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true, sessionId: 'sess-1', rawSession: { id: 'sess-1' }, mode: 'plain', ctx: null,
    });
    const admittedUser = {
      id: 'm1', seq: 1, localId: 'local-1', sidechainId: null, messageRole: 'user', createdAt: 1,
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
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
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
      externalShareableSnapshot: {
        turns: [{
          turnId: 'turn-1', status: 'completed', startedAt: 1, updatedAt: 102,
          transcriptAnchors: {
            userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 102, finalAssistantMessageSeq: 102,
          },
        }],
        referencedUserRows: [admittedUser],
      },
    });

    const result = await getSessionTranscript({
      credentials,
      idOrPrefix: 'sess-1',
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
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledTimes(1);
  });

  it('holds the cursor at a publication-blocked completed turn until the same snapshot exposes it', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true, sessionId: 'sess-1', rawSession: { id: 'sess-1' }, mode: 'plain', ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
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
      idOrPrefix: 'sess-1',
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
    expect(fetchSessionTurnsProjection).not.toHaveBeenCalled();
  });

  it('holds the cursor at the same-transaction turn-settlement barrier without reconstructing active state', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true, sessionId: 'sess-1', rawSession: { id: 'sess-1' }, mode: 'plain', ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
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
      idOrPrefix: 'sess-1',
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
    resolveSessionTransportContext.mockResolvedValue({
      ok: true, sessionId: 'sess-1', rawSession: { id: 'sess-1' }, mode: 'plain', ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
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
      idOrPrefix: 'sess-1',
      projection: 'externalShareableV1',
      cursor: '0',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'external_shareable_snapshot_unavailable',
      errorMessage: 'external_shareable_snapshot_unavailable',
    });
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledTimes(1);
    expect(fetchSessionTurnsProjection).not.toHaveBeenCalled();
  });

  it('passes external transcript read cancellation through the raw page reader', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const cancellation = new AbortController();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true, sessionId: 'sess-1', rawSession: { id: 'sess-1' }, mode: 'plain', ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
      publicationBlocked: false,
      externalShareableSnapshot: { turns: [] },
    });
    const request: Parameters<typeof getSessionTranscript>[0] & Readonly<{ signal: AbortSignal }> = {
      credentials,
      idOrPrefix: 'sess-1',
      projection: 'externalShareableV1',
      signal: cancellation.signal,
    };

    await getSessionTranscript(request);

    expect(resolveSessionTransportContext).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess-1',
      signal: cancellation.signal,
    });
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.objectContaining({
      projection: 'externalShareableV1',
      signal: cancellation.signal,
    }));
  });

  it('stops after the authoritative page returns when cancellation wins before local projection', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const cancellation = new AbortController();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true, sessionId: 'sess-1', rawSession: { id: 'sess-1' }, mode: 'plain', ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockImplementationOnce(async () => {
      cancellation.abort();
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
      idOrPrefix: 'sess-1',
      projection: 'externalShareableV1',
      signal: cancellation.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not truncate semantic transcript message text by default', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    const longText = 'x'.repeat(5001);
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 1,
          createdAt: 10,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: longText } } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const result = await getSessionTranscript({ credentials, idOrPrefix: 'sess-1' });

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
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 1,
          createdAt: 10,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'abcdef' } } },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const result = await getSessionTranscript({ credentials, idOrPrefix: 'sess-1', maxCharsPerMessage: 3 });

    expect(result).toMatchObject({
      ok: true,
      items: [
        { id: '1', role: 'user', kind: 'user_message', text: 'abc', truncated: true },
      ],
    });
  });

  it('does not stored-role prefilter when optional event-like transcript items are requested', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 3,
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
      idOrPrefix: 'sess-1',
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
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.not.objectContaining({
      roles: expect.anything(),
    }));
  });

  it('keeps raw transcript page batches large enough for small semantic history requests', async () => {
    const { getSessionTranscript } = await import('./getSessionTranscript');
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1' },
      mode: 'plain',
      ctx: null,
    });
    fetchEncryptedTranscriptMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          seq: 1,
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
      idOrPrefix: 'sess-1',
      limit: 5,
      includeRaw: true,
      includeTools: true,
    });

    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.objectContaining({
      limit: 20,
    }));
  });
});
