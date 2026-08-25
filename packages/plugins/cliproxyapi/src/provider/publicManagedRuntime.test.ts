import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type {
  ConnectedAccountsService,
  PluginConnectedAccountBindingSummary,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ManagedProviderRuntime,
} from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';

import { CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME } from './publicManagedRuntime.js';

type ManagedPurpose = 'openai-upstream' | 'anthropic-upstream';

const managedPurposeFamilies = Object.freeze([
  Object.freeze({
    id: 'codex',
    provider: 'codex',
    purpose: 'openai-upstream' as const,
    allowedHttpsOrigin: 'https://chatgpt.com',
    protocols: Object.freeze(['openai-chat', 'openai-responses']),
    endpointTemplateIds: Object.freeze([
      'cliproxyapi-openai-responses',
      'cliproxyapi-openai-chat',
    ]),
  }),
  Object.freeze({
    id: 'claude',
    provider: 'claude',
    purpose: 'anthropic-upstream' as const,
    allowedHttpsOrigin: 'https://api.anthropic.com',
    protocols: Object.freeze(['anthropic']),
    endpointTemplateIds: Object.freeze(['cliproxyapi-anthropic']),
  }),
]);

const healthySnapshot = Object.freeze({
  id: 'cliproxyapi-managed',
  state: 'healthy',
  mode: 'spawn',
  baseUrl: 'http://127.0.0.1:45123',
  startedAtMs: 1,
  lastHealthyAtMs: 2,
  diagnostics: Object.freeze([]),
  diagnosticsTruncated: false,
} satisfies ManagedServiceSnapshot);

function bindingFor(purpose: ManagedPurpose): PluginConnectedAccountBindingSummary {
  const service = purpose === 'openai-upstream'
    ? Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      })
    : Object.freeze({
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      });
  return Object.freeze({
    purpose,
    service,
    account: Object.freeze({
      service,
      accountId: `${purpose}-account`,
    }),
    target: Object.freeze({ kind: 'account' as const, displayName: purpose }),
  });
}

function connectedAccounts(boundPurposes: readonly ManagedPurpose[]): Readonly<{
  service: ConnectedAccountsService;
  getBinding: ReturnType<typeof vi.fn<ConnectedAccountsService['getBinding']>>;
}> {
  const bound = new Set(boundPurposes);
  const getBinding = vi.fn<ConnectedAccountsService['getBinding']>(async (purpose) => (
    purpose === 'openai-upstream' || purpose === 'anthropic-upstream'
      ? (bound.has(purpose) ? bindingFor(purpose) : null)
      : null
  ));
  return Object.freeze({
    getBinding,
    service: Object.freeze({
      getBinding,
      async requestSelection() {
        throw new Error('selection is unavailable during managed start');
      },
      async materialize() {
        throw new Error('materialization is unavailable during managed start');
      },
      async listAccounts() {
        throw new Error('account listing is unavailable during managed start');
      },
      async materializeListedAccount() {
        throw new Error('exact-listed materialization is unavailable during managed start');
      },
      watch() { return Object.freeze({ dispose() {} }); },
    }) satisfies ConnectedAccountsService,
  });
}

function healthyIdentity(boundPurposes: readonly ManagedPurpose[]) {
  const families = managedPurposeFamilies.filter((family) => (
    boundPurposes.includes(family.purpose)
  ));
  return Object.freeze({
    v: 1,
    contractVersion: 'happier.cliproxyapi-managed/v1',
    sdkVersion: 'v7.2.95',
    wrapperBuildVersion: 'cliproxyapi-test-build',
    protocols: families.flatMap((family) => family.protocols),
    purposes: families.map((family) => Object.freeze({
      consumer: Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      }),
      purpose: family.purpose,
    })),
    modelListEnabled: true,
  });
}

function healthResponse(boundPurposes: readonly ManagedPurpose[]): ManagedServiceResponse {
  return Object.freeze({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: new Response(JSON.stringify(healthyIdentity(boundPurposes))).body,
  });
}

function managedService(boundPurposes: readonly ManagedPurpose[]): ManagedServiceHandle {
  return Object.freeze({
    snapshot: () => healthySnapshot,
    observe: vi.fn(() => Object.freeze({ dispose() {} })),
    waitUntilHealthy: vi.fn(async () => healthySnapshot),
    request: vi.fn(async () => healthResponse(boundPurposes)),
    stop: vi.fn(async () => Object.freeze({ status: 'stopped' as const })),
    dispose: vi.fn(async () => undefined),
  });
}

const requestedEndpointTemplateIds = Object.freeze([
  'cliproxyapi-openai-responses',
  'cliproxyapi-openai-chat',
  'cliproxyapi-anthropic',
]);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MANAGED_RUNTIME_ROOT = join(PACKAGE_ROOT, 'managed-runtime');
const MANAGED_PURPOSE_CONFIGURATION_ENV =
  'HAPPIER_CLIPROXYAPI_MANAGED_PURPOSE_CONFIGURATION';
const DOWNSTREAM_BEARER_ENV = 'HAPPIER_CLIPROXYAPI_DOWNSTREAM_BEARER';
const REQUEST_AUTH_CAPABILITY_PATH_ENV =
  'HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH';
const DOWNSTREAM_BEARER = 'cliproxyapi-composed-downstream-bearer';

type ChildExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type DeclaredPurpose = Readonly<{
  consumer: Readonly<{ pluginId: string; localId: string }>;
  purpose: string;
  protocols: readonly string[];
}>;

type SpawnedManagedWrapper = Readonly<{
  handle: ManagedServiceHandle;
  purposeConfiguration: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readDeclaredPurposes(purposeConfiguration: string): readonly DeclaredPurpose[] {
  const parsed: unknown = JSON.parse(purposeConfiguration);
  if (!isRecord(parsed) || parsed.v !== 2 || !Array.isArray(parsed.purposes)) {
    throw new Error('managed purpose declaration is invalid');
  }
  return Object.freeze(parsed.purposes.map((value) => {
    if (!isRecord(value) || !isRecord(value.consumer)
      || typeof value.consumer.pluginId !== 'string'
      || typeof value.consumer.localId !== 'string'
      || typeof value.purpose !== 'string'
      || !Array.isArray(value.protocols)
      || value.protocols.some((protocol) => typeof protocol !== 'string')) {
      throw new Error('managed purpose declaration row is invalid');
    }
    return Object.freeze({
      consumer: Object.freeze({
        pluginId: value.consumer.pluginId,
        localId: value.consumer.localId,
      }),
      purpose: value.purpose,
      protocols: Object.freeze([...value.protocols]),
    });
  }));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const rejectOnce = (error: Error): void => {
      server.off('error', rejectOnce);
      rejectListen(error);
    };
    server.once('error', rejectOnce);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectOnce);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test HTTP server did not receive a loopback port');
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

function awaitChildExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(Object.freeze({
      code: child.exitCode,
      signal: child.signalCode,
    }));
  }
  return new Promise((resolveExit) => {
    let settled = false;
    const resolveOnce = (result: ChildExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(result);
    };
    child.once('exit', (code, signal) => {
      resolveOnce(Object.freeze({ code, signal }));
    });
    child.once('error', () => {
      resolveOnce(Object.freeze({ code: null, signal: null }));
    });
  });
}

async function buildManagedWrapper(root: string): Promise<string> {
  const operatingSystem = process.platform === 'win32'
    ? 'windows'
    : process.platform;
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
  if (
    (operatingSystem !== 'darwin' && operatingSystem !== 'linux'
      && operatingSystem !== 'windows')
    || (architecture !== 'amd64' && architecture !== 'arm64')
  ) {
    throw new Error(
      `CLIProxyAPI composed wrapper test does not support ${process.platform}/${process.arch}`,
    );
  }
  const executable = join(
    root,
    `happier-cliproxyapi-managed${operatingSystem === 'windows' ? '.exe' : ''}`,
  );
  const child = spawn('go', [
    '-C',
    MANAGED_RUNTIME_ROOT,
    'run',
    './tools/build',
    '--target',
    `${operatingSystem}-${architecture}`,
    '--output',
    executable,
  ], {
    env: {
      ...process.env,
      HAPPIER_VERSION: 'cliproxyapi-composed-test',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exit = await awaitChildExit(child);
  if (exit.code !== 0) {
    throw new Error(
      `build managed CLIProxyAPI wrapper exited ${String(exit.code)} ${stderr}`,
    );
  }
  return executable;
}

async function spawnManagedWrapper(input: Readonly<{
  executable: string;
  spec: Parameters<ManagedServices['supervise']>[0];
  capabilityPath: string;
  outboundProxyPort: number;
}>): Promise<SpawnedManagedWrapper> {
  if (input.spec.mode.kind !== 'spawn') {
    throw new Error('CLIProxyAPI managed runtime must use the spawn mode');
  }
  const purposeConfiguration = input.spec.mode.launch.env[
    MANAGED_PURPOSE_CONFIGURATION_ENV
  ];
  if (typeof purposeConfiguration !== 'string') {
    throw new Error('CLIProxyAPI managed runtime did not emit its purpose declaration');
  }
  const portServer = createServer();
  const port = await listen(portServer);
  await close(portServer);
  const baseUrl = `http://127.0.0.1:${port}`;
  let startupError: Error | null = null;
  const child = spawn(input.executable, [], {
    env: {
      ...process.env,
      // This exact producer-owned value is what the real wrapper consumes.
      ...input.spec.mode.launch.env,
      PORT: String(port),
      [DOWNSTREAM_BEARER_ENV]: DOWNSTREAM_BEARER,
      [REQUEST_AUTH_CAPABILITY_PATH_ENV]: input.capabilityPath,
      HTTP_PROXY: `http://127.0.0.1:${input.outboundProxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${input.outboundProxyPort}`,
      http_proxy: `http://127.0.0.1:${input.outboundProxyPort}`,
      https_proxy: `http://127.0.0.1:${input.outboundProxyPort}`,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.once('error', (error) => {
    startupError = error;
  });
  const exit = awaitChildExit(child);
  let disposed = false;
  const snapshot = (): ManagedServiceSnapshot => Object.freeze({
    id: 'cliproxyapi-managed',
    state: 'healthy',
    mode: 'spawn',
    baseUrl,
    startedAtMs: 1,
    lastHealthyAtMs: 1,
    diagnostics: Object.freeze([]),
    diagnosticsTruncated: false,
  } satisfies ManagedServiceSnapshot);
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exit, delay(10_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exit;
      }
    }
  };
  const handle = Object.freeze({
    snapshot,
    observe() {
      return Object.freeze({ dispose() {} });
    },
    async waitUntilHealthy(options) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (options?.signal?.aborted) {
          throw options.signal.reason ?? new Error('managed wrapper health was aborted');
        }
        if (startupError !== null) throw startupError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `managed CLIProxyAPI wrapper exited before health ${String(child.exitCode)} ${stderr}`,
          );
        }
        try {
          const response = await fetch(`${baseUrl}/healthz`, {
            signal: options?.signal,
          });
          await response.body?.cancel();
          if (response.status === 200) return snapshot();
        } catch (error) {
          if (options?.signal?.aborted) throw error;
        }
        await delay(25);
      }
      throw new Error(`managed CLIProxyAPI wrapper did not become healthy ${stderr}`);
    },
    async request(request) {
      const response = await fetch(new URL(request.pathAndQuery, baseUrl), {
        method: request.method ?? 'GET',
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      });
      return Object.freeze({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.freeze(Object.fromEntries(response.headers.entries())),
        body: response.body,
      } satisfies ManagedServiceResponse);
    },
    async stop() {
      await dispose();
      return Object.freeze({ status: 'stopped' as const });
    },
    dispose,
  } satisfies ManagedServiceHandle);
  return Object.freeze({ handle, purposeConfiguration });
}

async function responseStatus(
  service: ManagedServiceHandle,
  pathAndQuery: string,
  method: 'GET' | 'POST',
): Promise<number> {
  const response = await service.request({
    pathAndQuery,
    method,
    headers: Object.freeze({
      authorization: `Bearer ${DOWNSTREAM_BEARER}`,
      'content-type': 'application/json',
    }),
    body: method === 'POST' ? new TextEncoder().encode('{}') : undefined,
  });
  await response.body?.cancel();
  return response.status;
}

async function catalogModelIds(service: ManagedServiceHandle): Promise<readonly string[]> {
  const response = await service.request({
    pathAndQuery: '/v1/models',
    method: 'GET',
    headers: Object.freeze({ authorization: `Bearer ${DOWNSTREAM_BEARER}` }),
  });
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new Error(`managed wrapper catalog status = ${response.status}`);
  }
  const parsed: unknown = await new Response(response.body).json();
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new Error('managed wrapper catalog has an invalid shape');
  }
  return Object.freeze(parsed.data.map((row) => {
    if (!isRecord(row) || typeof row.id !== 'string') {
      throw new Error('managed wrapper catalog row has no model id');
    }
    return row.id;
  }));
}

async function healthIdentity(service: ManagedServiceHandle): Promise<unknown> {
  const response = await service.request({ pathAndQuery: '/healthz', method: 'GET' });
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new Error(`managed wrapper health status = ${response.status}`);
  }
  return new Response(response.body).json();
}

describe('CLIProxyAPI managed runtime bound-purpose launch snapshot', () => {
  it.each([
    {
      name: 'OpenAI only',
      boundPurposes: ['openai-upstream'] as const,
      expectedEndpointTemplateIds: [
        'cliproxyapi-openai-responses',
        'cliproxyapi-openai-chat',
      ],
    },
    {
      name: 'Claude only',
      boundPurposes: ['anthropic-upstream'] as const,
      expectedEndpointTemplateIds: ['cliproxyapi-anthropic'],
    },
    {
      name: 'both families',
      boundPurposes: ['openai-upstream', 'anthropic-upstream'] as const,
      expectedEndpointTemplateIds: [
        'cliproxyapi-openai-responses',
        'cliproxyapi-openai-chat',
        'cliproxyapi-anthropic',
      ],
    },
  ] as const)('derives $name serving facts from one non-secret purpose snapshot', async ({
    boundPurposes,
    expectedEndpointTemplateIds,
  }) => {
    const accounts = connectedAccounts(boundPurposes);
    const service = managedService(boundPurposes);
    const supervise = vi.fn<ManagedServices['supervise']>(async () => service);
    const signal = new AbortController().signal;

    const result = await CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME.start({
      reason: 'explicitStartLocal',
      endpointTemplateIds: requestedEndpointTemplateIds,
    }, {
      connectedAccounts: accounts.service,
      managedServices: Object.freeze({
        dependencies: Object.freeze({}) as never,
        supervise,
      }),
      signal,
    });

    const purposeConfiguration = JSON.stringify({
      v: 2,
      modelListEnabled: true,
      purposes: managedPurposeFamilies.filter((family) => (
        boundPurposes.includes(family.purpose)
      )).map((family) => ({
        id: family.id,
        provider: family.provider,
        consumer: {
          pluginId: 'happier.provider.cliproxyapi',
          localId: 'cliproxyapi',
        },
        purpose: family.purpose,
        allowedHttpsOrigin: family.allowedHttpsOrigin,
        protocols: family.protocols,
      })),
    });
    expect(accounts.getBinding).toHaveBeenNthCalledWith(
      1,
      'openai-upstream',
      { signal },
    );
    expect(accounts.getBinding).toHaveBeenNthCalledWith(
      2,
      'anthropic-upstream',
      { signal },
    );
    expect(accounts.getBinding).toHaveBeenCalledTimes(2);
    expect(supervise).toHaveBeenCalledWith(expect.objectContaining({
      mode: expect.objectContaining({
        launch: expect.objectContaining({
          // The host materializes this exact path: the native CLI payload stages
          // it and the npm CLI postinstall extracts it into the same runtime
          // root, then records it in the canonical runtime-asset manifest.
          executable: {
            kind: 'packaged-runtime-binary',
            directorySegments: ['tools', 'unpacked'],
            executableBaseName: 'happier-cliproxyapi-managed',
          },
          env: {
            HOST: '127.0.0.1',
            HAPPIER_CLIPROXYAPI_MANAGED_PURPOSE_CONFIGURATION:
              purposeConfiguration,
          },
        }),
      }),
    }), { signal });
    expect(JSON.stringify(supervise.mock.calls[0]?.[0]))
      .not.toContain('-account');
    expect(service.request).toHaveBeenCalledOnce();
    expect(result.endpoints.map((endpoint) => endpoint.endpointTemplateId))
      .toEqual(expectedEndpointTemplateIds);
  });

  it('composes the TypeScript declaration with the real wrapper for sparse bound purposes', async () => {
    const accounts = connectedAccounts([]);
    const signal = new AbortController().signal;
    let forbiddenBindOrStateCreationCount = 0;

    await expect(CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME.start({
      reason: 'explicitStartLocal',
      endpointTemplateIds: requestedEndpointTemplateIds,
    }, {
      connectedAccounts: accounts.service,
      managedServices: Object.freeze({
        dependencies: Object.freeze({}) as never,
        async supervise() {
          forbiddenBindOrStateCreationCount += 1;
          throw new Error('a zero-bound start must not create managed state');
        },
      }),
      signal,
    })).rejects.toThrow('requires at least one bound Connected Account purpose');

    expect(accounts.getBinding).toHaveBeenCalledTimes(2);
    expect(forbiddenBindOrStateCreationCount).toBe(0);

    const root = await mkdtemp(join(tmpdir(), 'happier-cliproxyapi-composed-'));
    try {
      const executable = await buildManagedWrapper(root);
      for (const testCase of [
        {
          name: 'OpenAI only',
          boundPurposes: ['openai-upstream'] as const,
          expectedEndpointTemplateIds: [
            'cliproxyapi-openai-responses',
            'cliproxyapi-openai-chat',
          ],
          boundModelId: 'gpt-5.5',
          unboundModelId: 'claude-sonnet-4-6',
          excludedRoutes: [
            '/v1/messages',
            '/v1/messages/count_tokens',
          ],
        },
        {
          name: 'Claude only',
          boundPurposes: ['anthropic-upstream'] as const,
          expectedEndpointTemplateIds: ['cliproxyapi-anthropic'],
          boundModelId: 'claude-sonnet-4-6',
          unboundModelId: 'gpt-5.5',
          excludedRoutes: [
            '/v1/responses',
            '/v1/chat/completions',
          ],
        },
      ] as const) {
        const requestAuthEffects = { count: 0 };
        const requestAuthServer = createServer((_request, response) => {
          requestAuthEffects.count += 1;
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error: { code: 'unexpected' } }));
        });
        const outboundEffects = { count: 0 };
        const outboundProxy = createServer((_request, response) => {
          outboundEffects.count += 1;
          response.writeHead(502);
          response.end();
        });
        outboundProxy.on('connect', (_request, socket) => {
          outboundEffects.count += 1;
          socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        });
        const requestAuthPort = await listen(requestAuthServer);
        const outboundProxyPort = await listen(outboundProxy);
        const caseRoot = join(root, testCase.name.toLowerCase().replaceAll(' ', '-'));
        const capabilityPath = join(caseRoot, 'request-auth', 'capability.json');
        await mkdir(dirname(capabilityPath), { recursive: true, mode: 0o700 });
        await writeFile(capabilityPath, JSON.stringify({
          v: 2,
          materializationId: `cliproxyapi-composed-${testCase.name}`,
          subjectScopeDigest: 'a'.repeat(64),
          capability: Buffer.alloc(32, 7).toString('base64url'),
          httpPort: requestAuthPort,
        }), { mode: 0o600 });
        if (process.platform !== 'win32') await chmod(capabilityPath, 0o600);

        let wrapper: SpawnedManagedWrapper | null = null;
        try {
          const sparseAccounts = connectedAccounts(testCase.boundPurposes);
          const result = await CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME.start({
            reason: 'explicitStartLocal',
            endpointTemplateIds: requestedEndpointTemplateIds,
          }, {
            connectedAccounts: sparseAccounts.service,
            managedServices: Object.freeze({
              dependencies: Object.freeze({}) as never,
              async supervise(spec) {
                wrapper = await spawnManagedWrapper({
                  executable,
                  spec,
                  capabilityPath,
                  outboundProxyPort,
                });
                return wrapper.handle;
              },
            }),
            signal,
          });
          if (wrapper === null) throw new Error('managed wrapper was never supervised');

          const declaredPurposes = readDeclaredPurposes(wrapper.purposeConfiguration);
          const actualHealthIdentity = await healthIdentity(result.service);
          if (!isRecord(actualHealthIdentity)) {
            throw new Error('managed wrapper health identity is invalid');
          }
          expect(actualHealthIdentity.protocols).toEqual(
            declaredPurposes.flatMap((purpose) => purpose.protocols),
          );
          expect(actualHealthIdentity.purposes).toEqual(
            declaredPurposes.map((purpose) => ({
              consumer: purpose.consumer,
              purpose: purpose.purpose,
            })),
          );
          expect(actualHealthIdentity.modelListEnabled).toBe(true);
          expect(result.endpoints.map((endpoint) => endpoint.endpointTemplateId))
            .toEqual(testCase.expectedEndpointTemplateIds);

          const modelIds = await catalogModelIds(result.service);
          expect(modelIds).toContain(testCase.boundModelId);
          expect(modelIds).not.toContain(testCase.unboundModelId);
          for (const excludedRoute of testCase.excludedRoutes) {
            expect(await responseStatus(result.service, excludedRoute, 'POST')).toBe(404);
          }
          expect(requestAuthEffects.count).toBe(0);
          expect(outboundEffects.count).toBe(0);
        } finally {
          await wrapper?.handle.dispose();
          await close(requestAuthServer);
          await close(outboundProxy);
        }
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
    // Budget derived from the two measured terms, not from a round number. `buildManagedWrapper`
    // compiles the Go wrapper in-test: 85.9 s against an empty GOCACHE and 37.7 s against a warm
    // one, both under heavy parallel load. Driving the built wrapper for both families adds ~30 s.
    // Worst measured total is therefore ~116 s, which the previous 120 s budget cleared by 3% --
    // it timed out under parallel suite load and passed at 115.2 s alone. 300 s is ~2.6x the
    // worst measurement and still bounds a wrapper that never becomes ready.
  }, 300_000);
});
