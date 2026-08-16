import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCodexAgentRuntimeDescriptorV1 } from '@happier-dev/protocol';

const fetchSessionByIdMock = vi.fn();
const tryDecryptSessionMetadataMock = vi.fn();

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (...args: unknown[]) => tryDecryptSessionMetadataMock(...args),
}));

import { loadLinkedDirectSession } from './loadLinkedDirectSession';

describe('loadLinkedDirectSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-links a converted session from its external history import record', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_converted' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/home/kunde21',
      tag: 'direct:v1:a94278a6cd532c1f472c99c66d7c6ade3ef4a38565ebded7bcfc1d76b6948841',
      // takeover.persist deletes directSessionV1 after import and records the provenance instead.
      externalHistoryImportV1: {
        v: 1,
        providerId: 'pi',
        remoteSessionId: '01a00481-8cdc-78ff-a4aa-9b243badd9fb',
        importedAtMs: 123,
        source: { kind: 'piAgentDir', agentDir: '/home/kunde21/.pi/agent' },
      },
    });

    const result = await loadLinkedDirectSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_converted',
      machineId: 'machine_1',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        providerId: 'pi',
        machineId: 'machine_1',
        remoteSessionId: '01a00481-8cdc-78ff-a4aa-9b243badd9fb',
        source: { kind: 'piAgentDir', agentDir: '/home/kunde21/.pi/agent' },
      }),
    });
  });

  it('still rejects a converted session when no machine scope can back the relink', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_converted_no_machine' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      externalHistoryImportV1: {
        v: 1,
        providerId: 'pi',
        remoteSessionId: '01a00481-8cdc-78ff-a4aa-9b243badd9fb',
        importedAtMs: 123,
        source: { kind: 'piAgentDir', agentDir: '/home/kunde21/.pi/agent' },
      },
    });

    const result = await loadLinkedDirectSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_converted_no_machine',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'session_is_not_direct',
    });
  });

  it('prefers the nested OpenCode runtime descriptor over stale legacy metadata', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_1' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'legacy-session',
      opencodeBackendMode: 'acp',
      directSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-session',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
        linkedAtMs: 1,
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'runtime-session',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 'runtime-session',
                serverBaseUrl: 'http://127.0.0.1:4096/',
                serverBaseUrlExplicit: true,
              },
            },
          },
        },
      },
    });

    const result = await loadLinkedDirectSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_1',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        providerId: 'opencode',
        remoteSessionId: 'runtime-session',
      }),
    });
  });

  it('preserves connected-service group identity from the canonical Codex runtime descriptor', async () => {
    const homePath = '/tmp/happier/daemon/connected-services/materialized/csm_session_1/codex/codex-home';
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_codex_group' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-thread',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          connectedServiceGroupId: 'happier',
          homePath,
        },
        linkedAtMs: 1,
        agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
          backendMode: 'appServer',
          vendorSessionId: 'runtime-thread',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          connectedServiceGroupId: 'happier',
          homePath,
        }),
      },
    });

    const result = await loadLinkedDirectSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_codex_group',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        providerId: 'codex',
        remoteSessionId: 'runtime-thread',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          connectedServiceGroupId: 'happier',
          homePath,
        },
      }),
    });
  });
});
