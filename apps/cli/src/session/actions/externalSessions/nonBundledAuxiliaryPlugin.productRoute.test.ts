import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveExternalSessionsAutoLinkSourcePolicyIdV1,
  ExternalSessionsAgentIdSchema,
  ExternalSessionTakeoverStartInputV1Schema,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  resolveExternalSessionOperationTimelineV1,
} from '@happier-dev/protocol';
import type {
  ExternalSessionOperationReference,
} from '@happier-dev/plugin-sdk/sessions/external';

import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCurrentExternalSessionAgentIdentity } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import { resolveLinkedExternalSessionQualifiedIdentity } from '@/api/session/external/linking/qualifiedLinkIdentity';
import { createConfiguredPluginExternalSessionsAdapter } from '@/session/external/configuredSourceMaterializer';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
  resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry,
  spawnResolvedExternalTakeoverSessionFromRuntimeRegistry,
} from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';

import { executeExternalSessionCandidateQuery } from './candidateQuery';
import {
  executeExternalSessionCandidatesListAction,
  executeExternalSessionLinkEnsureAction,
} from './discoveryLinkActions';
import {
  resolveExternalSessionSourceKeyOwner,
  resolveExternalSessionSurfaceOps,
} from './providerOpsResolution';
import {
  executeExternalSessionTranscriptPageAction,
  executeExternalSessionTranscriptReadAfterAction,
} from './transcriptActions';
import {
  loadCurrentExternalSessionExternalLinkedTakeoverSource,
  loadCurrentExternalSessionPersistedTakeoverSource,
  loadCurrentExternalSessionPersistedTakeoverTarget,
} from './takeoverPhaseRunner';
import type {
  ExternalSessionPersistedTakeoverImportRecord,
} from './materializeAction';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import { deriveExternalSessionPluginOperationDurableKey } from '@/session/external/pluginOperationDurableKey';

const fetchSessionByIdMock = vi.fn();
const fetchSessionsPageMock = vi.fn();
const lookupSessionsByTagsMock = vi.fn();
const getOrCreateSessionByTagMock = vi.fn();
const readCredentialsMock = vi.fn();
const fetchAccountProfileMock = vi.fn();
const fetchAccountEncryptionCurrentnessMock = vi.fn();
const listSessionMarkersMock = vi.fn(async () => []);

vi.mock('@/persistence', () => ({
  readStoredCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

vi.mock('@/api/accountProfile', () => ({
  fetchAccountProfile: (...args: unknown[]) => fetchAccountProfileMock(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
  fetchSessionsPage: (...args: unknown[]) => fetchSessionsPageMock(...args),
  lookupSessionsByTags: (...args: unknown[]) => lookupSessionsByTagsMock(...args),
  getOrCreateSessionByTag: (...args: unknown[]) => getOrCreateSessionByTagMock(...args),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<
    typeof import('@/api/client/connectedServiceCredentialApi')
  >(),
  fetchAccountEncryptionCurrentness: (...args: unknown[]) =>
    fetchAccountEncryptionCurrentnessMock(...args),
}));

vi.mock('@/daemon/sessionRegistry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/sessionRegistry')>(),
  listSessionMarkers: () => listSessionMarkersMock(),
}));

const PLUGIN_ID = 'acme.external-sessions-product-route';
const REPLACEMENT_PLUGIN_ID = 'acme.external-sessions-product-route-replacement';
const AGENT_ID = 'external-product-route-agent';
const AUTHOR_PLUGIN_ID = 'acme.external-sessions-author-only';
const AUTHOR_AGENT_ID = 'external-author-only-agent';
const SOURCE = Object.freeze({ kind: 'syntheticProductRoute', scope: 'scope-a' });
const SECOND_SOURCE = Object.freeze({ kind: 'syntheticProductRoute', scope: 'scope-b' });
const CANONICALIZED_SOURCE_ALIAS = Object.freeze({
  kind: 'syntheticProductRoute',
  scope: 'scope-alias-to-b',
});
const MALFORMED_SOURCE = Object.freeze({ kind: 'syntheticProductRoute', scope: 'scope-malformed' });
const OVERSIZED_SOURCE = Object.freeze({ kind: 'syntheticProductRoute', scope: 'scope-oversized' });

function productionTakeoverRecord(input: Readonly<{
  contributionGeneration: string;
  targetStorageMode: 'external-linked' | 'persisted';
}>): ExternalSessionPersistedTakeoverImportRecord {
  const sourceCursor = 'source-cursor-product-route';
  const request = {
    v: 1 as const,
    idempotencyKey: 'takeover-product-route-1',
    sessionId: 'linked-product-route-session',
    source: {
      machineId: 'machine-product-route',
      remoteSessionId: 'remote-product-route',
      qualifiedIdentity: {
        v: 1 as const,
        agent: { pluginId: PLUGIN_ID, localId: AGENT_ID },
        source: { kind: SOURCE.kind, contractVersion: 1 as const },
      },
      linkGeneration: '41',
      sourceGeneration: createExternalSessionSourceGenerationAnchor(sourceCursor),
      contributionGeneration: input.contributionGeneration,
    },
    plan: 'takeover' as const,
    targetStorageMode: input.targetStorageMode,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
  return {
    v: 1,
    operationId: 'external-takeover:product-route-1',
    revision: 3,
    request,
    status: 'awaiting_user_resume',
    phase: 'admitting',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: 2,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'snapshot_complete',
    publication: {
      materializationPublicationId: 'publication-product-route-1',
      materializedThroughSourceAt: 10,
      publishedThroughServerSeq: 3,
    },
    checkpoint: {
      sourcePagesRead: 1,
      stagedItemCount: 1,
      importedItemCount: 1,
      acceptedThroughServerSeq: 3,
      acknowledgedBatchId: 'historical-import-complete',
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
        diagnostics: [],
      },
    },
    bindings: { operationClaimId: 'released-import-claim' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 4,
      sourceSnapshotEvidenceRef: sourceCursor,
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'admitting',
  } as ExternalSessionPersistedTakeoverImportRecord;
}

async function materializeAuxiliaryOnlyPlugin(
  pluginRoot: string,
  version = '1.0.0',
  pluginId = PLUGIN_ID,
  includeTakeover = false,
  includeDeclarativeAcp = false,
): Promise<void> {
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2,
    id: pluginId,
    version,
    displayName: 'External Sessions product-route fixture',
    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
    hostAccess: { required: [], optional: [] },
    contributes: {
      agents: [{
        id: AGENT_ID,
        title: 'External Sessions product-route Agent',
        ...(includeDeclarativeAcp
          ? {
              runtime: {
                kind: 'acp',
                transport: {
                  kind: 'webSocket',
                  url: 'ws://127.0.0.1:65535/acp',
                },
              },
              primary: 'sessions',
            }
          : {}),
        capabilities: {
          surfaces: ['externalSessions'],
          ...(includeDeclarativeAcp
            ? {
                sessions: {
                  open: ['create', 'resume'],
                  delivery: ['newTurn'],
                  cancel: true,
                },
              }
            : {}),
        },
        surfaces: {
          externalSession: {
            sources: [{
              sourceKind: SOURCE.kind,
              terminalFollow: { userRowClassification: 'explicitV1' },
              schema: {
                fields: [
                  { name: 'kind', kind: 'literal', value: SOURCE.kind },
                  {
                    name: 'scope',
                    kind: 'enum',
                    values: [
                      'scope-a',
                      'scope-b',
                      'scope-alias-to-b',
                      'scope-malformed',
                      'scope-oversized',
                    ],
                  },
                ],
              },
              key: {
                segments: [
                  { kind: 'literal', value: SOURCE.kind },
                  { kind: 'field', field: 'scope' },
                ],
              },
              instances: [{ kind: 'default', constants: { scope: 'scope-a' } }],
            }],
          },
        },
      }],
    },
  }), 'utf8');
  await writeFile(join(pluginRoot, 'daemon.mjs'), `
    const sourceFor = (request) => Object.freeze({
      kind: '${SOURCE.kind}',
      scope: request.source.scope === 'scope-alias-to-b'
        ? 'scope-b'
        : request.source.scope,
    });
    const transcriptItem = (id) => ({
      id,
      createdAtMs: 10,
      messageRole: 'agent',
      raw: {
        role: 'agent',
        content: { type: 'output', data: { type: 'message', message: id } },
      },
    });

    export function activate(api) {
      api.agents.registerExternalSessions('${AGENT_ID}', {
        async resolveSource(request) {
          return { ok: true, value: { source: sourceFor(request) } };
        },
        async listCandidates(request) {
          if (request.searchTerm === 'wait-for-cancel') {
            return await new Promise((resolve) => {
              request.signal.addEventListener('abort', () => resolve({
                ok: true,
                value: { candidates: [], nextCursor: null },
              }), { once: true });
            });
          }
          if (request.source.scope === 'scope-malformed') {
            return {
              ok: true,
              value: { candidates: [], nextCursor: null, unexpected: true },
            };
          }
          if (request.source.scope === 'scope-oversized') {
            return {
              ok: true,
              value: {
                candidates: Array.from({ length: 51 }, (_, index) => ({
                  remoteSessionId: 'oversized-' + index,
                  updatedAtMs: index,
                })),
                nextCursor: null,
              },
            };
          }
          const total = 10_000;
          const scope = request.source.scope;
          const cursorPrefix = scope + ':offset:';
          const offset = request.cursor
            ? Number.parseInt(request.cursor.slice(cursorPrefix.length), 10)
            : 0;
          if (
            (request.cursor && !request.cursor.startsWith(cursorPrefix))
            || !['scope-a', 'scope-b'].includes(scope)
            ||
            !Number.isSafeInteger(offset)
            || offset < 0
            || offset >= total
            || request.maxItems > 50
          ) {
            throw new Error('synthetic_candidate_source_eager_enumeration');
          }
          const count = Math.min(request.maxItems, total - offset);
          const candidates = Array.from({ length: count }, (_, localIndex) => {
            const index = offset + localIndex;
            const remotePrefix = scope === 'scope-a'
              ? 'remote-product-route'
              : 'remote-product-route-scope-b';
            return {
              remoteSessionId: index === 0
                ? remotePrefix
                : remotePrefix + '-' + index,
              title: index === 0
                ? 'Synthetic product-route session'
                : 'Synthetic product-route session ' + index,
              createdAtMs: index + 1,
              updatedAtMs: total - index,
              linkData: {
                fixture: 'listed-by-auxiliary-plugin',
                candidateIndex: index,
                scope,
              },
            };
          });
          const nextOffset = offset + count;
          return {
            ok: true,
            value: {
              candidates,
              nextCursor: nextOffset < total ? cursorPrefix + nextOffset : null,
            },
          };
        },
        async resolveLinkIdentity(request) {
          return {
            ok: true,
            value: {
              source: sourceFor(request),
              remoteSessionId: request.remoteSessionId,
              linkData: {
                fixture: 'linked-by-auxiliary-plugin',
                scope: request.source.scope,
              },
            },
          };
        },
        async resolveLinkedIdentity(request) {
          return {
            ok: true,
            value: {
              source: sourceFor(request),
              remoteSessionId: request.remoteSessionId,
              linkData: request.linkData,
            },
          };
        },
        async pageTranscript(request) {
          if (request.remoteSessionId === 'malicious-oversized-transcript') {
            return {
              ok: true,
              value: {
                items: Array.from({ length: 201 }, (_, index) => transcriptItem('oversized-' + index)),
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
              },
            };
          }
          return {
            ok: true,
            value: {
              items: [transcriptItem('page-from-auxiliary-plugin')],
              nextCursor: null,
              tailCursor: 'tail-product-route',
              hasMore: false,
            },
          };
        },
        async readAfterTranscript() {
          return {
            ok: true,
            value: {
              outcome: 'advanced',
              items: [transcriptItem('read-after-from-auxiliary-plugin')],
              nextCursor: 'tail-product-route-next',
              boundary: 'tail-product-route-next',
            },
          };
        },
      });
      ${includeTakeover ? `
      api.agents.registerExternalSessionTakeover('${AGENT_ID}', {
        async resolveLaunch(request) {
          return {
            ok: true,
            value: {
              directory: request.linkedDirectory ?? '/tmp/synthetic-product-route',
            },
          };
        },
      });
      ` : ''}
    }
  `, 'utf8');
}

async function materializeAuthorOnlyPlugin(pluginRoot: string): Promise<void> {
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2,
    id: AUTHOR_PLUGIN_ID,
    version: '1.0.0',
    displayName: 'External Sessions author-only fixture',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
    hostAccess: {
      required: [{
        id: 'author-external-sessions',
        capability: 'sessions',
        reason: 'Read and control configured External Sessions.',
        scope: { access: ['read', 'control'] },
      }],
      optional: [],
    },
    contributes: {
      agents: [{
        id: AUTHOR_AGENT_ID,
        title: 'Author-only Agent',
        runtime: {
          kind: 'acp',
          transport: { kind: 'webSocket', url: 'ws://127.0.0.1:65535/acp' },
        },
        primary: 'sessions',
        capabilities: {
          surfaces: [],
          sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        },
      }],
    },
  }), 'utf8');
  await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}', 'utf8');
}

describe('non-bundled auxiliary-only Agent ordinary External Sessions routes', () => {
  let controllerOwnsRegistry = false;

  afterEach(async () => {
    vi.clearAllMocks();
    if (controllerOwnsRegistry) {
      controllerOwnsRegistry = false;
      await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    }
  });

  it('binds an author-only ordinary plugin to the one current-global External Sessions service', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-external-author-global-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-external-author-source-'));
    const authorRoot = await mkdtemp(join(tmpdir(), 'happier-external-author-only-'));
    const hostOwner = createExternalSessionHostOperationOwner();
    const followExecute = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: 'tail-product-route',
      subscription: Object.freeze({ async dispose() {} }),
    }));
    const installation = await hostOwner.install({
      followOperation: { execute: followExecute },
      followTargetOperation: null,
    });
    const takeoverStart = vi.fn(async (raw: unknown) => {
      const input = ExternalSessionTakeoverStartInputV1Schema.parse(raw);
      return {
        ok: true as const,
        operation: {
          sessionId: input.request.sessionId,
          operationId: 'external-takeover:author-only',
          revision: 0,
        },
      };
    });
    let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
    let linkedMetadata: unknown = null;
    try {
      await materializeAuxiliaryOnlyPlugin(sourceRoot);
      await materializeAuthorOnlyPlugin(authorRoot);
      await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot: sourceRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
      });
      await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot: authorRoot,
        pluginId: AUTHOR_PLUGIN_ID,
        manifestVersion: '1.0.0',
      });
      readCredentialsMock.mockResolvedValue({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      });
      fetchAccountProfileMock.mockResolvedValue({ connectedServicesV2: [] });
      fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
        mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1,
      });
      fetchSessionsPageMock.mockResolvedValue({
        sessions: [], hasNext: false, nextCursor: null,
      });
      lookupSessionsByTagsMock.mockImplementation(async ({ tags }: { tags: readonly string[] }) => ({
        state: 'available', tags, sessions: [],
      }));
      getOrCreateSessionByTagMock.mockImplementation(async (input: { metadata: unknown }) => {
        const metadata = {
          ...(input.metadata as Record<string, unknown>),
          path: '/local/selected/workspace',
        };
        linkedMetadata = metadata;
        return { session: { id: 'linked-product-route-session', metadata } };
      });
      fetchSessionByIdMock.mockImplementation(async () => linkedMetadata
        ? {
            id: 'linked-product-route-session',
            currentStorageState: 'machine_only',
            encryptionMode: 'plain',
            metadata: JSON.stringify(linkedMetadata),
            metadataVersion: 1,
            active: false,
            thinking: false,
          }
        : null);

      runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        externalSessionHostOperationOwner: hostOwner,
        externalSessionsActiveServerDir: happyHomeDir,
        resolveExternalSessionCurrentMachineId: () => 'machine-product-route',
        externalSessionPluginAdmissionOwner: { takeoverStart },
      });
      await runtimeRegistry.activateContributionsOnDemand([{
        pluginId: AUTHOR_PLUGIN_ID, family: 'agents', localId: AUTHOR_AGENT_ID,
      }]);
      let authorCallerGenerationCurrent = true;
      const services = await runtimeRegistry.createAgentInvocationServices({
        pluginId: AUTHOR_PLUGIN_ID,
        pluginVersion: '1.0.0',
        agentId: AUTHOR_AGENT_ID,
        generation: String(runtimeRegistry.generation),
        correlationId: 'author-only-current-global',
        cwd: happyHomeDir,
        signal: new AbortController().signal,
        isGenerationCurrent: () => authorCallerGenerationCurrent,
      });
      const external = services.sessions.external;
      expect(Reflect.ownKeys(external).sort()).toEqual([
        'attach', 'capabilities', 'followTranscript', 'list', 'readTranscript', 'takeover',
      ]);
      expect((await external.capabilities()).list).toMatchObject({ status: 'available' });
      expect(runtimeRegistry.activatedPluginIds.has(PLUGIN_ID)).toBe(true);
      const listed = await external.list({ agentId: AGENT_ID, limit: 1 });
      expect(runtimeRegistry.activatedPluginIds.has(PLUGIN_ID)).toBe(true);
      expect(listed.items[0]?.ref).toMatchObject({
        agentId: AGENT_ID,
        remoteSessionId: 'remote-product-route',
      });
      const ref = listed.items[0]!.ref;
      const followed = await external.followTranscript(ref, {}, vi.fn());
      expect(followed).toMatchObject({ status: 'following' });
      expect(followExecute).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: PLUGIN_ID,
        contributionId: AGENT_ID,
      }));
      if (followed.status === 'following') await followed.subscription.dispose();
      const takeoverResult: ExternalSessionOperationReference = await external.takeover(ref, {
        targetStorageMode: 'persisted',
        idempotencyKey: 'same-author-key',
      });
      expect(takeoverResult).toMatchObject({ operationId: 'external-takeover:author-only' });
      const takeoverInput = ExternalSessionTakeoverStartInputV1Schema.parse(
        takeoverStart.mock.calls[0]?.[0],
      );
      expect(takeoverInput.request.idempotencyKey).toBe(
        deriveExternalSessionPluginOperationDurableKey({
          pluginId: AUTHOR_PLUGIN_ID,
          callerKey: 'same-author-key',
        }),
      );
      expect(takeoverInput.request.targetDirectory).toBe('/local/selected/workspace');

      const linkEffectsBeforeRetirement = getOrCreateSessionByTagMock.mock.calls.length;
      const followEffectsBeforeRetirement = followExecute.mock.calls.length;
      const takeoverEffectsBeforeRetirement = takeoverStart.mock.calls.length;
      authorCallerGenerationCurrent = false;

      expect(await external.capabilities()).toEqual({
        list: { status: 'unavailable', code: 'plugin_generation_retired' },
        attach: { status: 'unavailable', code: 'plugin_generation_retired' },
        takeover: { status: 'unavailable', code: 'plugin_generation_retired' },
        transcript: { status: 'unavailable', code: 'plugin_generation_retired' },
        follow: { status: 'unavailable', code: 'plugin_generation_retired' },
      });
      await expect(external.list({ agentId: AGENT_ID })).rejects.toMatchObject({
        code: 'plugin_generation_retired',
      });
      await expect(external.attach(ref)).rejects.toMatchObject({
        code: 'plugin_generation_retired',
      });
      await expect(external.readTranscript(ref, {
        mode: 'page',
        direction: 'older',
      })).rejects.toMatchObject({ code: 'plugin_generation_retired' });
      await expect(external.followTranscript(ref, {}, vi.fn())).resolves.toEqual({
        status: 'unavailable',
        code: 'plugin_generation_retired',
      });
      await expect(external.takeover(ref, {
        targetStorageMode: 'persisted',
        idempotencyKey: 'retired-author-key',
      })).rejects.toMatchObject({ code: 'plugin_generation_retired' });
      expect(getOrCreateSessionByTagMock).toHaveBeenCalledTimes(linkEffectsBeforeRetirement);
      expect(followExecute).toHaveBeenCalledTimes(followEffectsBeforeRetirement);
      expect(takeoverStart).toHaveBeenCalledTimes(takeoverEffectsBeforeRetirement);
    } finally {
      await runtimeRegistry?.dispose();
      await installation.dispose();
      await hostOwner.retire();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(authorRoot, { recursive: true, force: true });
    }
  });

  it('preserves the optional takeover sibling for a real-loader auxiliary-only Agent', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-external-takeover-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-external-takeover-plugin-'));
    let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
    const custodyWarning = vi.spyOn(logger, 'warn');
    try {
      await materializeAuxiliaryOnlyPlugin(pluginRoot, '1.0.0', PLUGIN_ID, true);
      await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
      });

      runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        pluginIds: [PLUGIN_ID],
      });
      expect(custodyWarning).not.toHaveBeenCalledWith(
        '[PLUGIN RUNTIME] Obsolete generation custody reconciliation failed',
        expect.anything(),
      );

      expect(
        runtimeRegistry.activatedPluginIds.has(PLUGIN_ID),
        JSON.stringify(runtimeRegistry.pluginDiagnosticsByPluginId[PLUGIN_ID], null, 2),
      ).toBe(true);
      expect(runtimeRegistry.agentRuntimesByAgentId.get(AGENT_ID)).toMatchObject({
        pluginId: PLUGIN_ID,
        agentId: AGENT_ID,
        hasPrimaryRuntime: false,
        externalSessions: expect.any(Object),
        externalSessionTakeover: expect.any(Object),
      });
    } finally {
      custodyWarning.mockRestore();
      await runtimeRegistry?.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('carries declaration-owned source keys through the real takeover loaders and fails closed before quiescence when authority changes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-external-source-key-home-'));
    const unavailableHappyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-external-source-key-unavailable-home-'),
    );
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-external-source-key-plugin-'));
    let unownedRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
    try {
      await materializeAuxiliaryOnlyPlugin(pluginRoot, '1.0.0', PLUGIN_ID, true);
      await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
      });
      unownedRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        pluginIds: [PLUGIN_ID],
      });
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: [PLUGIN_ID],
        durableRevision: 1,
        runningSessionDisposition: 'retainRunningSessions',
      });
      controllerOwnsRegistry = true;
      const runtimeRegistry = unownedRegistry;
      unownedRegistry = null;
      const contributionGeneration =
        runtimeRegistry.agentRuntimesByAgentId.get(AGENT_ID)?.generation;
      if (!contributionGeneration) {
        throw new Error('Expected the synthetic Agent contribution generation');
      }
      const sourceKeyOwner = await resolveExternalSessionSourceKeyOwner(
        ExternalSessionsAgentIdSchema.parse(AGENT_ID),
        SOURCE,
      );
      if (!sourceKeyOwner) {
        throw new Error('Expected the synthetic declaration-owned source key');
      }

      const linkedMetadata = {
        path: '/tmp/synthetic-product-route',
        externalSessionV1: {
          v: 1,
          agentId: AGENT_ID,
          machineId: 'machine-product-route',
          remoteSessionId: 'remote-product-route',
          linkedAtMs: 41,
          source: SOURCE,
          qualifiedIdentity: {
            v: 1,
            agent: { pluginId: PLUGIN_ID, localId: AGENT_ID },
            source: { kind: SOURCE.kind, contractVersion: 1 },
          },
        },
      };
      let currentRawSession = {
        id: 'linked-product-route-session',
        currentStorageState: 'machine_only',
        encryptionMode: 'plain',
        metadata: JSON.stringify(linkedMetadata),
        metadataVersion: 4,
        active: false,
        thinking: false,
      };
      readCredentialsMock.mockResolvedValue({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      });
      fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
        mode: 'plain',
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
      });
      fetchSessionByIdMock.mockImplementation(async () => currentRawSession);
      listSessionMarkersMock.mockResolvedValue([]);

      const persistedRecord = productionTakeoverRecord({
        contributionGeneration,
        targetStorageMode: 'persisted',
      });
      const externalLinkedRecord = productionTakeoverRecord({
        contributionGeneration,
        targetStorageMode: 'external-linked',
      }) as unknown as Parameters<
        typeof loadCurrentExternalSessionExternalLinkedTakeoverSource
      >[0];

      const externalLinked =
        await loadCurrentExternalSessionExternalLinkedTakeoverSource(
          externalLinkedRecord,
        );
      expect(externalLinked.linked.canonicalResolvedSourceKey).toBe(
        sourceKeyOwner.sourceKey,
      );
      expect(externalLinked.permitsAdmission).toBe(false);
      expect(listSessionMarkersMock).toHaveBeenCalled();
      listSessionMarkersMock.mockClear();

      await expect(loadCurrentExternalSessionPersistedTakeoverSource(
        persistedRecord,
      )).rejects.toMatchObject({ actionCode: 'not_allowed' });
      expect(listSessionMarkersMock).toHaveBeenCalled();
      listSessionMarkersMock.mockClear();

      await expect(loadCurrentExternalSessionPersistedTakeoverTarget(
        persistedRecord,
      )).resolves.toMatchObject({
        canonicalResolvedSourceKey: sourceKeyOwner.sourceKey,
      });
      expect(listSessionMarkersMock).not.toHaveBeenCalled();

      const staleGenerationRecord = productionTakeoverRecord({
        contributionGeneration: `${contributionGeneration}:retired`,
        targetStorageMode: 'external-linked',
      }) as unknown as Parameters<
        typeof loadCurrentExternalSessionExternalLinkedTakeoverSource
      >[0];
      await expect(
        loadCurrentExternalSessionExternalLinkedTakeoverSource(
          staleGenerationRecord,
        ),
      ).rejects.toMatchObject({ actionCode: 'source_unavailable' });
      expect(listSessionMarkersMock).not.toHaveBeenCalled();

      currentRawSession = {
        ...currentRawSession,
        currentStorageState: 'hosted',
        metadata: JSON.stringify({
          path: '/tmp/synthetic-product-route',
          externalHistoryImportV1: {
            v: 1,
            agentId: AGENT_ID,
            remoteSessionId: 'remote-product-route',
            importedAtMs: 100,
            source: SOURCE,
          },
        }),
      };
      await expect(loadCurrentExternalSessionPersistedTakeoverTarget(
        persistedRecord,
      )).resolves.toMatchObject({
        source: SOURCE,
        canonicalResolvedSourceKey: sourceKeyOwner.sourceKey,
      });
      expect(listSessionMarkersMock).not.toHaveBeenCalled();

      unownedRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: unavailableHappyHomeDir,
        pluginIds: [],
      });
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: [PLUGIN_ID],
        durableRevision: 2,
        runningSessionDisposition: 'retainRunningSessions',
      });
      unownedRegistry = null;
      // The singleton is shared by this integration file. Leave the live,
      // empty replacement for the next test to replace; the file's terminal
      // test owns shutdown.
      controllerOwnsRegistry = false;
      currentRawSession = {
        ...currentRawSession,
        currentStorageState: 'machine_only',
        metadata: JSON.stringify(linkedMetadata),
      };
      await expect(
        loadCurrentExternalSessionExternalLinkedTakeoverSource(
          externalLinkedRecord,
        ),
      ).rejects.toMatchObject({ actionCode: 'source_unavailable' });
      expect(listSessionMarkersMock).not.toHaveBeenCalled();
    } finally {
      await unownedRegistry?.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(unavailableHappyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('consumes the real-loader takeover sibling through a declarative ACP primary for direct and persisted spawn', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-external-takeover-acp-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-external-takeover-acp-plugin-'));
    let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
    try {
      await materializeAuxiliaryOnlyPlugin(
        pluginRoot,
        '1.0.0',
        PLUGIN_ID,
        true,
        true,
      );
      await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
      });
      runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        pluginIds: [PLUGIN_ID],
      });
      const linked = {
        rawSession: {
          id: 'linked-synthetic-takeover',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: false,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
        metadata: {},
        sessionPath: '/tmp/synthetic-product-route',
        agentId: AGENT_ID,
        machineId: 'machine-synthetic-takeover',
        remoteSessionId: 'remote-product-route',
        linkGeneration: 'link-generation-synthetic',
        source: SOURCE,
        linkData: {
          fixture: 'linked-by-auxiliary-plugin',
          scope: SOURCE.scope,
        },
        codexBackendMode: null,
      } satisfies LoadedLinkedExternalSession;
      const spawnSession = vi.fn(async () => ({
        type: 'success' as const,
        sessionId: linked.rawSession.id,
      }));

      for (const transcriptStorage of ['direct', 'persisted'] as const) {
        const resolved =
          await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
            registry: runtimeRegistry,
            linked,
            sessionId: linked.rawSession.id,
            targetDirectory: linked.sessionPath,
            signal: new AbortController().signal,
          });
        expect(resolved).toMatchObject({
          ok: true,
          value: {
            options: {
              directory: linked.sessionPath,
              existingSessionId: linked.rawSession.id,
              resume: linked.remoteSessionId,
            },
          },
        });
        if (!resolved.ok) continue;

        await expect(
          spawnResolvedExternalTakeoverSessionFromRuntimeRegistry({
            registry: runtimeRegistry,
            resolved: resolved.value,
            options: {
              transcriptStorage,
              ...(transcriptStorage === 'persisted'
                ? {
                    persistedTakeoverAdmission: {
                      mode: 'persisted',
                      operationId: 'operation-synthetic',
                      attemptId: 'attempt-synthetic',
                    },
                  }
                : {}),
            },
            signal: new AbortController().signal,
            spawnSession,
          }),
        ).resolves.toMatchObject({
          ok: true,
          value: {
            type: 'success',
            sessionId: linked.rawSession.id,
          },
        });
      }
      expect(spawnSession).toHaveBeenCalledTimes(2);
    } finally {
      await runtimeRegistry?.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('demand-activates supported consumers and fails closed for unavailable follow and takeover', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-external-product-home-'));
    const replacementHappyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-external-product-home-replacement-'),
    );
    const uninstalledHappyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-external-product-home-uninstalled-'),
    );
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-external-product-plugin-'));
    const replacementPluginRoot = await mkdtemp(
      join(tmpdir(), 'happier-external-product-plugin-replacement-'),
    );
    let unownedRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
    try {
      await materializeAuxiliaryOnlyPlugin(pluginRoot);
      await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
      });

      unownedRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
      expect(unownedRegistry.contributes.agentDefinitionsById.get(AGENT_ID)).toMatchObject({
        id: AGENT_ID,
        pluginId: PLUGIN_ID,
        provenance: 'external',
      });
      expect(unownedRegistry.activatedPluginIds.has(PLUGIN_ID)).toBe(false);

      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: [PLUGIN_ID],
        durableRevision: 3,
        runningSessionDisposition: 'retainRunningSessions',
      });
      controllerOwnsRegistry = true;
      const runtimeRegistry = unownedRegistry;
      unownedRegistry = null;

      readCredentialsMock.mockResolvedValue({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      });
      fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
        mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1,
      });
      fetchSessionByIdMock.mockResolvedValue(null);
      fetchSessionsPageMock.mockResolvedValue({
        sessions: [],
        hasNext: false,
        nextCursor: null,
      });
      lookupSessionsByTagsMock.mockImplementation(
        async ({ tags }: { tags: readonly string[] }) => ({
          state: 'available',
          tags,
          sessions: [],
        }),
      );
      getOrCreateSessionByTagMock.mockResolvedValue({
        session: { id: 'linked-product-route-session', metadata: {} },
      });

      const listed = await executeExternalSessionCandidatesListAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        source: SOURCE,
        searchTerm: 'fixture',
        limit: 1,
      });
      let failureDiagnostic: unknown = null;
      if (!listed.ok) {
        try {
          const providerOps = await resolveExternalSessionSurfaceOps(
            ExternalSessionsAgentIdSchema.parse(AGENT_ID),
          );
          if (!providerOps.validateSource) {
            throw new Error('Resolved External Sessions surface omitted validateSource');
          }
          const listCandidates = providerOps.listCandidates;
          const validated = await providerOps.validateSource({ source: SOURCE });
          const directList = validated.ok && listCandidates
            ? await listCandidates({
                source: validated.source,
                limit: 1,
                searchTerm: 'fixture',
              })
            : null;
          const identity = await resolveCurrentExternalSessionAgentIdentity(
            ExternalSessionsAgentIdSchema.parse(AGENT_ID),
          );
          let candidateQuery: unknown = null;
          if (validated.ok && listCandidates && identity) {
            try {
              candidateQuery = await executeExternalSessionCandidateQuery({
                activeServerDir: configuration.activeServerDir,
                agentIdentity: identity.identity,
                source: validated.source,
                searchTerm: 'fixture',
                limit: 1,
                listCandidates: async (request) => await listCandidates({
                  source: validated.source,
                  ...request,
                }),
              });
            } catch (error) {
              candidateQuery = {
                error: error instanceof Error
                  ? { name: error.name, message: error.message, stack: error.stack }
                  : error,
              };
            }
          }
          failureDiagnostic = {
            activated: runtimeRegistry.activatedPluginIds.has(PLUGIN_ID),
            identity,
            validated,
            directList,
            candidateQuery,
          };
        } catch (error) {
          failureDiagnostic = {
            activated: runtimeRegistry.activatedPluginIds.has(PLUGIN_ID),
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
          };
        }
      }
      expect(listed, JSON.stringify({ listed, failureDiagnostic }, null, 2)).toMatchObject({
        ok: true,
        candidates: [{
          remoteSessionId: 'remote-product-route',
          linkData: {
            fixture: 'listed-by-auxiliary-plugin',
            candidateIndex: 0,
          },
        }],
        nextCursor: expect.any(String),
      });
      const listedIdentity = await resolveCurrentExternalSessionAgentIdentity(
        ExternalSessionsAgentIdSchema.parse(AGENT_ID),
      );
      const listedSourceKeyOwner = await resolveExternalSessionSourceKeyOwner(
        ExternalSessionsAgentIdSchema.parse(AGENT_ID),
        SOURCE,
      );
      if (!listedIdentity || !listedSourceKeyOwner) {
        throw new Error('Expected the canonical Browse source scope owners');
      }
      const listedQualifiedIdentity = {
        v: 1 as const,
        agent: listedIdentity.identity,
        source: {
          kind: SOURCE.kind,
          contractVersion: 1 as const,
        },
      };
      expect(listed).toMatchObject({
        ok: true,
        autoLinkPolicyScopeV1: {
          qualifiedIdentity: listedQualifiedIdentity,
          sourcePolicyId: deriveExternalSessionsAutoLinkSourcePolicyIdV1({
            machineId: 'machine-product-route',
            qualifiedIdentity: listedQualifiedIdentity,
            canonicalResolvedSourceKey: listedSourceKeyOwner.sourceKey,
          }),
        },
      });
      expect(listed.ok && Object.keys(listed.autoLinkPolicyScopeV1 ?? {})).toEqual([
        'qualifiedIdentity',
        'sourcePolicyId',
      ]);
      expect(listed.ok && JSON.stringify(listed.autoLinkPolicyScopeV1)).not.toContain(
        listedSourceKeyOwner.sourceKey,
      );
      expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
      const [scopeAFirst, scopeBFirst] = await Promise.all([
        executeExternalSessionCandidatesListAction({
          machineId: 'machine-product-route',
          agentId: AGENT_ID,
          source: SOURCE,
          limit: 2,
        }),
        executeExternalSessionCandidatesListAction({
          machineId: 'machine-product-route',
          agentId: AGENT_ID,
          source: SECOND_SOURCE,
          limit: 2,
        }),
      ]);
      expect(scopeAFirst).toMatchObject({
        ok: true,
        candidates: [
          { remoteSessionId: 'remote-product-route' },
          { remoteSessionId: 'remote-product-route-1' },
        ],
        nextCursor: expect.any(String),
      });
      expect(scopeBFirst).toMatchObject({
        ok: true,
        candidates: [
          { remoteSessionId: 'remote-product-route-scope-b' },
          { remoteSessionId: 'remote-product-route-scope-b-1' },
        ],
        nextCursor: expect.any(String),
      });
      if (
        !scopeAFirst.ok
        || !scopeAFirst.nextCursor
        || !scopeBFirst.ok
        || !scopeBFirst.nextCursor
      ) {
        throw new Error('Expected independently qualified continuation cursors');
      }
      expect(scopeAFirst.autoLinkPolicyScopeV1?.sourcePolicyId).not.toBe(
        scopeBFirst.autoLinkPolicyScopeV1?.sourcePolicyId,
      );
      const canonicalizedAliasList = await executeExternalSessionCandidatesListAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        source: CANONICALIZED_SOURCE_ALIAS,
        limit: 2,
      });
      expect(canonicalizedAliasList.ok).toBe(true);
      if (canonicalizedAliasList.ok) {
        expect(canonicalizedAliasList.candidates).toEqual(expect.arrayContaining([
          expect.objectContaining({
            remoteSessionId: 'remote-product-route-scope-b',
          }),
        ]));
      }
      const rawAliasSourceKeyOwner = await resolveExternalSessionSourceKeyOwner(
        ExternalSessionsAgentIdSchema.parse(AGENT_ID),
        CANONICALIZED_SOURCE_ALIAS,
      );
      if (!canonicalizedAliasList.ok || !rawAliasSourceKeyOwner) {
        throw new Error('Expected the provider-canonicalized Browse source scope');
      }
      expect(canonicalizedAliasList.autoLinkPolicyScopeV1?.sourcePolicyId).toBe(
        scopeBFirst.autoLinkPolicyScopeV1?.sourcePolicyId,
      );
      expect(canonicalizedAliasList.autoLinkPolicyScopeV1?.sourcePolicyId).not.toBe(
        deriveExternalSessionsAutoLinkSourcePolicyIdV1({
          machineId: 'machine-product-route',
          qualifiedIdentity: listedQualifiedIdentity,
          canonicalResolvedSourceKey: rawAliasSourceKeyOwner.sourceKey,
        }),
      );
      const [scopeASecond, scopeBSecond] = await Promise.all([
        executeExternalSessionCandidatesListAction({
          machineId: 'machine-product-route',
          agentId: AGENT_ID,
          source: SOURCE,
          cursor: scopeAFirst.nextCursor,
          limit: 2,
        }),
        executeExternalSessionCandidatesListAction({
          machineId: 'machine-product-route',
          agentId: AGENT_ID,
          source: SECOND_SOURCE,
          cursor: scopeBFirst.nextCursor,
          limit: 2,
        }),
      ]);
      expect(scopeASecond).toMatchObject({
        ok: true,
        candidates: [
          { remoteSessionId: 'remote-product-route-2' },
          { remoteSessionId: 'remote-product-route-3' },
        ],
      });
      expect(scopeBSecond).toMatchObject({
        ok: true,
        candidates: [
          { remoteSessionId: 'remote-product-route-scope-b-2' },
          { remoteSessionId: 'remote-product-route-scope-b-3' },
        ],
      });
      const malformedList = await executeExternalSessionCandidatesListAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        source: MALFORMED_SOURCE,
        limit: 1,
      });
      expect(malformedList).toEqual({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'agent_unavailable',
        retryable: false,
      });
      expect(malformedList).not.toHaveProperty('autoLinkPolicyScopeV1');
      expect(JSON.stringify(malformedList)).not.toContain('agent_error');
      const oversizedList = await executeExternalSessionCandidatesListAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        source: OVERSIZED_SOURCE,
        limit: 1,
      });
      expect(oversizedList).toEqual({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'agent_unavailable',
        retryable: false,
      });
      expect(oversizedList).not.toHaveProperty('autoLinkPolicyScopeV1');
      expect(JSON.stringify(oversizedList)).not.toContain('agent_error');
      expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
      expect(runtimeRegistry.activatedPluginIds.has(PLUGIN_ID)).toBe(true);
      const runtimeLease = runtimeRegistry.agentRuntimesByAgentId.get(AGENT_ID);
      expect(runtimeLease).toMatchObject({
        pluginId: PLUGIN_ID,
        agentId: AGENT_ID,
        hasPrimaryRuntime: false,
        externalSessions: expect.any(Object),
      });
      if (!runtimeLease?.retirementSignal) {
        throw new Error('Expected the dynamic Agent lease to expose retirement');
      }

      const contribution = runtimeRegistry.contributes.agentDefinitionsById.get(AGENT_ID);
      expect(contribution).toBeDefined();
      const contributionGenerationId = runtimeLease.generation;
      expect(contributionGenerationId).toEqual(expect.any(String));
      if (!contributionGenerationId) {
        throw new Error('Expected the current Agent runtime lease to expose its generation');
      }
      const basis = Object.freeze({
        contributionGenerationId,
        accountSettingsRevision: 'account:product-route',
      });
      const configured = await createConfiguredPluginExternalSessionsAdapter({
        agents: [contribution!],
        account: { connectedServicesV2: [] },
        basis,
        readCurrentBasis: () => basis,
        isCurrent: () => runtimeLease.isCurrent(),
        retirementSignal: runtimeLease.retirementSignal,
        resolveProviderOps: async (agentId) => {
          const providerOps = await resolveExternalSessionSurfaceOps(
            ExternalSessionsAgentIdSchema.parse(agentId),
          );
          if (
            !providerOps.validateSource
            || !providerOps.listCandidates
            || !providerOps.pageTranscript
          ) return null;
          return {
            ...providerOps,
            validateSource: providerOps.validateSource,
            listCandidates: providerOps.listCandidates,
            pageTranscript: providerOps.pageTranscript,
          };
        },
      });
      const configuredList = await configured.authorService.list({ limit: 1 });
      expect(configuredList.items).toHaveLength(1);
      expect(configuredList.items[0]?.ref).toMatchObject({
        agentId: AGENT_ID,
        remoteSessionId: 'remote-product-route',
      });
      const configuredLargeFirst = await configured.authorService.list({
        limit: 10_000,
        maxBytes: 10 * 1024 * 1024,
      });
      expect(configuredLargeFirst.items).toHaveLength(50);
      expect(configuredLargeFirst.items.map((item) => item.ref.remoteSessionId)).toEqual([
        'remote-product-route',
        ...Array.from(
          { length: 49 },
          (_, index) => `remote-product-route-${index + 1}`,
        ),
      ]);
      expect(configuredLargeFirst.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
      if (!configuredLargeFirst.nextCursor) {
        throw new Error('Expected a configured-source list cursor');
      }
      const configuredLargeSecond = await configured.authorService.list({
        cursor: configuredLargeFirst.nextCursor,
        limit: 10_000,
        maxBytes: 10 * 1024 * 1024,
      });
      expect(configuredLargeSecond.items).toHaveLength(50);
      expect(configuredLargeSecond.items.map((item) => item.ref.remoteSessionId)).toEqual(
        Array.from(
          { length: 50 },
          (_, index) => `remote-product-route-${index + 50}`,
        ),
      );
      const cancelledList = new AbortController();
      cancelledList.abort();
      await expect(configured.authorService.list(
        {},
        { signal: cancelledList.signal },
      )).rejects.toMatchObject({
        name: 'PluginError',
        code: 'plugin_operation_aborted',
      });
      expect(await configured.authorService.capabilities()).toMatchObject({
        list: { status: 'available' },
        transcript: { status: 'available' },
        follow: {
          status: 'unavailable',
          code: 'plugin_external_follow_unavailable',
        },
        takeover: {
          status: 'unavailable',
          code: 'plugin_external_takeover_contextual_admission_unavailable',
        },
      });
      const configuredRef = configuredList.items[0]!.ref;
      // The public author service accepts only a host-qualified refresh cursor.
      // A raw contribution tail cursor is a malformed public input and would be
      // refused before the follow-availability decision this case asserts.
      await expect(configured.authorService.followTranscript(
        configuredRef,
        {},
        vi.fn(),
      )).resolves.toEqual({
        status: 'unavailable',
        code: 'plugin_external_follow_unavailable',
      });
      await expect(configured.authorService.takeover(configuredRef, {
        targetStorageMode: 'persisted',
        idempotencyKey: 'product-route-key',
      })).rejects.toMatchObject({
        code: 'plugin_external_takeover_contextual_admission_unavailable',
      });

      const pageScanCountBeforeLink = fetchSessionsPageMock.mock.calls.length;
      const linked = await executeExternalSessionLinkEnsureAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        remoteSessionId: 'remote-product-route',
        source: SOURCE,
      });
      expect(linked).toEqual({
        ok: true,
        sessionId: 'linked-product-route-session',
        created: true,
      });
      expect(lookupSessionsByTagsMock).toHaveBeenCalledOnce();
      expect(fetchSessionsPageMock.mock.calls.slice(pageScanCountBeforeLink)).toEqual([
        [expect.objectContaining({
          token: 'token',
          limit: 200,
          archivedOnly: false,
        })],
        [expect.objectContaining({
          token: 'token',
          limit: 200,
          archivedOnly: true,
        })],
      ]);
      expect(getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
        externalSessionV1: {
          remoteSessionId: 'remote-product-route',
          linkData: { fixture: 'linked-by-auxiliary-plugin' },
          qualifiedIdentity: {
            v: 1,
            agent: {
              pluginId: PLUGIN_ID,
              localId: AGENT_ID,
            },
            source: {
              kind: SOURCE.kind,
              contractVersion: 1,
            },
          },
        },
      });

      const page = await executeExternalSessionTranscriptPageAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        remoteSessionId: 'remote-product-route',
        source: SOURCE,
        direction: 'older',
        maxBytes: 16 * 1024,
        maxItems: 1,
      });
      expect(page).toMatchObject({
        ok: true,
        items: [{ id: 'page-from-auxiliary-plugin' }],
        hasMore: false,
      });
      expect(page.ok && page.tailCursor).toMatch(/^happier_external_cursor_v1:/);
      if (!page.ok || !page.tailCursor) {
        throw new Error('Auxiliary plugin transcript page did not provide a tail cursor');
      }
      const pageTailCursor = page.tailCursor;
      const oversizedTranscript = await executeExternalSessionTranscriptPageAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        remoteSessionId: 'malicious-oversized-transcript',
        source: SOURCE,
        direction: 'older',
        maxBytes: 524_288,
        maxItems: 200,
      });
      expect(oversizedTranscript).toEqual({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'agent_unavailable',
        retryable: false,
      });
      expect(JSON.stringify(oversizedTranscript)).not.toContain('agent_error');

      const readAfter = await executeExternalSessionTranscriptReadAfterAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        remoteSessionId: 'remote-product-route',
        source: SOURCE,
        cursor: pageTailCursor,
        maxBytes: 16 * 1024,
        maxItems: 1,
      });
      expect(readAfter).toMatchObject({
        ok: true,
        items: [{ id: 'read-after-from-auxiliary-plugin' }],
        nextCursor: expect.stringMatching(/^happier_external_cursor_v1:/),
        truncated: false,
      });
      await expect(configured.authorService.readTranscript(configuredRef, {
        mode: 'readAfter',
        cursor: pageTailCursor,
        limit: 1,
        maxBytes: 16 * 1024,
      })).resolves.toMatchObject({
        items: [{ id: 'read-after-from-auxiliary-plugin' }],
        nextCursor: expect.stringMatching(/^happier_external_cursor_v1:/),
      });

      const persistedMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
      const persistedLink = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(persistedMetadata);
      if (!persistedLink?.qualifiedIdentity) {
        throw new Error('Expected the linked session to persist a qualified identity');
      }

      await materializeAuxiliaryOnlyPlugin(
        replacementPluginRoot,
        '2.0.0',
        REPLACEMENT_PLUGIN_ID,
      );
      await seedCurrentLocalPathPluginFixture({
        happyHomeDir: replacementHappyHomeDir,
        pluginRoot: replacementPluginRoot,
        pluginId: REPLACEMENT_PLUGIN_ID,
        manifestVersion: '2.0.0',
      });
      unownedRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: replacementHappyHomeDir,
      });
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: [PLUGIN_ID, REPLACEMENT_PLUGIN_ID],
        durableRevision: 4,
        runningSessionDisposition: 'retainRunningSessions',
      });
      controllerOwnsRegistry = true;
      const replacementRegistry = unownedRegistry;
      unownedRegistry = null;

      expect(runtimeLease.retirementSignal.aborted).toBe(true);
      await expect(configured.authorService.list()).rejects.toMatchObject({
        name: 'PluginError',
        code: 'plugin_generation_retired',
      });
      const replacementListed = await executeExternalSessionCandidatesListAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        source: SOURCE,
        limit: 1,
      });
      expect(replacementListed).toMatchObject({
        ok: true,
        candidates: [{ remoteSessionId: 'remote-product-route' }],
      });
      if (!listed.ok || !listed.nextCursor) {
        throw new Error('Expected the retired generation to expose a continuation cursor');
      }
      const retiredCursorList = await executeExternalSessionCandidatesListAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        source: SOURCE,
        cursor: listed.nextCursor,
        limit: 1,
      });
      expect(retiredCursorList).toMatchObject({
        ok: false,
        errorCode: 'invalid_request',
        error: expect.stringContaining('invalid_request'),
      });
      expect(retiredCursorList).not.toHaveProperty('autoLinkPolicyScopeV1');
      const replacementIdentity = await resolveCurrentExternalSessionAgentIdentity(
        ExternalSessionsAgentIdSchema.parse(AGENT_ID),
      );
      expect(replacementIdentity).toMatchObject({
        identity: {
          pluginId: REPLACEMENT_PLUGIN_ID,
          localId: AGENT_ID,
        },
      });
      if (!replacementIdentity) {
        throw new Error('Expected the replacement Agent identity');
      }
      await expect(resolveLinkedExternalSessionQualifiedIdentity(persistedLink, {
        resolveCurrentAgent: async () => replacementIdentity,
      })).resolves.toEqual({
        ok: false,
        errorCode: 'agent_unavailable',
        error: 'external_session_qualified_agent_unavailable',
      });
      expect(replacementRegistry.agentRuntimesByAgentId.get(AGENT_ID)).toMatchObject({
        pluginId: REPLACEMENT_PLUGIN_ID,
        agentId: AGENT_ID,
        hasPrimaryRuntime: false,
      });

      unownedRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: uninstalledHappyHomeDir,
      });
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: [REPLACEMENT_PLUGIN_ID],
        durableRevision: 5,
        runningSessionDisposition: 'retainRunningSessions',
      });
      expect(unownedRegistry.contributes.agentDefinitionsById.has(AGENT_ID)).toBe(false);
      unownedRegistry = null;
      const uninstalledList = await executeExternalSessionCandidatesListAction({
        machineId: 'machine-product-route',
        agentId: AGENT_ID,
        source: SOURCE,
        limit: 1,
      });
      expect(uninstalledList).toMatchObject({
        ok: false,
        errorCode: 'agent_unavailable',
      });
      expect(uninstalledList).not.toHaveProperty('autoLinkPolicyScopeV1');

      controllerOwnsRegistry = false;
      await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    } finally {
      if (controllerOwnsRegistry) {
        controllerOwnsRegistry = false;
        await pluginReloadController.shutdown({ timeoutMs: 5_000 });
      }
      await unownedRegistry?.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(replacementHappyHomeDir, { recursive: true, force: true });
      await rm(uninstalledHappyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(replacementPluginRoot, { recursive: true, force: true });
    }
  });
});
