import { afterEach, describe, expect, it, vi } from 'vitest';

import axios, { AxiosError } from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionSystemRecordsHttp', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  it.each(['read', 'list', 'upsert'] as const)('opens retained V1 rows on %s without relaxing the response envelope', async (operation) => {
    const { readSessionSystemRecordV1, listSessionSystemRecordsV1, upsertSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    const address = { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' } as const;
    const canonical = { id: 'row', address, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      content: { t: 'plain', v: { arbitraryPluginData: { retained: true } } },
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' };
    const record = { ...canonical, content: { ...canonical.content, retiredField: true } };
    const body = operation === 'list' ? { records: [record], nextCursor: null, hasNext: false } : { record };
    const invalidRecord = { ...canonical, retiredRoutingField: true };
    vi.spyOn(axios, operation === 'upsert' ? 'put' : 'get')
      .mockResolvedValueOnce({ status: 200, data: body })
      .mockResolvedValueOnce({ status: 200, data: operation === 'list'
        ? { records: [invalidRecord], nextCursor: null, hasNext: false } : { record: invalidRecord } })
      .mockResolvedValueOnce({ status: 200, data: { ...body, retiredEnvelopeField: true } });
    const open = async () => operation === 'read'
      ? readSessionSystemRecordV1({ token: 'token', sessionId: 'session', address })
      : operation === 'list'
        ? (await listSessionSystemRecordsV1({ token: 'token', sessionId: 'session', query: { ...address, limit: 10 } })).records[0]
        : upsertSessionSystemRecordV1({ token: 'token', sessionId: 'session', request: {
          address, content: { t: 'plain', v: canonical.content.v }, expectedRevision: null,
        } });
    await expect(open()).resolves.toEqual(canonical);
    await expect(open()).rejects.toMatchObject({ code: 'plugin_session_record_invalid_response' });
    await expect(open()).rejects.toMatchObject({ code: 'plugin_session_record_invalid_response' });
  });

  it('reads host V1 records at a captured Home without fabricating plugin authority', async () => {
    const { readSessionSystemRecordV1, listSessionSystemRecordsV1 } = await import('./sessionSystemRecordsHttp');
    const get = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 200, data: { record: null } })
      .mockResolvedValueOnce({ status: 200, data: { records: [], nextCursor: null, hasNext: false } });
    await readSessionSystemRecordV1({ token: 'token', serverUrl: 'https://captured.example', sessionId: 'session/one',
      address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' } });
    await listSessionSystemRecordsV1({ token: 'token', serverUrl: 'https://captured.example', sessionId: 'session/one',
      query: { owner: 'host', namespace: 'surface', kind: 'item.v1', limit: 10 } });
    for (const [url, config] of get.mock.calls) {
      expect(url).toMatch(/^https:\/\/captured.example\/v2\/sessions\/session%2Fone\/system-records/);
      expect(config?.headers).toMatchObject({ 'x-happier-session-system-records-protocol': '1' });
      expect(config?.headers).not.toHaveProperty('x-happier-plugin-id');
    }
  });

  it('keeps the producer\'s typed record refusal instead of inferring it from the HTTP status', async () => {
    const { readSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    const address = { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' } as const;
    vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 403, data: { error: 'Forbidden', code: 'plugin_session_record_forbidden' } })
      .mockResolvedValueOnce({ status: 404, data: { error: 'Not found', code: 'plugin_session_record_feature_disabled' } })
      .mockResolvedValueOnce({ status: 401, data: { error: 'Unauthorized' } });
    // A definite authorization denial must not read as "you are not signed in".
    await expect(readSessionSystemRecordV1({ token: 'token', sessionId: 'session', address }))
      .rejects.toMatchObject({ code: 'plugin_session_record_forbidden' });
    await expect(readSessionSystemRecordV1({ token: 'token', sessionId: 'session', address }))
      .rejects.toMatchObject({ code: 'plugin_session_record_feature_disabled' });
    // An untyped authentication failure keeps the authentication disposition.
    await expect(readSessionSystemRecordV1({ token: 'token', sessionId: 'session', address }))
      .rejects.toMatchObject({ code: 'not_authenticated' });
  });

  it('rejects V1 records outside the requested address before any consumer opens them', async () => {
    const { readSessionSystemRecordV1, listSessionSystemRecordsV1 } = await import('./sessionSystemRecordsHttp');
    const address = { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'wanted' } as const;
    const record = { id: 'row', address: { ...address, localId: 'other' }, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      content: { t: 'encrypted', c: 'opaque' }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' };
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { record } })
      .mockResolvedValueOnce({ status: 200, data: { records: [record], nextCursor: null, hasNext: false } });
    await expect(readSessionSystemRecordV1({ token: 'token', sessionId: 'session', address })).rejects.toMatchObject({ code: 'plugin_session_record_invalid_response' });
    await expect(listSessionSystemRecordsV1({ token: 'token', sessionId: 'session', query: { ...address, limit: 10 } })).rejects.toMatchObject({ code: 'plugin_session_record_invalid_response' });
  });

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('upserts a system record through the dedicated session system-record route', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { upsertSessionSystemRecord } = await import('./sessionSystemRecordsHttp');

    const putSpy = vi.spyOn(axios, 'put').mockResolvedValueOnce({
      status: 200,
      data: {
        record: {
          id: 'rec-1',
          sessionId: 'sess/1',
          namespace: 'memory',
          kind: 'summary_shard.v1',
          localId: 'memory:summary_shard:v1:1-2',
          content: {
            t: 'plain',
            v: {
              v: 1,
              seqFrom: 1,
              seqTo: 2,
              createdAtFromMs: 1,
              createdAtToMs: 2,
              summary: 'S',
              keywords: [],
              entities: [],
              decisions: [],
            },
          },
          createdAt: '2026-05-19T00:00:00.000Z',
          updatedAt: '2026-05-19T00:00:00.000Z',
        },
      },
    } as never);

    await expect(
      upsertSessionSystemRecord({
        token: 'token-1',
        sessionId: 'sess/1',
        namespace: 'memory',
        kind: 'summary_shard.v1',
        localId: 'memory:summary_shard:v1:1-2',
        content: {
          t: 'plain',
          v: {
            v: 1,
            seqFrom: 1,
            seqTo: 2,
            createdAtFromMs: 1,
            createdAtToMs: 2,
            summary: 'S',
            keywords: [],
            entities: [],
            decisions: [],
          },
        },
      }),
    ).resolves.toMatchObject({
      sessionId: 'sess/1',
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:1-2',
    });

    expect(putSpy).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/sess%2F1/system-records',
      expect.objectContaining({
        namespace: 'memory',
        kind: 'summary_shard.v1',
        localId: 'memory:summary_shard:v1:1-2',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
        }),
      }),
    );
    expect(putSpy.mock.calls[0]?.[2]?.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('fetches paginated, latest, and single memory system records with query params', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const {
      fetchLatestSessionSystemRecord,
      fetchSessionSystemRecord,
      fetchSessionSystemRecordsPage,
    } = await import('./sessionSystemRecordsHttp');

    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          records: [],
          nextCursor: 'cursor-2',
          hasNext: true,
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          record: {
            id: 'rec-latest',
            sessionId: 'sess-1',
            namespace: 'memory',
            kind: 'synopsis.v1',
            localId: 'memory:synopsis:v1:10',
            content: { t: 'plain', v: { v: 1, seqTo: 10, updatedAtMs: 99, synopsis: 'S' } },
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:01.000Z',
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { record: null },
      } as never);

    await expect(fetchSessionSystemRecordsPage({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:1-2',
      cursor: 'cursor-1',
      limit: 25,
    })).resolves.toMatchObject({ records: [], nextCursor: 'cursor-2', hasNext: true });

    await expect(fetchLatestSessionSystemRecord({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      kind: 'synopsis.v1',
    })).resolves.toMatchObject({ localId: 'memory:synopsis:v1:10' });

    await expect(fetchSessionSystemRecord({
      token: 'token-1',
      sessionId: 'sess-1',
      namespace: 'memory',
      localId: 'memory:synopsis:v1:missing',
    })).resolves.toBeNull();

    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      'http://server.example.test/v2/sessions/sess-1/system-records',
      expect.objectContaining({
        params: {
          namespace: 'memory',
          kind: 'summary_shard.v1',
          localId: 'memory:summary_shard:v1:1-2',
          cursor: 'cursor-1',
          limit: 25,
        },
      }),
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      'http://server.example.test/v2/sessions/sess-1/system-records/latest',
      expect.objectContaining({
        params: {
          namespace: 'memory',
          kind: 'synopsis.v1',
        },
      }),
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      3,
      'http://server.example.test/v2/sessions/sess-1/system-records/record',
      expect.objectContaining({
        params: {
          namespace: 'memory',
          localId: 'memory:synopsis:v1:missing',
        },
      }),
    );
  });

  it('uses the V1 plugin-record transport with the host-stamped identity and operation header', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const {
      deleteSessionSystemRecordV1,
      listSessionSystemRecordsV1,
      readSessionSystemRecordV1,
      upsertSessionSystemRecordV1,
    } = await import('./sessionSystemRecordsHttp');
    const address = {
      owner: 'plugin' as const,
      namespace: 'acme.notes',
      kind: 'memo',
      localId: 'today',
    };
    const storedRecord = {
      id: 'record-1',
      address,
      content: { t: 'plain' as const, v: { text: 'remember this' } },
      revision: 'ssr1.AAAAAWkAAAAB',
      createdAt: '2026-05-19T00:00:00.000Z',
      updatedAt: '2026-05-19T00:00:01.000Z',
    };
    const signal = new AbortController().signal;
    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: { records: [storedRecord], nextCursor: null, hasNext: false },
      } as never)
      .mockResolvedValueOnce({ status: 200, data: { record: storedRecord } } as never);
    const putSpy = vi.spyOn(axios, 'put').mockResolvedValueOnce({
      status: 200,
      data: { record: storedRecord },
    } as never);
    const deleteSpy = vi.spyOn(axios, 'delete').mockResolvedValueOnce({
      status: 200,
      data: { ok: true },
    } as never);

    await expect(listSessionSystemRecordsV1({
      token: 'token-1',
      sessionId: 'sess/1',
      pluginId: 'acme.notes',
      query: { owner: 'plugin', namespace: 'acme.notes', limit: 25 },
      signal,
    })).resolves.toEqual({ records: [storedRecord], nextCursor: null, hasNext: false });
    await expect(readSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess/1',
      pluginId: 'acme.notes',
      address,
      signal,
    })).resolves.toEqual(storedRecord);
    await expect(upsertSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess/1',
      pluginId: 'acme.notes',
      request: { address, content: storedRecord.content },
      signal,
    })).resolves.toEqual(storedRecord);
    await expect(deleteSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess/1',
      pluginId: 'acme.notes',
      request: { address },
      signal,
    })).resolves.toBeUndefined();

    const expectedHeaders = expect.objectContaining({
      Authorization: 'Bearer token-1',
      'x-happier-plugin-id': 'acme.notes',
      'x-happier-session-system-records-protocol': '1',
    });
    const listUrl = new URL(getSpy.mock.calls[0]![0]);
    expect(listUrl.pathname).toBe('/v2/sessions/sess%2F1/system-records');
    expect(Object.fromEntries(listUrl.searchParams)).toEqual({
      owner: 'plugin',
      namespace: 'acme.notes',
      limit: '25',
    });
    expect(getSpy.mock.calls[0]![1]).toEqual(expect.objectContaining({
      headers: expectedHeaders,
      signal,
    }));

    const readUrl = new URL(getSpy.mock.calls[1]![0]);
    expect(readUrl.pathname).toBe('/v2/sessions/sess%2F1/system-records/record');
    expect(Object.fromEntries(readUrl.searchParams)).toEqual({
      owner: 'plugin',
      namespace: 'acme.notes',
      kind: 'memo',
      localId: 'today',
    });
    expect(getSpy.mock.calls[1]![1]).toEqual(expect.objectContaining({
      headers: expectedHeaders,
      signal,
    }));
    expect(putSpy).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/sess%2F1/system-records',
      { address, content: storedRecord.content },
      expect.objectContaining({ headers: expectedHeaders, signal }),
    );
    expect(deleteSpy).toHaveBeenCalledWith(
      'http://server.example.test/v2/sessions/sess%2F1/system-records/record',
      expect.objectContaining({
        data: { address },
        headers: expectedHeaders,
        signal,
      }),
    );
    expect(putSpy.mock.calls[0]?.[2]?.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('uses ordinary Session authority for strict host requests even when called by a plugin', async () => {
    const { listSessionSystemRecordsV1, readSessionSystemRecordV1, upsertSessionSystemRecordV1, deleteSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    const address = { owner: 'host' as const, namespace: 'memory' as const, kind: 'synopsis.v1' as const, localId: 'current' };
    const record = {
      id: 'record-1', address, content: { t: 'plain' as const, v: { v: 1, seqTo: 10, updatedAtMs: 99, synopsis: 'S' } },
      revision: 'ssr1.AAAAAWkAAAAB', createdAt: '2026-05-19T00:00:00.000Z', updatedAt: '2026-05-19T00:00:00.000Z',
    };
    const get = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 200, data: { records: [record], nextCursor: null, hasNext: false } })
      .mockResolvedValueOnce({ status: 200, data: { record } });
    const put = vi.spyOn(axios, 'put').mockResolvedValueOnce({ status: 200, data: { record } });
    const remove = vi.spyOn(axios, 'delete').mockResolvedValueOnce({ status: 200, data: { ok: true } });
    const context = { token: 'token', sessionId: 'session', pluginId: 'acme.notes' };
    await expect(listSessionSystemRecordsV1({ ...context, query: { owner: 'host', namespace: 'memory', limit: 1 } })).resolves.toMatchObject({ records: [record] });
    await expect(readSessionSystemRecordV1({ token: context.token, sessionId: context.sessionId, address })).resolves.toEqual(record);
    await expect(upsertSessionSystemRecordV1({ ...context, request: { address, content: record.content } })).resolves.toEqual(record);
    await deleteSessionSystemRecordV1({ ...context, request: { address } });
    for (const headers of [get.mock.calls[0]?.[1]?.headers, get.mock.calls[1]?.[1]?.headers, put.mock.calls[0]?.[2]?.headers, remove.mock.calls[0]?.[1]?.headers]) {
      expect(headers).toMatchObject({ Authorization: 'Bearer token', 'x-happier-session-system-records-protocol': '1' });
      expect(headers).not.toHaveProperty('x-happier-plugin-id');
    }
  });

  it('rejects a plugin address without valid plugin identity before sending', async () => {
    const { readSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { record: null } });
    await expect(readSessionSystemRecordV1({
      token: 'token', sessionId: 'session', pluginId: '',
      address: { owner: 'plugin', namespace: 'notes', kind: 'entry.v1', localId: 'entry' },
    })).rejects.toMatchObject({ code: 'plugin_session_record_invalid_query' });
    expect(get).not.toHaveBeenCalled();
  });

  it('preserves a typed V1 conflict and its current revision', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { upsertSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    vi.spyOn(axios, 'put').mockResolvedValueOnce({
      status: 409,
      data: {
        error: 'Plugin Session system record operation failed',
        code: 'plugin_session_record_revision_conflict',
        currentRevision: 'ssr1.AAAAAWkAAAAB',
      },
    } as never);

    await expect(upsertSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess-1',
      pluginId: 'acme.notes',
      request: {
        address: {
          owner: 'plugin',
          namespace: 'acme.notes',
          kind: 'memo',
          localId: 'today',
        },
        content: { t: 'plain', v: { text: 'new value' } },
      },
    })).rejects.toMatchObject({
      code: 'plugin_session_record_revision_conflict',
      currentRevision: 'ssr1.AAAAAWkAAAAB',
      response: { status: 409 },
    });
  });

  it('retries one lost mutation acknowledgement with the exact sealed upsert and delete requests', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { deleteSessionSystemRecordV1, upsertSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    const address = {
      owner: 'plugin' as const,
      namespace: 'acme.notes',
      kind: 'memo',
      localId: 'today',
    };
    const upsertRequest = {
      address,
      content: { t: 'encrypted' as const, c: 'sealed-ciphertext-from-one-invocation' },
      expectedRevision: 'ssr1.AAAAAWkAAAAB',
    };
    const deleteRequest = { address, expectedRevision: 'ssr1.AAAAAWkAAAAB' };
    const storedRecord = {
      id: 'record-1',
      address,
      content: upsertRequest.content,
      revision: 'ssr1.AAAAAWkAAAAB',
      createdAt: '2026-05-19T00:00:00.000Z',
      updatedAt: '2026-05-19T00:00:01.000Z',
    };
    const putSpy = vi.spyOn(axios, 'put')
      .mockRejectedValueOnce(new AxiosError('response lost after commit', 'ECONNRESET'))
      .mockResolvedValueOnce({ status: 200, data: { record: storedRecord } } as never);
    const deleteSpy = vi.spyOn(axios, 'delete')
      .mockRejectedValueOnce(new AxiosError('response lost after commit', 'ECONNRESET'))
      .mockResolvedValueOnce({ status: 200, data: { ok: true } } as never);

    await expect(upsertSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess-1',
      pluginId: 'acme.notes',
      request: upsertRequest,
    })).resolves.toEqual(storedRecord);
    await expect(deleteSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess-1',
      pluginId: 'acme.notes',
      request: deleteRequest,
    })).resolves.toBeUndefined();

    expect(putSpy).toHaveBeenCalledTimes(2);
    expect(putSpy.mock.calls[0]?.[1]).toBe(upsertRequest);
    expect(putSpy.mock.calls[1]?.[1]).toBe(upsertRequest);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy.mock.calls[0]?.[1]?.data).toBe(deleteRequest);
    expect(deleteSpy.mock.calls[1]?.[1]?.data).toBe(deleteRequest);
  });

  it('reports a non-retryable outcome-unknown mutation result after the bounded exact replay also loses acknowledgement', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { upsertSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    const request = {
      address: {
        owner: 'plugin' as const,
        namespace: 'acme.notes',
        kind: 'memo',
        localId: 'today',
      },
      content: { t: 'encrypted' as const, c: 'same-sealed-ciphertext' },
    };
    const putSpy = vi.spyOn(axios, 'put')
      .mockRejectedValueOnce(new AxiosError('response lost after commit', 'ECONNRESET'))
      .mockRejectedValueOnce(new AxiosError('response lost after replay', 'ECONNRESET'));

    await expect(upsertSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess-1',
      pluginId: 'acme.notes',
      request,
    })).rejects.toMatchObject({
      code: 'plugin_session_record_outcome_unknown',
      retryable: false,
    });
    expect(putSpy).toHaveBeenCalledTimes(2);
    expect(putSpy.mock.calls[0]?.[1]).toBe(request);
    expect(putSpy.mock.calls[1]?.[1]).toBe(request);
  });

  it('does not replay a received 5xx mutation status', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { upsertSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    const putSpy = vi.spyOn(axios, 'put').mockResolvedValueOnce({
      status: 503,
      data: { code: 'plugin_session_record_transport_error' },
    } as never);

    await expect(upsertSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess-1',
      pluginId: 'acme.notes',
      request: {
        address: {
          owner: 'plugin',
          namespace: 'acme.notes',
          kind: 'memo',
          localId: 'today',
        },
        content: { t: 'plain', v: { note: 'received 5xx stays ordinary' } },
      },
    })).rejects.toMatchObject({
      code: 'plugin_session_record_transport_error',
      response: { status: 503 },
    });
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a cancelled mutation', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { upsertSessionSystemRecordV1 } = await import('./sessionSystemRecordsHttp');
    const controller = new AbortController();
    const putSpy = vi.spyOn(axios, 'put').mockImplementationOnce(async () => {
      controller.abort();
      throw new AxiosError('cancelled', 'ERR_CANCELED');
    });

    await expect(upsertSessionSystemRecordV1({
      token: 'token-1',
      sessionId: 'sess-1',
      pluginId: 'acme.notes',
      request: {
        address: {
          owner: 'plugin',
          namespace: 'acme.notes',
          kind: 'memo',
          localId: 'today',
        },
        content: { t: 'plain', v: { note: 'do not retry after cancellation' } },
      },
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

});
