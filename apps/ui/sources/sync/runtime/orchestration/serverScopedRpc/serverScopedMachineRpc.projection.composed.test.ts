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
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import { createPlainAccountEncryptionCurrentnessHttpResponse } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
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
import { dispatchBrowserContextActionViaMachineRpc } from '@/sync/domains/browser/context/machineRpc';
import { dispatchBrowserDaemonControlCommandViaMachineRpc, listBrowserDaemonViewsViaMachineRpc, watchBrowserDaemonViewsViaMachineRpc } from '@/sync/domains/browser/control/machineRpc';
import { fetchBrowserDiagnosticsSnapshotViaMachineRpc } from '@/sync/domains/browser/diagnostics/machineRpc';
import { createManagedChromiumBrowserAnnotationCaptureProvider } from '@/sync/domains/browser/context/managedChromiumAnnotationProvider';
import { createBrowserAnnotationRuntimeExecutor } from '@/sync/domains/browser/context/runtimeAnnotationExecutor';
import { createBrowserContextAnnotationAdapter } from '@/sync/domains/browser/context/annotationAdapter';
import { createBrowserContextState } from '@/sync/domains/browser/context/state';
import { applyBrowserControlEvent, createBrowserControlState } from '@/sync/domains/browser/control/reducer';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';

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
    machineListStatusByServerId: initialStorage.machineListStatusByServerId,
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
    refusal?: Readonly<{ errorCode: string; failureCause?: unknown }>;
    result?: unknown;
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
    const currentness = createPlainAccountEncryptionCurrentnessHttpResponse(request.url ?? '');
    if (currentness) { response.end(await currentness.text()); return; }
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
    if (options.refuse?.() ?? Boolean(options.refusal))
      return {
        ack: {
          ok: false,
          error: 'Forbidden',
          errorCode: RPC_ERROR_CODES.FORBIDDEN,
          ...options.refusal,
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
          options.result ?? { success: true, key: 'plain' },
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

async function annotate(home: Awaited<ReturnType<typeof createActiveHome>>) {
  const identity = { browserSessionId: 'browser', viewId: 'view' };
  const capabilities = buildBrowserAdapterCapabilities({ adapterKind: 'chromiumSidecar',
    supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['streamedSurface'] });
  const control = applyBrowserControlEvent(createBrowserControlState(), { ...identity, kind: 'viewOpened',
    eventId: 'open', occurredAt: 1, target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test/' },
    platform: 'web', adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface',
    adapterCapabilities: { ...capabilities, contextKinds: ['browserAnnotation'] } });
  let state = createBrowserContextState();
  const adapter = createBrowserContextAnnotationAdapter({ resolveBinding: () => ({ state,
    view: control.viewsById.view!, browserContextEnabled: true, attachmentsUploadsEnabled: true,
    contextCapabilities: { enabled: true, available: true, supportedContextKinds: ['browserAnnotation'],
      supportedAdapterKinds: ['chromiumSidecar'], screenshot: { supported: true, requiresAttachmentUploads: true },
      text: { maxSelectionChars: 2048, maxSummaryChars: 8192 }, disabledReasons: [], policyDeniedReasons: [] },
    captureProvider: createManagedChromiumBrowserAnnotationCaptureProvider({ machineId: MACHINE, serverId: home.profile.id }),
    commitAnnotation: async () => ({ ok: false, reason: 'not_attached' }),
  }), onStateChange: next => { state = next; } });
  return createBrowserAnnotationRuntimeExecutor({ adapter })('browser.context.annotation.start', identity);
}

describe('Browser consumers preserve the real scoped RPC refusal', () => {
  it('retains coded ACK causes through context, control, discovery, diagnostics and the annotation Action', async () => {
    stored.token = tokenFor(ACCOUNT);
    const failureCause = { phase: 'browser.capture', errorClass: 'Error', errorCode: 'capture_source_unavailable', httpStatus: null };
    let refusing = false;
    const home = await createActiveHome({ refuse: () => refusing, refusal: { errorCode: 'capture_source_unavailable', failureCause } });
    try {
      await applySync(home, createMachineFixture({ id: MACHINE, storageMode: 'plain', access: ownAccess('plain') }));
      const scope = { machineId: MACHINE, serverId: home.profile.id };
      expect(await home.rpc()).toEqual({ success: true, key: 'plain' });
      refusing = true;
      await expect(home.rpc()).rejects.toMatchObject({ rpcErrorCode: 'capture_source_unavailable', failureCause });
      const expected = { ok: false, errorCode: 'capture_source_unavailable', failureCause };
      const results = await Promise.all([
        dispatchBrowserContextActionViaMachineRpc({ ...scope, actionId: 'browser.context.captureScreenshot', input: {} }),
        dispatchBrowserDaemonControlCommandViaMachineRpc({ ...scope,
          command: { kind: 'reload', commandId: 'reload', browserSessionId: 'browser', viewId: 'view' } }),
        listBrowserDaemonViewsViaMachineRpc({ ...scope, browserSessionId: 'browser' }),
        watchBrowserDaemonViewsViaMachineRpc({ ...scope, accountId: ACCOUNT, browserSessionId: 'browser', knownViewIds: [], signal: new AbortController().signal }),
        fetchBrowserDiagnosticsSnapshotViaMachineRpc(scope),
        annotate(home),
      ]);
      expect(results).toMatchObject(results.map(() => expected));
    } finally { await home.close(); }
  });

  it('retains the validated returned context refusal through the real annotation adapter and Action', async () => {
    stored.token = tokenFor(ACCOUNT);
    const failure = { ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_context_sensitive_origin' };
    const home = await createActiveHome({ result: { protocolVersion: 1, result: failure } });
    try {
      await applySync(home, createMachineFixture({ id: MACHINE, storageMode: 'plain', access: ownAccess('plain') }));
      expect(await annotate(home)).toEqual(failure);
    } finally { await home.close(); }
  });
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

  it.each([
    { outcome: 'ready', status: undefined },
    { outcome: 'unavailable', status: undefined },
    { outcome: 'aborted', status: undefined },
    { outcome: 'ready', status: 'loading' },
    { outcome: 'unavailable', status: 'loading' },
    { outcome: 'aborted', status: 'loading' },
  ] as const)('holds a cold scoped projection with list status $status, then settles $outcome', async ({ outcome, status }) => {
    stored.token = tokenFor(ACCOUNT);
    const encryption = await Encryption.create(new Uint8Array(32).fill(71));
    const source = await Encryption.create(new Uint8Array(32).fill(71));
    const dataKey = new Uint8Array(32).fill(72);
    await source.initializeMachines(new Map([[MACHINE, dataKey]]));
    const home = await createActiveHome({ ciphers: () => [['hydrated', source.getMachineEncryption(MACHINE)!]] });
    const capture = vi.spyOn(apiSocket, 'captureBoundMachineRpcContent');
    const abort = new AbortController();
    try {
      const cold = createMachineFixture({ id: MACHINE, storageMode: 'e2ee', metadata: null,
        dataEncryptionKey: Buffer.from(await source.encryptEncryptionKey(dataKey)).toString('base64'),
        availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
      await applySync(home, cold, { encryption });
      // Before Sync publishes its first rows, the cold Home has no list status.
      getStorage().setState({ machineListStatusByServerId: status ? { [home.profile.id]: status } : {} });
      let settled = false;
      const pending = home.rpc({ preferScoped: true, signal: abort.signal }).then(
        value => { settled = true; return { value }; },
        error => { settled = true; return { error }; },
      );
      await vi.waitFor(() => expect(capture).toHaveBeenCalled());
      expect(settled).toBe(false);
      expect(home.calls).toHaveLength(0);
      expect(home.readCount).toBe(0);
      if (outcome === 'aborted') abort.abort();
      else if (outcome === 'ready') {
        const metadata = await source.getMachineEncryption(MACHINE)!.encryptMetadata(createMachineFixture().metadata!);
        await fetchAndApplyMachines({
          credentials: { token: stored.token, secret: Buffer.from(new Uint8Array(32).fill(71)).toString('base64') },
          expectedAccountMode: 'e2ee', sourceServerId: home.profile.id, encryption, machineDataKeys: new Map(),
          request: async () => new Response(JSON.stringify([{ ...cold, metadata }])),
          getMachineSnapshot: () => getStorage().getState().machines,
          getExistingMachine: id => getStorage().getState().machines[id],
          applyMachineDisplayEntries: (machines, options) => getStorage().getState().replaceMachineDisplays(machines,
            { sourceServerId: home.profile.id, ...options }),
          applyMachines: (machines, replace) => getStorage().getState().applyMachines(machines, replace, { sourceServerId: home.profile.id }),
          onListComplete: () => getStorage().getState().markMachineListSettled(home.profile.id),
        });
      } else getStorage().setState({ machineListStatusByServerId: { [home.profile.id]: 'idle' } });
      const result = await pending;
      if (outcome === 'ready') expect(result).toMatchObject({ value: { success: true, key: 'hydrated' } });
      else expect(result).toMatchObject({ error: { rpcErrorCode: outcome === 'aborted'
        ? 'MACHINE_RPC_ABORTED' : 'MACHINE_ENCRYPTION_UNAVAILABLE' } });
      expect(home.calls).toHaveLength(outcome === 'ready' ? 1 : 0);
      expect(home.readCount).toBe(0);
    } finally {
      abort.abort(); capture.mockRestore();
      await home.close();
      encryption.retireAccountMaterial(); source.retireAccountMaterial();
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
