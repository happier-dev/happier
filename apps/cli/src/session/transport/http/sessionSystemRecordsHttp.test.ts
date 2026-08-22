import { afterEach, describe, expect, it, vi } from 'vitest';

import axios, { AxiosError } from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionControl.sessionSystemRecordsHttp', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

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
    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      'http://server.example.test/v2/sessions/sess%2F1/system-records',
      expect.objectContaining({
        params: { owner: 'plugin', namespace: 'acme.notes', limit: 25 },
        headers: expectedHeaders,
        signal,
      }),
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      'http://server.example.test/v2/sessions/sess%2F1/system-records/record',
      expect.objectContaining({ params: address, headers: expectedHeaders, signal }),
    );
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
