import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';

import type { Metadata, PermissionMode } from '@/api/types';
import { resolveAgentCompositionPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import {
  runPermissionModePromptLoop,
  type PermissionModePromptLoopTurnOperations,
} from '@/agent/runtime/runPermissionModePromptLoop';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import {
  combinePermissionModeQueuedPrompts,
  type PermissionModeQueuedPrompt,
} from '@/agent/runtime/permissions/queuedPrompt';
import {
  resolveAgentCompositionThroughRuntimeRegistry,
  type AgentCompositionResolution,
  type AgentCompositionToolSelection,
} from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import { bundlePluginDaemonRuntime } from '@/plugins/authoring/bundleDaemonRuntime';
import { evaluatePluginAuthorSource } from '@/plugins/authoring/sourceModule';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  projectExecutablePluginToolCatalog,
  type ProjectedPluginToolCatalogEntry,
} from '@/plugins/runtime/toolCatalog';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

const daemonCatalogBoundary = vi.hoisted(() => ({
  read: vi.fn(),
  execute: vi.fn(),
}));

const sessionSystemRecordsBoundary = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
  fetchServerFeaturesSnapshot: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  lookupSessionsByTags: vi.fn(),
  readSessionSystemRecordV1: vi.fn(),
  upsertSessionSystemRecordV1: vi.fn(),
  deleteSessionSystemRecordV1: vi.fn(),
}));

// The test harness itself consumes current SDK source. The author fixture is
// separately normalized and compiled before immutable runtime activation; a
// packed dependency remains a separate publisher/QA gate.
vi.mock('@happier-dev/plugin-sdk', async () => await vi.importActual(
  '../../../../packages/plugin-sdk/src/index.ts',
));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
    requestDaemonPluginActionExecution: daemonCatalogBoundary.execute,
  };
});

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readStoredCredentials: () => sessionSystemRecordsBoundary.readStoredCredentials(),
  };
});

vi.mock('@/features/serverFeaturesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/serverFeaturesClient')>();
  return {
    ...actual,
    fetchServerFeaturesSnapshot: (...args: unknown[]) => sessionSystemRecordsBoundary.fetchServerFeaturesSnapshot(...args),
  };
});

vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>();
  return {
    ...actual,
    fetchAccountEncryptionCurrentness: (...args: unknown[]) => (
      sessionSystemRecordsBoundary.fetchAccountEncryptionCurrentness(...args)
    ),
  };
});

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
  return {
    ...actual,
    fetchSessionById: (...args: unknown[]) => sessionSystemRecordsBoundary.fetchSessionById(...args),
    fetchSessionsPage: (...args: unknown[]) => sessionSystemRecordsBoundary.fetchSessionsPage(...args),
    lookupSessionsByTags: (...args: unknown[]) => sessionSystemRecordsBoundary.lookupSessionsByTags(...args),
  };
});

vi.mock('@/session/transport/http/sessionSystemRecordsHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/transport/http/sessionSystemRecordsHttp')>();
  return {
    ...actual,
    readSessionSystemRecordV1: (...args: unknown[]) => (
      sessionSystemRecordsBoundary.readSessionSystemRecordV1(...args)
    ),
    upsertSessionSystemRecordV1: (...args: unknown[]) => (
      sessionSystemRecordsBoundary.upsertSessionSystemRecordV1(...args)
    ),
    deleteSessionSystemRecordV1: (...args: unknown[]) => (
      sessionSystemRecordsBoundary.deleteSessionSystemRecordV1(...args)
    ),
  };
});

import { startHappyServer, type HappyMcpSessionClient } from '@/mcp/startHappyServer';

const COMPANION_PLUGIN_ID = 'examples.public-sdk-review-assistant';
const COMPANION_TOOL_ID = 'review-summary-tool';
const COMPANION_TOOL_NAME = 'review_summary';
const UNMANAGED_TOOL_NAME = 'always_visible';
const COMPANION_SESSION_ID = 'composition-turn-session';

type CompositionResolutionRegistry = Parameters<typeof resolveAgentCompositionThroughRuntimeRegistry>[0];

function configureCompanionSystemRecordsBoundary() {
  const address = Object.freeze({
    owner: 'plugin' as const,
    namespace: 'agent-context-companion',
    kind: 'review-cursor',
    localId: 'current',
  });
  const revisions = Object.freeze([
    'ssr1.AAAAAWkAAAAB',
    'ssr1.AAAAAWkAAAAC',
    'ssr1.AAAAAWkAAAAD',
    'ssr1.AAAAAWkAAAAE',
  ]);
  let record: Readonly<Record<string, unknown>> | null = null;
  let revisionIndex = 0;
  let conflictOnNextUpsert = false;
  const sameAddress = (value: unknown) => (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as Readonly<Record<string, unknown>>).owner === address.owner
    && (value as Readonly<Record<string, unknown>>).namespace === address.namespace
    && (value as Readonly<Record<string, unknown>>).kind === address.kind
    && (value as Readonly<Record<string, unknown>>).localId === address.localId
  );
  const nextRevision = () => {
    const revision = revisions[revisionIndex];
    revisionIndex += 1;
    if (!revision) throw new Error('companion_system_record_revision_fixture_exhausted');
    return revision;
  };
  const store = (content: unknown) => {
    record = Object.freeze({
      id: 'companion-record-1',
      address,
      content,
      revision: nextRevision(),
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    });
    return record;
  };

  for (const mock of Object.values(sessionSystemRecordsBoundary)) mock.mockReset();
  sessionSystemRecordsBoundary.readStoredCredentials.mockResolvedValue(Object.freeze({
    token: 'companion-account-token',
    encryption: Object.freeze({ type: 'legacy' as const, secret: new Uint8Array(32).fill(7) }),
  }));
  sessionSystemRecordsBoundary.fetchServerFeaturesSnapshot.mockResolvedValue(Object.freeze({
    status: 'ready' as const,
    features: Object.freeze({
      features: Object.freeze({}),
      capabilities: Object.freeze({
        session: Object.freeze({ systemRecords: Object.freeze({ protocolVersions: Object.freeze([1]) }) }),
      }),
    }),
  }));
  sessionSystemRecordsBoundary.fetchAccountEncryptionCurrentness.mockResolvedValue(Object.freeze({
    mode: 'plain' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
  }));
  sessionSystemRecordsBoundary.fetchSessionById.mockImplementation(async (request: Readonly<{
    sessionId: string;
  }>) => Object.freeze({
    id: request.sessionId,
    active: true,
    activeAt: 1,
    encryptionMode: 'plain' as const,
    metadata: Object.freeze({}),
    updatedAt: 1,
  }));
  sessionSystemRecordsBoundary.fetchSessionsPage.mockResolvedValue(Object.freeze({
    sessions: Object.freeze([]),
    nextCursor: null,
    hasNext: false,
  }));
  sessionSystemRecordsBoundary.lookupSessionsByTags.mockResolvedValue(Object.freeze({
    state: 'available' as const,
    sessions: Object.freeze([]),
  }));
  sessionSystemRecordsBoundary.readSessionSystemRecordV1.mockImplementation(async (request: Readonly<{
    pluginId: string;
    sessionId: string;
    address: unknown;
  }>) => {
    expect(request.pluginId).toBe(COMPANION_PLUGIN_ID);
    expect(request.sessionId).toBe(COMPANION_SESSION_ID);
    return sameAddress(request.address) ? record : null;
  });
  sessionSystemRecordsBoundary.upsertSessionSystemRecordV1.mockImplementation(async (request: Readonly<{
    pluginId: string;
    sessionId: string;
    request: Readonly<{
      address: unknown;
      content: unknown;
      expectedRevision?: string | null;
    }>;
  }>) => {
    expect(request.pluginId).toBe(COMPANION_PLUGIN_ID);
    expect(request.sessionId).toBe(COMPANION_SESSION_ID);
    expect(sameAddress(request.request.address)).toBe(true);
    const currentRevision = typeof record?.revision === 'string' ? record.revision : null;
    if (request.request.expectedRevision !== currentRevision) {
      throw Object.assign(new Error('companion_system_record_revision_conflict'), {
        code: 'plugin_session_record_revision_conflict',
        ...(currentRevision ? { currentRevision } : {}),
      });
    }
    if (conflictOnNextUpsert) {
      conflictOnNextUpsert = false;
      const winning = store(Object.freeze({
        t: 'plain' as const,
        v: Object.freeze({
          version: 1,
          cursor: 'other-authorized-client',
          annotation: 'Written by another authorized client.',
        }),
      }));
      throw Object.assign(new Error('companion_system_record_revision_conflict'), {
        code: 'plugin_session_record_revision_conflict',
        currentRevision: winning.revision,
      });
    }
    return store(request.request.content);
  });
  sessionSystemRecordsBoundary.deleteSessionSystemRecordV1.mockImplementation(async (request: Readonly<{
    pluginId: string;
    sessionId: string;
    request: Readonly<{ address: unknown; expectedRevision?: string | null }>;
  }>) => {
    expect(request.pluginId).toBe(COMPANION_PLUGIN_ID);
    expect(request.sessionId).toBe(COMPANION_SESSION_ID);
    expect(sameAddress(request.request.address)).toBe(true);
    const currentRevision = typeof record?.revision === 'string' ? record.revision : null;
    if (request.request.expectedRevision !== currentRevision) {
      throw Object.assign(new Error('companion_system_record_revision_conflict'), {
        code: 'plugin_session_record_revision_conflict',
        ...(currentRevision ? { currentRevision } : {}),
      });
    }
    record = null;
  });

  return Object.freeze({
    address,
    record: () => record,
    conflictOnNextUpsert: () => { conflictOnNextUpsert = true; },
  });
}

const publicAuthoringSourceRoot = fileURLToPath(new URL(
  '../../../../packages/plugin-sdk/examples/public-authoring',
  import.meta.url,
));
const canonicalPluginSdkRoot = fileURLToPath(new URL(
  '../../../../packages/plugin-sdk',
  import.meta.url,
));
const canonicalPluginProtocolRoot = fileURLToPath(new URL(
  '../../../../packages/protocol',
  import.meta.url,
));
const canonicalPluginAgentsRoot = fileURLToPath(new URL(
  '../../../../packages/agents',
  import.meta.url,
));
const canonicalPluginCliCommonRoot = fileURLToPath(new URL(
  '../../../../packages/cli-common',
  import.meta.url,
));
const canonicalPluginUiRoot = fileURLToPath(new URL(
  '../../../../packages/plugin-ui',
  import.meta.url,
));

async function linkCanonicalPublicRuntimePackages(projectRoot: string): Promise<void> {
  const scopeRoot = join(projectRoot, 'node_modules', '@happier-dev');
  await mkdir(scopeRoot, { recursive: true });
  for (const [packageName, packageRoot] of [
    ['protocol', canonicalPluginProtocolRoot],
    ['agents', canonicalPluginAgentsRoot],
    ['cli-common', canonicalPluginCliCommonRoot],
    ['plugin-ui', canonicalPluginUiRoot],
  ] as const) {
    await symlink(
      packageRoot,
      join(scopeRoot, packageName),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const sdkRoot = join(scopeRoot, 'plugin-sdk');
  await mkdir(sdkRoot, { recursive: true });
  const sdkPackageJson = JSON.parse(
    await readFile(join(canonicalPluginSdkRoot, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const rewriteSourceExport = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value
        .replace('./dist/', './src/')
        .replace(/\.js$/u, '.ts');
    }
    if (Array.isArray(value)) return value.map(rewriteSourceExport);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      rewriteSourceExport(child),
    ]));
  };
  sdkPackageJson.main = './src/index.ts';
  sdkPackageJson.types = './src/index.ts';
  sdkPackageJson.exports = rewriteSourceExport(sdkPackageJson.exports);
  await writeFile(join(sdkRoot, 'package.json'), `${JSON.stringify(sdkPackageJson)}\n`, 'utf8');
  await cp(join(canonicalPluginSdkRoot, 'src'), join(sdkRoot, 'src'), { recursive: true });
}

async function createTrustedLocalLinkInstall(params: Readonly<{
  sourceRootPath: string;
  manifestVersion: string;
}>) {
  const distribution = await createLocalPathPluginDistributionIdentity(params.sourceRootPath);
  return Object.freeze({
    mode: 'link' as const,
    manifestVersion: params.manifestVersion,
    installedPath: null,
    trust: createPluginTrustRecord({
      pluginId: COMPANION_PLUGIN_ID,
      distribution,
      approvedAtMs: 1,
    }),
  });
}

async function createPublicAuthoringRuntimeRegistry(): Promise<Readonly<{
  runtimeRegistry: CompositionResolutionRegistry;
  immutableGenerationId: string;
  manifestId: string;
  dispose: () => Promise<void>;
}>> {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-composition-home-'));
  const sourceParentDir = await mkdtemp(join(tmpdir(), 'happier-agent-composition-plugin-'));
  const pluginRoot = join(sourceParentDir, 'public-authoring');
  let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
  try {
    await cp(publicAuthoringSourceRoot, pluginRoot, { recursive: true });
    await linkCanonicalPublicRuntimePackages(pluginRoot);
    const evaluated = await evaluatePluginAuthorSource({ locator: pluginRoot });
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
      join(pluginRoot, '.happier-plugin', 'plugin.json'),
      evaluated.canonicalManifestJson,
      'utf8',
    );
    await bundlePluginDaemonRuntime(pluginRoot);
    // The source fixture needs node_modules only while its public source is
    // evaluated and bundled. Immutable runtime admission accepts regular
    // package files, not a test-only symlinked dependency tree.
    await rm(join(pluginRoot, 'node_modules'), { recursive: true, force: true });
    const fixture = await writeCommittedLocalPathPluginFixture({
      happyHomeDir,
      pluginId: COMPANION_PLUGIN_ID,
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
        compatibility: { status: 'compatible', diagnostics: [] },
        install: await createTrustedLocalLinkInstall({
          sourceRootPath: pluginRoot,
          manifestVersion: evaluated.manifest.version,
        }),
        state: { enabled: true },
      },
    });
    runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      generation: 1,
    });
    return Object.freeze({
      runtimeRegistry,
      immutableGenerationId: fixture.immutableGenerationId,
      manifestId: evaluated.manifest.id,
      dispose: async () => {
        await runtimeRegistry?.dispose();
        await Promise.all([
          rm(happyHomeDir, { recursive: true, force: true }),
          rm(sourceParentDir, { recursive: true, force: true }),
        ]);
      },
    });
  } catch (error) {
    await Promise.all([
      rm(happyHomeDir, { recursive: true, force: true }),
      rm(sourceParentDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

function createModeQueue(): MessageQueue2<{
  permissionMode: PermissionMode;
  appendSystemPrompt?: string | null;
  model?: string;
  suppressUserEcho?: boolean;
  providerPromptAlreadyResolved?: boolean;
  inputContextBlock?: string;
}, PermissionModeQueuedPrompt> {
  return new MessageQueue2(
    (mode) => JSON.stringify(mode),
    { batcher: (messages) => combinePermissionModeQueuedPrompts(messages) },
  );
}

function createUnmanagedDaemonTool(): ProjectedPluginToolCatalogEntry {
  const tool = {
    toolId: 'unmanaged.plugin/always-visible',
    actionId: 'always-visible-action',
    name: UNMANAGED_TOOL_NAME,
    title: 'Always visible',
    description: 'An unmanaged control tool.',
    inputSchema: { type: 'object', additionalProperties: false },
    surfaces: Object.freeze(['agent', 'mcp']),
  } satisfies ProjectedPluginToolCatalogEntry;
  return Object.freeze(tool);
}

async function listToolNames(url: string): Promise<ReadonlySet<string>> {
  const client = new Client({ name: 'composition-turn-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    return new Set((tools.tools ?? []).map((tool) => String(tool.name)));
  } finally {
    await client.close();
  }
}

async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = new Client({ name: 'composition-turn-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

async function runComposedTurn(params: Readonly<{
  agentId: string;
  runtimeRegistry: CompositionResolutionRegistry;
  serverUrl: string;
  selection: { current: AgentCompositionToolSelection | null };
  abortOnCompletion?: boolean;
  onBeforeProviderSend?: () => void | Promise<void>;
  onProviderSend?: () => Promise<unknown>;
}>): Promise<Readonly<{
  resolution: AgentCompositionResolution;
  providerPrompt: string;
  namesDuringProviderSend: ReadonlySet<string>;
  toolCallDuringProviderSend: unknown;
}>> {
  const session = createMutableApiSessionClientFixture<Metadata>({
    sessionId: 'composition-turn-session',
  });
  session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
  const queue = createModeQueue();
  queue.push({ text: 'review this turn', localId: `local-${params.agentId}` }, { permissionMode: 'default' });
  let namesDuringProviderSend: ReadonlySet<string> | null = null;
  let toolCallDuringProviderSend: unknown = null;
  let resolution: AgentCompositionResolution | null = null;
  let providerPrompt: string | null = null;
  const runtime = {
    beginTurnLifecycle: vi.fn(),
    sendTurnPrompt: vi.fn(async (prompt: string) => {
      providerPrompt = prompt;
      await params.onBeforeProviderSend?.();
      namesDuringProviderSend = await listToolNames(params.serverUrl);
      toolCallDuringProviderSend = await params.onProviderSend?.();
    }),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => {
      if (params.abortOnCompletion) {
        throw new DOMException('turn cancelled', 'AbortError');
      }
    }),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'provider-session-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    compactContext: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
    shouldResumeAfterPermissionModeChange: vi.fn(() => true),
  } satisfies PermissionModePromptLoopTurnOperations;
  let shouldExit = false;
  const loopOptions = {
    providerName: 'Composition test provider',
    agentMessageType: params.agentId,
    explicitPermissionMode: undefined,
    session,
    messageQueue: queue,
    permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
    runtime,
    createOverrideSynchronizer: () => ({
      syncFromMetadata: () => undefined,
      flushPendingAfterStart: async () => undefined,
    }),
    messageBuffer: new MessageBuffer(),
    shouldExit: () => shouldExit,
    getAbortSignal: () => new AbortController().signal,
    keepAlive: () => undefined,
    setThinking: () => undefined,
    sendReady: () => { shouldExit = true; },
    currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode: () => undefined,
    setCurrentPermissionModeUpdatedAt: () => undefined,
    resolveAgentCompositionBeforeDispatch: async ({ signal }) => {
      resolution = await resolveAgentCompositionThroughRuntimeRegistry(params.runtimeRegistry, {
        sessionId: session.sessionId,
        agentId: params.agentId,
        runtimeFamily: 'hostSession',
        signal,
      });
      return {
        managedPluginIds: resolution.managedPluginIds,
        selectedTools: resolution.selectedTools,
        selectedToolBindings: resolution.selectedToolBindings,
        prompt: resolveAgentCompositionPromptText(resolution),
      };
    },
    setActiveAgentCompositionToolSelection: (selection) => { params.selection.current = selection; },
    formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
  } satisfies Parameters<typeof runPermissionModePromptLoop>[0];
  const loop = runPermissionModePromptLoop(loopOptions);

  await loop.catch((error) => {
    if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error;
  });
  if (!resolution || !providerPrompt || !namesDuringProviderSend) {
    throw new Error('composition_turn_observation_missing');
  }
  return Object.freeze({ resolution, providerPrompt, namesDuringProviderSend, toolCallDuringProviderSend });
}

describe('startHappyServer Agent composition turn', () => {
  it('keeps generation G bound in-flight and admits a canonical public-authoring generation H on the next turn', async () => {
    const runtimeG = await createPublicAuthoringRuntimeRegistry();
    try {
      expect(runtimeG.manifestId).toBe(COMPANION_PLUGIN_ID);
      const runtimeH = await createPublicAuthoringRuntimeRegistry();
      try {
        const admittedToolG = projectExecutablePluginToolCatalog(runtimeG.runtimeRegistry).find(
          (tool) => tool.toolId === `${COMPANION_PLUGIN_ID}/${COMPANION_TOOL_ID}`,
        );
        const admittedToolH = projectExecutablePluginToolCatalog(runtimeH.runtimeRegistry).find(
          (tool) => tool.toolId === `${COMPANION_PLUGIN_ID}/${COMPANION_TOOL_ID}`,
        );
        if (!admittedToolG || !admittedToolH) {
          throw new Error('public_authoring_companion_tool_not_projected');
        }
        expect(runtimeH.immutableGenerationId).not.toBe(runtimeG.immutableGenerationId);

        let daemonCatalog: readonly ProjectedPluginToolCatalogEntry[] = Object.freeze([
          admittedToolG,
          createUnmanagedDaemonTool(),
        ]);
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.execute.mockReset();
        daemonCatalogBoundary.read.mockImplementation(async () => ({
          kind: 'available' as const,
          plugins: Object.freeze([]),
          tools: daemonCatalog,
        }));
        daemonCatalogBoundary.execute.mockResolvedValue({
          matched: true,
          result: {
            ok: true,
            result: { completed: true },
          },
        });
        const selection: { current: AgentCompositionToolSelection | null } = { current: null };
        const rpcHandlerManager: HappyMcpSessionClient['rpcHandlerManager'] = {
          registerHandler: () => undefined,
          invokeLocal: async () => ({}),
        };
        const happyClient: HappyMcpSessionClient = {
          sessionId: 'composition-turn-session',
          rpcHandlerManager,
          updateMetadata: () => undefined,
          getActiveAgentCompositionToolSelection: () => selection.current,
        };
        const server = await startHappyServer(happyClient);

        try {
          // The real custom Agent is the Context Companion's positive path:
          // it receives only its manifest-targeted asset and bounded
          // instruction. Tool delivery stays with the canonical native-MCP
          // capability owner, so this external ACP Agent must not inherit the
          // Companion tool merely because it selected the asset.
          const companionTurnG = await runComposedTurn({
            agentId: 'review-agent',
            runtimeRegistry: runtimeG.runtimeRegistry,
            serverUrl: server.url,
            selection,
          });
          expect(companionTurnG.resolution.managedPluginIds).toEqual([COMPANION_PLUGIN_ID]);
          expect(companionTurnG.resolution.selectedTools).toEqual([]);
          expect(companionTurnG.resolution.selectedToolBindings).toEqual([]);
          expect(companionTurnG.resolution.promptAssetBlocks).toEqual([
            expect.objectContaining({
              id: `plugin_prompt_asset.${COMPANION_PLUGIN_ID}/agent-context-companion-prompt`,
              scope: 'first_turn',
              text: expect.stringContaining('Agent Context Companion'),
            }),
          ]);
          expect(companionTurnG.resolution.additionalInstructions).toEqual([
            expect.objectContaining({
              pluginId: COMPANION_PLUGIN_ID,
              text: expect.stringContaining('review cursor'),
            }),
          ]);
          expect(companionTurnG.providerPrompt).toContain('Agent Context Companion');
          expect(companionTurnG.providerPrompt).toContain('review cursor');
          expect(companionTurnG.namesDuringProviderSend).not.toContain(COMPANION_TOOL_NAME);
          expect(selection.current).toBeNull();

          const selectedTurnG = await runComposedTurn({
            agentId: 'claude',
            runtimeRegistry: runtimeG.runtimeRegistry,
            serverUrl: server.url,
            selection,
            onBeforeProviderSend: () => {
              // The daemon reload publishes a real H catalog while this
              // provider turn still owns its already-admitted G snapshot.
              daemonCatalog = Object.freeze([
                admittedToolH,
                createUnmanagedDaemonTool(),
              ]);
            },
            onProviderSend: async () => await callTool(server.url, COMPANION_TOOL_NAME, {
              transcript: 'Summarize the selected generation.',
            }),
          });
          expect(selectedTurnG.resolution.managedPluginIds).toEqual([COMPANION_PLUGIN_ID]);
          expect(selectedTurnG.resolution.selectedTools).toEqual([{
            pluginId: COMPANION_PLUGIN_ID,
            localId: COMPANION_TOOL_ID,
          }]);
          expect(selectedTurnG.resolution.selectedToolBindings).toEqual([expect.objectContaining({
            tool: expect.objectContaining({
              toolId: `${COMPANION_PLUGIN_ID}/${COMPANION_TOOL_ID}`,
              name: COMPANION_TOOL_NAME,
            }),
            expectedContributorImmutableGenerationId: runtimeG.immutableGenerationId,
          })]);
          expect(selectedTurnG.namesDuringProviderSend).toContain(COMPANION_TOOL_NAME);
          expect(selectedTurnG.namesDuringProviderSend).toContain(UNMANAGED_TOOL_NAME);
          expect(selectedTurnG.providerPrompt).toContain(COMPANION_TOOL_NAME);
          expect(selectedTurnG.toolCallDuringProviderSend).toEqual(expect.objectContaining({
            isError: false,
          }));
          expect(daemonCatalogBoundary.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
            actionId: 'review-summary',
            expectedContributorImmutableGenerationId: runtimeG.immutableGenerationId,
          }));
          expect(selection.current).toBeNull();

          // With G's selection cleared, the next composition reads the real
          // H registry and H's ordinary daemon catalog rather than retaining
          // a G registry lease or a second catalog owner in MCP.
          const nextTurnCatalog = await listToolNames(server.url);
          expect(nextTurnCatalog).toContain(COMPANION_TOOL_NAME);
          expect(nextTurnCatalog).toContain(UNMANAGED_TOOL_NAME);
          const selectedTurnH = await runComposedTurn({
            agentId: 'claude',
            runtimeRegistry: runtimeH.runtimeRegistry,
            serverUrl: server.url,
            selection,
            onProviderSend: async () => await callTool(server.url, COMPANION_TOOL_NAME, {
              transcript: 'Summarize the reloaded generation.',
            }),
          });
          expect(selectedTurnH.resolution.selectedToolBindings).toEqual([expect.objectContaining({
            tool: expect.objectContaining({
              toolId: `${COMPANION_PLUGIN_ID}/${COMPANION_TOOL_ID}`,
              name: COMPANION_TOOL_NAME,
            }),
            expectedContributorImmutableGenerationId: runtimeH.immutableGenerationId,
          })]);
          expect(selectedTurnH.namesDuringProviderSend).toContain(COMPANION_TOOL_NAME);
          expect(selectedTurnH.namesDuringProviderSend).toContain(UNMANAGED_TOOL_NAME);
          expect(selectedTurnH.toolCallDuringProviderSend).toEqual(expect.objectContaining({
            isError: false,
          }));
          expect(daemonCatalogBoundary.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
            actionId: 'review-summary',
            expectedContributorImmutableGenerationId: runtimeH.immutableGenerationId,
          }));
          expect(selection.current).toBeNull();

          const cancelledTurnH = await runComposedTurn({
            agentId: 'claude',
            runtimeRegistry: runtimeH.runtimeRegistry,
            serverUrl: server.url,
            selection,
            abortOnCompletion: true,
          });
          expect(cancelledTurnH.resolution.selectedToolBindings).toEqual([expect.objectContaining({
            expectedContributorImmutableGenerationId: runtimeH.immutableGenerationId,
          })]);
          expect(cancelledTurnH.namesDuringProviderSend).toContain(COMPANION_TOOL_NAME);
          expect(cancelledTurnH.namesDuringProviderSend).toContain(UNMANAGED_TOOL_NAME);
          expect(selection.current).toBeNull();
        } finally {
          selection.current = null;
          server.stop();
        }
      } finally {
        await runtimeH.dispose();
      }
    } finally {
      await runtimeG.dispose();
    }
  }, 120_000);

  it('persists the public Context Companion through the activated Session handle and lets a stale CAS writer lose', async () => {
    const boundary = configureCompanionSystemRecordsBoundary();
    const resolveCompanion = async (runtime: CompositionResolutionRegistry) => (
      await resolveAgentCompositionThroughRuntimeRegistry(runtime, {
        sessionId: COMPANION_SESSION_ID,
        agentId: 'review-agent',
        runtimeFamily: 'hostSession',
      })
    );
    const firstRuntime = await createPublicAuthoringRuntimeRegistry();
    try {
      await expect(resolveCompanion(firstRuntime.runtimeRegistry)).resolves.toMatchObject({
        managedPluginIds: [COMPANION_PLUGIN_ID],
        additionalInstructions: [expect.objectContaining({
          pluginId: COMPANION_PLUGIN_ID,
          text: expect.stringContaining('review cursor'),
        })],
      });
      expect(sessionSystemRecordsBoundary.readSessionSystemRecordV1).toHaveBeenCalledTimes(1);
      expect(sessionSystemRecordsBoundary.upsertSessionSystemRecordV1).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pluginId: COMPANION_PLUGIN_ID,
          sessionId: COMPANION_SESSION_ID,
          request: expect.objectContaining({
            address: boundary.address,
            expectedRevision: null,
            content: {
              t: 'plain',
              v: expect.objectContaining({
                version: 1,
                cursor: 'review-agent',
                annotation: expect.stringContaining('review cursor'),
              }),
            },
          }),
        }),
      );
      expect(boundary.record()).toMatchObject({
        address: boundary.address,
        content: {
          t: 'plain',
          v: expect.objectContaining({ cursor: 'review-agent' }),
        },
      });

      boundary.conflictOnNextUpsert();
      await expect(resolveCompanion(firstRuntime.runtimeRegistry)).resolves.toMatchObject({
        managedPluginIds: [COMPANION_PLUGIN_ID],
      });
      expect(boundary.record()).toMatchObject({
        content: {
          t: 'plain',
          v: expect.objectContaining({ cursor: 'other-authorized-client' }),
        },
      });
    } finally {
      await firstRuntime.dispose();
    }

    const winningRevision = boundary.record()?.revision;
    if (typeof winningRevision !== 'string') {
      throw new Error('companion_system_record_conflict_winner_missing_revision');
    }

    // Registry retirement itself has no plugin-local cleanup path. A fresh
    // activated client reads the surviving server record and performs its
    // next CAS update through the same public Session capability.
    const restartedRuntime = await createPublicAuthoringRuntimeRegistry();
    try {
      await expect(resolveCompanion(restartedRuntime.runtimeRegistry)).resolves.toMatchObject({
        managedPluginIds: [COMPANION_PLUGIN_ID],
      });
      expect(sessionSystemRecordsBoundary.upsertSessionSystemRecordV1).toHaveBeenLastCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ expectedRevision: winningRevision }),
        }),
      );
      expect(boundary.record()).toMatchObject({
        content: {
          t: 'plain',
          v: expect.objectContaining({ cursor: 'review-agent' }),
        },
      });
    } finally {
      await restartedRuntime.dispose();
    }
  }, 120_000);
});
