import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import type {
  ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import {
  createPluginStateStore,
  writeCommittedLocalPathPluginFixture,
} from '@/plugins/store/state.testkit';
import { PluginStateInstallRecordSchema } from '@/plugins/store/state';
import { createSelectedPluginOptionalAccess } from '@/plugins/daemon/optionalAccessSelections';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type {
  PinnedHttpStreamRequest,
  PinnedHttpStreamResponse,
} from '@/network/pinnedHttp';

const filesystemBoundary = vi.hoisted(() => ({
  retiredMarkerPath: '',
  retiredMarkerContents: '',
  retiredMarkerChecks: 0,
  retireAfterAdmission: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>) {
      const [path] = args;
      if (
        filesystemBoundary.retireAfterAdmission
        && String(path) === filesystemBoundary.retiredMarkerPath
      ) {
        filesystemBoundary.retiredMarkerChecks += 1;
        if (filesystemBoundary.retiredMarkerChecks === 2) {
          await actual.writeFile(
            filesystemBoundary.retiredMarkerPath,
            filesystemBoundary.retiredMarkerContents,
            'utf8',
          );
        }
      }
      return await actual.lstat(...args);
    },
  };
});

// Keep the resolver's generated artifact boundary real, but narrow it to one
// generated bundled package that this external runtime does not activate.
vi.mock('../projection/registry/sources/generatedBundledPluginArtifacts', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../projection/registry/sources/generatedBundledPluginArtifacts')
  >();
  const artifact = actual.BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find(
    (candidate) => candidate.record.pluginId === 'happier.scm.backend.git',
  );
  if (!artifact) throw new Error('Expected the generated omitted SCM artifact');
  return {
    BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS: Object.freeze([artifact]),
  };
});

vi.mock('../projection/registry/sources/generatedBundledPlugins', () => ({
  BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS: Object.freeze([]),
}));
vi.mock('../projection/registry/sources/generatedBundledPluginManifests', () => ({
  BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: Object.freeze([]),
  BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: Object.freeze([]),
}));

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const temporaryDirectories: string[] = [];
const FIXTURE_AGENT_ID = 'fixture-agent';
const FIXTURE_MCP_ACCESS_ID = 'fixture-mcp';
const FIXTURE_MCP_SERVER_ID = 'fixture-tools';
const FIXTURE_MCP_SUBSCRIPTIONS_GLOBAL = '__happier_fixture_mcp_subscriptions__';
const FIXTURE_VALIDATED_ADDRESS = '203.0.114.10';

function createFixtureNetworkDependencies() {
  const resolveNetworkAddresses = vi.fn(async (hostname: string) => {
    if (hostname !== 'tenant.example.test') {
      throw new Error(`Unexpected DNS lookup for ${hostname}`);
    }
    return Object.freeze([FIXTURE_VALIDATED_ADDRESS]);
  });
  const openPinnedStream = vi.fn(async (request: PinnedHttpStreamRequest) => {
    if (!request.validatedAddresses.includes(FIXTURE_VALIDATED_ADDRESS)) {
      throw new Error('Pinned HTTP fixture did not receive the admitted address');
    }
    const bytes = new TextEncoder().encode('{}');
    let delivered = false;
    return Object.freeze({
      status: 200,
      headers: Object.freeze({ 'content-type': 'application/json' }),
      contentLength: bytes.byteLength,
      read: async () => {
        if (delivered) return null;
        delivered = true;
        return bytes;
      },
      cancel: () => {},
    }) satisfies PinnedHttpStreamResponse;
  });
  return Object.freeze({ resolveNetworkAddresses, openPinnedStream });
}

type FixtureMcpResourceSubscription = {
  listener: (event: Readonly<{ uri: string }>) => void | Promise<void>;
  disposed: boolean;
};

const fixtureMcpSubscriptions = new Map<string, FixtureMcpResourceSubscription>();

type McpHostAccessRequest = Extract<
  PluginHostAccessRequestV2,
  Readonly<{ capability: 'mcp' }>
>;

function fixtureMcpAccessRequest(): McpHostAccessRequest {
  return {
    id: FIXTURE_MCP_ACCESS_ID,
    capability: 'mcp',
    reason: 'Use the fixture MCP server.',
    scope: {
      serverRefs: [FIXTURE_MCP_SERVER_ID],
      discoverySourceRefs: [],
      operations: ['listTools', 'callTools'],
    },
  };
}

async function createTrustedLocalLinkInstall(params: Readonly<{
  pluginId: string;
  sourceRootPath: string;
  manifestVersion: string;
  optionalAccess?: ReturnType<typeof createSelectedPluginOptionalAccess>;
}>) {
  const distribution = await createLocalPathPluginDistributionIdentity(params.sourceRootPath);
  return PluginStateInstallRecordSchema.parse({
    mode: 'link' as const,
    manifestVersion: params.manifestVersion,
    installedPath: null,
    trust: createPluginTrustRecord({
      pluginId: params.pluginId,
      distribution,
      approvedAtMs: 1,
    }),
    ...(params.optionalAccess === undefined
      ? {}
      : { optionalAccess: params.optionalAccess }),
  });
}

async function createFixture(): Promise<Readonly<{
  happyHomeDir: string;
  pluginId: string;
  pluginRoot: string;
}>> {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-currentness-home-'));
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-bundled-currentness-plugin-'));
  temporaryDirectories.push(happyHomeDir, pluginRoot);
  const pluginId = 'acme.bundled-currentness';

  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2,
    id: pluginId,
    version: '1.0.0',
    displayName: 'Bundled currentness fixture',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    hostAccess: {
      required: [{
        id: 'fixture-api',
        capability: 'network',
        reason: 'Complete the configured account connection',
        scope: {
          targets: [{ kind: 'connectedAccountOrigin', service: 'fixture-account' }],
          methods: ['POST'],
        },
      }],
      optional: [],
    },
    contributes: {
      connectedAccountDescriptors: [{
        id: 'fixture-account',
        title: 'Fixture account',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
            configuration: {
              scope: 'service',
              changeBehavior: 'refresh',
              fields: [{
                id: 'api-origin',
                title: 'API origin',
                schema: { type: 'string', minLength: 1 },
                required: true,
                semantic: 'connectedAccountOrigin',
              }],
            },
          }],
        },
      }],
    },
  }), 'utf8');
  await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
    api.connectedAccounts.register('fixture-account', {
      authentication: { modes: { manual: { kind: 'manual', async complete(_input, context) {
        const response = await context.services.http.request({
          url: context.configuration.values['api-origin'] + '/session',
          method: 'POST',
          redirect: 'error',
        });
        if (response.status !== 200) return { status: 'unavailable' };
        return { status: 'connected', accountId: 'fixture-account-id', displayName: 'Fixture account', scopes: [] };
      } } } },
      async refresh() { return { status: 'unavailable' }; },
      async revoke() { return { status: 'remoteUnsupported' }; },
      async status() { return { status: 'connected', displayName: 'Fixture account' }; },
      async materialize() { return { kind: 'environment', env: {} }; },
    });
  }`, 'utf8');

  await writeCommittedLocalPathPluginFixture({
    happyHomeDir,
    pluginId,
    sourceRootPath: pluginRoot,
    plugin: {
      source: {
        kind: 'path',
        locator: pluginRoot,
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        resolvedPath: pluginRoot,
        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
      },
      compatibility: { status: 'unknown', diagnostics: [] },
      install: await createTrustedLocalLinkInstall({
        pluginId,
        sourceRootPath: pluginRoot,
        manifestVersion: '1.0.0',
      }),
      state: { enabled: true },
    },
  });

  return Object.freeze({ happyHomeDir, pluginId, pluginRoot });
}

async function writeNextFixtureGeneration(params: Readonly<{
  happyHomeDir: string;
  pluginId: string;
  pluginRoot: string;
  manifestVersion: string;
  optionalAccess?: ReturnType<typeof createSelectedPluginOptionalAccess>;
}>): Promise<void> {
  const manifestPath = join(params.pluginRoot, '.happier-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(manifestPath, JSON.stringify({
    ...manifest,
    version: params.manifestVersion,
  }), 'utf8');
  await writeCommittedLocalPathPluginFixture({
    happyHomeDir: params.happyHomeDir,
    pluginId: params.pluginId,
    sourceRootPath: params.pluginRoot,
    plugin: {
      source: {
        kind: 'path',
        locator: params.pluginRoot,
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        resolvedPath: params.pluginRoot,
        manifestPath,
      },
      compatibility: { status: 'unknown', diagnostics: [] },
      install: await createTrustedLocalLinkInstall({
        pluginId: params.pluginId,
        sourceRootPath: params.pluginRoot,
        manifestVersion: params.manifestVersion,
        optionalAccess: params.optionalAccess,
      }),
      state: { enabled: true },
    },
  });
}

async function createMcpFixture(): Promise<Readonly<{
  happyHomeDir: string;
  pluginId: string;
  pluginRoot: string;
}>> {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-mcp-currentness-home-'));
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-mcp-currentness-plugin-'));
  const pluginId = 'acme.mcp-currentness';
  temporaryDirectories.push(happyHomeDir, pluginRoot);
  Reflect.set(globalThis, FIXTURE_MCP_SUBSCRIPTIONS_GLOBAL, fixtureMcpSubscriptions);
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2,
    id: pluginId,
    version: '1.0.0',
    displayName: 'MCP currentness fixture',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
    hostAccess: {
      required: [],
      optional: [fixtureMcpAccessRequest()],
    },
    contributes: {
      agents: [{
        id: FIXTURE_AGENT_ID,
        title: 'Fixture Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: {
            open: ['create'],
            delivery: ['newTurn'],
            cancel: true,
          },
        },
      }],
      mcp: {
        servers: [{
          id: FIXTURE_MCP_SERVER_ID,
          title: 'Fixture tools',
          kind: 'dynamic',
        }],
      },
    },
  }), 'utf8');
  await writeFile(join(pluginRoot, 'agentRuntime.mjs'), `export function fixtureAgentRuntimeFactory() {
    return {
      async dispose() {},
      sessions: {
        async open(request) {
          return {
            sessionId: request.sessionId,
            async send() { return { status: 'admitted' }; },
            watch() { return { dispose() {} }; },
            async dispose() {},
          };
        },
      },
    };
  }`, 'utf8');
  await writeFile(join(pluginRoot, 'daemon.mjs'), `import { fixtureAgentRuntimeFactory } from './agentRuntime.mjs';
  const fixtureMcpSubscriptions = Reflect.get(globalThis, ${JSON.stringify(FIXTURE_MCP_SUBSCRIPTIONS_GLOBAL)});
  if (!(fixtureMcpSubscriptions instanceof Map)) throw new Error('Missing fixture MCP subscription registry');
  export function activate(api) {
    api.agents.register(${JSON.stringify(FIXTURE_AGENT_ID)}, fixtureAgentRuntimeFactory, {
      sessionRunnerFactory: {
        module: './agentRuntime.mjs',
        export: 'fixtureAgentRuntimeFactory',
        runtimeApiVersion: 1,
      },
    });
    api.mcp.registerServer(${JSON.stringify(FIXTURE_MCP_SERVER_ID)}, {
      async dispose() {},
      async listTools() {
        return { items: [{ name: 'run', inputSchema: { type: 'object' } }] };
      },
      async callTool() {
        return { ok: true };
      },
      async listResources() {
        return { items: [] };
      },
      async listResourceTemplates() {
        return { items: [] };
      },
      async readResource() {
        return { contents: [] };
      },
      async subscribeResource(_request, listener) {
        const subscription = { listener, disposed: false };
        fixtureMcpSubscriptions.set(${JSON.stringify(pluginId)}, subscription);
        return { async dispose() { subscription.disposed = true; } };
      },
      async listPrompts() {
        return { items: [] };
      },
      async getPrompt() {
        return { messages: [] };
      },
    });
  }`, 'utf8');
  const optionalAccess = createSelectedPluginOptionalAccess({
    pluginId,
    declarations: [fixtureMcpAccessRequest()],
    decisions: [{ accessId: FIXTURE_MCP_ACCESS_ID, selected: true }],
    selectedAtMs: 1,
  });
  await writeCommittedLocalPathPluginFixture({
    happyHomeDir,
    pluginId,
    sourceRootPath: pluginRoot,
    plugin: {
      source: {
        kind: 'path',
        locator: pluginRoot,
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        resolvedPath: pluginRoot,
        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
      },
      compatibility: { status: 'unknown', diagnostics: [] },
      install: await createTrustedLocalLinkInstall({
        pluginId,
        sourceRootPath: pluginRoot,
        manifestVersion: '1.0.0',
        optionalAccess,
      }),
      state: { enabled: true },
    },
  });
  return Object.freeze({ happyHomeDir, pluginId, pluginRoot });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  filesystemBoundary.retiredMarkerPath = '';
  filesystemBoundary.retiredMarkerContents = '';
  filesystemBoundary.retiredMarkerChecks = 0;
  filesystemBoundary.retireAfterAdmission = false;
  fixtureMcpSubscriptions.clear();
  Reflect.deleteProperty(globalThis, FIXTURE_MCP_SUBSCRIPTIONS_GLOBAL);
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('resolveExecutablePluginRuntimeRegistry bundled immutable currentness', () => {
  it('does not let an omitted bundled artifact retire an admitted executable HTTP consumer', async () => {
    const { happyHomeDir, pluginId } = await createFixture();
    const artifact = BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS[0];
    if (!artifact) throw new Error('Expected the generated bundled artifact fixture');
    const networkDependencies = createFixtureNetworkDependencies();

    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }),
      provenance: 'external',
      existingAgentIds: new Set(),
    }));
    const generationAuthority = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    if (!generationAuthority) throw new Error('Expected the durable external generation authority');
    const runtime = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      contributes,
      generationAuthority,
      networkDependencies,
    });
    try {
      const lease = await runtime.resolveConnectedAccountRuntime?.({
        pluginId,
        localId: 'fixture-account',
      });
      if (!lease) throw new Error('Expected a connected-account runtime lease');

      const paths = resolvePluginStorePaths({ happyHomeDir });
      filesystemBoundary.retiredMarkerPath = join(
        paths.generationsDir,
        `.retired-${artifact.record.immutableGenerationId}.v1.json`,
      );
      filesystemBoundary.retiredMarkerContents = JSON.stringify({
        t: 'happier_retired_plugin_generation_v1',
        schemaVersion: 1,
        pluginId: artifact.record.pluginId,
        immutableGenerationId: artifact.record.immutableGenerationId,
      });
      filesystemBoundary.retireAfterAdmission = true;

      const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
        target: Object.freeze({
          kind: 'service',
          service: lease.ref,
          modeId: 'manual',
        }),
        revision: 'configuration-1',
        values: Object.freeze({ 'api-origin': 'https://tenant.example.test' }),
        getSecret: async () => null,
      });
      const result = await runtime.connectedAccountRuntimeInvoker?.invokeAuthentication({
        admission: Object.freeze({
          service: lease.ref,
          descriptor: lease.descriptor.authentication.modes[0]!,
          modeId: 'manual',
          generation: lease.generation,
          immutableGenerationId: lease.immutableGenerationId,
        }),
        operation: Object.freeze({
          kind: 'submitManual',
          fields: Object.freeze({ token: 'fixture-token' }),
        }),
        context: Object.freeze({
          service: lease.ref,
          attempt: Object.freeze({ kind: 'connect', attemptId: 'fixture-attempt-1' }),
          configuration,
          attemptCredentials: Object.freeze({
            get: async () => null,
            set: async () => undefined,
            delete: async () => undefined,
          }),
        }),
        isConfigurationCurrent: () => true,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: 'connected', accountId: 'fixture-account-id' });
      expect(networkDependencies.openPinnedStream).toHaveBeenCalledOnce();
      expect(filesystemBoundary.retiredMarkerChecks).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps a retained G MCP client available under a permissive durable H selection, then narrows it', async () => {
    const { happyHomeDir, pluginId, pluginRoot } = await createMcpFixture();
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }),
      provenance: 'external',
      existingAgentIds: new Set(),
    }));
    const generationAuthority = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    if (!generationAuthority) throw new Error('Expected durable MCP generation authority');
    const runtime = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      contributes,
      generationAuthority,
    });
    try {
      await runtime.activateContributionsOnDemand([{
        pluginId,
        family: 'agents',
        localId: FIXTURE_AGENT_ID,
      }]);
      const binding = runtime.agentRuntimesByAgentId
        .get(`${pluginId}/${FIXTURE_AGENT_ID}`)
        ?.sessionRunnerFactoryBinding;
      if (!binding) throw new Error('Expected fixture Agent runner binding');
      const createCurrentGlobalMcp = runtime.createRetainedRunnerAgentCurrentGlobalMcpService;
      if (!createCurrentGlobalMcp) throw new Error('Expected current-global MCP service factory');
      const mcp = await createCurrentGlobalMcp({
        binding,
        sessionId: 'fixture-mcp-session',
        correlationId: 'fixture-mcp-client',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
      });
      const client = await mcp.connect(
        { pluginId, localId: FIXTURE_MCP_SERVER_ID },
        { elicitation: { mode: 'reject' } },
      );
      try {
        await expect(client.callTool('run', {})).resolves.toEqual({ ok: true });

        await writeNextFixtureGeneration({
          happyHomeDir,
          pluginId,
          pluginRoot,
          manifestVersion: '2.0.0',
          optionalAccess: createSelectedPluginOptionalAccess({
            pluginId,
            declarations: [fixtureMcpAccessRequest()],
            decisions: [{ accessId: FIXTURE_MCP_ACCESS_ID, selected: true }],
            selectedAtMs: 2,
          }),
        });

        await expect(client.callTool('run', {})).resolves.toEqual({ ok: true });

        await createPluginStateStore({ happyHomeDir }).update((current) => {
          const plugin = current.plugins[pluginId];
          if (!plugin) throw new Error('Expected MCP fixture plugin state');
          return {
            ...current,
            plugins: {
              ...current.plugins,
              [pluginId]: {
                ...plugin,
                install: {
                  ...plugin.install,
                  optionalAccess: [],
                },
              },
            },
          };
        });

        await expect(client.callTool('run', {})).rejects.toMatchObject({
          code: 'plugin_final_resource_not_selected',
        });
      } finally {
        await client.dispose();
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('retires a selected MCP resource subscription before a durable selection revocation can deliver an update', async () => {
    const { happyHomeDir, pluginId } = await createMcpFixture();
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }),
      provenance: 'external',
      existingAgentIds: new Set(),
    }));
    const generationAuthority = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    if (!generationAuthority) throw new Error('Expected durable MCP generation authority');
    const runtime = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      contributes,
      generationAuthority,
    });
    try {
      await runtime.activateContributionsOnDemand([{
        pluginId,
        family: 'agents',
        localId: FIXTURE_AGENT_ID,
      }]);
      const binding = runtime.agentRuntimesByAgentId
        .get(`${pluginId}/${FIXTURE_AGENT_ID}`)
        ?.sessionRunnerFactoryBinding;
      if (!binding) throw new Error('Expected fixture Agent runner binding');
      const createCurrentGlobalMcp = runtime.createRetainedRunnerAgentCurrentGlobalMcpService;
      if (!createCurrentGlobalMcp) throw new Error('Expected current-global MCP service factory');
      const mcp = await createCurrentGlobalMcp({
        binding,
        sessionId: 'fixture-mcp-resource-session',
        correlationId: 'fixture-mcp-resource-client',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
      });
      const client = await mcp.connect(
        { pluginId, localId: FIXTURE_MCP_SERVER_ID },
        { elicitation: { mode: 'reject' } },
      );
      try {
        const listener = vi.fn(async () => {});
        const subscription = await client.subscribeResource('file:///guide', listener);
        const fixtureSubscription = fixtureMcpSubscriptions.get(pluginId);
        if (!fixtureSubscription) throw new Error('Expected fixture MCP resource subscription');

        await createPluginStateStore({ happyHomeDir }).update((current) => {
          const plugin = current.plugins[pluginId];
          if (!plugin) throw new Error('Expected MCP fixture plugin state');
          return {
            ...current,
            plugins: {
              ...current.plugins,
              [pluginId]: {
                ...plugin,
                install: {
                  ...plugin.install,
                  optionalAccess: [],
                },
              },
            },
          };
        });

        await fixtureSubscription.listener({ uri: 'file:///guide' });

        expect(listener).not.toHaveBeenCalled();
        expect(fixtureSubscription.disposed).toBe(true);
        await subscription.dispose();
      } finally {
        await client.dispose();
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('denies a retained G MCP client after a durable hard revocation', async () => {
    const { happyHomeDir, pluginId } = await createMcpFixture();
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }),
      provenance: 'external',
      existingAgentIds: new Set(),
    }));
    const generationAuthority = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    if (!generationAuthority) throw new Error('Expected durable MCP generation authority');
    const generationG = generationAuthority.generations.get(pluginId)?.immutableGenerationId;
    if (!generationG) throw new Error('Expected durable G immutable generation');
    const runtime = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      contributes,
      generationAuthority,
    });
    try {
      await runtime.activateContributionsOnDemand([{
        pluginId,
        family: 'agents',
        localId: FIXTURE_AGENT_ID,
      }]);
      const binding = runtime.agentRuntimesByAgentId
        .get(`${pluginId}/${FIXTURE_AGENT_ID}`)
        ?.sessionRunnerFactoryBinding;
      if (!binding) throw new Error('Expected fixture Agent runner binding');
      const createCurrentGlobalMcp = runtime.createRetainedRunnerAgentCurrentGlobalMcpService;
      if (!createCurrentGlobalMcp) throw new Error('Expected current-global MCP service factory');
      const mcp = await createCurrentGlobalMcp({
        binding,
        sessionId: 'fixture-mcp-hard-revoke-session',
        correlationId: 'fixture-mcp-hard-revoke-client',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
      });
      const client = await mcp.connect(
        { pluginId, localId: FIXTURE_MCP_SERVER_ID },
        { elicitation: { mode: 'reject' } },
      );
      try {
        await expect(client.callTool('run', {})).resolves.toEqual({ ok: true });

        await createPluginRegistryStateStore({
          happyHomeDir,
          runtimeLifecycle: Object.freeze({
            prepare: async () => Object.freeze({
              abort: async () => undefined,
              adopt: async () => undefined,
            }),
          }),
          runHardRevocationCurrentnessChange: async (_pluginId, change) => {
            await change({ onApplied: () => {} });
          },
        }).hardRevokeRunningSessionsForGenerationIntegrityFailure({
          pluginId,
          immutableGenerationId: generationG,
        });

        await expect(client.callTool('run', {})).rejects.toMatchObject({
          code: expect.stringMatching(/^plugin_final_generation_/),
        });
      } finally {
        await client.dispose();
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps a retained G HTTP operation available while durable H is desired', async () => {
    const { happyHomeDir, pluginId, pluginRoot } = await createFixture();
    const networkDependencies = createFixtureNetworkDependencies();
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }),
      provenance: 'external',
      existingAgentIds: new Set(),
    }));
    const generationAuthority = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    if (!generationAuthority) throw new Error('Expected durable G generation authority');
    const generationG = generationAuthority.generations.get(pluginId)?.immutableGenerationId;
    if (!generationG) throw new Error('Expected durable G immutable generation');
    const runtime = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      contributes,
      generationAuthority,
      networkDependencies,
    });
    try {
      const lease = await runtime.resolveConnectedAccountRuntime?.({
        pluginId,
        localId: 'fixture-account',
      });
      if (!lease) throw new Error('Expected G connected-account runtime lease');

      await writeNextFixtureGeneration({
        happyHomeDir,
        pluginId,
        pluginRoot,
        manifestVersion: '2.0.0',
      });
      const currentAuthority = await readCurrentCommittedPluginGenerations(
        resolvePluginStorePaths({ happyHomeDir }),
      );
      const generationH = currentAuthority?.generations.get(pluginId)?.immutableGenerationId;
      expect(generationH).toBeDefined();
      expect(generationH).not.toBe(generationG);

      const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
        target: Object.freeze({
          kind: 'service',
          service: lease.ref,
          modeId: 'manual',
        }),
        revision: 'configuration-1',
        values: Object.freeze({ 'api-origin': 'https://tenant.example.test' }),
        getSecret: async () => null,
      });
      await expect(runtime.connectedAccountRuntimeInvoker?.invokeAuthentication({
        admission: Object.freeze({
          service: lease.ref,
          descriptor: lease.descriptor.authentication.modes[0]!,
          modeId: 'manual',
          generation: lease.generation,
          immutableGenerationId: lease.immutableGenerationId,
        }),
        operation: Object.freeze({
          kind: 'submitManual',
          fields: Object.freeze({ token: 'fixture-token' }),
        }),
        context: Object.freeze({
          service: lease.ref,
          attempt: Object.freeze({ kind: 'connect', attemptId: 'fixture-attempt-h' }),
          configuration,
          attemptCredentials: Object.freeze({
            get: async () => null,
            set: async () => undefined,
            delete: async () => undefined,
          }),
        }),
        isConfigurationCurrent: () => true,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        status: 'connected',
        accountId: 'fixture-account-id',
      });
      expect(networkDependencies.openPinnedStream).toHaveBeenCalledOnce();
    } finally {
      await runtime.dispose();
    }
  });
});
