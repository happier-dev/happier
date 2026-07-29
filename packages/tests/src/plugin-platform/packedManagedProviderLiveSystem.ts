import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import type {
  PackedManagedProviderPreparedInput,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import { reserveAvailablePort } from '../testkit/network/reserveAvailablePort';
import {
  spawnLoggedProcess,
  type SpawnedProcess,
} from '../testkit/process/spawnProcess';
import { waitFor } from '../testkit/timing';
import type {
  PackedManagedProviderActivationFailureObservation,
  PackedManagedProviderFreshSpawnObservation,
  PackedManagedProviderLiveSystem,
  PackedManagedProviderWrapperObservation,
} from './packedManagedProviderLiveScenario';

const DOWNSTREAM_BEARER = 'packed-managed-downstream-bearer';
const CREDENTIAL_SENTINELS = Object.freeze([
  'packed-openai-api-key-sentinel',
  'packed-codex-api-key-sentinel',
  'packed-anthropic-api-key-sentinel',
  'packed-anthropic-auth-token-sentinel',
  'packed-claude-oauth-token-sentinel',
  'packed-management-password-sentinel',
  'packed-request-auth-capability-sentinel',
]);

type ManagedComposedRuntime = Readonly<{
  probeFreshManagedSpawn(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderFreshSpawnObservation>;
  probeActivationFailureCleanup(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderActivationFailureObservation>;
  cleanup(): Promise<void>;
}>;

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

function minimalWrapperEnvironment(
  port: number,
  upstreamProxyUrl: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    HOST: '127.0.0.1',
    PORT: String(port),
    HTTPS_PROXY: upstreamProxyUrl,
    https_proxy: upstreamProxyUrl,
    OPENAI_API_KEY: CREDENTIAL_SENTINELS[0],
    CODEX_API_KEY: CREDENTIAL_SENTINELS[1],
    ANTHROPIC_API_KEY: CREDENTIAL_SENTINELS[2],
    ANTHROPIC_AUTH_TOKEN: CREDENTIAL_SENTINELS[3],
    CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL_SENTINELS[4],
    MANAGEMENT_PASSWORD: CREDENTIAL_SENTINELS[5],
    HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN: CREDENTIAL_SENTINELS[6],
  };
  if (process.platform === 'win32') {
    for (const name of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) {
      if (process.env[name]) result[name] = process.env[name];
    }
  } else if (process.env.TMPDIR) {
    result.TMPDIR = process.env.TMPDIR;
  }
  return result;
}

async function startCountingRefusalServer(
  port: number,
): Promise<Readonly<{ count: () => number; stop: () => Promise<void> }>> {
  let count = 0;
  const sockets = new Set<import('node:stream').Duplex>();
  const server = createServer((_request, response) => {
    count += 1;
    response.statusCode = 503;
    response.end('unavailable');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    count: () => count,
    stop: async () => {
      const closed = once(server, 'close').catch(() => {});
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

async function startCountingUpstreamProxy(
  port: number,
): Promise<Readonly<{
  url: string;
  count: () => number;
  stop: () => Promise<void>;
}>> {
  let count = 0;
  const sockets = new Set<import('node:stream').Duplex>();
  const server: Server = createServer((_request, response) => {
    count += 1;
    response.statusCode = 502;
    response.end();
  });
  server.on('connect', (_request, socket) => {
    count += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => count,
    stop: async () => {
      const closed = once(server, 'close').catch(() => {});
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

async function readResponseBody(response: Response): Promise<string> {
  return (await response.text()).slice(0, 512 * 1024);
}

async function fetchWithBearer(
  url: string,
  params: Readonly<{
    method?: 'GET' | 'POST';
    bearer?: string;
    body?: string;
  }> = {},
): Promise<Readonly<{ status: number; body: string }>> {
  const response = await fetch(url, {
    method: params.method ?? 'GET',
    headers: {
      ...(params.bearer
        ? { Authorization: `Bearer ${params.bearer}` }
        : {}),
      ...(params.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(params.body ? { body: params.body } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await readResponseBody(response) };
}

async function listFilesRecursively(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.push(path);
    }
  };
  await visit(root);
  return result.sort();
}

function containsCredentialSentinel(value: string): boolean {
  return [...CREDENTIAL_SENTINELS, DOWNSTREAM_BEARER]
    .some((sentinel) => value.includes(sentinel));
}

function containsExpectedReadinessLine(stdout: string): boolean {
  return stdout.split(/\r?\n/u).some((line) => {
    try {
      const value = JSON.parse(line) as {
        contractVersion?: unknown;
        sdkVersion?: unknown;
        protocols?: unknown;
        purposes?: unknown;
      };
      return Object.keys(value).length === 4
        && value.contractVersion === 'happier.cliproxyapi-managed/v1'
        && value.sdkVersion === 'v7.2.95'
        && Array.isArray(value.protocols)
        && value.protocols.length === 1
        && value.protocols[0] === 'openai-responses'
        && Array.isArray(value.purposes)
        && value.purposes.length === 1
        && typeof value.purposes[0] === 'object'
        && value.purposes[0] !== null
        && (value.purposes[0] as {
          consumer?: { pluginId?: unknown; localId?: unknown };
          purpose?: unknown;
        }).consumer?.pluginId === 'happier.provider.cliproxyapi'
        && (value.purposes[0] as {
          consumer?: { pluginId?: unknown; localId?: unknown };
          purpose?: unknown;
        }).consumer?.localId === 'cliproxyapi'
        && (value.purposes[0] as { purpose?: unknown }).purpose
          === 'openai-upstream';
    } catch {
      return false;
    }
  });
}

async function stopTrackedProcess(processes: Set<SpawnedProcess>, proc: SpawnedProcess): Promise<void> {
  try {
    await proc.stop();
  } finally {
    processes.delete(proc);
  }
}

async function probePackagedWrapper(
  input: PackedManagedProviderPreparedInput,
  processes: Set<SpawnedProcess>,
): Promise<PackedManagedProviderWrapperObservation> {
  const root = join(input.prepared.standaloneCliArtifact.extractRoot, 'wrapper-conformance');
  const runtimeDir = join(root, 'runtime');
  const capabilityPath = join(root, 'request-auth-capability.json');
  const configPath = join(root, 'managed-runtime.json');
  const stdoutPath = join(root, 'wrapper.stdout.log');
  const stderrPath = join(root, 'wrapper.stderr.log');
  await rm(root, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const isolatedPorts: number[] = [];
  while (isolatedPorts.length < 3) {
    const port = await reserveAvailablePort();
    if (port !== 8317 && !isolatedPorts.includes(port)) {
      isolatedPorts.push(port);
    }
  }
  const [daemonPort, wrapperPort, upstreamProxyPort] =
    isolatedPorts as [number, number, number];
  await writePrivateJson(configPath, {
    v: 1,
    materializationId: 'packed-materialization',
    wrapperBuildVersion: input.prepared.candidate.cli.version,
    gateway: {
      downstreamBearer: DOWNSTREAM_BEARER,
      runtimeDir,
      authEntries: [{
        id: 'codex',
        provider: 'codex',
        purpose: {
          consumer: {
            pluginId: 'happier.provider.cliproxyapi',
            localId: 'cliproxyapi',
          },
          purpose: 'openai-upstream',
        },
      }],
      protocols: ['openai-responses'],
      modelListEnabled: true,
    },
    requestAuth: {
      capabilityPath,
    },
  });

  const requestAuthBoundary = await startCountingRefusalServer(daemonPort);
  const upstreamBoundary = await startCountingUpstreamProxy(
    upstreamProxyPort,
  ).catch(async (error) => {
    await requestAuthBoundary.stop();
    throw error;
  });
  let proc: SpawnedProcess;
  try {
    proc = spawnLoggedProcess({
      command: input.prepared.wrapperExecutable,
      args: ['--config', configPath],
      cwd: root,
      env: minimalWrapperEnvironment(wrapperPort, upstreamBoundary.url),
      stdoutPath,
      stderrPath,
      cleanupDescendantsOnExit: true,
    });
  } catch (error) {
    await Promise.all([
      requestAuthBoundary.stop(),
      upstreamBoundary.stop(),
    ]);
    throw error;
  }
  processes.add(proc);
  let health = { status: 0, body: '' };
  let model = { status: 0, body: '' };
  let management = { status: 0, body: '' };
  let preactivation = { status: 0, body: '' };
  try {
    await waitFor(async () => {
      try {
        health = await fetchWithBearer(`http://127.0.0.1:${wrapperPort}/healthz`);
        return health.status === 200;
      } catch {
        return false;
      }
    }, {
      timeoutMs: 15_000,
      intervalMs: 50,
      context: 'packaged CLIProxyAPI wrapper readiness',
    });
    model = await fetchWithBearer(
      `http://127.0.0.1:${wrapperPort}/v1/models`,
      { bearer: DOWNSTREAM_BEARER },
    );
    management = await fetchWithBearer(
      `http://127.0.0.1:${wrapperPort}/v0/management/config`,
      { bearer: DOWNSTREAM_BEARER },
    );
    preactivation = await fetchWithBearer(
      `http://127.0.0.1:${wrapperPort}/v1/responses`,
      {
        method: 'POST',
        bearer: DOWNSTREAM_BEARER,
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'must fail before capability activation',
        }),
      },
    );
  } finally {
    await stopTrackedProcess(processes, proc);
    await Promise.all([
      requestAuthBoundary.stop(),
      upstreamBoundary.stop(),
    ]);
  }

  const [stdout, stderr, runtimeEntries] = await Promise.all([
    readFile(stdoutPath, 'utf8'),
    readFile(stderrPath, 'utf8'),
    listFilesRecursively(runtimeDir),
  ]);
  const healthIdentity = JSON.parse(health.body) as {
    wrapperBuildVersion?: unknown;
    contractVersion?: unknown;
    sdkVersion?: unknown;
    materializationId?: unknown;
    protocols?: unknown;
    purposes?: unknown;
    modelListEnabled?: unknown;
  };
  const capabilityFileCreated = (await listFilesRecursively(root))
    .includes(capabilityPath);
  const credentialSentinelObserved = [stdout, stderr, health.body]
    .some(containsCredentialSentinel)
    || (await Promise.all(runtimeEntries.map(async (path) =>
      containsCredentialSentinel(await readFile(path, 'utf8')))))
      .some(Boolean);

  return {
    buildVersion:
      typeof healthIdentity.wrapperBuildVersion === 'string'
        ? healthIdentity.wrapperBuildVersion
        : '',
    contractVersion:
      typeof healthIdentity.contractVersion === 'string'
        ? healthIdentity.contractVersion
        : '',
    sdkVersion:
      typeof healthIdentity.sdkVersion === 'string'
        ? healthIdentity.sdkVersion
        : '',
    materializationId:
      typeof healthIdentity.materializationId === 'string'
        ? healthIdentity.materializationId
        : '',
    protocolCount:
      Array.isArray(healthIdentity.protocols)
        ? healthIdentity.protocols.length
        : 0,
    purposeCount:
      Array.isArray(healthIdentity.purposes)
        ? healthIdentity.purposes.length
        : 0,
    modelListEnabled: healthIdentity.modelListEnabled === true,
    readinessIdentityMatched: containsExpectedReadinessLine(stdout),
    healthStatus: health.status,
    modelStatus: model.status,
    managementStatus: management.status,
    preactivationStatus: preactivation.status,
    capabilityFileCreated,
    requestAuthRequests: requestAuthBoundary.count(),
    upstreamRequests: upstreamBoundary.count(),
    credentialSentinelObserved,
    runtimeEntriesAfterStop: runtimeEntries,
    wrapperStopped: proc.child.exitCode !== null || proc.child.signalCode !== null,
  };
}

async function loadManagedComposedRuntime(): Promise<ManagedComposedRuntime> {
  const module = await import('./packedManagedProviderComposedRuntime');
  return await module.startPackedManagedProviderComposedRuntime();
}

export function createCanonicalPackedManagedProviderLiveSystem():
PackedManagedProviderLiveSystem {
  const processes = new Set<SpawnedProcess>();
  let composedRuntime: ManagedComposedRuntime | null = null;
  const requireComposedRuntime = async (): Promise<ManagedComposedRuntime> => {
    composedRuntime ??= await loadManagedComposedRuntime();
    return composedRuntime;
  };
  return {
    probePackagedWrapper: async (input) =>
      await probePackagedWrapper(input, processes),
    probeFreshManagedSpawn: async (input) =>
      await (await requireComposedRuntime()).probeFreshManagedSpawn(input),
    probeActivationFailureCleanup: async (input) =>
      await (await requireComposedRuntime()).probeActivationFailureCleanup(input),
    cleanup: async () => {
      const errors: unknown[] = [];
      if (composedRuntime) {
        try {
          await composedRuntime.cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const proc of [...processes]) {
        try {
          await stopTrackedProcess(processes, proc);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'packed managed live cleanup failed');
      }
    },
  };
}
