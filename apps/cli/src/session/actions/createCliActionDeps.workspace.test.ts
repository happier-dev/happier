import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealSessionOwnerMetadataEnvelopeV1, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createCliActionInventoryDeps } from './cliActionDeps/createCliActionInventoryDeps';

afterEach(() => vi.restoreAllMocks());

describe('headless Session-open workspace targeting', () => {
  it('does not reinterpret another encrypted Session as plain for a Session bearer inventory', async () => {
    const targetSessionId = 'c123456789012345678901234';
    const rawSession = createSessionRecordFixture({ id: targetSessionId, encryptionMode: 'e2ee', dataEncryptionKey: null,
      metadata: JSON.stringify({ sessionModesV1: { provider: 'codex', availableModes: [{ id: 'private-mode' }] } }),
    });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: rawSession } });
    const deps = createCliActionInventoryDeps({ token: 'session-bearer', sessionId: 'source-session', mode: 'plain', ctx: null });
    await expect(deps.sessionModesList!({ sessionId: targetSessionId })).resolves.toEqual({ sessionId: targetSessionId, items: [] });
  });

  it.each(['plain', 'e2ee', 'missing', 'mismatched'] as const)('projects the owner workspace into Action inventories (%s)', async (scenario) => {
    const sessionId = 'c123456789012345678901234';
    const machineKey = new Uint8Array(32).fill(11);
    const credentials: StoredCredentials = scenario === 'e2ee'
      ? { token: 'inventory-token', encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(12), machineKey } }
      : { token: 'inventory-token', encryption: null };
    const mode = scenario === 'e2ee' || scenario === 'mismatched' ? 'e2ee' : 'plain';
    const ownerMetadata = { v: 1 as const, workspace: { path: '/owner/workspace', machineId: 'owner-machine' } };
    const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1,
      share: null, metadata: JSON.stringify({ v: 1 }), ownerMetadata: scenario === 'missing' ? undefined : scenario === 'e2ee'
        ? sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata, material: { type: 'dataKey', machineKey },
          randomBytes: (length) => new Uint8Array(length).fill(13) }) : { t: 'plain', v: ownerMetadata },
    });
    const sessionResponse = V2SessionByIdResponseSchema.parse({ session: rawSession });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const href = String(url);
      const data = href.endsWith('/v1/account/encryption/currentness')
        ? { mode, version: 1, signingKeyFingerprint: mode === 'e2ee' ? 'a'.repeat(64) : null,
            contentKeyFingerprint: mode === 'e2ee' ? 'b'.repeat(64) : null, updatedAt: 1 }
        : href.includes(`/sessions/${sessionId}`) ? sessionResponse : null;
      if (!data) throw new Error(`Unexpected test HTTP request ${href}`);
      return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const { deps } = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId, rawSession,
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test', mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
    });
    expect(await deps.pathsListRecent!({})).toEqual({ items: scenario === 'plain' || scenario === 'e2ee'
      ? [{ id: '/owner/workspace', value: '/owner/workspace', path: '/owner/workspace', label: '/owner/workspace',
          machineId: 'owner-machine', current: true }] : [] });
  });

  it('preserves ordinary Session open but refuses a UI tab instead of claiming that tab was opened', async () => {
    const sessionId = 'c123456789012345678901234';
    const sessionResponse = V2SessionByIdResponseSchema.parse({ session: {
      id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryptionMode: 'plain', metadata: '{}', metadataVersion: 1, dataEncryptionKey: null,
      agentState: '{}', agentStateVersion: 1,
    } });
    // HTTP is the genuine boundary; ID resolution, codecs and Session-open admission remain real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const href = String(url);
      const data = href.endsWith('/v1/account/encryption/currentness')
        ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
        : href.includes(`/sessions/${sessionId}`) ? sessionResponse : null;
      if (!data) throw new Error(`Unexpected test HTTP request ${href}`);
      return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const { executor } = createCliActionExecutorHarness({
      token: 'workspace-test-token', credentials: { token: 'workspace-test-token', encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test', sessionId,
      mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
    });
    await expect(executor.execute('session.open', { sessionId, serverId: 'home-a' }, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: true, result: { status: 'opened' } });
    await expect(executor.execute('session.open', { sessionId, serverId: 'home-a', tabId: 'ui-tab' }, { surface: 'cli' })).resolves.toMatchObject({
      ok: false, errorCode: 'unsupported_action',
    });
  });
});
