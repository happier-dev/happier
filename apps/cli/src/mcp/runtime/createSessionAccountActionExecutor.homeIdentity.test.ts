import { EventEmitter } from 'node:events';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { createSessionAccountActionExecutor } from './createSessionAccountActionExecutor';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';

const { socketBoundary } = vi.hoisted(() => ({ socketBoundary: { socket: null as EventEmitter | null } }));
// HTTP and the socket are system boundaries; the Action and observer remain real.
vi.mock('@/api/session/sockets', () => ({ createUserScopedSocketConnection: () => {
  const boundary = Object.assign(socketBoundary.socket!, { connected: false, connect() {}, disconnect() {}, close() {} });
  return { socket: boundary, transport: createSocketTransportAdapter(boundary) };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration(); socketBoundary.socket = null; });

it('keeps a passive bound Session watch on its saved Home and refuses a foreign Home', async () => {
  await withTempDir('happier-mcp-watch-home-', async homeDir => {
    socketBoundary.socket = new EventEmitter();
    vi.stubEnv('HAPPIER_HOME_DIR', homeDir);
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'local-profile');
    reloadConfiguration();
    const url = 'https://watch.example.test';
    await updateSettings(current => ({ ...current, servers: { ...current.servers, 'local-profile': {
      id: 'local-profile', name: 'Watch', serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact' as const,
      homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_watch_home',
        canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }),
    }, 'foreign-profile': {
      id: 'foreign-profile', name: 'Foreign', serverUrl: 'https://foreign.example.test', webappUrl: 'https://foreign.example.test',
      createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
      homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_foreign',
        canonicalServerUrl: 'https://foreign.example.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://foreign.example.test' }] }),
    } } }));
    const sessionId = 'c123456789012345678901234';
    const now = Date.now();
    const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}',
      updatedAt: now, active: true, activeAt: now, latestTurnStatus: 'completed', latestTurnStatusObservedAt: now,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected HTTP path: ${new URL(String(url)).pathname}`);
    });
    const credentials = { token: 'test-token', encryption: null } as const;
    const base = createCliActionExecutor({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: 'srv_watch_home', serverHttpBaseUrl: url });
    const executor = createSessionAccountActionExecutor({ base, client: { sessionId,
      getServerBinding: () => ({ serverId: 'local-profile', serverUrl: url }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
    } });
    const foreignSnapshots: unknown[] = [];
    expect(await executor.execute('wait', { target: { kind: 'session', serverId: 'srv_foreign', sessionId },
      condition: { kind: 'ready' } }, { onWaitSnapshot: snapshot => { foreignSnapshots.push(snapshot); } }))
      .toMatchObject({ ok: true, result: { disposition: 'unsupported_condition' } });
    expect(foreignSnapshots).toEqual([]);
    for (const serverId of ['local-profile', 'srv_watch_home']) {
      const lifetime = new AbortController();
      const snapshots: unknown[] = [];
      expect(await executor.execute('wait', { target: { kind: 'session', serverId, sessionId },
        condition: { kind: 'ready' } }, { signal: lifetime.signal,
        onWaitSnapshot: snapshot => { snapshots.push(snapshot); lifetime.abort(); } }))
        .toMatchObject({ ok: true, result: { disposition: 'cancelled' } });
      expect(snapshots).toEqual([expect.objectContaining({ awareness: expect.objectContaining({ sessionId, runtime: 'idle' }) })]);
    }
  });
});
