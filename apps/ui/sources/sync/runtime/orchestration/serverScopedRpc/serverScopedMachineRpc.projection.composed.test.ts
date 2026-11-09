import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import {
  SOCKET_RPC_EVENTS,
  type SocketRpcRequestPayload,
} from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { countTransportRequests } from '@/dev/testkit';
import {
  createMachineFixture,
  createMachineReadBatchResponseFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { Encryption } from '@/sync/encryption/encryption';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import {
  getActiveServerSnapshot,
  setActiveServer,
} from '@/sync/domains/server/serverRuntime';
import {
  publishAppliedActiveServerRuntimeAvailability,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { machineRpcWithServerScope } from './serverScopedMachineRpc';
import { resetScopedMachineTransportCacheForTests } from './serverScopedRpcPool';
import { serverScopedRpcSocketPool } from './serverScopedRpcSocketPool';

// Real scoped context, captured read transport, HTTP Machine-row batch, Socket.IO
// carrier, RPC codec and Sync's applied Machine projection; only device credential
// persistence is replaced (testkit boundary).
const tokenFor = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const stored = vi.hoisted(() => ({ token: '' }));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
  const { createTokenStorageModuleMock } =
    await import('@/dev/testkit/mocks/tokenStorage');
  const actual =
    await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
  return createTokenStorageModuleMock({
    importOriginal,
    subscribeHomeCredentialMutations: actual.subscribeHomeCredentialMutations,
    tokenStorage: {
      getCredentialsForServerUrl: async () => ({ token: stored.token }),
    },
  });
});

const ACCOUNT = 'projection-account';
const MACHINE = 'projected-machine';
const N = 407; // D25-ATTR: 407 actionOperation.get.v2 RPCs to one Machine in 60 s.
const initialStorage = getStorage().getState();

afterEach(async () => {
  apiSocket.disconnect();
  publishAppliedActiveServerRuntimeAvailability(false);
  getStorage().setState({
    machines: initialStorage.machines,
    machineListByServerId: initialStorage.machineListByServerId,
  });
  await serverScopedRpcSocketPool.stopAll();
  serverScopedRpcSocketPool.resetForTests();
  resetScopedMachineTransportCacheForTests();
});

type Decoder = (
  packet: SocketRpcRequestPayload,
) => Promise<{ ack: unknown }>;

async function createActiveHome(
  options: Readonly<{
    ciphers?: () => ReadonlyArray<
      readonly [
        string,
        {
          encryptRaw: (v: unknown) => Promise<string>;
          decryptRaw: (v: string) => Promise<unknown>;
        },
      ]
    >;
    refuse?: () => boolean;
  }> = {},
) {
  const row = createPlainMachineRowFixture({ id: MACHINE, accountId: ACCOUNT });
  const calls: Array<{ mode: string; params: unknown }> = [];
  const reads = countTransportRequests(
    async (body: string) =>
      createMachineReadBatchResponseFixture(body, (id) =>
        id === row.id ? row : null,
      ),
    () => 'POST /v1/machines/read-batch',
  );
  const http = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health' || request.url === '/v1/auth/ping')
      response.end('{}');
    else if (request.url === '/v1/machines/read-batch') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.end(
        await (
          await reads.request(Buffer.concat(chunks).toString('utf8'))
        ).text(),
      );
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  const decode: Decoder = async (packet) => {
    if (options.refuse?.())
      return {
        ack: {
          ok: false,
          error: 'Forbidden',
          errorCode: RPC_ERROR_CODES.FORBIDDEN,
        },
      };
    for (const [label, cipher] of options.ciphers?.() ?? []) {
      try {
        const decoded = await socketRpcCodec.decodeRequestParams(
          { mode: 'e2ee', cipher },
          packet.params,
          packet.method,
        );
        calls.push({ mode: label, params: decoded.params });
        return {
          ack: {
            ok: true,
            result: await socketRpcCodec.encodeResponse(
              { mode: 'e2ee', cipher },
              { success: true, key: label },
              decoded.callId,
            ),
          },
        };
      } catch {
        /* try the next published key */
      }
    }
    const decoded = await socketRpcCodec.decodeRequestParams(
      { mode: 'plain' },
      packet.params,
      packet.method,
    );
    calls.push({ mode: 'plain', params: decoded.params });
    return {
      ack: {
        ok: true,
        result: await socketRpcCodec.encodeResponse(
          { mode: 'plain' },
          { success: true, key: 'plain' },
          decoded.callId,
        ),
      },
    };
  };
  const relay = new Server(http, { path: '/v1/updates/' });
  relay.on('connection', (socket) =>
    socket.on(
      SOCKET_RPC_EVENTS.CALL,
      async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) =>
        ack((await decode(packet)).ack),
    ),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing HTTP address');
  const profile = await upsertServerProfile({
    serverUrl: `http://127.0.0.1:${address.port}`,
    name: 'Projection Home',
  });
  return {
    profile,
    calls,
    reads,
    get readCount() {
      return reads.read()['POST /v1/machines/read-batch'] ?? 0;
    },
    // Same shape as Sync's push consumer: accountId-qualified actionOperation.get.v2.
    rpc: (
      extra: Partial<Parameters<typeof machineRpcWithServerScope>[0]> = {},
    ) =>
      machineRpcWithServerScope({
        serverId: profile.id,
        accountId: ACCOUNT,
        machineId: MACHINE,
        method: 'actionOperation.get.v2',
        payload: { operationId: 'projection' },
        ...extra,
      }),
    close: async () => {
      await serverScopedRpcSocketPool.stopAll();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    },
  };
}

/** Apply this Home and Account as Sync's active runtime with the given Machine projection. */
async function applySync(
  home: Awaited<ReturnType<typeof createActiveHome>>,
  machine: Machine,
  options: Readonly<{
    syncAccountId?: string;
    encryption?: Encryption | null;
  }> = {},
) {
  await setActiveServer({ serverId: home.profile.id });
  const snapshot = getActiveServerSnapshot();
  publishAppliedActiveServerSnapshot(snapshot);
  getStorage().setState({
    machines: { [machine.id]: machine },
    machineListByServerId: { [home.profile.id]: [machine] },
  });
  const token = tokenFor(options.syncAccountId ?? ACCOUNT);
  apiSocket.initialize(
    {
      endpoint: home.profile.serverUrl,
      serverId: home.profile.id,
      generation: snapshot.generation,
      token,
      credentials: { token },
    },
    options.encryption ?? null,
  );
}

const ownAccess = (resourceMode: 'plain' | 'e2ee') => ({
  custodian: { accountId: ACCOUNT, displayName: '' },
  role: 'manage' as const,
  resourceMode,
  accessState: 'ready' as const,
});

describe('scoped Machine RPC on the applied active Home consumes Sync’s Machine projection', () => {
  it(`${N} sequential accountId-qualified RPCs read no Machine row; reads follow pushed changes, not calls`, async () => {
    stored.token = tokenFor(ACCOUNT);
    const home = await createActiveHome();
    try {
      await applySync(
        home,
        createMachineFixture({
          id: MACHINE,
          storageMode: 'plain',
          access: ownAccess('plain'),
        }),
      );
      for (let index = 0; index < N; index += 1)
        await expect(home.rpc()).resolves.toMatchObject({ success: true });
      console.log(
        JSON.stringify({
          scenario: 'sequential-projected',
          rpcCount: home.calls.length,
          machineRowReads: home.readCount,
        }),
      );
      expect(home.calls).toHaveLength(N);
      expect(home.readCount).toBe(0);
    } finally {
      await home.close();
    }
  }, 180_000);

  it('an Account switch between selection and send emits nothing; a different scoped Account reads the row', async () => {
    stored.token = tokenFor(ACCOUNT);
    const home = await createActiveHome();
    try {
      const machine = createMachineFixture({
        id: MACHINE,
        storageMode: 'plain',
        access: ownAccess('plain'),
      });
      await applySync(home, machine);
      const otherToken = tokenFor('other-account');
      await expect(
        home.rpc({
          onIssued: () => undefined,
          preparePayload: () => {
            apiSocket.initialize(
              {
                endpoint: home.profile.serverUrl,
                serverId: home.profile.id,
                generation: getActiveServerSnapshot().generation,
                token: otherToken,
                credentials: { token: otherToken },
              },
              null,
            );
            return { operationId: 'projection' };
          },
        }),
      ).rejects.toMatchObject({
        rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE',
      });
      expect(home.calls).toHaveLength(0);
      expect(home.readCount).toBe(0);
      // Sync now serves another Account: this Account's scoped call is not bound to its projection.
      await expect(home.rpc()).resolves.toMatchObject({ success: true });
      await expect(home.rpc()).resolves.toMatchObject({ success: true });
      expect(home.readCount).toBe(2);
    } finally {
      await home.close();
    }
  });

  it('a pin-locked own-Account E2EE Machine refuses typed with zero reads and zero plaintext RPCs', async () => {
    stored.token = tokenFor(ACCOUNT);
    const home = await createActiveHome();
    try {
      // The Home serves a plain row; Sync's downgrade pin locked that same row.
      await applySync(
        home,
        createMachineFixture({
          id: MACHINE,
          storageMode: 'plain',
          access: ownAccess('plain'),
          metadata: null,
          availability: { kind: 'locked', reason: 'decryption_failed' },
        }),
      );
      await expect(home.rpc()).rejects.toMatchObject({
        rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE',
      });
      // The unscoped active route refuses too and its scoped fallback does not re-read the row.
      await expect(
        machineRpcWithServerScope({
          serverId: home.profile.id,
          machineId: MACHINE,
          method: 'actionOperation.get.v2',
          payload: {},
        }),
      ).rejects.toMatchObject({
        rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE',
      });
      expect(home.calls).toHaveLength(0);
      expect(home.readCount).toBe(0);
    } finally {
      await home.close();
    }
  });

  it('a key-transition push changes the next call’s envelope without a row read', async () => {
    stored.token = tokenFor(ACCOUNT);
    const encryption = await Encryption.create(new Uint8Array(32).fill(61));
    const firstKey = new Uint8Array(32).fill(62),
      nextKey = new Uint8Array(32).fill(63);
    const firstEnvelope = Buffer.from(
      await encryption.encryptEncryptionKey(firstKey),
    ).toString('base64');
    const nextEnvelope = Buffer.from(
      await encryption.encryptEncryptionKey(nextKey),
    ).toString('base64');
    const published: Array<
      readonly [
        string,
        NonNullable<ReturnType<Encryption['getMachineEncryption']>>,
      ]
    > = [];
    await encryption.initializeMachines(new Map([[MACHINE, firstKey]]));
    published.push(['first', encryption.getMachineEncryption(MACHINE)!]);
    const home = await createActiveHome({ ciphers: () => published });
    try {
      const machine = createMachineFixture({
        id: MACHINE,
        storageMode: 'e2ee',
        access: ownAccess('e2ee'),
        dataEncryptionKey: firstEnvelope,
      });
      await applySync(home, machine, { encryption });
      await expect(home.rpc()).resolves.toMatchObject({
        success: true,
        key: 'first',
      });
      // Sync's push consumer applies the transition: new opened key and projected envelope.
      await encryption.initializeMachines(new Map([[MACHINE, nextKey]]));
      published.unshift(['next', encryption.getMachineEncryption(MACHINE)!]);
      getStorage().setState({
        machines: {
          [MACHINE]: { ...machine, dataEncryptionKey: nextEnvelope },
        },
      });
      await expect(home.rpc()).resolves.toMatchObject({
        success: true,
        key: 'next',
      });
      expect(home.calls.map((call) => call.mode)).toEqual(['first', 'next']);
      expect(home.readCount).toBe(0);
    } finally {
      await home.close();
      encryption.retireAccountMaterial();
    }
  });

  it('a stale projected ready after revoke gets the server’s forbidden', async () => {
    stored.token = tokenFor(ACCOUNT);
    const home = await createActiveHome({ refuse: () => true });
    try {
      await applySync(
        home,
        createMachineFixture({
          id: MACHINE,
          storageMode: 'plain',
          access: ownAccess('plain'),
        }),
      );
      await expect(home.rpc()).rejects.toMatchObject({
        rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN,
      });
      expect(home.readCount).toBe(0);
    } finally {
      await home.close();
    }
  });
});

describe('scoped Machine RPC on a secondary Home keeps the row read', () => {
  it('reads the row per call when Sync is not applied to that Home', async () => {
    stored.token = tokenFor(ACCOUNT);
    const home = await createActiveHome();
    try {
      await expect(home.rpc()).resolves.toMatchObject({
        success: true,
        key: 'plain',
      });
      await expect(home.rpc()).resolves.toMatchObject({
        success: true,
        key: 'plain',
      });
      expect(home.readCount).toBe(2);
    } finally {
      await home.close();
    }
  });
});
