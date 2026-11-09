import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { DEFAULT_CATALOG_AGENT_ID } from '@/agent/catalog/ids';
import {
  bindApiSessionSocketMock,
  createAvailableSessionSpawnMachineSnapshot,
  createApiSessionSocketStub,
  resolveApiSessionSocketDefaultAck,
  respondToExactMachineSessionSpawnRpc,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session create plaintext sessions (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let observedMetadataUpdateCallCount = 0;
  let observedSpawnBody: Record<string, unknown> | null = null;
  let observedHttpRequests: string[] = [];
  let observedRpcMethods: string[] = [];
  let ambiguousConnectedSelector = false;
  // The real creation owner requires an Account-scoped retry namespace.
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'selector-transport-account' })).toString('base64url')}.signature`;
  const codexService = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
  const codexServiceKey = `${codexService.pluginId}/${codexService.localId}`;
  const inventoryPaths = [
    '/v1/account/entity-rows/connected-accounts/purposes',
    '/v1/account/entity-rows/connected-metadata/presentation',
    '/v1/account/entity-rows/connected-metadata/acknowledgements',
  ];
  // These projection endpoints serve discovery for the explicit-auth cohorts.
  // Profile/settings/currentness also serve spawn admission; keep their full
  // histogram separate instead of attributing every read to the inventory Action.
  const inventoryRequests = () => observedHttpRequests.filter(request => inventoryPaths.some(path => request === `GET ${path}`));
  const expectedInventoryRequests = () => inventoryPaths.map(path => `GET ${path}`).sort();
  const spawnRequests = () => observedRpcMethods.filter(method => (
    method === `machine_integration:${RPC_METHODS.SPAWN_HAPPY_SESSION}`
    || method === `machine_integration:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`
  ));

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-create-plain-');
    observedMetadataUpdateCallCount = 0;
    observedSpawnBody = null;
    observedHttpRequests = [];
    observedRpcMethods = [];
    ambiguousConnectedSelector = false;
    resetActiveAccountSettingsSnapshotForTests();

    const sessionId = 'sess_integration_create_plain_123';
    let metadataJson = JSON.stringify({ path: process.cwd(), host: 'spawn-host' });
    let metadataVersion = 0;
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      observedHttpRequests.push(`${req.method} ${url.pathname}`);

      // Only the Home transport is substituted: the CLI inventory Action,
      // catalog readers, schema projections and selector remain real.
      if (req.method === 'GET' && url.pathname === '/v1/account/profile') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(AccountProfileSchema.parse({
          id: 'selector-transport-account',
          connectedAccountsV4: [{
            ref: { service: codexService, accountId: ambiguousConnectedSelector ? 'codex-pool' : 'codex1' },
            status: 'connected', authenticationModeId: 'oauth', kind: 'oauth',
            revisionSemantics: 'legacy_unfenced', credentialRevision: null,
            configurationReady: true, configurationRevision: null, scopes: [],
          }],
          connectedAccountGroupsV4: [{
            v: 1, ref: { service: codexService, groupId: 'codex-pool' },
            incarnation: 'selector-group', displayName: 'Codex pool',
            policy: { autoSwitch: false }, activeConnectedAccountId: 'codex1',
            generation: 1, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
            members: [{ v: 1, connectedAccountId: 'codex1', priority: 100, enabled: true,
              state: {}, createdAt: 1, updatedAt: 1 }],
          }],
        })));
        return;
      }

      if (req.method === 'GET' && inventoryPaths.includes(url.pathname)) {
        const purposes = url.pathname.endsWith('/connected-accounts/purposes');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'present', revision: 1, content: { t: 'plain', v: purposes
          ? { key: 'purposes', value: { v: 1, bindings: [] } }
          : { v: 1, entries: [] } } }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v2/account/settings') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: 1, content: { t: 'plain', v: {} } }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v2/account/settings/history') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ snapshots: [] }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/account/encryption') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/machines/machine_integration') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ machine: createAvailableSessionSpawnMachineSnapshot('machine_integration') }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v2/sessions/lookup-by-tags') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sessions: [] }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/account/encryption/currentness') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          mode: 'plain',
          version: 1,
          signingKeyFingerprint: null,
          contentKeyFingerprint: null,
          updatedAt: 1,
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: true,
              activeAt: 2,
              archivedAt: null,
              metadata: metadataJson,
              metadataVersion,
              agentState: null,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: null,
              encryptionMode: 'plain',
              share: null,
            },
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve session control integration test server address');
    }

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    writeDaemonState({
      pid: process.pid,
      httpPort: address.port,
      startedAt: Date.now(),
      startedWithCliVersion: 'test',
      controlToken: 'test-token',
    });

    const socket = createApiSessionSocketStub({
      emitWithAck: (event, payload, socket) => event === SOCKET_RPC_EVENTS.CALL
        ? new Promise(resolve => socket.emit(event, payload, resolve))
        : resolveApiSessionSocketDefaultAck(event, payload),
      emit: (event: string, args: unknown[]) => {
        if (event === SOCKET_RPC_EVENTS.CALL) {
          const call = args[0];
          if (call && typeof call === 'object' && 'method' in call && typeof call.method === 'string') {
            observedRpcMethods.push(call.method);
          }
        }
        if (respondToExactMachineSessionSpawnRpc({
          event,
          args,
          machineId: 'machine_integration',
          sessionId,
          onSpawnRequest: (request) => {
            observedSpawnBody = { ...request };
            metadataJson = JSON.stringify({
              path: process.cwd(),
              host: 'spawn-host',
              sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence,
            });
          },
        })) {
          return;
        }

        if (event !== 'update-metadata') return;
        const [data, callback] = args as [any, ((value: unknown) => void) | undefined];
        observedMetadataUpdateCallCount += 1;
        expect(data?.expectedVersion).toBe(metadataVersion);
        const decrypted = JSON.parse(String(data?.metadata ?? '{}'));
        expect(decrypted?.tag).toBeUndefined();
        if (decrypted?.summary !== undefined) {
          expect(decrypted?.summary?.text).toBe('My Title');
        }
        metadataJson = String(data.metadata);
        metadataVersion += 1;
        callback?.({ result: 'success', version: metadataVersion, metadata: metadataJson });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);
  });

  afterEach(async (context) => {
    const histogram = (requests: readonly string[]) => requests.reduce<Record<string, number>>((counts, request) => {
      counts[request] = (counts[request] ?? 0) + 1;
      return counts;
    }, {});
    console.info('[selector-transport]', JSON.stringify({
      test: context.task.name,
      discoveryOnlyHttp: histogram(inventoryRequests()),
      allHttp: histogram(observedHttpRequests),
      allRpc: histogram(observedRpcMethods),
    }));
    resetActiveAccountSettingsSnapshotForTests();
    await clearDaemonStateForTestTeardown();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }

    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  async function createWithAuth(auth: string) {
    const { handleSessionCommand } = await import('./index');
    const machineKeySeed = new Uint8Array(32).fill(8);
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--agent', 'codex', '--auth', auth, '--json'], {
        readCredentialsFn: async () => ({ token, encryption: {
          type: 'dataKey', publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed), machineKey: machineKeySeed,
        } }),
      });
      return output.json();
    } finally {
      output.restore();
    }
  }

  it.each([
    ['cs:openai-codex:group:codex-pool', { source: 'connected', selection: 'group', groupId: 'codex-pool' }],
    ['cs:openai-codex:profile:codex1', { source: 'connected', selection: 'profile', profileId: 'codex1' }],
    ['cs:codex-pool', { source: 'connected', selection: 'group', groupId: 'codex-pool' }],
  ] as const)('measures inventory HTTP independently from spawn RPC for %s', async (auth, binding) => {
    expect(resolveCatalogAgentConnectedAccountServiceIds('codex')).toContain(codexServiceKey);
    const parsed = await createWithAuth(auth);
    expect(parsed, JSON.stringify(parsed)).toMatchObject({ ok: true, kind: 'session_create', data: {
      created: true, session: { id: 'sess_integration_create_plain_123' },
    } });
    expect(observedSpawnBody?.connectedServices).toEqual({ v: 2, bindingsByServiceId: { [codexServiceKey]: binding } });
    expect(spawnRequests()).toHaveLength(1);
    expect(inventoryRequests().sort()).toEqual(auth === 'cs:codex-pool'
      ? expectedInventoryRequests()
      : []);
  });

  it('retains shorthand ambiguity without dispatching a spawn', async () => {
    ambiguousConnectedSelector = true;
    const parsed = await createWithAuth('cs:codex-pool');
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.message).toContain(`connected_service_auth_ambiguous:cs:${codexServiceKey}:profile:codex-pool,cs:${codexServiceKey}:group:codex-pool`);
    expect(inventoryRequests().sort()).toEqual(expectedInventoryRequests());
    expect(spawnRequests()).toEqual([]);
    expect(observedSpawnBody).toBeNull();
  });

  it('refuses an unsupported qualified service without inventory or spawn transport', async () => {
    const parsed = await createWithAuth('cs:unsupported-service:group:codex-pool');
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.message).toContain('connected_service_auth_not_found');
    expect(inventoryRequests()).toEqual([]);
    expect(spawnRequests()).toEqual([]);
    expect(observedSpawnBody).toBeNull();
  });

  it('returns the spawned plaintext session envelope through exact-machine dispatch', async () => {
    const { handleSessionCommand } = await import('./index');

    const machineKeySeed = new Uint8Array(32).fill(8);

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--title', 'My Title', '--json'], {
        readCredentialsFn: async () => ({
          token,
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.v).toBe(1);
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(parsed.kind).toBe('session_create');
      expect(parsed.data?.created).toBe(true);
      expect(parsed.data?.session?.id).toBe('sess_integration_create_plain_123');
      expect(observedSpawnBody).toEqual(expect.objectContaining({
        directory: process.cwd(),
        machineId: 'machine_integration',
        backendTarget: { kind: 'backend', backendId: DEFAULT_CATALOG_AGENT_ID, sourceKind: 'built_in' },
        initialTitle: 'My Title',
        spawnNonce: expect.any(String),
      }));
      expect(observedMetadataUpdateCallCount).toBe(0);
    } finally {
      output.restore();
    }
  });
});
