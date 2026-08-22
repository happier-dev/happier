import { afterEach, describe, expect, it, vi } from 'vitest';

import axios, { AxiosError } from 'axios';

import type {
  AccountEncryptionCurrentnessResponse,
  SessionSystemRecordAddress,
  SessionSystemRecordContent,
  SessionSystemRecordStored,
} from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { createPluginSessionSystemRecordsService } from './pluginSessionSystemRecordsService';

const sessionId = 'session-123456789';
const plainCredentials = {
  token: 'token-1',
  encryption: null,
} satisfies StoredCredentials;
const e2eeCredentials = {
  token: 'token-1',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
} satisfies StoredCredentials;
const plainCurrentness = {
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;
const e2eeCurrentness = {
  mode: 'e2ee' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;

function rawSession(mode: 'plain' | 'e2ee'): RawSessionRecord {
  return {
    id: sessionId,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 1,
    encryptionMode: mode,
    metadata: '{}',
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
  };
}

function storedRecord(
  address: SessionSystemRecordAddress,
  content: SessionSystemRecordContent,
): SessionSystemRecordStored {
  return {
    id: 'record-1',
    address,
    content,
    revision: 'ssr1.AAAAAWkAAAAB',
    createdAt: '2026-05-19T00:00:00.000Z',
    updatedAt: '2026-05-19T00:00:01.000Z',
  };
}

function installNetworkBoundary(params: Readonly<{
  mode: 'plain' | 'e2ee';
  onPut: (request: Readonly<{
    address: SessionSystemRecordAddress;
    content: SessionSystemRecordContent;
  }>) => SessionSystemRecordStored;
  putResponse?: Readonly<{ status: number; data: unknown }>;
}>) {
  process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    features: {},
    capabilities: { session: { systemRecords: { protocolVersions: [1] } } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  const getSpy = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.endsWith(`/v2/sessions/${sessionId}`)) {
      return { status: 200, data: { session: rawSession(params.mode) } } as never;
    }
    if (url.endsWith('/v1/account/encryption/currentness')) {
      return {
        status: 200,
        data: params.mode === 'plain' ? plainCurrentness : e2eeCurrentness,
      } as never;
    }
    throw new Error(`Unexpected GET ${url}`);
  });
  const putSpy = vi.spyOn(axios, 'put').mockImplementation(async (_url, request) => (
    params.putResponse ?? {
      status: 200,
      data: {
        record: params.onPut(request as Readonly<{
          address: SessionSystemRecordAddress;
          content: SessionSystemRecordContent;
        }>),
      },
    }
  ) as never);
  return { getSpy, putSpy };
}

function createService(credentials: StoredCredentials) {
  return createPluginSessionSystemRecordsService({
    credentials,
    pluginId: 'acme.notes',
    sessionId,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
}

describe('pluginSessionSystemRecordsService', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects malformed known host content before it can be sealed or sent in a plain Session', async () => {
    const { putSpy } = installNetworkBoundary({
      mode: 'plain',
      onPut: (request) => storedRecord(request.address, request.content),
    });
    const service = createService(plainCredentials);

    await expect(service.upsertSystemRecord({
      address: {
        owner: 'host',
        namespace: 'activity',
        kind: 'workflow_run.v1',
        localId: 'activity:workflow_run:v1:record-1',
      },
      content: {},
    })).rejects.toMatchObject({ code: 'plugin_session_record_invalid_request' });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed known host content before it can be sealed or sent in an E2EE Session', async () => {
    const { putSpy } = installNetworkBoundary({
      mode: 'e2ee',
      onPut: (request) => storedRecord(request.address, request.content),
    });
    const service = createService(e2eeCredentials);

    await expect(service.upsertSystemRecord({
      address: {
        owner: 'host',
        namespace: 'activity',
        kind: 'workflow_run.v1',
        localId: 'activity:workflow_run:v1:record-1',
      },
      content: {},
    })).rejects.toMatchObject({ code: 'plugin_session_record_invalid_request' });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed opened host content from plain and E2EE record responses', async () => {
    const plainNetwork = installNetworkBoundary({
      mode: 'plain',
      onPut: (request) => storedRecord(request.address, { t: 'plain', v: {} }),
    });
    const plainService = createService(plainCredentials);
    const address = {
      owner: 'host' as const,
      namespace: 'memory' as const,
      kind: 'synopsis.v1' as const,
      localId: 'memory:synopsis:v1:record-1',
    };
    const validSynopsis = {
      v: 1,
      seqTo: 1,
      updatedAtMs: 1,
      synopsis: 'Valid request content.',
    };

    await expect(plainService.upsertSystemRecord({ address, content: validSynopsis })).rejects.toMatchObject({
      code: 'plugin_session_record_invalid_response',
    });
    expect(plainNetwork.putSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    const e2eeNetwork = installNetworkBoundary({
      mode: 'e2ee',
      onPut: (request) => storedRecord(request.address, {
        t: 'encrypted',
        c: encryptSessionPayload({
          ctx: { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' },
          payload: {},
        }),
      }),
    });
    const e2eeService = createService(e2eeCredentials);

    await expect(e2eeService.upsertSystemRecord({ address, content: validSynopsis })).rejects.toMatchObject({
      code: 'plugin_session_record_invalid_response',
    });
    expect(e2eeNetwork.putSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps valid catalog-owned host content and generic plugin content compatible', async () => {
    const { putSpy } = installNetworkBoundary({
      mode: 'plain',
      onPut: (request) => storedRecord(request.address, request.content),
    });
    const service = createService(plainCredentials);
    const hostAddress = {
      owner: 'host' as const,
      namespace: 'memory' as const,
      kind: 'synopsis.v1' as const,
      localId: 'memory:synopsis:v1:record-1',
    };
    const hostContent = {
      v: 1,
      seqTo: 1,
      updatedAtMs: 1,
      synopsis: 'Valid catalog-owned content.',
    };
    const pluginAddress = {
      owner: 'plugin' as const,
      namespace: 'acme.notes',
      kind: 'memo',
      localId: 'today',
    };
    const pluginContent = { arbitrary: ['strict', 'json', 1] };

    await expect(service.upsertSystemRecord({ address: hostAddress, content: hostContent })).resolves.toMatchObject({
      address: hostAddress,
      content: hostContent,
    });
    await expect(service.upsertSystemRecord({ address: pluginAddress, content: pluginContent })).resolves.toMatchObject({
      address: pluginAddress,
      content: pluginContent,
    });
    expect(putSpy).toHaveBeenCalledTimes(2);
  });

  it('settles a lost E2EE mutation acknowledgement through the public service with the exact sealed request', async () => {
    const { putSpy } = installNetworkBoundary({
      mode: 'e2ee',
      onPut: (request) => storedRecord(request.address, request.content),
    });
    putSpy.mockRejectedValueOnce(new AxiosError('response lost after commit', 'ECONNRESET'));
    const service = createService(e2eeCredentials);
    const request = {
      address: {
        owner: 'plugin' as const,
        namespace: 'acme.notes',
        kind: 'memo',
        localId: 'today',
      },
      content: { note: 'seal this exactly once' },
    };

    await expect(service.upsertSystemRecord(request)).resolves.toMatchObject({
      address: request.address,
      content: request.content,
    });
    expect(putSpy).toHaveBeenCalledTimes(2);
    const firstRequest = putSpy.mock.calls[0]?.[1];
    const replayRequest = putSpy.mock.calls[1]?.[1];
    expect(replayRequest).toBe(firstRequest);
    expect(firstRequest).toMatchObject({
      content: expect.objectContaining({ t: 'encrypted' }),
    });
  });

  it('returns non-retryable outcome-unknown rather than unavailable after the public mutation replay also loses acknowledgement', async () => {
    const { putSpy } = installNetworkBoundary({
      mode: 'plain',
      onPut: (request) => storedRecord(request.address, request.content),
    });
    putSpy
      .mockRejectedValueOnce(new AxiosError('response lost after commit', 'ECONNRESET'))
      .mockRejectedValueOnce(new AxiosError('response lost after replay', 'ECONNRESET'));
    const service = createService(plainCredentials);

    await expect(service.upsertSystemRecord({
      address: {
        owner: 'plugin',
        namespace: 'acme.notes',
        kind: 'memo',
        localId: 'today',
      },
      content: { note: 'do not report unavailable after ambiguous settlement' },
    })).rejects.toMatchObject({
      code: 'plugin_session_record_outcome_unknown',
      retryable: false,
    });
    expect(putSpy).toHaveBeenCalledTimes(2);
  });

  it('does not replay a received 5xx mutation status and maps it to retryable unavailable', async () => {
    const { putSpy } = installNetworkBoundary({
      mode: 'plain',
      onPut: (request) => storedRecord(request.address, request.content),
      putResponse: {
        status: 503,
        data: { code: 'plugin_session_record_transport_error' },
      },
    });
    const service = createService(plainCredentials);

    await expect(service.upsertSystemRecord({
      address: {
        owner: 'plugin',
        namespace: 'acme.notes',
        kind: 'memo',
        localId: 'today',
      },
      content: { note: 'a server status is not a lost acknowledgement' },
    })).rejects.toMatchObject({
      code: 'plugin_session_records_unavailable',
      retryable: true,
    });
    expect(putSpy).toHaveBeenCalledTimes(1);
  });
});
