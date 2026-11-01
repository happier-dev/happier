import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceBindingsV1, ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';
import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSessionListResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

const { listSessionMarkers, io } = vi.hoisted(() => ({ listSessionMarkers: vi.fn(), io: vi.fn() }));
// Only OS custody discovery and network transports are replaced; metadata updates and encryption stay real.
vi.mock('@/daemon/sessionRegistry', () => ({ listSessionMarkers }));
vi.mock('socket.io-client', async (importOriginal) => ({ ...await importOriginal<typeof import('socket.io-client')>(), io }));

import { ensureDirectSessionLink } from './ensureDirectSessionLink';

const credentials = { token: 'machine-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } satisfies Credentials;
const bindings = { v: 1, bindingsByServiceId: {
  'openai-codex': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'member' },
} } satisfies ConnectedServiceBindingsV1;
const identity = { v: 1, id: 'csm_neighbour', createdAtMs: 1 } satisfies ConnectedServiceMaterializationIdentityV1;

function marker(nativeId?: string): DaemonSessionMarker {
  return {
    pid: 12345, happySessionId: 'neighbour', happyHomeDir: '/synthetic', createdAt: 1, updatedAt: 2,
    flavor: 'codex', cwd: '/repo', metadata: {
      flavor: 'codex', path: '/repo', ...(nativeId ? { codexSessionId: nativeId } : {}),
      connectedServices: bindings, connectedServicesUpdatedAt: 1, connectedServiceMaterializationIdentityV1: identity,
    },
  };
}

describe('Direct link connected-service ownership', () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  async function relayFor(existingMetadata?: Record<string, unknown>) {
    const app = Fastify();
    let session = createSessionRecordFixture({ id: 'linked', encryptionMode: 'plain', metadata: JSON.stringify(existingMetadata ?? {}) });
    app.get('/v2/sessions', async () => createSessionListResponseFixture(existingMetadata ? [session] : []));
    app.get('/v2/sessions/archived', async () => createSessionListResponseFixture([]));
    app.get('/v2/sessions/linked', async () => ({ session }));
    app.post<{ Body: { metadata: string } }>('/v1/sessions', async (request) => {
      session = createSessionRecordFixture({ id: 'linked', encryptionMode: 'e2ee', metadata: request.body.metadata });
      return { session };
    });
    io.mockImplementation(() => createApiSessionSocketStub({ emit: (event, args) => {
      if (event !== 'update-metadata') return;
      const [payload, acknowledge] = args as [{ metadata: string; expectedVersion: number }, (reply: unknown) => void];
      session = { ...session, metadata: payload.metadata, metadataVersion: payload.expectedVersion + 1 };
      acknowledge({ result: 'success', metadata: session.metadata, version: session.metadataVersion });
    } }));
    await app.ready();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe('/v1/features');
      return new Response('{}', { status: 404 });
    }));
    cleanup.push(() => app.close());
    cleanup.push(installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin }));
    return () => tryDecryptSessionMetadata({ credentials, rawSession: session });
  }

  const link = () => ensureDirectSessionLink({ credentials, machineId: 'machine', providerId: 'codex',
    remoteSessionId: 'thread-b', source: { kind: 'codexHome', home: 'user' }, directoryHint: '/repo', nowMs: () => 10 });

  it.each([undefined, 'thread-a'])('does not inherit a same-directory marker for native identity %s', async (nativeId) => {
    listSessionMarkers.mockResolvedValue([marker(nativeId)]);
    const readMetadata = await relayFor();
    await link();
    expect(readMetadata()).toMatchObject({ codexSessionId: 'thread-b', directSessionV1: { remoteSessionId: 'thread-b' } });
    expect(readMetadata()).not.toHaveProperty('connectedServices');
    expect(readMetadata()).not.toHaveProperty('connectedServiceMaterializationIdentityV1');
  });

  it('retains exact native-session continuity even when the marker directory differs', async () => {
    listSessionMarkers.mockResolvedValue([{ ...marker('thread-b'), cwd: '/other', metadata: { ...marker('thread-b').metadata, path: '/other' } }]);
    const readMetadata = await relayFor();
    await link();
    expect(readMetadata()).toMatchObject({ connectedServices: bindings, connectedServiceMaterializationIdentityV1: identity });
  });

  it('preserves an existing link identity and binding when a different native session shares its directory', async () => {
    listSessionMarkers.mockResolvedValue([marker('thread-a')]);
    const ownedIdentity = { ...identity, id: 'csm_owned' };
    const tag = `direct:v1:${createHash('sha256').update('machine|codex|thread-b|codexHome:user:::').digest('hex')}`;
    const readMetadata = await relayFor({ tag, flavor: 'codex', codexSessionId: 'thread-b', path: '/repo',
      connectedServices: bindings, connectedServiceMaterializationIdentityV1: ownedIdentity,
      directSessionV1: { v: 1, machineId: 'machine', providerId: 'codex', remoteSessionId: 'thread-b',
        source: { kind: 'codexHome', home: 'user' }, linkedAtMs: 1 } });
    const result = await link();
    expect(result.created).toBe(false);
    expect(readMetadata()).toMatchObject({ connectedServices: bindings, connectedServiceMaterializationIdentityV1: ownedIdentity,
      codexSessionId: 'thread-b' });
  });
});
