import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExternalSessionOperationSocketCommandV1,
  ExternalSessionOperationSocketResponseV1,
  ExternalSessionPriorStableStorageV1,
  LinkedExternalSessionQualifiedIdentityV1,
} from '@happier-dev/protocol';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentExternalSessionsContribution,
  AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
  AgentExternalSessionSource,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  activate as activateClaudePlugin,
  PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-claude';
import {
  activate as activateCodexPlugin,
  PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-codex';
import {
  activate as activateOpenCodePlugin,
  PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-opencode';
import {
  activate as activatePiPlugin,
  PLUGIN_MANIFEST as PI_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-pi';
import {
  activate as activateOhMyPiPlugin,
  PLUGIN_MANIFEST as OH_MY_PI_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-ohmypi';
import { afterEach, describe, expect, it, vi } from 'vitest';

const readCredentialsMock = vi.fn();
const loadLinkedExternalSessionMock = vi.fn();
const resolveSurfaceMock = vi.fn();
const prepareItemMock = vi.fn();
const stageItemMock = vi.fn((input: { item: unknown } & Record<string, unknown>) => ({
  v: 1,
  kind: 'external_session_historical_import_staged_item',
  ...input,
}));
const fetchSessionByIdMock = vi.fn();

const { MockExternalSessionHistoricalImportRequiredItemError } = vi.hoisted(() => ({
  MockExternalSessionHistoricalImportRequiredItemError: class extends Error {
    readonly category: 'record' | 'media' | 'conversion';

    constructor(category: 'record' | 'media' | 'conversion') {
      super('Required external-session item failed.');
      this.category = category;
    }
  },
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));
vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
  loadLinkedExternalSession: (...args: unknown[]) => loadLinkedExternalSessionMock(...args),
}));
vi.mock('./providerOpsResolution', () => ({
  resolveGenerationBoundExternalSessionFollowSurface: (...args: unknown[]) => resolveSurfaceMock(...args),
}));
vi.mock('@/api/session/external/import/importExternalSessionTranscript', () => ({
  ExternalSessionHistoricalImportRequiredItemError:
    MockExternalSessionHistoricalImportRequiredItemError,
  prepareExternalSessionHistoricalImportItem: (...args: unknown[]) => prepareItemMock(...args),
  stageExternalSessionHistoricalImportItem: (input: { item: unknown } & Record<string, unknown>) =>
    stageItemMock(input),
  readExternalSessionHistoricalImportStagedItem: (value: unknown) => value,
  validateExternalSessionHistoricalImportStagedItem: ({ staged }: {
    staged: { item: unknown };
  }) => prepareItemMock({ item: staged.item }),
}));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
}));

import { createExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import {
  createExternalSessionOperationPrivateStagingStore,
} from '@/session/external/staging/operationPrivateStaging';

import { createDefaultExternalSessionMaterializeActionExecutor } from './materializeDefault';
import { listExternalSessionOperationRecords } from './operationRecordStore';

const roots: string[] = [];
const loopbackServers: Server[] = [];
const unavailableManagedEndpointRead: AgentExternalSessionsManagedEndpointRead =
  async () => {
    throw new Error('Managed endpoint read is unavailable in this file-backed fixture');
  };
const unavailableInvocationExec = createUnavailablePluginServices().exec;

function createLoopbackManagedEndpointRead(baseUrl: string) {
  const requestedPaths: string[] = [];
  const managedEndpointRead = vi.fn<AgentExternalSessionsManagedEndpointRead>(
    async ({ pathAndQuery, headers }) => {
      if (!pathAndQuery.startsWith('/')) {
        throw new Error('Managed endpoint reads must use a relative path and query');
      }
      requestedPaths.push(pathAndQuery);
      const response = await fetch(new URL(pathAndQuery, `${baseUrl}/`), {
        method: 'GET',
        ...(headers ? { headers } : {}),
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: response.body,
      };
    },
  );
  return { managedEndpointRead, requestedPaths };
}
const machineOnlyPriorStableStorage = {
  state: 'machine_only',
} satisfies ExternalSessionPriorStableStorageV1;

function inspectAuthorityResponse(
  command: ExternalSessionOperationSocketCommandV1,
  priorStableStorage: ExternalSessionPriorStableStorageV1,
): Extract<ExternalSessionOperationSocketResponseV1, { kind: 'authority' }> | null {
  if (command.kind !== 'inspect') return null;
  return {
    v: 1,
    kind: 'authority',
    claim: command.claim,
    revision: command.expectedRevision,
    priorStableStorage,
  };
}

function createRealContributionProviderOps(input: Readonly<{
  contribution: AgentExternalSessionsContribution;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointRead;
  source: AgentExternalSessionSource;
  remoteSessionId: string;
}>) {
  const readAfterValues: unknown[] = [];
  const invocation = (maxSerializedBytes: number) => ({
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes,
    managedEndpointRead: input.managedEndpointRead ?? unavailableManagedEndpointRead,
    exec: unavailableInvocationExec,
  });
  const pageTranscript = vi.fn(async (request: Readonly<{
    cursor?: string;
    direction: 'older' | 'newer';
    maxBytes: number;
    maxItems: number;
  }>) => {
    const result = await input.contribution.pageTranscript({
      ...invocation(request.maxBytes),
      source: input.source,
      remoteSessionId: input.remoteSessionId,
      direction: request.direction,
      ...(request.cursor ? { cursor: request.cursor } : {}),
      maxItems: request.maxItems,
    });
    if (!result.ok) throw new Error(result.message);
    return {
      ...result.value,
      items: [...result.value.items],
      tailCursor: result.value.tailCursor ?? null,
      hasMore: result.value.hasMore ?? false,
      truncated: result.value.truncated ?? false,
    };
  });
  const readAfterTranscript = vi.fn(async (request: Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
  }>) => {
    const result = await input.contribution.readAfterTranscript({
      ...invocation(request.maxBytes),
      source: input.source,
      remoteSessionId: input.remoteSessionId,
      cursor: request.cursor,
      maxItems: request.maxItems,
    });
    if (!result.ok) throw new Error(result.message);
    readAfterValues.push(result.value);
    return result.value;
  });
  return { pageTranscript, readAfterTranscript, readAfterValues };
}

async function runRealContributionMaterialization(input: Readonly<{
  activeServerDir: string;
  agentId: string;
  contribution: AgentExternalSessionsContribution;
  id: string;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointRead;
  onFirstBatch?: () => Promise<void>;
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
  remoteSessionId: string;
  source: AgentExternalSessionSource;
}>) {
  const providerOps = createRealContributionProviderOps(input);
  readCredentialsMock.mockResolvedValue({
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  });
  loadLinkedExternalSessionMock.mockResolvedValue({
    ok: true,
    session: {
      rawSession: { currentStorageState: 'machine_only', metadataVersion: 7 },
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: input.agentId,
          machineId: 'machine-1',
          remoteSessionId: input.remoteSessionId,
          source: input.source,
          qualifiedIdentity: input.qualifiedIdentity,
          linkedAtMs: 1,
        },
      },
      sessionPath: null,
      agentId: input.agentId,
      machineId: 'machine-1',
      remoteSessionId: input.remoteSessionId,
      linkGeneration: 'link-1',
      source: input.source,
      codexBackendMode: null,
    },
  });
  resolveSurfaceMock.mockResolvedValue({
    resource: {
      pluginGeneration: 'contribution-1',
      retirementSignal: new AbortController().signal,
    },
    providerOps: {
      pageTranscript: providerOps.pageTranscript,
      readAfterTranscript: providerOps.readAfterTranscript,
    },
  });
  prepareItemMock.mockImplementation(async ({ item }: { item: { id: string } }) => ({
    localId: `history:${item.id}`,
    sidechainId: null,
    messageRole: 'user',
    content: { t: 'plain', v: { role: 'user', text: item.id } },
  }));
  fetchSessionByIdMock.mockResolvedValue({
    materializationPublicationId: `publication-${input.id}`,
    materializedThroughSourceAt: 100,
    publishedThroughServerSeq: 1,
  });

  let acceptedThroughServerSeq = 0;
  const acceptedLocalIds: string[] = [];
  let firstBatch = true;
  const commandKinds: string[] = [];
  const sendHistoricalCommand = vi.fn(async (
    command: ExternalSessionOperationSocketCommandV1,
  ): Promise<ExternalSessionOperationSocketResponseV1> => {
    const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
    if (authority) return authority;
    commandKinds.push(command.kind);
    if (command.kind === 'begin' || command.kind === 'resume') {
      return {
        v: 1,
        kind: 'ready',
        claim: command.claim,
        revision: command.expectedRevision,
        historicalImportJobId: `job-${input.id}`,
        limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        priorStableStorage: machineOnlyPriorStableStorage,
      };
    }
    if (command.kind === 'batch') {
      acceptedLocalIds.push(...command.items.map((item) => item.localId));
      acceptedThroughServerSeq += command.items.length;
      if (firstBatch) {
        firstBatch = false;
        await input.onFirstBatch?.();
      }
      return {
        v: 1,
        kind: 'batch_accepted',
        claim: command.claim,
        revision: command.expectedRevision,
        batchId: command.batchId,
        acceptedThroughServerSeq,
      };
    }
    if (command.kind === 'finalize') {
      return {
        v: 1,
        kind: 'finalized',
        claim: command.claim,
        revision: command.expectedRevision,
        acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
        publication: {
          materializationPublicationId: `publication-${input.id}`,
          materializedThroughSourceAt: 100,
          publishedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
        },
      };
    }
    return {
      v: 1,
      kind: 'error',
      errorCode: 'invalid_state',
      message: `Unexpected command: ${command.kind}`,
    };
  });
  const executor = createDefaultExternalSessionMaterializeActionExecutor({
    activeServerDir: input.activeServerDir,
    operationExclusion: createExternalSessionOperationExclusion({
      activeServerDir: input.activeServerDir,
      ownerId: `materialize-${input.id}-test`,
    }),
    sendHistoricalCommand,
    publishProgress: async () => undefined,
  });
  const result = await executor.start({
    request: {
      v: 1,
      idempotencyKey: `default-${input.id}`,
      sessionId: `session-${input.id}`,
      source: {
        machineId: 'machine-1',
        remoteSessionId: input.remoteSessionId,
        qualifiedIdentity: input.qualifiedIdentity,
        linkGeneration: 'link-1',
        sourceGeneration: 'source-1',
        contributionGeneration: 'contribution-1',
      },
      plan: 'materialize',
      targetStorageMode: 'external-linked',
      targetRuntimeMode: null,
    },
  });
  return {
    acceptedLocalIds,
    commandKinds,
    providerOps,
    result,
  };
}

async function startLoopbackJsonServer(
  readJson: (url: URL) => unknown,
): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(readJson(url)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  loopbackServers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const qualifiedIdentity = {
  v: 1 as const,
  agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
  source: { kind: 'codexHome', contractVersion: 1 as const },
};
const source = { kind: 'codexHome' as const, home: 'user' as const };

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(loopbackServers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('default external session materialize capture', () => {
  it('continues materialization when the real Claude leaf skips a progress record', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-claude-progress-'));
    roots.push(activeServerDir);
    const configDir = join(activeServerDir, '.claude');
    const projectId = 'project-progress';
    const remoteSessionId = 'remote-progress';
    const transcriptDir = join(configDir, 'projects', projectId);
    const transcriptPath = join(transcriptDir, `${remoteSessionId}.jsonl`);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      uuid: 'initial-user',
      timestamp: '2026-07-28T00:00:00.000Z',
      message: { content: 'initial message' },
    })}\n`, 'utf8');

    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    const activation = await createPluginTestkit({
      manifest: CLAUDE_PLUGIN_MANIFEST,
      module: { activate: activateClaudePlugin },
    });
    const contribution = activation.registration('agents', 'claude')?.externalSessions;
    await activation.dispose();
    if (!contribution) {
      throw new Error('Claude External Sessions contribution was not registered');
    }
    const claudeSource = { kind: 'claudeConfig' as const, configDir, projectId };
    const claudeQualifiedIdentity = {
      v: 1 as const,
      agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
      source: { kind: 'claudeConfig', contractVersion: 1 as const },
    };
    const linked = {
      rawSession: { currentStorageState: 'machine_only', metadataVersion: 7 },
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-1',
          remoteSessionId,
          source: claudeSource,
          qualifiedIdentity: claudeQualifiedIdentity,
          linkedAtMs: 1,
        },
      },
      sessionPath: null,
      agentId: 'claude',
      machineId: 'machine-1',
      remoteSessionId,
      linkGeneration: 'link-1',
      source: claudeSource,
      codexBackendMode: null,
    };
    readCredentialsMock.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    loadLinkedExternalSessionMock.mockResolvedValue({ ok: true, session: linked });

    const invocation = () => ({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 30_000,
      maxSerializedBytes: 512 * 1024,
      managedEndpointRead: unavailableManagedEndpointRead,
      exec: unavailableInvocationExec,
    });
    const pageTranscript = vi.fn(async (request: Readonly<{
      cursor?: string;
      direction: 'older' | 'newer';
      maxItems: number;
    }>) => {
      const result = await contribution.pageTranscript({
        ...invocation(),
        source: claudeSource,
        remoteSessionId,
        direction: request.direction,
        ...(request.cursor ? { cursor: request.cursor } : {}),
        maxItems: request.maxItems,
      });
      if (!result.ok) throw new Error(result.message);
      return {
        ...result.value,
        items: [...result.value.items],
        tailCursor: result.value.tailCursor ?? null,
        hasMore: result.value.hasMore ?? false,
        truncated: result.value.truncated ?? false,
      };
    });
    const readAfterTranscript = vi.fn(async (request: Readonly<{
      cursor: string;
      maxItems: number;
    }>) => {
      const result = await contribution.readAfterTranscript({
        ...invocation(),
        source: claudeSource,
        remoteSessionId,
        cursor: request.cursor,
        maxItems: request.maxItems,
      });
      if (!result.ok) throw new Error(result.message);
      return result.value;
    });
    resolveSurfaceMock.mockResolvedValue({
      resource: {
        pluginGeneration: 'contribution-1',
        retirementSignal: new AbortController().signal,
      },
      providerOps: {
        pageTranscript,
        readAfterTranscript,
      },
    });
    prepareItemMock.mockImplementation(async ({ item }: {
      item: { id: string };
    }) => ({
      localId: `history:${item.id}`,
      sidechainId: null,
      messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', text: item.id } },
    }));
    fetchSessionByIdMock.mockResolvedValue({
      materializationPublicationId: 'publication-claude-progress',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: 1,
    });

    let progressAppended = false;
    const commandKinds: string[] = [];
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      commandKinds.push(command.kind);
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-claude-progress',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        if (!progressAppended) {
          progressAppended = true;
          await appendFile(transcriptPath, `${JSON.stringify({
            type: 'progress',
            uuid: 'known-progress',
            timestamp: '2026-07-28T00:00:01.000Z',
          })}\n`, 'utf8');
        }
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: 1,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-claude-progress',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          },
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: `Unexpected command: ${command.kind}`,
      };
    });
    const executor = createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-claude-progress-test',
      }),
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    const result = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-claude-progress',
        sessionId: 'session-claude-progress',
        source: {
          machineId: 'machine-1',
          remoteSessionId,
          qualifiedIdentity: claudeQualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
      },
    });
    expect(commandKinds).toEqual(['begin', 'batch', 'finalize']);
    expect(readAfterTranscript).toHaveBeenCalled();
  });

  it('continues materialization when the real Pi leaf skips a session_info record', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-pi-session-info-'));
    roots.push(activeServerDir);
    const agentDir = join(activeServerDir, '.pi', 'agent');
    const sessionRoot = join(agentDir, 'sessions', '--workspace--');
    const remoteSessionId = 'pi-session-info';
    const transcriptPath = join(sessionRoot, `2026-07-28T00-00-00.000Z_${remoteSessionId}.jsonl`);
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: remoteSessionId,
        timestamp: '2026-07-28T00:00:00.000Z',
        cwd: '/workspace',
      }),
      JSON.stringify({
        type: 'message',
        id: 'initial-user',
        parentId: null,
        timestamp: '2026-07-28T00:00:00.000Z',
        message: { role: 'user', content: 'initial message' },
      }),
      '',
    ].join('\n'), 'utf8');

    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const activation = await createPluginTestkit({
      manifest: PI_PLUGIN_MANIFEST,
      module: { activate: activatePiPlugin },
    });
    const contribution = activation.registration('agents', 'pi')?.externalSessions;
    await activation.dispose();
    if (!contribution) {
      throw new Error('Pi External Sessions contribution was not registered');
    }
    const piSource = { kind: 'piAgentDir' as const, agentDir, sessionFile: transcriptPath };
    const piQualifiedIdentity = {
      v: 1 as const,
      agent: { pluginId: 'happier.agent.pi', localId: 'pi' },
      source: { kind: 'piAgentDir', contractVersion: 1 as const },
    };
    const linked = {
      rawSession: { currentStorageState: 'machine_only', metadataVersion: 7 },
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'pi',
          machineId: 'machine-1',
          remoteSessionId,
          source: piSource,
          qualifiedIdentity: piQualifiedIdentity,
          linkedAtMs: 1,
        },
      },
      sessionPath: null,
      agentId: 'pi',
      machineId: 'machine-1',
      remoteSessionId,
      linkGeneration: 'link-1',
      source: piSource,
      codexBackendMode: null,
    };
    readCredentialsMock.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    loadLinkedExternalSessionMock.mockResolvedValue({ ok: true, session: linked });

    const invocation = () => ({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 30_000,
      maxSerializedBytes: 512 * 1024,
      managedEndpointRead: unavailableManagedEndpointRead,
      exec: unavailableInvocationExec,
    });
    const pageTranscript = vi.fn(async (request: Readonly<{
      cursor?: string;
      direction: 'older' | 'newer';
      maxItems: number;
    }>) => {
      const result = await contribution.pageTranscript({
        ...invocation(),
        source: piSource,
        remoteSessionId,
        direction: request.direction,
        ...(request.cursor ? { cursor: request.cursor } : {}),
        maxItems: request.maxItems,
      });
      if (!result.ok) throw new Error(result.message);
      return {
        ...result.value,
        items: [...result.value.items],
        tailCursor: result.value.tailCursor ?? null,
        hasMore: result.value.hasMore ?? false,
        truncated: result.value.truncated ?? false,
      };
    });
    const readAfterTranscript = vi.fn(async (request: Readonly<{
      cursor: string;
      maxItems: number;
    }>) => {
      const result = await contribution.readAfterTranscript({
        ...invocation(),
        source: piSource,
        remoteSessionId,
        cursor: request.cursor,
        maxItems: request.maxItems,
      });
      if (!result.ok) throw new Error(result.message);
      return result.value;
    });
    resolveSurfaceMock.mockResolvedValue({
      resource: {
        pluginGeneration: 'contribution-1',
        retirementSignal: new AbortController().signal,
      },
      providerOps: {
        pageTranscript,
        readAfterTranscript,
      },
    });
    prepareItemMock.mockImplementation(async ({ item }: {
      item: { id: string };
    }) => ({
      localId: `history:${item.id}`,
      sidechainId: null,
      messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', text: item.id } },
    }));
    fetchSessionByIdMock.mockResolvedValue({
      materializationPublicationId: 'publication-pi-session-info',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: 1,
    });

    let sessionInfoAppended = false;
    const commandKinds: string[] = [];
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      commandKinds.push(command.kind);
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-pi-session-info',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        if (!sessionInfoAppended) {
          sessionInfoAppended = true;
          await appendFile(transcriptPath, `${JSON.stringify({
            type: 'session_info',
            id: 'updated-title',
            parentId: 'initial-user',
            timestamp: '2026-07-28T00:00:01.000Z',
            name: 'Updated title only',
          })}\n`, 'utf8');
        }
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: 1,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-pi-session-info',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          },
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: `Unexpected command: ${command.kind}`,
      };
    });
    const executor = createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-pi-session-info-test',
      }),
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    const result = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-pi-session-info',
        sessionId: 'session-pi-session-info',
        source: {
          machineId: 'machine-1',
          remoteSessionId,
          qualifiedIdentity: piQualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
      },
    });
    expect(commandKinds).toEqual(['begin', 'batch', 'finalize']);
    expect(readAfterTranscript).toHaveBeenCalled();
  });

  it('continues materialization when the real Oh My Pi leaf skips a session_info record', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-ohmypi-session-info-'));
    roots.push(activeServerDir);
    const agentDir = join(activeServerDir, '.pi', 'agent');
    const sessionRoot = join(agentDir, 'sessions', '--workspace--');
    const remoteSessionId = 'ohmypi-session-info';
    const transcriptPath = join(sessionRoot, `2026-07-28T00-00-00.000Z_${remoteSessionId}.jsonl`);
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: remoteSessionId,
        timestamp: '2026-07-28T00:00:00.000Z',
        cwd: '/workspace',
      }),
      JSON.stringify({
        type: 'message',
        id: 'initial-user',
        parentId: null,
        timestamp: '2026-07-28T00:00:00.000Z',
        message: { role: 'user', content: 'initial message' },
      }),
      '',
    ].join('\n'), 'utf8');

    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const activation = await createPluginTestkit({
      manifest: OH_MY_PI_PLUGIN_MANIFEST,
      module: { activate: activateOhMyPiPlugin },
    });
    const contribution = activation.registration('agents', 'ohmypi')?.externalSessions;
    await activation.dispose();
    if (!contribution) {
      throw new Error('Oh My Pi External Sessions contribution was not registered');
    }
    const ohMyPiSource = {
      kind: 'ohMyPiAgentDir' as const,
      agentDir,
      sessionFilePath: transcriptPath,
    };
    const ohMyPiQualifiedIdentity = {
      v: 1 as const,
      agent: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' },
      source: { kind: 'ohMyPiAgentDir', contractVersion: 1 as const },
    };
    const linked = {
      rawSession: { currentStorageState: 'machine_only', metadataVersion: 7 },
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'ohmypi',
          machineId: 'machine-1',
          remoteSessionId,
          source: ohMyPiSource,
          qualifiedIdentity: ohMyPiQualifiedIdentity,
          linkedAtMs: 1,
        },
      },
      sessionPath: null,
      agentId: 'ohmypi',
      machineId: 'machine-1',
      remoteSessionId,
      linkGeneration: 'link-1',
      source: ohMyPiSource,
      codexBackendMode: null,
    };
    readCredentialsMock.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    loadLinkedExternalSessionMock.mockResolvedValue({ ok: true, session: linked });

    const invocation = () => ({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 30_000,
      maxSerializedBytes: 512 * 1024,
      managedEndpointRead: unavailableManagedEndpointRead,
      exec: unavailableInvocationExec,
    });
    const pageTranscript = vi.fn(async (request: Readonly<{
      cursor?: string;
      direction: 'older' | 'newer';
      maxItems: number;
    }>) => {
      const result = await contribution.pageTranscript({
        ...invocation(),
        source: ohMyPiSource,
        remoteSessionId,
        direction: request.direction,
        ...(request.cursor ? { cursor: request.cursor } : {}),
        maxItems: request.maxItems,
      });
      if (!result.ok) throw new Error(result.message);
      return {
        ...result.value,
        items: [...result.value.items],
        tailCursor: result.value.tailCursor ?? null,
        hasMore: result.value.hasMore ?? false,
        truncated: result.value.truncated ?? false,
      };
    });
    const readAfterTranscript = vi.fn(async (request: Readonly<{
      cursor: string;
      maxItems: number;
    }>) => {
      const result = await contribution.readAfterTranscript({
        ...invocation(),
        source: ohMyPiSource,
        remoteSessionId,
        cursor: request.cursor,
        maxItems: request.maxItems,
      });
      if (!result.ok) throw new Error(result.message);
      return result.value;
    });
    resolveSurfaceMock.mockResolvedValue({
      resource: {
        pluginGeneration: 'contribution-1',
        retirementSignal: new AbortController().signal,
      },
      providerOps: {
        pageTranscript,
        readAfterTranscript,
      },
    });
    prepareItemMock.mockImplementation(async ({ item }: {
      item: { id: string };
    }) => ({
      localId: `history:${item.id}`,
      sidechainId: null,
      messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', text: item.id } },
    }));
    fetchSessionByIdMock.mockResolvedValue({
      materializationPublicationId: 'publication-ohmypi-session-info',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: 1,
    });

    let sessionInfoAppended = false;
    const commandKinds: string[] = [];
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      commandKinds.push(command.kind);
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-ohmypi-session-info',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        if (!sessionInfoAppended) {
          sessionInfoAppended = true;
          await appendFile(transcriptPath, `${JSON.stringify({
            type: 'session_info',
            timestamp: '2026-07-28T00:00:01.000Z',
            name: 'Updated title only',
          })}\n`, 'utf8');
        }
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: 1,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-ohmypi-session-info',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          },
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: `Unexpected command: ${command.kind}`,
      };
    });
    const executor = createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-ohmypi-session-info-test',
      }),
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    const result = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-ohmypi-session-info',
        sessionId: 'session-ohmypi-session-info',
        source: {
          machineId: 'machine-1',
          remoteSessionId,
          qualifiedIdentity: ohMyPiQualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
      },
    });
    expect(commandKinds).toEqual(['begin', 'batch', 'finalize']);
    expect(readAfterTranscript).toHaveBeenCalled();
  });

  it('continues materialization when the activated Codex leaf skips session_meta', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-codex-real-'));
    roots.push(activeServerDir);
    const codexHome = join(activeServerDir, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions', '2026', '07', '28');
    const remoteSessionId = '11111111-1111-1111-1111-111111111111';
    const transcriptPath = join(
      sessionsDir,
      `rollout-2026-07-28T00-00-00-${remoteSessionId}.jsonl`,
    );
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-28T00:00:00.000Z',
        payload: {
          id: remoteSessionId,
          timestamp: '2026-07-28T00:00:00.000Z',
          cwd: '/workspace',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-28T00:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'initial message' }],
        },
      }),
      '',
    ].join('\n'), 'utf8');

    vi.stubEnv('CODEX_HOME', codexHome);
    const activation = await createPluginTestkit({
      manifest: CODEX_PLUGIN_MANIFEST,
      module: { activate: activateCodexPlugin },
    });
    const contribution = activation.registration('agents', 'codex')?.externalSessions;
    await activation.dispose();
    if (!contribution) {
      throw new Error('Codex External Sessions contribution was not registered');
    }
    expect(Object.keys(contribution).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      'resolveSource',
    ]);

    const codexSource = {
      kind: 'codexHome' as const,
      home: 'user' as const,
      homePath: codexHome,
    };
    const codexQualifiedIdentity = {
      v: 1 as const,
      agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
      source: { kind: 'codexHome', contractVersion: 1 as const },
    };
    const materialized = await runRealContributionMaterialization({
      activeServerDir,
      agentId: 'codex',
      contribution,
      id: 'codex-session-meta-malformed',
      qualifiedIdentity: codexQualifiedIdentity,
      remoteSessionId,
      source: codexSource,
      onFirstBatch: async () => {
        await appendFile(transcriptPath, `${JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-07-28T00:00:02.000Z',
          payload: {
            id: remoteSessionId,
            timestamp: '2026-07-28T00:00:02.000Z',
            cwd: '/workspace',
          },
        })}\n`, 'utf8');
      },
    });

    expect(materialized.providerOps.readAfterValues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcome: 'advanced',
        items: [],
        diagnostics: [{
          code: 'non_transcript_record_skipped',
          count: 1,
          positions: [expect.any(Number)],
        }],
      }),
    ]));
    expect(materialized.result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
      },
    });
    expect(materialized.commandKinds).toEqual(['begin', 'batch', 'finalize']);
    expect(materialized.providerOps.readAfterTranscript).toHaveBeenCalled();
  });

  it('imports more than 1,000 real Codex rollout messages exactly once in source order', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-codex-large-'));
    roots.push(activeServerDir);
    const codexHome = join(activeServerDir, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions', '2026', '07', '28');
    const remoteSessionId = '33333333-3333-3333-3333-333333333333';
    const fileName = `rollout-2026-07-28T00-00-00-${remoteSessionId}.jsonl`;
    const fileRelPath = `sessions/2026/07/28/${fileName}`;
    const transcriptPath = join(sessionsDir, fileName);
    const messageCount = 1_001;
    const sessionMeta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-28T00:00:00.000Z',
      payload: {
        id: remoteSessionId,
        timestamp: '2026-07-28T00:00:00.000Z',
        cwd: '/workspace',
      },
    });
    let offsetBytes = Buffer.byteLength(`${sessionMeta}\n`, 'utf8');
    const expectedAcceptedLocalIds: string[] = [];
    const transcriptLines = [sessionMeta];
    for (let index = 0; index < messageCount; index += 1) {
      const transcriptLine = JSON.stringify({
        type: 'response_item',
        timestamp: new Date(Date.UTC(2026, 6, 28, 0, 0, index + 1)).toISOString(),
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `large-import-message-${index}` }],
        },
      });
      transcriptLines.push(transcriptLine);
      expectedAcceptedLocalIds.push(
        `history:codex:${fileRelPath}:${String(offsetBytes).padStart(12, '0')}:000`,
      );
      offsetBytes += Buffer.byteLength(`${transcriptLine}\n`, 'utf8');
    }
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(transcriptPath, `${transcriptLines.join('\n')}\n`, 'utf8');

    vi.stubEnv('CODEX_HOME', codexHome);
    const activation = await createPluginTestkit({
      manifest: CODEX_PLUGIN_MANIFEST,
      module: { activate: activateCodexPlugin },
    });
    const contribution = activation.registration('agents', 'codex')?.externalSessions;
    await activation.dispose();
    if (!contribution) {
      throw new Error('Codex External Sessions contribution was not registered');
    }

    const materialized = await runRealContributionMaterialization({
      activeServerDir,
      agentId: 'codex',
      contribution,
      id: 'codex-large-import',
      qualifiedIdentity: {
        v: 1,
        agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
        source: { kind: 'codexHome', contractVersion: 1 },
      },
      remoteSessionId,
      source: { kind: 'codexHome', home: 'user', homePath: codexHome },
    });

    expect(materialized.result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          stagedItemCount: messageCount,
          importedItemCount: messageCount,
          acceptedThroughServerSeq: messageCount,
        },
      },
    });
    expect(materialized.acceptedLocalIds).toEqual(expectedAcceptedLocalIds);
    expect(new Set(materialized.acceptedLocalIds).size).toBe(messageCount);
    expect(materialized.commandKinds[0]).toBe('begin');
    expect(materialized.commandKinds.at(-1)).toBe('finalize');
    expect(materialized.commandKinds.filter((kind) => kind === 'batch')).toHaveLength(6);
  });

  it('uses the activated OpenCode leaf to distinguish internal compaction from idless unknown rows', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-opencode-real-'));
    roots.push(activeServerDir);
    const messagesBySession = new Map<string, unknown[]>();
    const baseUrl = await startLoopbackJsonServer((url) => {
      const sessionMatch = /^\/session\/([^/]+)$/u.exec(url.pathname);
      if (sessionMatch) {
        return {
          id: decodeURIComponent(sessionMatch[1]!),
          time: { created: 100, updated: 200 },
        };
      }
      const messagesMatch = /^\/session\/([^/]+)\/message$/u.exec(url.pathname);
      if (messagesMatch) {
        const sessionId = decodeURIComponent(messagesMatch[1]!);
        const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 1));
        return (messagesBySession.get(sessionId) ?? []).slice(-limit);
      }
      throw new Error(`Unexpected OpenCode test request: ${url.pathname}`);
    });
    const managedEndpoint = createLoopbackManagedEndpointRead(baseUrl);
    vi.stubEnv('HAPPIER_OPENCODE_SERVER_URL', baseUrl);
    const activation = await createPluginTestkit({
      manifest: OPENCODE_PLUGIN_MANIFEST,
      module: { activate: activateOpenCodePlugin },
    });
    const contribution = activation.registration('agents', 'opencode')?.externalSessions;
    await activation.dispose();
    if (!contribution) {
      throw new Error('OpenCode External Sessions contribution was not registered');
    }
    expect(Object.keys(contribution).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      'resolveManagedEndpointService',
      'resolveSource',
    ]);

    const opencodeSource = {
      kind: 'opencodeServer' as const,
      baseUrl,
      directory: '/workspace',
    };
    const opencodeQualifiedIdentity = {
      v: 1 as const,
      agent: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
      source: { kind: 'opencodeServer', contractVersion: 1 as const },
    };
    const visibleMessage = (id: string) => ({
      info: { id, role: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text: 'initial message' }],
    });

    const compactionSessionId = 'opencode-compaction';
    messagesBySession.set(compactionSessionId, [visibleMessage('message-initial')]);
    const compaction = await runRealContributionMaterialization({
      activeServerDir,
      agentId: 'opencode',
      contribution,
      id: 'opencode-compaction',
      managedEndpointRead: managedEndpoint.managedEndpointRead,
      qualifiedIdentity: opencodeQualifiedIdentity,
      remoteSessionId: compactionSessionId,
      source: opencodeSource,
      onFirstBatch: async () => {
        messagesBySession.get(compactionSessionId)!.push({
          info: {
            id: 'message-compaction',
            role: 'assistant',
            summary: true,
            time: { created: 2 },
          },
          parts: [{ type: 'text', text: 'internal compaction summary' }],
        });
      },
    });
    expect(compaction.result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
      },
    });
    expect(compaction.commandKinds).toEqual(['begin', 'batch', 'finalize']);
    expect(managedEndpoint.managedEndpointRead).toHaveBeenCalled();
    expect(managedEndpoint.requestedPaths.every((path) => path.startsWith('/'))).toBe(true);

    const unknownSessionId = 'opencode-idless-unknown';
    messagesBySession.set(unknownSessionId, [visibleMessage('message-initial')]);
    const unknown = await runRealContributionMaterialization({
      activeServerDir,
      agentId: 'opencode',
      contribution,
      id: 'opencode-idless-unknown',
      managedEndpointRead: managedEndpoint.managedEndpointRead,
      qualifiedIdentity: opencodeQualifiedIdentity,
      remoteSessionId: unknownSessionId,
      source: opencodeSource,
      onFirstBatch: async () => {
        messagesBySession.get(unknownSessionId)!.push({
          info: { role: 'system', time: { created: 2 } },
          parts: [{ type: 'text', text: 'future idless server record' }],
        });
      },
    });
    expect(unknown.result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        error: {
          code: 'source_changed',
          retryable: true,
        },
      },
    });
    expect(unknown.commandKinds).toEqual(['begin', 'batch']);
    expect(unknown.providerOps.readAfterTranscript).toHaveBeenCalled();
  });

  it('feeds each empty-source final catch-up page through staging before reading the next page and preserves chronological replay', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-materialize-empty-final-catch-up-streaming-',
    ));
    roots.push(activeServerDir);
    readCredentialsMock.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    const linked = {
      rawSession: {
        currentStorageState: 'machine_only',
        metadataVersion: 7,
      },
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-empty-final-catch-up',
          source,
          qualifiedIdentity,
          linkedAtMs: 1,
        },
      },
      sessionPath: null,
      agentId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'remote-empty-final-catch-up',
      linkGeneration: 'link-1',
      source,
      codexBackendMode: null,
    };
    loadLinkedExternalSessionMock.mockResolvedValue({ ok: true, session: linked });
    const stagingObserver = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 100_000, maxBytes: 512 * 1024 * 1024 },
        aggregate: { maxItems: 500_000, maxBytes: 2 * 1024 * 1024 * 1024 },
      },
    });
    let uncursoredPageReads = 0;
    let stagedPagesBeforeSecondSourceRead: number | null = null;
    let stagedItemsBeforeSecondSourceRead: number | null = null;
    const pageTranscript = vi.fn(async (input: Readonly<{
      cursor?: string;
      maxItems: number;
    }>) => {
      if (input.cursor === 'older-1') {
        const [record] = await listExternalSessionOperationRecords(activeServerDir);
        if (!record) throw new Error('Expected the final catch-up operation record.');
        const checkpoint = await stagingObserver.readCaptureCheckpoint({
          operationId: record.operationId,
        });
        if (checkpoint.status !== 'ready') {
          throw new Error('Expected first final catch-up page to be staged.');
        }
        stagedPagesBeforeSecondSourceRead = checkpoint.sourcePagesRead;
        stagedItemsBeforeSecondSourceRead = checkpoint.stagedItemCount;
        return {
          items: [{ id: 'older-final-item' }],
          nextCursor: null,
          tailCursor: 'tail-final-1',
          hasMore: false,
          truncated: false,
        };
      }
      if (input.maxItems === 1) {
        return uncursoredPageReads < 2
          ? {
            items: [],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
            truncated: false,
          }
          : {
            items: [{ id: 'newer-final-item' }],
            nextCursor: 'older-1',
            tailCursor: 'tail-final-1',
            hasMore: true,
            truncated: false,
          };
      }
      uncursoredPageReads += 1;
      return uncursoredPageReads === 1
        ? {
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }
        : {
          items: [{ id: 'newer-final-item' }],
          nextCursor: 'older-1',
          tailCursor: 'tail-final-1',
          hasMore: true,
          truncated: false,
        };
    });
    resolveSurfaceMock.mockResolvedValue({
      resource: {
        pluginGeneration: 'contribution-1',
        retirementSignal: new AbortController().signal,
      },
      providerOps: {
        pageTranscript,
        readAfterTranscript: vi.fn(async () => ({
          outcome: 'already_current' as const,
        })),
      },
    });
    prepareItemMock.mockImplementation(async ({ item }: { item: { id: string } }) => ({
      localId: `history:${item.id}`,
      sidechainId: null,
      messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', text: item.id } },
    }));
    const serverOrder: string[] = [];
    fetchSessionByIdMock.mockImplementation(async () => ({
      materializationPublicationId: 'publication-empty-final-catch-up',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: serverOrder.length,
    }));
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-empty-final-catch-up',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        serverOrder.push(...command.items.map((entry) => entry.localId));
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: serverOrder.length,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-empty-final-catch-up',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          },
        };
      }
      throw new Error(`Unexpected historical import command: ${command.kind}`);
    });
    const executor = createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-empty-final-catch-up-streaming-test',
      }),
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    const result = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-empty-final-catch-up-streaming',
        sessionId: 'session-empty-final-catch-up-streaming',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'remote-empty-final-catch-up',
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });

    // The initial empty capture has already staged its capture and final-
    // validation groups. The first appended page must become the third group
    // before the iterator asks the source for its older sibling.
    expect(stagedPagesBeforeSecondSourceRead).toBe(3);
    expect(stagedItemsBeforeSecondSourceRead).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: { stagedItemCount: 2, importedItemCount: 2 },
      },
    });
    expect(serverOrder).toEqual([
      'history:older-final-item',
      'history:newer-final-item',
    ]);
  });

  it('rechecks after import acknowledgements and imports a bounded append before finalizing', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-final-catch-up-'));
    roots.push(activeServerDir);
    readCredentialsMock.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    const linked = {
      rawSession: {
        currentStorageState: 'machine_only',
        metadataVersion: 7,
      },
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source,
          qualifiedIdentity,
          linkedAtMs: 1,
        },
      },
      sessionPath: null,
      agentId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      linkGeneration: 'link-1',
      source,
      codexBackendMode: null,
    };
    loadLinkedExternalSessionMock.mockResolvedValue({ ok: true, session: linked });

    let appendVisible = false;
    const pageTranscript = vi.fn(async (input: Readonly<{ maxItems: number }>) => ({
      items: input.maxItems === 1
        ? [{ id: appendVisible ? 'appended-after-ack' : 'initial' }]
        : [{ id: 'initial' }],
      nextCursor: null,
      tailCursor: appendVisible ? 'tail-2' : 'tail-1',
      hasMore: false,
      truncated: false,
    }));
    const readAfterTranscript = vi.fn(async (input: Readonly<{ cursor: string }>) => {
      if (appendVisible && input.cursor === 'tail-1') {
        return {
          outcome: 'advanced' as const,
          items: [],
          nextCursor: 'tail-diagnostic',
          boundary: 'source-record:17',
          diagnostics: [{
            code: 'non_transcript_record_skipped',
            count: 1,
            positions: [17],
          }],
        };
      }
      if (appendVisible && input.cursor === 'tail-diagnostic') {
        return {
          outcome: 'advanced' as const,
          items: [{ id: 'appended-after-ack' }],
          nextCursor: 'tail-2',
          boundary: 'tail-2',
        };
      }
      return { outcome: 'already_current' as const };
    });
    resolveSurfaceMock.mockResolvedValue({
      resource: {
        pluginGeneration: 'contribution-1',
        retirementSignal: new AbortController().signal,
      },
      providerOps: {
        pageTranscript,
        readAfterTranscript,
      },
    });
    prepareItemMock.mockImplementation(async ({ item }: { item: { id: string } }) => ({
      localId: `history:${item.id}`,
      sidechainId: null,
      messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', text: item.id } },
    }));
    const serverOrder: string[] = [];
    const commandKinds: string[] = [];
    fetchSessionByIdMock.mockImplementation(async () => ({
      materializationPublicationId: 'publication-final-catch-up',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: serverOrder.length,
    }));
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      commandKinds.push(command.kind);
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-final-catch-up',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        serverOrder.push(...command.items.map((entry) => entry.localId));
        appendVisible = true;
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: serverOrder.length,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-final-catch-up',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          },
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: 'Unexpected discard.',
      };
    });
    const executor = createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-final-catch-up-test',
      }),
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    const result = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-final-catch-up',
        sessionId: 'session-1',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          stagedItemCount: 2,
          importedItemCount: 2,
          acceptedThroughServerSeq: 2,
        },
      },
    });
    expect(serverOrder).toEqual([
      'history:initial',
      'history:appended-after-ack',
    ]);
    expect(commandKinds).toEqual([
      'begin',
      'batch',
      'batch',
      'finalize',
    ]);
    expect(readAfterTranscript.mock.calls.map(([input]) => input.cursor))
      .toEqual(['tail-1', 'tail-1', 'tail-diagnostic', 'tail-2', 'tail-2']);
  });

  it.each([
    ['plain-one', 1, 'plain'],
    ['plain-many', 20, 'plain'],
    ['e2ee-keyed', 1, 'e2ee'],
  ] as const)(
    'bounds current-link reads per replay phase and group for %s',
    async (caseLabel, itemCount, encryptionMode) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), `happier-materialize-bounded-currentness-${itemCount}-`));
    roots.push(activeServerDir);
    readCredentialsMock.mockImplementation(async () => ({
      token: 'token',
      encryption: encryptionMode === 'plain'
        ? null
        : {
          type: 'dataKey' as const,
          publicKey: new Uint8Array([1, 2]),
          machineKey: new Uint8Array([3, 4]),
        },
    }));
    const linked = {
      rawSession: {
        currentStorageState: 'machine_only',
        metadataVersion: 7,
        encryptionMode,
        dataEncryptionKey: encryptionMode === 'plain' ? null : ' ZGVr ',
      },
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source,
          qualifiedIdentity,
          linkedAtMs: 1,
        },
      },
      sessionPath: null,
      agentId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      linkGeneration: 'link-1',
      source,
      codexBackendMode: null,
    };
    let linkReadCount = 0;
    loadLinkedExternalSessionMock.mockImplementation(async () => {
      linkReadCount += 1;
      return {
        ok: true,
        session: {
          ...linked,
          rawSession: {
            ...linked.rawSession,
            dataEncryptionKey: encryptionMode === 'plain'
              ? null
              : linkReadCount % 2 === 0 ? 'ZGVr' : ' ZGVr ',
          },
        },
      };
    });

    const transcriptItems = Array.from({ length: itemCount }, (_, index) => ({
      id: `item-${index}`,
    }));
    const pageTranscript = vi.fn(async () => ({
      items: transcriptItems,
      nextCursor: null,
      tailCursor: `tail-${itemCount}`,
      hasMore: false,
      truncated: false,
    }));
    resolveSurfaceMock.mockResolvedValue({
      resource: {
        pluginGeneration: 'contribution-1',
        retirementSignal: new AbortController().signal,
      },
      providerOps: {
        pageTranscript,
        readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' as const })),
      },
    });
    prepareItemMock.mockImplementation(async ({ item }: { item: { id: string } }) => ({
      localId: `history:${item.id}`,
      sidechainId: null,
      messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', text: item.id } },
    }));
    fetchSessionByIdMock.mockResolvedValue({
      materializationPublicationId: 'publication-bounded-currentness',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: transcriptItems.length,
    });

    let linkReadsAtImportBegin = -1;
    let linkReadsAtFirstBatch = -1;
    let credentialReadsAtImportBegin = -1;
    let credentialReadsAtFirstBatch = -1;
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      if (command.kind === 'begin') {
        linkReadsAtImportBegin = loadLinkedExternalSessionMock.mock.calls.length;
        credentialReadsAtImportBegin = readCredentialsMock.mock.calls.length;
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-bounded-currentness',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        linkReadsAtFirstBatch = loadLinkedExternalSessionMock.mock.calls.length;
        credentialReadsAtFirstBatch = readCredentialsMock.mock.calls.length;
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: command.items.length,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-bounded-currentness',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          },
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: 'Unexpected historical import command.',
      };
    });
    const executor = createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: `materialize-bounded-currentness-${caseLabel}-test`,
      }),
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    const result = await executor.start({
      request: {
        v: 1,
        idempotencyKey: `default-bounded-currentness-${caseLabel}`,
        sessionId: 'session-1',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });

    expect(result).toMatchObject({ ok: true, progress: { status: 'completed' } });
    expect(linkReadsAtImportBegin).toBeGreaterThanOrEqual(0);
    expect(linkReadsAtFirstBatch - linkReadsAtImportBegin).toBe(3);
    expect(credentialReadsAtFirstBatch - credentialReadsAtImportBegin).toBe(4);
    },
  );

  it('fences malformed-source UTF-8 diagnostics before any historical write, finalize, or publication', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-malformed-utf8-'));
    roots.push(activeServerDir);
    readCredentialsMock.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    loadLinkedExternalSessionMock.mockResolvedValue({
      ok: true,
      session: {
        rawSession: { currentStorageState: 'machine_only', metadataVersion: 7 },
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source,
            qualifiedIdentity,
            linkedAtMs: 1,
          },
        },
        sessionPath: null,
        agentId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        linkGeneration: 'link-1',
        source,
        codexBackendMode: null,
      },
    });
    let malformedAdvanceObserved = false;
    const pageTranscript = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      tailCursor: malformedAdvanceObserved ? 'tail-after-malformed' : 'tail-before-malformed',
      hasMore: false,
      truncated: false,
    }));
    const readAfterTranscript = vi.fn()
      .mockImplementationOnce(async () => {
        malformedAdvanceObserved = true;
        return {
          outcome: 'advanced' as const,
          items: [],
          nextCursor: 'tail-after-malformed',
          boundary: 'tail-after-malformed',
          diagnostics: [{
            code: 'unsupported_record_skipped',
            count: 1,
            positions: [416],
          }, {
            code: 'malformed_source_utf8',
            count: 1,
            positions: [417],
          }],
        };
      })
      .mockResolvedValue({ outcome: 'already_current' });
    resolveSurfaceMock.mockResolvedValue({
      resource: {
        pluginGeneration: 'contribution-1',
        retirementSignal: new AbortController().signal,
      },
      providerOps: {
        pageTranscript,
        readAfterTranscript,
      },
    });
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      throw new Error(`Unexpected historical command: ${command.kind}`);
    });
    const executor = createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-malformed-utf8-test',
      }),
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    const result = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-malformed-utf8',
        sessionId: 'session-malformed-utf8',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        checkpoint: {
          stagedItemCount: 0,
          importedItemCount: 0,
          requiredItemFailures: {
            total: 2,
            record: 2,
            media: 0,
            conversion: 0,
          },
        },
        error: { code: 'required_items_failed' },
      },
    });
    expect(sendHistoricalCommand.mock.calls
      .filter(([command]) => command.kind !== 'inspect')).toEqual([]);
    expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    expect(prepareItemMock).not.toHaveBeenCalled();
  });

  it('uses the Agent tail boundary, catches up appends, and revalidates the final tail before publication', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-default-'));
    roots.push(activeServerDir);
    readCredentialsMock.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    const linked = {
      rawSession: {
        currentStorageState: 'machine_only',
        metadataVersion: 7,
      },
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source,
          qualifiedIdentity,
          linkedAtMs: 1,
        },
      },
      sessionPath: null,
      agentId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      linkGeneration: 'link-1',
      source,
      codexBackendMode: null,
    };
    loadLinkedExternalSessionMock.mockResolvedValue({ ok: true, session: linked });

    const pageTranscript = vi.fn(async (input: Readonly<{
      cursor?: string;
      maxItems: number;
      maxBytes: number;
    }>) => {
      if (input.maxBytes < 128) {
        throw new Error('transcript result envelope exceeds the requested byte budget');
      }
      if (input.cursor === 'older-1') {
        return {
          items: [{ id: 'oldest' }],
          nextCursor: null,
          tailCursor: 'tail-1',
          hasMore: false,
          truncated: false,
        };
      }
      if (input.maxItems === 1) {
        return {
          items: [{ id: 'appended' }],
          nextCursor: null,
          tailCursor: 'tail-2',
          hasMore: true,
          truncated: false,
        };
      }
      return {
        items: [{ id: 'newest' }],
        nextCursor: 'older-1',
        tailCursor: 'tail-1',
        hasMore: true,
        truncated: false,
      };
    });
    const readAfterTranscript = vi.fn(async (input: Readonly<{ cursor: string }>) => (
      input.cursor === 'tail-1'
        ? {
          outcome: 'advanced' as const,
          items: [{ id: 'appended' }],
          nextCursor: 'tail-2',
          boundary: 'appended',
        }
        : { outcome: 'already_current' as const }
    ));
    const transcriptMediaReadRoots = ['/tmp/codex-materialize-media'];
    const validateSource = vi.fn(async ({ source: candidateSource }) => ({
      ok: true as const,
      source: candidateSource,
      transcriptMediaReadRoots,
    }));
    resolveSurfaceMock.mockResolvedValue({
      resource: {
        pluginGeneration: 'contribution-1',
        retirementSignal: new AbortController().signal,
      },
      providerOps: {
        validateSource,
        pageTranscript,
        readAfterTranscript,
      },
    });
    prepareItemMock.mockImplementation(async ({ item }: { item: { id: string } }) => ({
      localId: `history:${item.id}`,
      sidechainId: null,
      messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', text: item.id } },
    }));
    fetchSessionByIdMock.mockResolvedValue({
      materializationPublicationId: 'publication-1',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: 3,
    });

    const serverOrder: string[] = [];
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-1',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        serverOrder.push(...command.items.map((entry) => entry.localId));
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: serverOrder.length,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-1',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          },
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: 'Unexpected discard.',
      };
    });
    const executor = createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-default-test',
      }),
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    const result = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-capture-1',
        sessionId: 'session-1',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          sourcePagesRead: 4,
          stagedItemCount: 3,
          importedItemCount: 3,
        },
      },
    });
    expect(readAfterTranscript.mock.calls.map(([input]) => input.cursor))
      .toEqual(['tail-1', 'tail-2', 'tail-2']);
    expect(pageTranscript).toHaveBeenLastCalledWith(expect.objectContaining({
      direction: 'older',
      maxItems: 1,
      maxBytes: 512 * 1024,
    }));
    expect(serverOrder).toEqual([
      'history:oldest',
      'history:newest',
      'history:appended',
    ]);
    expect(validateSource).toHaveBeenCalledTimes(2);
    expect(stageItemMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceReadRoots: transcriptMediaReadRoots,
    }));

    pageTranscript.mockImplementation(async (input: Readonly<{ maxItems: number }>) => (
      input.maxItems === 1
        ? {
          items: [{ id: 'rewritten' }],
          nextCursor: null,
          tailCursor: 'tail-rewritten',
          hasMore: false,
          truncated: false,
        }
        : {
          items: [{ id: 'before-rewrite' }],
          nextCursor: null,
          tailCursor: 'tail-before-rewrite',
          hasMore: false,
          truncated: false,
        }
    ));
    readAfterTranscript.mockResolvedValue({ outcome: 'already_current' });
    const serverCallsBeforeRewrite = sendHistoricalCommand.mock.calls
      .filter(([command]) => command.kind !== 'inspect')
      .length;
    const rewritten = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-capture-rewritten',
        sessionId: 'session-rewritten',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });
    expect(rewritten).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'staging',
        error: {
          code: 'source_changed',
          retryable: true,
        },
      },
    });
    expect(sendHistoricalCommand.mock.calls
      .filter(([command]) => command.kind !== 'inspect'))
      .toHaveLength(serverCallsBeforeRewrite);

    pageTranscript.mockImplementation(async (input: Readonly<{
      cursor?: string;
      maxItems: number;
    }>) => {
      if (input.cursor === 'older-unavailable') {
        throw new Error('source disappeared');
      }
      return {
        items: [{ id: 'before-unavailable' }],
        nextCursor: 'older-unavailable',
        tailCursor: 'tail-before-unavailable',
        hasMore: true,
        truncated: false,
      };
    });
    const unavailable = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-capture-unavailable',
        sessionId: 'session-unavailable',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });
    expect(unavailable).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'staging',
        error: {
          code: 'source_unavailable',
          retryable: true,
        },
      },
    });
    expect(sendHistoricalCommand.mock.calls
      .filter(([command]) => command.kind !== 'inspect'))
      .toHaveLength(serverCallsBeforeRewrite);

    pageTranscript.mockImplementation(async (input: Readonly<{ maxItems: number }>) => ({
      items: input.maxItems === 1 ? [] : [{ id: 'media-failure' }],
      nextCursor: null,
      tailCursor: 'tail-media-failure',
      hasMore: false,
      truncated: false,
    }));
    readAfterTranscript.mockResolvedValue({ outcome: 'already_current' });
    prepareItemMock.mockRejectedValueOnce(
      new MockExternalSessionHistoricalImportRequiredItemError('media'),
    );
    const serverCallsBeforeMediaFailure = sendHistoricalCommand.mock.calls
      .filter(([command]) => command.kind !== 'inspect')
      .length;
    const publicationReadsBeforeMediaFailure = fetchSessionByIdMock.mock.calls.length;
    const mediaFailure = await executor.start({
      request: {
        v: 1,
        idempotencyKey: 'default-capture-media-failure',
        sessionId: 'session-media-failure',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          qualifiedIdentity,
          linkGeneration: 'link-1',
          sourceGeneration: 'source-1',
          contributionGeneration: 'contribution-1',
        },
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });
    expect(mediaFailure).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        currentStorageState: 'machine_only',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 0,
          requiredItemFailures: {
            total: 1,
            record: 0,
            media: 1,
            conversion: 0,
            diagnosticsTruncated: false,
          },
        },
        fence: { kind: 'none' },
        error: {
          code: 'required_items_failed',
          retryable: true,
        },
      },
    });
    expect(sendHistoricalCommand.mock.calls
      .filter(([command]) => command.kind !== 'inspect')
      .slice(serverCallsBeforeMediaFailure)
      .map(([command]) => command.kind))
      .toEqual(['begin']);
    expect(fetchSessionByIdMock).toHaveBeenCalledTimes(publicationReadsBeforeMediaFailure);
  });

  it.each([
    ['source_replaced', 'source_changed'],
    ['gap_or_cursor_expired', 'source_changed'],
    ['source_unavailable', 'source_unavailable'],
    ['read_failed', 'source_unavailable'],
  ] as const)(
    'preserves the E9 %s outcome as %s during capture and explicit Resume revalidation',
    async (outcome, expectedCode) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-e9-outcome-'));
      roots.push(activeServerDir);
      readCredentialsMock.mockResolvedValue({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      });
      const linked = {
        rawSession: {
          currentStorageState: 'machine_only',
          metadataVersion: 7,
        },
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source,
            qualifiedIdentity,
            linkedAtMs: 1,
          },
        },
        sessionPath: null,
        agentId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        linkGeneration: 'link-1',
        source,
        codexBackendMode: null,
      };
      let serverPriorStableStorage: ExternalSessionPriorStableStorageV1 =
        machineOnlyPriorStableStorage;
      loadLinkedExternalSessionMock.mockResolvedValue({ ok: true, session: linked });
      const pageTranscript = vi.fn(async () => ({
        items: [{ id: 'initial' }],
        nextCursor: null,
        tailCursor: 'tail-1',
        hasMore: false,
        truncated: false,
      }));
      let exposeSourceOutcome = true;
      const readAfterTranscript = vi.fn(async () => (
        exposeSourceOutcome
          ? { outcome }
          : { outcome: 'already_current' as const }
      ));
      resolveSurfaceMock.mockResolvedValue({
        resource: {
          pluginGeneration: 'contribution-1',
          retirementSignal: new AbortController().signal,
        },
        providerOps: {
          pageTranscript,
          readAfterTranscript,
        },
      });
      prepareItemMock.mockImplementation(async ({ item }: { item: { id: string } }) => ({
        localId: `history:${item.id}`,
        sidechainId: null,
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', text: item.id } },
      }));
      const sendHistoricalCommand = vi.fn(async (
        command: ExternalSessionOperationSocketCommandV1,
      ): Promise<ExternalSessionOperationSocketResponseV1> => {
        const authority = inspectAuthorityResponse(command, serverPriorStableStorage);
        if (authority) return authority;
        if (command.kind === 'begin' || command.kind === 'resume') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: `job-e9-${outcome}`,
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: serverPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          return {
            v: 1,
            kind: 'error',
            errorCode: 'internal_error',
            message: 'Interrupt import before explicit source revalidation.',
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: 'Finalize is forbidden for this source outcome.',
        };
      });
      const executor = createDefaultExternalSessionMaterializeActionExecutor({
        activeServerDir,
        operationExclusion: createExternalSessionOperationExclusion({
          activeServerDir,
          ownerId: `materialize-e9-${outcome}`,
        }),
        sendHistoricalCommand,
        publishProgress: async () => undefined,
      });

      const result = await executor.start({
        request: {
          v: 1,
          idempotencyKey: `default-e9-${outcome}`,
          sessionId: 'session-1',
          source: {
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            qualifiedIdentity,
            linkGeneration: 'link-1',
            sourceGeneration: 'source-1',
            contributionGeneration: 'contribution-1',
          },
          plan: 'materialize',
          targetStorageMode: 'external-linked',
          targetRuntimeMode: null,
        },
      });

      expect(result).toMatchObject({
        ok: true,
        progress: {
          status: 'awaiting_user_resume',
          phase: 'staging',
          currentStorageState: 'machine_only',
          error: {
            code: expectedCode,
            retryable: true,
          },
        },
      });
      expect(sendHistoricalCommand.mock.calls
        .map(([command]) => command.kind)
        .filter((kind) => kind !== 'inspect'))
        .toEqual([]);

      exposeSourceOutcome = false;
      serverPriorStableStorage = {
        state: 'snapshot_complete',
        publication: {
          materializationPublicationId: 'publication-before-e9-resume',
          materializedThroughSourceAt: 100,
          publishedThroughServerSeq: 20,
        },
      };
      Object.assign(linked.rawSession, {
        currentStorageState: 'snapshot_complete',
        materializationPublicationId: 'publication-before-e9-resume',
        materializedThroughSourceAt: 100,
        publishedThroughServerSeq: 20,
      });
      const interrupted = await executor.start({
        request: {
          v: 1,
          idempotencyKey: `default-e9-resume-${outcome}`,
          sessionId: 'session-e9-resume',
          source: {
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            qualifiedIdentity,
            linkGeneration: 'link-1',
            sourceGeneration: 'source-1',
            contributionGeneration: 'contribution-1',
          },
          plan: 'materialize',
          targetStorageMode: 'external-linked',
          targetRuntimeMode: null,
        },
      });
      expect(interrupted).toMatchObject({
        ok: true,
        progress: {
          status: 'awaiting_user_resume',
          phase: 'importing',
          publication: {
            materializationPublicationId: 'publication-before-e9-resume',
            publishedThroughServerSeq: 20,
          },
        },
      });
      if (!interrupted.ok) throw new Error('Expected interrupted import.');

      sendHistoricalCommand.mockClear();
      exposeSourceOutcome = true;
      const refusedResume = await executor.resume({
        sessionId: 'session-e9-resume',
        operationId: interrupted.progress.operationId,
        revision: interrupted.progress.revision,
      });
      expect(refusedResume).toMatchObject({
        ok: true,
        progress: {
          status: 'awaiting_user_resume',
          phase: 'importing',
          publication: {
            materializationPublicationId: 'publication-before-e9-resume',
            publishedThroughServerSeq: 20,
          },
          fence: {
            kind: 'incomplete_update',
            publication: {
              materializationPublicationId: 'publication-before-e9-resume',
              publishedThroughServerSeq: 20,
            },
          },
          error: {
            code: expectedCode,
            retryable: true,
          },
        },
      });
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
    },
  );
});
