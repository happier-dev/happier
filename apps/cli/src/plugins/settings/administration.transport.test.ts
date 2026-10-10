import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRpcCallError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { Credentials } from '@/persistence';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { fetchServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const {
  daemonReply,
  readStoredCredentials,
  axiosGet,
  sockets,
} = vi.hoisted(() => ({
  daemonReply: vi.fn(),
  readStoredCredentials: vi.fn(),
  axiosGet: vi.fn(),
  sockets: [] as ApiSessionSocketStub[],
}));

// Exercise the real Machine RPC codec, acknowledgement lifetime and cancellation
// owner. Only the HTTP and Socket.IO network adapters are replaced.
vi.mock('socket.io-client', () => ({ io: () => {
  const socket = createApiSessionSocketStub({
    emitWithAck: async (_event, payload) => {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid RPC packet');
      const qualifiedMethod = Reflect.get(payload, 'method');
      if (typeof qualifiedMethod !== 'string') throw new Error('Invalid RPC method');
      const separator = qualifiedMethod.indexOf(':');
      try {
        const result = await daemonReply({
          machineId: qualifiedMethod.slice(0, separator),
          method: qualifiedMethod.slice(separator + 1),
          request: Reflect.get(payload, 'params'),
        });
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Network error', errorCode: readRpcErrorCode(error) };
      }
    },
  });
  sockets.push(socket);
  return socket;
} }));

vi.mock('axios', () => ({ default: { get: (...args: unknown[]) => axiosGet(...args) } }));

vi.mock('@/configuration', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { configuration: {
    serverUrl: 'https://api.example.test', apiServerUrl: 'https://api.example.test',
    activeServerId: 'home', activeServerDir: join(tmpdir(), 'happier-settings-transport-test'),
    happyHomeDir: join(tmpdir(), 'happier-settings-transport-test'),
  } };
});

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials,
}));

import {
  executePluginSettingsAdministrationAction,
  projectAccountSettingsAdministrationSnapshot,
} from './administration';

const credentials: Credentials = {
  token: 'account-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

const target = {
  kind: 'daemon' as const,
  serverIdentityId: 'srv_settings_1',
  machineId: 'machine-1',
};

const listRequest = {
  actionId: 'plugins.settings.list' as const,
  input: {
    pluginId: 'acme.settings',
    scope: { kind: 'daemon' as const },
    target,
  },
};

let fixtureHome: string | undefined;

async function installDeclaredDaemonSecret(): Promise<string> {
  fixtureHome = await mkdtemp(join(tmpdir(), 'happier-settings-transport-'));
  const pluginRoot = join(fixtureHome, 'source');
  const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n');
  await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({
    id: 'acme.settings', secrets: [{ id: 'daemon-token', custody: 'daemon' }],
  })));
  await writeCommittedLocalPathPluginFixture({
    happyHomeDir: fixtureHome,
    pluginId: 'acme.settings',
    sourceRootPath: pluginRoot,
    plugin: {
      source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
      compatibility: { status: 'compatible', diagnostics: [] },
      install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null },
      state: { enabled: true },
    },
  });
  return fixtureHome;
}

beforeEach(() => {
  resetServerFeaturesClientForTests();
  sockets.length = 0;
  axiosGet.mockReset();
  axiosGet.mockResolvedValue({ data: { machine: {
    id: target.machineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
  } } });
  vi.stubGlobal('fetch', async () => Response.json({ features: {}, capabilities: {
    serverIdentity: { serverIdentityId: target.serverIdentityId },
  } }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetServerFeaturesClientForTests();
  if (fixtureHome) await rm(fixtureHome, { recursive: true, force: true });
  fixtureHome = undefined;
});

describe('Plugin Settings administration daemon transport', () => {
  beforeEach(() => {
    daemonReply.mockReset();
    readStoredCredentials.mockReset();
    readStoredCredentials.mockResolvedValue(credentials);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
  ])('maps an older daemon receiver absence (%s) to typed unsupported without another owner', async (rpcErrorCode) => {
    daemonReply.mockRejectedValue(createRpcCallError({
      error: 'The selected daemon has no Plugin Settings administration receiver.',
      errorCode: rpcErrorCode,
    }));

    await expect(executePluginSettingsAdministrationAction(listRequest)).resolves.toMatchObject({
      ok: false,
      kind: 'plugins.settings.list',
      errorCode: 'plugin_settings_daemon_unsupported',
    });
    expect(daemonReply).toHaveBeenCalledTimes(1);
    expect(daemonReply).toHaveBeenCalledWith(expect.objectContaining({
      machineId: target.machineId,
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
    }));
  });

  it('fails the exact target currentness check before any daemon read', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ features: {}, capabilities: {
      serverIdentity: { serverIdentityId: 'srv_replaced_1' },
    } }));

    await expect(executePluginSettingsAdministrationAction(listRequest)).resolves.toMatchObject({
      ok: false,
      kind: 'plugins.settings.list',
      errorCode: 'plugin_settings_target_not_current',
    });
    expect(daemonReply).not.toHaveBeenCalled();
  });

  it('preserves cancellation instead of turning it into availability', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(executePluginSettingsAdministrationAction({
      ...listRequest,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(daemonReply).not.toHaveBeenCalled();
  });

  it('withdraws one shared server identity reader before reply while retaining its neighbor', async () => {
    const controller = new AbortController();
    const reason = new Error('Identity observation withdrawn');
    const failures: unknown[] = [];
    let release!: (response: Response) => void;
    let transportSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((resolve) => {
      release = resolve;
      transportSignal = options.signal ?? undefined;
    }));
    vi.stubGlobal('fetch', fetch);
    const cancelled = executePluginSettingsAdministrationAction({ ...listRequest, signal: controller.signal })
      .catch((error: unknown) => { failures.push(error); });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const retained = fetchServerFeaturesSnapshot({ serverUrl: 'https://api.example.test' });
    controller.abort(reason);
    try {
      await vi.waitFor(() => expect(failures[0]).toBe(reason));
      expect(transportSignal?.aborted).toBe(false);
      release(Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: target.serverIdentityId } } }));
      await expect(retained).resolves.toMatchObject({ status: 'ready' });
      expect(daemonReply).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      release(Response.json({ features: {}, capabilities: {} }));
      await Promise.all([cancelled, retained]);
    }
  });

  it('does not route daemon secret unbind through the destructive delete receiver', async () => {
    const happyHomeDir = await installDeclaredDaemonSecret();

    await expect(executePluginSettingsAdministrationAction({
      actionId: 'plugins.settings.secret.unbind',
      happyHomeDir,
      input: {
        pluginId: 'acme.settings',
        localId: 'daemon-token',
        secretDaemonTarget: target,
      },
    })).resolves.toMatchObject({
      ok: false,
      kind: 'plugins.settings.secret.unbind',
      errorCode: 'plugin_settings_secret_binding_unavailable',
    });
    expect(daemonReply).not.toHaveBeenCalled();
  });

});

describe('Plugin Settings administration declaration defaults', () => {
  const projectedField = (
    field: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> => ({
    kind: 'settings.field',
    version: '1.0.0',
    secretCustody: null,
    ...field,
  });

  const projection = {
    protocolVersion: 1,
    projection: {
      v: 2,
      generation: 1,
      settingsById: {
        'acme.settings/main': {
          id: 'main',
          pluginId: 'acme.settings',
          version: 1,
          title: 'Acme',
          scope: { kind: 'daemon' },
          presentation: {},
          target: { kind: 'plugin' },
          fields: [
            projectedField({
              id: 'retries',
              valueSchema: { type: 'number' },
              valueType: 'number',
              control: 'number',
              displayKey: 'Retries',
              defaultValue: 3,
            }),
            projectedField({
              id: 'endpoint',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'text',
              displayKey: 'Endpoint',
              defaultValue: 'https://declared.example',
            }),
            projectedField({
              id: 'nullable',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'text',
              displayKey: 'Nullable',
              defaultValue: 'declared-fallback',
            }),
            projectedField({
              id: 'undeclared',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'text',
              displayKey: 'Undeclared',
            }),
          ],
        },
      },
    },
  };

  const snapshot = {
    protocolVersion: 1,
    pluginId: 'acme.settings',
    scope: { kind: 'daemon' },
    revision: '7',
    // Sparse by construction: only `nullable` was ever written, and it was
    // written as an explicit JSON null.
    values: { nullable: null },
    redactedKeys: [],
  };

  beforeEach(() => {
    daemonReply.mockReset();
    readStoredCredentials.mockReset();
    readStoredCredentials.mockResolvedValue(credentials);
    daemonReply.mockImplementation(async (params: { method: string }) => {
      if (params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return projection;
      }
      if (params.method === RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET) return snapshot;
      throw new Error(`Unexpected daemon method ${params.method}`);
    });
  });

  it('lists the declared default for an absent value and keeps an explicit null', async () => {
    const listed = await executePluginSettingsAdministrationAction(listRequest);

    expect(listed).toMatchObject({ ok: true, kind: 'plugins.settings.list' });
    expect(listed.ok && listed.kind === 'plugins.settings.list' ? listed.data.fields : null)
      .toEqual([
        { localId: 'retries', secret: false, value: 3 },
        { localId: 'endpoint', secret: false, value: 'https://declared.example' },
        { localId: 'nullable', secret: false, value: null },
        { localId: 'undeclared', secret: false, value: null },
      ]);
  });

  it('accepts a late daemon Settings read under the caller lifetime', async () => {
    vi.useFakeTimers();
    daemonReply.mockImplementation((params: { method: string }) => new Promise((resolve) => {
      setTimeout(() => {
        resolve(params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE ? projection : snapshot);
      }, 31_000);
    }));
    try {
      const listed = executePluginSettingsAdministrationAction(listRequest);
      await vi.advanceTimersByTimeAsync(62_000);
      expect(await listed).toMatchObject({ ok: true, kind: 'plugins.settings.list' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels only the entered Settings read and keeps a neighboring read alive', async () => {
    const replies: Array<(value: unknown) => void> = [];
    daemonReply.mockImplementation(() => new Promise((resolve) => { replies.push(resolve); }));
    const first = new AbortController();
    const reason = new Error('Read withdrawn');
    const cancelled = executePluginSettingsAdministrationAction({ ...listRequest, signal: first.signal });
    const rejection = expect(cancelled).rejects.toBe(reason);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    const retained = executePluginSettingsAdministrationAction(listRequest);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    first.abort(reason);
    await rejection;
    expect(sockets[0]?.close).toHaveBeenCalledOnce();
    expect(sockets[1]?.close).not.toHaveBeenCalled();
    replies[0]!(projection);
    replies[1]!(projection);
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    replies[2]!(snapshot);
    await expect(retained).resolves.toMatchObject({ ok: true, kind: 'plugins.settings.list' });
    expect(daemonReply.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)).toHaveLength(1);
  });

  it.each(['settings', 'secret'] as const)('preserves the uncertain issued %s write when cancelled without replay', async (kind) => {
    const happyHomeDir = kind === 'secret' ? await installDeclaredDaemonSecret() : undefined;
    const method = kind === 'settings' ? RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET : RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE;
    let release!: (value: unknown) => void;
    daemonReply.mockImplementation((request: { method: string }) => request.method === method
      ? new Promise((resolve) => { release = resolve; })
      : Promise.resolve(projection));
    const controller = new AbortController();
    const pending = executePluginSettingsAdministrationAction({
      actionId: kind === 'settings' ? 'plugins.settings.set' : 'plugins.settings.secret.delete',
      ...(happyHomeDir ? { happyHomeDir } : {}),
      input: kind === 'settings'
        ? { ...listRequest.input, localId: 'retries', value: 5 }
        : { pluginId: 'acme.settings', localId: 'daemon-token', secretDaemonTarget: target },
      signal: controller.signal,
    });
    const outcome = expect(pending).resolves.toMatchObject({
      ok: false, errorCode: kind === 'settings' ? 'plugin_settings_outcome_unknown' : 'plugin_secret_outcome_unknown',
    });
    await vi.waitFor(() => expect(daemonReply.mock.calls.filter(([request]) => request.method === method)).toHaveLength(1));
    controller.abort(new Error('Write observation withdrawn'));
    await outcome;
    release({});
    expect(daemonReply.mock.calls.filter(([request]) => request.method === method)).toHaveLength(1);
  });

  it('retains a decoded write receipt when its caller withdraws during socket cleanup', async () => {
    const controller = new AbortController();
    daemonReply.mockImplementation(async (request: { method: string }) => {
      if (request.method !== RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET) return projection;
      const socket = sockets.at(-1);
      if (!socket) throw new Error('Missing write socket');
      // Cleanup is a network boundary reached after the RPC owner decoded its
      // acknowledgement. Model cancellation arriving at that exact point.
      socket.close.mockImplementation(() => controller.abort(new Error('Observer withdrew after receipt')));
      return { status: 'applied', snapshot: { ...snapshot, revision: '8', values: { retries: 5 } } };
    });
    await expect(executePluginSettingsAdministrationAction({
      actionId: 'plugins.settings.set',
      input: { ...listRequest.input, localId: 'retries', value: 5 },
      signal: controller.signal,
    })).resolves.toMatchObject({ ok: true, kind: 'plugins.settings.set', data: { revision: '8', application: { kind: 'live' } } });
    expect(controller.signal.aborted).toBe(true);
    expect(daemonReply.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET)).toHaveLength(1);
  });

  it('gets the declared default for an absent value instead of reporting the daemon unsupported', async () => {
    await expect(executePluginSettingsAdministrationAction({
      actionId: 'plugins.settings.get',
      input: {
        pluginId: 'acme.settings',
        scope: { kind: 'daemon' as const },
        target,
        localId: 'retries',
      },
    })).resolves.toMatchObject({
      ok: true,
      kind: 'plugins.settings.get',
      data: { localId: 'retries', value: 3 },
    });
  });

  it('gets an explicit null rather than substituting the declared default', async () => {
    await expect(executePluginSettingsAdministrationAction({
      actionId: 'plugins.settings.get',
      input: {
        pluginId: 'acme.settings',
        scope: { kind: 'daemon' as const },
        target,
        localId: 'nullable',
      },
    })).resolves.toMatchObject({
      ok: true,
      kind: 'plugins.settings.get',
      data: { localId: 'nullable', value: null },
    });
  });
});

describe('Plugin Settings Account administration snapshot projection', () => {
  const descriptors = [
    {
      id: 'endpoint',
      title: 'Endpoint',
      target: { kind: 'plugin' as const },
      scope: 'account' as const,
      schema: { type: 'string' as const },
      default: 'https://default.example',
    },
    {
      id: 'endpointByServer',
      title: 'Endpoint by server',
      target: { kind: 'plugin' as const },
      scope: 'account' as const,
      schema: { type: 'object' as const },
    },
  ];

  it('projects revision and effective values from one snapshot while hiding backing maps', () => {
    expect(projectAccountSettingsAdministrationSnapshot({
      descriptors,
      hiddenFieldIds: new Set(['endpointByServer']),
      snapshot: {
        scope: { kind: 'account' },
        revision: '41',
        values: {
          endpoint: 'https://snapshot.example',
          endpointByServer: { srv_one: 'https://hidden.example' },
        },
      },
    })).toEqual({
      scope: { kind: 'account' },
      revision: '41',
      fields: [{
        localId: 'endpoint',
        title: 'Endpoint',
        secret: false,
        value: 'https://snapshot.example',
      }],
    });
  });

  it('uses the declaration default only when the same snapshot has no own value', () => {
    expect(projectAccountSettingsAdministrationSnapshot({
      descriptors,
      hiddenFieldIds: new Set(['endpointByServer']),
      snapshot: { scope: { kind: 'account' }, revision: '42', values: {} },
    }).fields).toEqual([{
      localId: 'endpoint',
      title: 'Endpoint',
      secret: false,
      value: 'https://default.example',
    }]);
  });
});
